#!/usr/bin/env python3
"""Fetch daily and hourly OHLCV for the watchlist and write compact JSON for the static site.

Outputs (all consumed by docs/index.html):
  docs/data/daily.json           1y daily bars for every ticker, keyed by symbol
  docs/data/hourly/<TICKER>.json 3mo hourly bars, one file per ticker (lazy-loaded)

A ticker that fails is not dropped: its previous bars are carried over from the
existing daily.json and the failure is recorded under "errors".
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

TICKERS = [
    "NVDA", "PLTR", "MU", "MSFT", "AMD", "VRT", "META", "ARM", "AVGO", "GLW",
    "AMAT", "NET", "GOOGL", "AMZN", "GEV", "ANET", "ZS", "MRVL", "CRWD", "DELL",
    "ETN", "PANW", "SNOW", "QCOM", "CIEN", "CEG", "ASX", "OKTA", "CSCO", "ENPH",
    "NTAP", "AMKR", "HPQ", "SMCI", "NEE", "INTC", "SPXC", "VST", "NRG", "WDC",
    "LUMN",
]

DATA_DIR = Path(__file__).resolve().parents[1] / "docs" / "data"
DAILY_PATH = DATA_DIR / "daily.json"
HOURLY_DIR = DATA_DIR / "hourly"

DAILY_PERIOD = "1y"
HOURLY_PERIOD = "3mo"
ATTEMPTS = 4
BACKOFF_SECONDS = 2.0
PAUSE_SECONDS = 0.4


def fetch(symbol: str, period: str, interval: str) -> pd.DataFrame:
    """history() with backoff. Yahoo occasionally answers 429 to shared CI IPs."""
    last_error: Exception | None = None
    for attempt in range(ATTEMPTS):
        try:
            frame = yf.Ticker(symbol).history(
                period=period, interval=interval, auto_adjust=True, raise_errors=True
            )
            if frame.empty:
                raise ValueError("empty history")
            return frame
        except Exception as exc:  # noqa: BLE001 - any provider failure is retryable here
            last_error = exc
            if attempt < ATTEMPTS - 1:
                time.sleep(BACKOFF_SECONDS * (attempt + 1))
    raise RuntimeError(f"{symbol} {interval}: {last_error}")


def daily_bars(frame: pd.DataFrame) -> list:
    """[["YYYY-MM-DD", o, h, l, c, volume], ...] - date strings keep the time axis tz-free."""
    return [
        [
            index.strftime("%Y-%m-%d"),
            round(float(row.Open), 4),
            round(float(row.High), 4),
            round(float(row.Low), 4),
            round(float(row.Close), 4),
            int(row.Volume),
        ]
        for index, row in frame.iterrows()
    ]


def hourly_bars(frame: pd.DataFrame) -> list:
    """[[unix_seconds, o, h, l, c, volume], ...]

    Timestamps are New York wall-clock reinterpreted as UTC, so the chart's time
    axis reads in exchange time (09:30 open) regardless of the viewer's zone.
    """
    wall_clock = frame.index.tz_convert("America/New_York").tz_localize(None)
    stamps = (wall_clock.tz_localize("UTC").astype("int64") // 10**9).tolist()
    return [
        [
            int(stamp),
            round(float(row.Open), 4),
            round(float(row.High), 4),
            round(float(row.Low), 4),
            round(float(row.Close), 4),
            int(row.Volume),
        ]
        for stamp, (_, row) in zip(stamps, frame.iterrows())
    ]


def load_previous() -> dict:
    if not DAILY_PATH.exists():
        return {}
    try:
        return json.loads(DAILY_PATH.read_text()).get("tickers", {})
    except (json.JSONDecodeError, OSError):
        return {}


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HOURLY_DIR.mkdir(parents=True, exist_ok=True)
    previous = load_previous()

    tickers: dict[str, dict] = {}
    errors: dict[str, str] = {}
    fresh = 0

    for symbol in TICKERS:
        try:
            bars = daily_bars(fetch(symbol, DAILY_PERIOD, "1d"))
            tickers[symbol] = {"bars": bars}
            fresh += 1
            print(f"  daily  {symbol:<6} {len(bars):>4} bars")
        except Exception as exc:  # noqa: BLE001 - keep the site populated on partial failure
            errors[symbol] = str(exc)
            if symbol in previous:
                tickers[symbol] = previous[symbol]
                print(f"  daily  {symbol:<6} FAILED, kept previous ({exc})")
            else:
                print(f"  daily  {symbol:<6} FAILED, no previous data ({exc})")
            continue

        try:
            bars = hourly_bars(fetch(symbol, HOURLY_PERIOD, "1h"))
            (HOURLY_DIR / f"{symbol}.json").write_text(
                json.dumps({"bars": bars}, separators=(",", ":"))
            )
            print(f"  hourly {symbol:<6} {len(bars):>4} bars")
        except Exception as exc:  # noqa: BLE001 - hourly is optional, daily still renders
            errors[f"{symbol}:1h"] = str(exc)
            print(f"  hourly {symbol:<6} FAILED ({exc})")

        time.sleep(PAUSE_SECONDS)

    payload = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "order": TICKERS,
        "tickers": tickers,
        "errors": errors,
    }
    DAILY_PATH.write_text(json.dumps(payload, separators=(",", ":")))

    size_kb = DAILY_PATH.stat().st_size / 1024
    print(f"\n{fresh}/{len(TICKERS)} tickers refreshed, {len(errors)} errors")
    print(f"wrote {DAILY_PATH.relative_to(DATA_DIR.parents[1])} ({size_kb:.0f} KB)")
    return 0 if fresh else 1


if __name__ == "__main__":
    raise SystemExit(main())
