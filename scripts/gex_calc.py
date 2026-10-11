#!/usr/bin/env python3
"""Compute SPX dealer gamma exposure from Cboe's delayed option chain.

Writes docs/data/gex.json for the static page. The 13 MB Cboe snapshot is
fetched, used and discarded - only the derived summary is committed.

Fixes over the version this was ported from:
  * the valuation day, next session and monthly expiration are derived from the
    data instead of being hardcoded per run;
  * Call Wall / Put Wall only consider out-of-the-money strikes, so a "wall" can
    never sit on the wrong side of spot;
  * reports how concentrated the gamma is and where the flip lands once the
    biggest strikes are removed, because the flip is driven by a handful of them.

A failed fetch keeps the previous gex.json and records the error, so the page
never goes blank.
"""

from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import norm

CBOE_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json"
ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "docs" / "data" / "gex.json"

LOOKBACK = 0.15     # sweep spot +/-15% to find where net gamma crosses zero
GRID_STEP = 5.0
STRIKE_BAND = 0.08  # strikes drawn in the bar panels
WALL_BAND = 0.12    # strikes considered when locating the walls
TOP_N = 5           # strikes knocked out for the robustness check
ATTEMPTS = 4

# Dealer positioning is not observable. These are the assumption sets the page
# switches between; only the sign pattern means anything, the weights are
# arbitrary - which is exactly why a scenario's flip is worth a band, not a number.
SCENARIOS = {
    "A": (1.0, -1.0),   # 標準：造市商多 Call、空 Put
    "B": (-1.0, 1.0),   # 反向
    "E": (1.0, -0.5),   # 空 Put 減半
    "F": (0.5, -1.0),   # 多 Call 減半
    "C": (-1.0, -1.0),  # 空 Call + 空 Put
    "D": (1.0, 1.0),    # 多 Call + 多 Put
}


def fetch_snapshot() -> dict:
    last: Exception | None = None
    for _ in range(ATTEMPTS):
        try:
            req = urllib.request.Request(CBOE_URL, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.loads(res.read())
        except Exception as exc:  # noqa: BLE001 - any transport error is retryable
            last = exc
    raise RuntimeError(f"Cboe 下載失敗: {last}")


def third_friday(month_start: pd.Timestamp) -> pd.Timestamp:
    end = month_start + pd.offsets.MonthEnd(0)
    return pd.date_range(month_start, end, freq="W-FRI")[2]


def prepare(raw: dict):
    """Parse the option symbols and work out which session the snapshot describes."""
    data = raw["data"]
    spot = float(data["current_price"])
    fetched_at = pd.Timestamp(raw["timestamp"])

    o = pd.DataFrame(data["options"])
    parts = o.option.str.extract(r"^(SPXW?)(\d{6})([CP])(\d{8})$")
    o["root"] = parts[0]
    o["exp"] = pd.to_datetime(parts[1], format="%y%m%d")
    o["cp"] = parts[2]
    o["K"] = parts[3].astype(float) / 1000
    o = o.dropna(subset=["exp"]).copy()

    # SPXW lists an expiration for every trading day, so the expiration set is
    # itself the trading calendar - no holiday table needed.
    expirations = sorted(e for e in o.exp.unique() if e.date() > fetched_at.date())
    if not expirations:
        raise RuntimeError("資料裡找不到未來的到期日")
    session = pd.Timestamp(expirations[0])

    opex = third_friday(session.replace(day=1))
    if opex < session:
        opex = third_friday((session + pd.offsets.MonthEnd(1)).replace(day=1))

    # SPX monthly settles at the open, SPXW weekly at the close.
    settle_hours = np.where(o.root.values == "SPX", 9.5, 16.0)
    valuation = session + pd.Timedelta(hours=9.5)
    settlement = pd.DatetimeIndex(o.exp.values) + pd.to_timedelta(settle_hours, unit="h")
    o["T"] = (settlement - valuation).total_seconds() / (365 * 86400)
    o = o[o["T"] > 0].copy()

    return o, spot, fetched_at, session, opex


def fit_carry(o: pd.DataFrame, spot: float) -> float:
    """Forward price from put-call parity, then one log-linear fit against T."""
    o["mid"] = (o["bid"] + o.ask) / 2
    quoted = o[(o.bid > 0) & (o.ask > 0)]
    rows = []
    for _, g in quoted.groupby("exp"):
        calls = g[g.cp == "C"].groupby("K").mid.mean()
        puts = g[g.cp == "P"].groupby("K").mid.mean()
        strikes = calls.index.intersection(puts.index)
        strikes = strikes[abs(strikes / spot - 1) < 0.03]
        if len(strikes) < 3:
            continue
        diff = calls[strikes] - puts[strikes]
        nearest = diff.abs().sort_values().index[:5]
        rows.append((g["T"].iloc[0], float(np.median(nearest + diff[nearest]))))

    frame = pd.DataFrame(rows, columns=["T", "F"])
    frame = frame[frame["T"] > 20 / 365]
    if len(frame) < 3:
        raise RuntimeError("有效到期日太少，無法估遠期價格")
    return float(np.polyfit(frame["T"], np.log(frame["F"] / spot), 1)[0])


def build_smile(o: pd.DataFrame, spot: float, carry: float) -> dict:
    o["F0"] = spot * np.exp(carry * o["T"])
    o["x"] = np.log(o.K / o.F0)
    otm = o[((o.cp == "P") & (o.K < o.F0)) | ((o.cp == "C") & (o.K >= o.F0))]
    smile = {}
    for exp, g in otm.groupby("exp"):
        curve = g.groupby("x").iv.mean().sort_index()
        if len(curve) >= 3:
            smile[exp] = (curve.index.values, curve.values)
    return smile


def bs_gamma(spot, strike, T, sigma, carry):
    """Gamma does not depend on the drift, so no discount factor appears."""
    d1 = (np.log(spot / strike) + (carry + 0.5 * sigma * sigma) * T) / (sigma * np.sqrt(T))
    return norm.pdf(d1) / (spot * sigma * np.sqrt(T))


def main() -> int:
    try:
        raw = fetch_snapshot()
        o, spot, fetched_at, session, opex = prepare(raw)
        carry = fit_carry(o, spot)
        # the smile must only average contracts with a real IV, otherwise the
        # zero-IV rows drag the curve down and sigma can reach zero
        o = o[(o.iv > 0.01) & (o.open_interest > 0)].copy()
        smile = build_smile(o, spot, carry)
        o = o[o.exp.isin(smile)].copy()
        o["F0"] = spot * np.exp(carry * o["T"])
        o["x"] = np.log(o.K / o.F0)
    except Exception as exc:  # noqa: BLE001 - keep serving the previous file
        print(f"GEX 計算失敗：{exc}")
        if OUT_PATH.exists():
            stale = json.loads(OUT_PATH.read_text())
            stale["ok"] = False
            stale.setdefault("errors", []).append(str(exc))
            OUT_PATH.write_text(json.dumps(stale, separators=(",", ":")))
            print("保留前一次 gex.json")
            return 0
        return 1

    exp_values = o.exp.values
    exp_index = {e: exp_values == e for e in np.unique(exp_values)}
    strike_values = o.K.values
    t_values = o["T"].values
    oi_values = o.open_interest.values
    is_call = (o.cp == "C").values

    def dollar_gamma(price):
        forward = price * np.exp(carry * t_values)
        x = np.log(strike_values / forward)
        sigma = np.empty(len(o))
        for e, mask in exp_index.items():
            xs, vs = smile[pd.Timestamp(e)]
            sigma[mask] = np.interp(x[mask], xs, vs)
        return bs_gamma(price, strike_values, t_values, sigma, carry) * oi_values * 100 * price * price * 0.01

    buckets = {
        "30d": ("30天內到期", (o.exp <= session + pd.Timedelta(days=30)).values),
        "all": ("全部到期日", np.ones(len(o), dtype=bool)),
    }

    grid = np.arange(spot * (1 - LOOKBACK), spot * (1 + LOOKBACK) + 1, GRID_STEP)
    # one pass over the grid; every curve and every robustness variant is a
    # column sum of this matrix
    matrix = np.empty((len(grid), len(o)), dtype=np.float32)
    for i, price in enumerate(grid):
        matrix[i] = dollar_gamma(price)

    at_spot = dollar_gamma(spot)
    check = o[(abs(o.K / spot - 1) < 0.05) & (o.gamma > 0)]
    if len(check) > 50:
        mine = bs_gamma(spot, check.K.values, check["T"].values, check.iv.values, carry)
        corr = float(np.corrcoef(mine, check.gamma.values)[0, 1])
        ratio = float(np.median(mine / check.gamma.values))
    else:
        corr = ratio = None

    def flip_of(call_curve, put_curve, wc, wp):
        net = wc * call_curve + wp * put_curve
        sign = np.sign(net)
        crossings = np.where(sign[:-1] * sign[1:] < 0)[0]
        if not len(crossings):
            return None
        points = [grid[i] - net[i] * GRID_STEP / (net[i + 1] - net[i]) for i in crossings]
        return float(min(points, key=lambda v: abs(v - spot)))

    panels, curve, coverage = {}, {"prices": [float(p) for p in grid]}, {}

    for key, (title, mask) in buckets.items():
        table = pd.DataFrame({"K": strike_values[mask], "isC": is_call[mask], "g": at_spot[mask]})
        calls = table[table.isC].groupby("K").g.sum()
        puts = table[~table.isC].groupby("K").g.sum()
        by_strike = pd.DataFrame({"call": calls, "put": -puts}).fillna(0)
        by_strike["net"] = by_strike.call + by_strike.put
        near = by_strike[abs(by_strike.index / spot - 1) < STRIKE_BAND].sort_index()
        panels[key] = {
            "title": title,
            "strikes": [[float(k), round(c / 1e9, 3), round(p / 1e9, 3), round(n / 1e9, 3)]
                        for k, c, p, n in zip(near.index, near.call, near.put, near.net)],
        }

        call_curve = matrix[:, is_call & mask].sum(1) / 1e9
        put_curve = matrix[:, ~is_call & mask].sum(1) / 1e9
        curve[key] = {"call": [round(float(v), 3) for v in call_curve],
                      "put": [round(float(v), 3) for v in put_curve]}

        call_total = float(at_spot[is_call & mask].sum()) / 1e9
        put_total = float(at_spot[~is_call & mask].sum()) / 1e9

        # a wall must be on the correct side of spot, so calls only look above it
        # and puts only below; otherwise "resistance" can print under the market
        wall_table = table[abs(table.K / spot - 1) < WALL_BAND]
        call_by_strike = wall_table[wall_table.isC].groupby("K").g.sum() / 1e9
        put_by_strike = -wall_table[~wall_table.isC].groupby("K").g.sum() / 1e9
        otm_calls = call_by_strike[call_by_strike.index > spot]
        otm_puts = put_by_strike[put_by_strike.index < spot]

        # the flip is set by a handful of strikes, so show what survives without them
        by_magnitude = wall_table.groupby("K").g.sum().abs().sort_values(ascending=False)
        top = list(by_magnitude.head(TOP_N).index)
        keep = ~np.isin(strike_values, top)
        trimmed_call = matrix[:, is_call & mask & keep].sum(1) / 1e9
        trimmed_put = matrix[:, ~is_call & mask & keep].sum(1) / 1e9

        flips, nets, trimmed = {}, {}, {}
        for name, (wc, wp) in SCENARIOS.items():
            flips[name] = flip_of(call_curve, put_curve, wc, wp)
            trimmed[name] = flip_of(trimmed_call, trimmed_put, wc, wp)
            nets[name] = round(wc * call_total + wp * put_total, 2)

        round_or_none = lambda v: round(v, 0) if v is not None else None  # noqa: E731
        coverage[key] = {
            "netGex": nets,
            "flip": {k: round_or_none(v) for k, v in flips.items()},
            "flipExTop5": {k: round_or_none(v) for k, v in trimmed.items()},
            "callWall": [float(otm_calls.idxmax()), round(float(otm_calls.max()), 2)] if len(otm_calls) else None,
            "putWall": [float(otm_puts.idxmin()), round(float(otm_puts.min()), 2)] if len(otm_puts) else None,
            "concentration": {
                "topShare": round(float(by_magnitude.head(TOP_N).sum() / by_magnitude.sum()), 3),
                "strikes": [[float(k), round(float(v) / 1e9, 1)] for k, v in by_magnitude.head(TOP_N).items()],
                "count": int(len(by_magnitude)),
            },
        }

    iv30 = float(raw["data"].get("iv30") or 0) or None
    sigma1d = spot * iv30 / 100 / np.sqrt(252) if iv30 else None
    standard = {k: coverage[k]["flip"]["A"] for k in coverage if coverage[k]["flip"]["A"] is not None}
    distances = {k: round((spot - v) / sigma1d, 2) for k, v in standard.items()} if sigma1d else {}

    payload = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ok": True,
        "snapshot": {
            "timestamp": str(raw["timestamp"]),
            "spot": spot,
            "iv30": iv30,
            "contracts": int(len(o)),
            "contractsTotal": int(len(raw["data"]["options"])),
        },
        "session": {
            "valuation": str(session.date()),
            "opex": str(opex.date()),
            "carry": round(carry, 4),
            "sigma1d": round(sigma1d, 1) if sigma1d else None,
        },
        "validation": {
            "cboeGammaCorr": round(corr, 3) if corr else None,
            "cboeGammaRatio": round(ratio, 3) if ratio else None,
        },
        "panels": panels,
        "curve": curve,
        "metrics": {
            "buckets": coverage,
            "flipStandard": standard,
            "sigmaDistance": distances,
            "scenarios": {k: list(v) for k, v in SCENARIOS.items()},
        },
        "errors": [],
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, separators=(",", ":")))

    print(f"spot {spot:,.2f} | session {session.date()} | opex {opex.date()} | carry {carry:.4f}")
    print(f"{len(o)} 合約（原始 {len(raw['data']['options'])}）")
    if corr:
        print(f"對 Cboe gamma：相關 {corr:.3f}，中位數比值 {ratio:.3f}")
    for key, c in coverage.items():
        print(f"  {key:4} 淨GEX(A)={c['netGex']['A']:>7.2f}B  Flip(A)={c['flip']['A']}  "
              f"扣前{TOP_N}大={c['flipExTop5']['A']}  CallWall={c['callWall']}  PutWall={c['putWall']}  "
              f"前{TOP_N}大占={c['concentration']['topShare']:.1%}")
    if sigma1d:
        print(f"  1σ={sigma1d:.0f} 點 | 現價距 Flip（σ）={distances}")
    print(f"wrote {OUT_PATH.relative_to(ROOT)} ({OUT_PATH.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
