#!/usr/bin/env python3
"""Collect SPX gamma levels published by three third-party services, for comparison.

How each source is obtained:

  SquawkFlow      squawkflow.com/gex.md - a Markdown endpoint they publish for
                  machine reading, which spells out every level and its timestamp
  InsiderFinance  the values are server-rendered into their public SPX page, so
                  they are read out of the HTML
  FlashAlpha      their documented API; needs FLASHALPHA_API_KEY in the env

One source failing never blanks the table: that row is written with ok=false and
an error string so the page can show a dash and say which source it lost.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "docs" / "data" / "gex-peers.json"

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
TIMEOUT = 60

SOURCES = [
    ("squawkflow", "SquawkFlow", "https://squawkflow.com/gex"),
    ("insiderfinance", "InsiderFinance", "https://www.insiderfinance.io/gamma-exposure/spx"),
    ("flashalpha", "FlashAlpha", "https://flashalpha.com/dashboard"),
]


def get(url: str, headers: dict | None = None) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        return res.read().decode("utf-8", errors="ignore")


def num(text: str) -> float | None:
    """'$103.45B' / '$7,709.90' -> float."""
    if not text:
        return None
    cleaned = text.replace("$", "").replace(",", "").strip()
    match = re.match(r"-?\d+(\.\d+)?", cleaned)
    return float(match.group(0)) if match else None


def find(pattern: str, text: str) -> float | None:
    match = re.search(pattern, text, re.I)
    return num(match.group(1)) if match else None


def strip_tags(html: str) -> str:
    text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text.replace("&nbsp;", " ").replace("&amp;", "&")).strip()


def fetch_squawkflow() -> dict:
    text = get("https://squawkflow.com/gex.md")
    as_of = re.search(r"As of:\s*([\d-]+)", text)
    return {
        "spot": find(r"\*\*Spot:\*\*\s*\$([\d,.]+)", text),
        "netGex": find(r"\*\*Net GEX:\*\*\s*\$([\d,.]+)\s*B", text),
        "zeroGamma": find(r"\*\*Zero-gamma flip:\*\*\s*\$([\d,.]+)", text),
        "callWall": find(r"\*\*Call wall:\*\*\s*\$([\d,.]+)", text),
        "putWall": find(r"\*\*Put wall:\*\*\s*\$([\d,.]+)", text),
        "asOf": as_of.group(1) if as_of else None,
    }


def fetch_insiderfinance() -> dict:
    text = strip_tags(get("https://www.insiderfinance.io/gamma-exposure/spx"))
    return {
        "spot": find(r"Spot Price:\s*\$([\d,.]+)", text),
        "netGex": find(r"Net GEX:\s*\$([\d,.]+)\s*B", text),
        "zeroGamma": find(r"Zero-Gamma Level:\s*\$([\d,.]+)", text),
        "callWall": find(r"Call Wall:\s*\$([\d,.]+)", text),
        "putWall": find(r"Put Wall:\s*\$([\d,.]+)", text),
        "asOf": None,   # 頁面只給相對時間，沒有明確日期
    }


def fetch_flashalpha() -> dict:
    key = os.environ.get("FLASHALPHA_API_KEY")
    if not key:
        raise RuntimeError("沒有 FLASHALPHA_API_KEY 環境變數")
    payload = json.loads(get(
        "https://lab.flashalpha.com/v1/stock/spx/summary", {"X-Api-Key": key}
    ))
    exposure = payload.get("exposure") or {}
    net = exposure.get("net_gex")
    if net is None:
        raise RuntimeError(f"回應沒有 exposure.net_gex：{payload}")
    return {
        "spot": (payload.get("price") or {}).get("last"),
        "netGex": round(net / 1e9, 2),
        "zeroGamma": exposure.get("gamma_flip"),
        "callWall": exposure.get("call_wall"),
        "putWall": exposure.get("put_wall"),
        "asOf": (payload.get("as_of") or "")[:10] or None,
        "regime": exposure.get("regime"),
    }


FETCHERS = {
    "squawkflow": fetch_squawkflow,
    "insiderfinance": fetch_insiderfinance,
    "flashalpha": fetch_flashalpha,
}


def load_previous() -> dict:
    """上一次成功的數字，用來在抓不到時沿用。"""
    if not OUT_PATH.exists():
        return {}
    try:
        data = json.loads(OUT_PATH.read_text())
        return {p["key"]: p for p in data.get("peers", []) if p.get("ok")}
    except (json.JSONDecodeError, OSError, KeyError, TypeError):
        return {}


VALUES = ("spot", "zeroGamma", "callWall", "putWall", "netGex")


def main() -> int:
    previous = load_previous()
    today = datetime.now(timezone.utc).date().isoformat()
    peers = []

    for key, name, url in SOURCES:
        entry = {"key": key, "name": name, "url": url}
        try:
            values = FETCHERS[key]()
            missing = [k for k in ("zeroGamma", "callWall", "putWall", "netGex") if values.get(k) is None]
            if missing:
                raise RuntimeError(f"缺少欄位 {missing}")
            entry.update(values)
            entry.update({"ok": True, "stale": False, "fetchedAt": today})
            print(f"  {name:15} OK  零伽瑪 {values['zeroGamma']:,.0f}  Call {values['callWall']:,.0f}"
                  f"  Put {values['putWall']:,.0f}  淨GEX {values['netGex']:.2f}B")
        except Exception as exc:  # noqa: BLE001 - one bad source must not stop the rest
            old = previous.get(key)
            if old:
                # 沿用上一次成功的數字，但標記 stale 並保留它的日期，不假裝是新的
                entry.update({k: old.get(k) for k in VALUES})
                entry.update({
                    "ok": True, "stale": True,
                    "asOf": old.get("asOf"), "fetchedAt": old.get("fetchedAt"),
                    "error": str(exc)[:200],
                })
                when = old.get("asOf") or old.get("fetchedAt") or "前次"
                print(f"  {name:15} 抓取失敗，沿用 {when} 的值（{exc}）")
            else:
                entry.update({"ok": False, "stale": False, "error": str(exc)[:200]})
                print(f"  {name:15} 失敗，沒有可沿用的值：{exc}")
        peers.append(entry)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps({
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "peers": peers,
    }, separators=(",", ":"), ensure_ascii=False))

    fresh = sum(1 for p in peers if p["ok"] and not p["stale"])
    stale = sum(1 for p in peers if p.get("stale"))
    failed = sum(1 for p in peers if not p["ok"])
    print(f"\n{fresh} 個即時、{stale} 個沿用前次、{failed} 個失敗")
    print(f"wrote {OUT_PATH.relative_to(ROOT)} ({OUT_PATH.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
