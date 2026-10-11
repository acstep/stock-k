#!/usr/bin/env python3
"""Mirror SquawkFlow's open SPX gamma-level dataset and test what it predicts.

They publish daily dealer gamma levels (CC BY 4.0) as a CSV at
github.com/dhawalc/spx-gamma-levels; we keep a copy so the page has no runtime
dependency on their repo, and run the test their own write-up says nobody has
published: does the published gamma regime say anything about the next
session's realised volatility?

The alignment matters and was verified before writing any of this: each row's
`spot` is the close of its `oi_settle_date`, and `date` is the following
session, so the levels are known before the session they are scored against.
No look-ahead.

Writes docs/data/spx-levels.csv (verbatim copy) and docs/data/gex-backtest.json.
"""

from __future__ import annotations

import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

CSV_URL = "https://raw.githubusercontent.com/dhawalc/spx-gamma-levels/main/data/spx-gamma-levels.csv"
SOURCE = {
    "name": "SquawkFlow",
    "url": "https://github.com/dhawalc/spx-gamma-levels",
    "license": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
}

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "docs" / "data"
LEVELS_PATH = DATA_DIR / "spx-levels.csv"
OUT_PATH = DATA_DIR / "gex-backtest.json"
DAILY_PATH = DATA_DIR / "daily.json"


def mirror() -> str:
    """Download the dataset; keep the previous copy if the fetch fails."""
    req = urllib.request.Request(CSV_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as res:
        text = res.read().decode("utf-8-sig", errors="ignore")
    if "date,symbol" not in text.splitlines()[0]:
        raise RuntimeError(f"CSV 標頭不如預期：{text.splitlines()[0][:80]}")
    LEVELS_PATH.write_text(text, encoding="utf-8")
    return text


def spx_bars() -> pd.DataFrame:
    """^SPX daily bars already downloaded by fetch_kline.py - no extra request."""
    payload = json.loads(DAILY_PATH.read_text())
    bars = payload["tickers"]["^SPX"]["bars"]
    frame = pd.DataFrame(bars, columns=["date", "open", "high", "low", "close", "volume"])
    frame["date"] = pd.to_datetime(frame["date"])
    return frame.set_index("date").sort_index()


def build(levels: pd.DataFrame, spx: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for _, r in levels.dropna(subset=["oi_settle_date"]).iterrows():
        if r.date not in spx.index or r.oi_settle_date not in spx.index:
            continue
        i = spx.index.get_indexer([r.date])[0]
        if i < 2:
            continue
        day, prev, prev2 = spx.iloc[i], spx.iloc[i - 1], spx.iloc[i - 2]
        rows.append({
            "date": r.date,
            "regime": r.gamma_regime,
            "spot": float(r.spot),
            "flip": float(r.zero_gamma_flip),
            "callWall": float(r.call_wall),
            "putWall": float(r.put_wall),
            "netGex": float(r.net_gex_dollars) / 1e9,
            "range": (day.high - day.low) / prev.close * 100,
            "absRet": abs(day.close - prev.close) / prev.close * 100,
            "ret": (day.close - prev.close) / prev.close * 100,
            "prevRange": (prev.high - prev.low) / prev2.close * 100,
            "high": day.high, "low": day.low, "close": day.close,
        })
    return pd.DataFrame(rows)


def group_table(frame: pd.DataFrame, key: str) -> list:
    out = []
    for name, g in frame.groupby(key):
        out.append({
            "key": str(name), "days": int(len(g)),
            "range": round(float(g.range.mean()), 3),
            "absRet": round(float(g.absRet.mean()), 3),
            "prevRange": round(float(g.prevRange.mean()), 3),
            "ret": round(float(g.ret.mean()), 3),
        })
    return sorted(out, key=lambda d: d["key"])


def main() -> int:
    try:
        mirror()
    except Exception as exc:  # noqa: BLE001 - fall back to the copy we already have
        if not LEVELS_PATH.exists():
            print(f"下載失敗且沒有舊檔：{exc}")
            return 1
        print(f"下載失敗，沿用舊檔：{exc}")

    levels = pd.read_csv(LEVELS_PATH, parse_dates=["date", "oi_settle_date"])
    frame = build(levels, spx_bars())
    if len(frame) < 20:
        print(f"可用樣本只有 {len(frame)} 天，不足以分析")
        return 1

    pos = frame[frame.regime == "positive"]
    neg = frame[frame.regime == "negative"]
    sd = float(frame.range.std(ddof=1))
    se = sd * np.sqrt(1 / len(pos) + 1 / len(neg))
    tcrit = float(stats.t.ppf(0.975, len(neg) - 1))
    t, p = stats.ttest_ind(pos.range, neg.range, equal_var=False)

    # 這個樣本有辦法偵測到多大的差異？檢定力低於 80% 就代表「測不到」不能當「沒有」
    power = {}
    for eff in (0.1, 0.2, 0.3, 0.5):
        ratio = eff / (sd * np.sqrt(1 / len(pos) + 1 / len(neg)))
        crit = float(stats.t.ppf(0.975, len(neg) - 1))
        power[f"{eff}"] = round(float(
            1 - stats.nct.cdf(crit, len(neg) - 1, ratio) + stats.nct.cdf(-crit, len(neg) - 1, ratio)
        ), 3)

    frame["above"] = frame.spot > frame.flip
    above, below = frame[frame.above], frame[~frame.above]
    _, flip_p = stats.ttest_ind(above.range, below.range, equal_var=False) if len(below) > 1 else (0, None)

    corr, corr_p = stats.pearsonr((frame.spot - frame.flip) / frame.spot * 100, frame.range)

    touched_call = int((frame.high >= frame.callWall).sum())
    held_call = int(((frame.high >= frame.callWall) & (frame.close < frame.callWall)).sum())
    touched_put = int((frame.low <= frame.putWall).sum())
    held_put = int(((frame.low <= frame.putWall) & (frame.close > frame.putWall)).sum())

    payload = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": SOURCE,
        "note": "本頁鏡像 SquawkFlow 的開放資料集（CC BY 4.0），分析由本站自行計算。",
        "window": {
            "from": str(frame.date.min().date()), "to": str(frame.date.max().date()),
            "days": int(len(frame)),
        },
        "regime": group_table(frame, "regime"),
        "signTest": {
            "diff": round(float(pos.range.mean() - neg.range.mean()), 3),
            "p": round(float(p), 3),
            "needed": round(float(tcrit * se), 3),
            "sd": round(sd, 3),
            "power": power,
        },
        "flipTest": {
            "above": group_table(frame, "above"),
            "p": round(float(flip_p), 3) if flip_p is not None else None,
        },
        "distanceTest": {"corr": round(float(corr), 3), "p": round(float(corr_p), 3)},
        "walls": {
            "callTouched": touched_call, "callHeld": held_call,
            "putTouched": touched_put, "putHeld": held_put,
            "putDistAvg": round(float(((frame.spot - frame.putWall) / frame.spot * 100).mean()), 2),
            "callDistAvg": round(float(((frame.callWall - frame.spot) / frame.spot * 100).mean()), 2),
        },
        "medianDistToFlip": round(float(((frame.spot - frame.flip).abs() / frame.spot * 100).median()), 2),
    }
    OUT_PATH.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))

    print(f"樣本 {payload['window']['days']} 天（{payload['window']['from']} ~ {payload['window']['to']}）")
    for g in payload["regime"]:
        print(f"  {g['key']:9} {g['days']:>3} 天  平均振幅 {g['range']:.3f}%  前日 {g['prevRange']:.3f}%")
    print(f"  正 vs 負：差 {payload['signTest']['diff']:+.3f}%，p = {payload['signTest']['p']}，"
          f"要顯著需差 {payload['signTest']['needed']:.3f}%")
    print(f"  牆：Call 觸及 {touched_call} 守住 {held_call} | Put 觸及 {touched_put} 守住 {held_put}")
    print(f"wrote {OUT_PATH.relative_to(ROOT)} ({OUT_PATH.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
