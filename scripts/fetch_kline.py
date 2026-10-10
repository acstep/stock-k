#!/usr/bin/env python3
"""Fetch daily and hourly OHLCV for the watchlist and write compact JSON for the static site.

The watchlist lives in watchlist.txt at the repo root - one "SYMBOL 名稱" per
line, and the line order is the default order shown on the page.

Outputs (all consumed by docs/index.html):
  docs/data/daily.json           1y daily bars for every ticker, keyed by symbol
  docs/data/hourly/<TICKER>.json 3mo hourly bars, one file per ticker (lazy-loaded)

A ticker that fails is not dropped: its previous bars are carried over from the
existing daily.json and the failure is recorded under "errors". Hourly files for
tickers that left the watchlist are deleted.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

# Let provider errors surface as exceptions rather than empty frames, so a broken
# fetch can be told apart from a symbol that genuinely has no data. yfinance 1.x
# dropped the per-call raise_errors= argument in favour of this global.
yf.config.debug.hide_exceptions = False

ROOT = Path(__file__).resolve().parents[1]
WATCHLIST_PATH = ROOT / "watchlist.txt"
DATA_DIR = ROOT / "docs" / "data"
DAILY_PATH = DATA_DIR / "daily.json"
HOURLY_DIR = DATA_DIR / "hourly"

DAILY_PERIOD = "1y"
HOURLY_PERIOD = "3mo"
ATTEMPTS = 4
BACKOFF_SECONDS = 2.0
PAUSE_SECONDS = 0.4


def load_watchlist() -> list[tuple[str, str]]:
    """Parse watchlist.txt into [(symbol, name), ...], preserving line order.

    Format is "SYMBOL 名稱" - the name is optional and may contain spaces, so we
    split on the first run of whitespace only. Blank lines and #-comments are
    ignored; a # also starts an inline comment.
    """
    entries: list[tuple[str, str]] = []
    seen: set[str] = set()

    for lineno, raw in enumerate(WATCHLIST_PATH.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue

        symbol, _, name = line.replace("\t", " ").partition(" ")
        symbol = symbol.strip().upper()
        name = name.strip() or symbol

        if not symbol:
            continue
        if symbol in seen:
            print(f"  watchlist.txt:{lineno}  {symbol} 重複，略過")
            continue

        seen.add(symbol)
        entries.append((symbol, name))

    if not entries:
        raise SystemExit("watchlist.txt 裡沒有任何股票，中止")
    return entries


def prune_hourly(keep: set[str]) -> None:
    for path in sorted(HOURLY_DIR.glob("*.json")):
        if path.stem not in keep:
            path.unlink()
            print(f"  移除 {path.name}（已不在清單中）")


def fetch(symbol: str, period: str, interval: str) -> pd.DataFrame:
    """history() with backoff. Yahoo occasionally answers 429 to shared CI IPs."""
    last_error: Exception | None = None
    for attempt in range(ATTEMPTS):
        try:
            frame = yf.Ticker(symbol).history(
                period=period, interval=interval, auto_adjust=True
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

    watchlist = load_watchlist()
    symbols = [symbol for symbol, _ in watchlist]
    previous = load_previous()

    print(f"watchlist.txt: {len(symbols)} 檔\n")

    tickers: dict[str, dict] = {}
    errors: dict[str, str] = {}
    fresh = 0

    for symbol in symbols:
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

    prune_hourly(set(symbols))

    payload = {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "order": symbols,
        "names": dict(watchlist),
        "tickers": tickers,
        "errors": errors,
    }
    DAILY_PATH.write_text(json.dumps(payload, separators=(",", ":")))

    size_kb = DAILY_PATH.stat().st_size / 1024
    print(f"\n{fresh}/{len(symbols)} tickers refreshed, {len(errors)} errors")
    print(f"wrote {DAILY_PATH.relative_to(ROOT)} ({size_kb:.0f} KB)")
    return 0 if fresh else 1


if __name__ == "__main__":
    raise SystemExit(main())
