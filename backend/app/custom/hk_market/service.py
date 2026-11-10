"""港股日线服务：直连 TickFlow 免费层，自带限速、内存缓存与磁盘缓存。

免费层能力边界（2026-11 实测）：
- 有：港股 2,849 只标的、标的名称、历史日 K（可取 500+ 根）
- 无：实时行情、分钟 K；`amount`（成交额）字段恒为 0

因此这里的"成交额"是 `收盘 × 成交量` 的估算值，前端一律标「估」，
不给用户任何"这是真实成交额"的错觉。

限速：免费层按 IP 限制 60 次/分钟，本模块全局串行 + 1.05 秒最小间隔，
宁可慢一点也不能被限流（被限流后重试会拖垮整个看板的首次加载）。
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)

# 港股代码：5 位数字 + .HK（腾讯 00700.HK）。A 股的 6 位规范在这不适用。
SYMBOL_RE = re.compile(r"^\d{5}\.HK$")

# 默认看的一篮子（腾讯/汇丰/建行/美团/阿里/小米/京东/平安/港交所/友邦/中海油/新鸿基）
DEFAULT_BASKET: tuple[str, ...] = (
    "00700.HK",
    "00005.HK",
    "00939.HK",
    "03690.HK",
    "09988.HK",
    "01810.HK",
    "09618.HK",
    "02318.HK",
    "00388.HK",
    "01299.HK",
    "00883.HK",
    "00016.HK",
)

# 一次取满一年（约 250 个交易日），K 线接口按需切片，避免重复请求上游。
FETCH_BARS = 300
BARS_TTL = 6 * 3600  # 日线一天只变一次，6 小时足够
INSTRUMENTS_TTL = 7 * 86400

_CACHE_DIR = Path(settings.data_dir) / "custom" / "hk_market"
_BARS_FILE = _CACHE_DIR / "daily.json"
_INSTRUMENTS_FILE = _CACHE_DIR / "instruments.json"

_MIN_INTERVAL = 1.05
_throttle_lock = threading.Lock()
_last_call = 0.0

_client_lock = threading.Lock()
_client: Any = None

_cache_lock = threading.Lock()
_bars_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_instruments_cache: tuple[float, list[dict[str, str]]] | None = None


class HkDataError(RuntimeError):
    """上游不可用 / 无此标的，交由路由层转成 4xx-5xx。"""


def normalize_symbol(symbol: str) -> str:
    s = (symbol or "").strip().upper()
    if not SYMBOL_RE.match(s):
        raise HkDataError(f"港股代码格式应为 5 位数字 + .HK，例如 00700.HK，收到：{symbol!r}")
    return s


# ===== 基础设施 =====


def _get_client() -> Any:
    """TickFlow 免费层客户端（免注册，按 IP 限速）。"""
    global _client
    with _client_lock:
        if _client is None:
            from tickflow import TickFlow

            _client = TickFlow.free()
        return _client


def _throttle() -> None:
    """全局 1 秒 1 次，稳稳压在免费层 60 次/分之下。"""
    global _last_call
    with _throttle_lock:
        wait = _MIN_INTERVAL - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()


def _read_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _write_json(path: Path, payload: Any) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".writing")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
        tmp.replace(path)
    except OSError as exc:  # 缓存写失败只影响速度，不影响正确性
        logger.debug("hk_market 缓存写入失败 %s: %s", path, exc)


# ===== 标的清单 =====


def _load_instruments_disk() -> list[dict[str, str]] | None:
    raw = _read_json(_INSTRUMENTS_FILE)
    if not isinstance(raw, dict):
        return None
    if time.time() - float(raw.get("ts") or 0) > INSTRUMENTS_TTL:
        return None
    items = raw.get("items")
    return items if isinstance(items, list) else None


def instruments() -> list[dict[str, str]]:
    """港股全部标的（约 2,849 只），内存 → 磁盘 → 上游三级缓存。"""
    global _instruments_cache
    with _cache_lock:
        if _instruments_cache and time.time() - _instruments_cache[0] < INSTRUMENTS_TTL:
            return _instruments_cache[1]

    disk = _load_instruments_disk()
    if disk is not None:
        with _cache_lock:
            _instruments_cache = (time.time(), disk)
        return disk

    try:
        _throttle()
        rows = _get_client().exchanges.get_instruments("HK")
    except Exception as exc:  # noqa: BLE001 - 上游异常一律转成业务错误
        raise HkDataError(f"拉取港股标的清单失败：{exc}") from exc

    items = [
        {"symbol": str(r.get("symbol") or ""), "name": str(r.get("name") or "")}
        for r in rows
        if r.get("symbol")
    ]
    items.sort(key=lambda x: x["symbol"])
    with _cache_lock:
        _instruments_cache = (time.time(), items)
    _write_json(_INSTRUMENTS_FILE, {"ts": time.time(), "items": items})
    return items


def search_instruments(query: str, limit: int = 30) -> dict[str, Any]:
    items = instruments()
    q = (query or "").strip()
    if not q:
        return {"total": len(items), "items": []}

    qu = q.upper()
    code_hits = [i for i in items if qu in i["symbol"]]
    name_hits = [i for i in items if q in i["name"]]
    seen: set[str] = set()
    merged: list[dict[str, str]] = []
    for item in code_hits + name_hits:
        if item["symbol"] in seen:
            continue
        seen.add(item["symbol"])
        merged.append(item)
        if len(merged) >= limit:
            break

    # 代码完全匹配的排最前，其次是代码前缀匹配（用户通常记得开头几位）
    merged.sort(key=lambda i: (not i["symbol"].startswith(qu), not i["symbol"].startswith("0" + qu.lstrip("0")), i["symbol"]))
    return {"total": len(items), "items": merged}


# ===== 日线 =====


def _load_bars_disk() -> dict[str, Any]:
    raw = _read_json(_BARS_FILE)
    return raw if isinstance(raw, dict) else {}


def _fetch_bars(symbol: str, count: int) -> list[dict[str, Any]]:
    _throttle()
    try:
        df = _get_client().klines.get(symbol, period="1d", count=count, as_dataframe=True)
    except Exception as exc:  # noqa: BLE001
        raise HkDataError(f"拉取 {symbol} 日线失败：{exc}") from exc

    if df is None or len(df) == 0:
        raise HkDataError(f"{symbol} 没有日线数据（退市或代码有误？）")

    rows: list[dict[str, Any]] = []
    for rec in df.to_dict("records"):
        close = rec.get("close")
        if close is None:
            continue
        rows.append(
            {
                "date": str(rec.get("trade_date") or ""),
                # 上游价格带复权因子，会出现 654.3759235040231 这种长尾，统一收敛到 3 位
                "open": round(float(rec.get("open") or 0.0), 3),
                "high": round(float(rec.get("high") or 0.0), 3),
                "low": round(float(rec.get("low") or 0.0), 3),
                "close": round(float(close), 3),
                "volume": float(rec.get("volume") or 0.0),
                "name": str(rec.get("name") or ""),
            }
        )
    if not rows:
        raise HkDataError(f"{symbol} 日线全为空值")
    return rows


def daily_bars(symbol: str, count: int = FETCH_BARS, *, force: bool = False) -> list[dict[str, Any]]:
    """日线（含指标）。内存 → 磁盘 → 上游。返回按日期升序的完整序列。"""
    symbol = normalize_symbol(symbol)

    with _cache_lock:
        hit = _bars_cache.get(symbol)
        if hit and not force and time.time() - hit[0] < BARS_TTL:
            return hit[1]

    disk = _load_bars_disk()
    entry = disk.get(symbol)
    if not force and isinstance(entry, dict) and time.time() - float(entry.get("ts") or 0) < BARS_TTL:
        bars = entry.get("bars")
        if isinstance(bars, list) and bars:
            with _cache_lock:
                _bars_cache[symbol] = (float(entry["ts"]), bars)
            return bars

    want = max(count, FETCH_BARS)
    bars = with_indicators(_fetch_bars(symbol, want))

    with _cache_lock:
        _bars_cache[symbol] = (time.time(), bars)
    disk = _load_bars_disk()
    disk[symbol] = {"ts": time.time(), "bars": bars}
    _write_json(_BARS_FILE, disk)
    return bars


# ===== 指标（纯 Python，不引 A 股指标管线）=====


def _sma(values: list[float], n: int) -> list[float | None]:
    out: list[float | None] = []
    total = 0.0
    for i, v in enumerate(values):
        total += v
        if i >= n:
            total -= values[i - n]
        out.append(total / n if i >= n - 1 else None)
    return out


def _ema_series(values: list[float], n: int) -> list[float]:
    alpha = 2.0 / (n + 1)
    out: list[float] = []
    prev: float | None = None
    for v in values:
        prev = v if prev is None else alpha * v + (1 - alpha) * prev
        out.append(prev)
    return out


def _round(v: float | None, digits: int = 3) -> float | None:
    return None if v is None else round(v, digits)


def with_indicators(bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """就地补齐 ma5/10/20/60、MACD(12,26,9)、RSI14 —— 字段名与前端 K 线组件对齐。"""
    closes = [b["close"] for b in bars]
    ma5, ma10, ma20, ma60 = (_sma(closes, n) for n in (5, 10, 20, 60))
    ema12, ema26 = _ema_series(closes, 12), _ema_series(closes, 26)
    dif = [a - b for a, b in zip(ema12, ema26)]
    dea = _ema_series(dif, 9)
    hist = [(d - e) * 2 for d, e in zip(dif, dea)]

    rsi: list[float | None] = [None] * len(closes)
    period = 14
    if len(closes) > period:
        gains = losses = 0.0
        for i in range(1, period + 1):
            delta = closes[i] - closes[i - 1]
            gains += max(delta, 0.0)
            losses += max(-delta, 0.0)
        avg_gain, avg_loss = gains / period, losses / period
        for i in range(period, len(closes)):
            if i > period:
                delta = closes[i] - closes[i - 1]
                avg_gain = (avg_gain * (period - 1) + max(delta, 0.0)) / period
                avg_loss = (avg_loss * (period - 1) + max(-delta, 0.0)) / period
            rsi[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)

    prev_close: float | None = None
    for i, bar in enumerate(bars):
        bar["ma5"] = _round(ma5[i], 2)
        bar["ma10"] = _round(ma10[i], 2)
        bar["ma20"] = _round(ma20[i], 2)
        bar["ma60"] = _round(ma60[i], 2)
        bar["macd_dif"] = _round(dif[i])
        bar["macd_dea"] = _round(dea[i])
        bar["macd_hist"] = _round(hist[i])
        bar["rsi_14"] = _round(rsi[i], 1)
        bar["pct"] = None if not prev_close else round((bar["close"] / prev_close - 1) * 100, 2)
        bar["turnover_est"] = round(bar["close"] * bar["volume"])
        prev_close = bar["close"]
    return bars


# ===== 概览 =====


def _change(closes: list[float], span: int) -> float | None:
    if len(closes) <= span or closes[-1 - span] == 0:
        return None
    return round((closes[-1] / closes[-1 - span] - 1) * 100, 2)


def quote(symbol: str) -> dict[str, Any]:
    """单只港股的最新一日概览 + 区间涨跌。"""
    symbol = normalize_symbol(symbol)
    bars = daily_bars(symbol)
    last = bars[-1]
    prev = bars[-2] if len(bars) > 1 else None
    closes = [b["close"] for b in bars]

    year = last["date"][:4]
    ytd_base = next((b["close"] for b in bars if b["date"].startswith(year)), None)
    window = bars[-250:]
    high_52w = max(b["high"] for b in window)
    low_52w = min(b["low"] for b in window)

    return {
        "symbol": symbol,
        "name": last.get("name") or symbol,
        "date": last["date"],
        "close": last["close"],
        "open": last["open"],
        "high": last["high"],
        "low": last["low"],
        "prev_close": prev["close"] if prev else None,        "pct": last["pct"],
        "amplitude": (
            round((last["high"] - last["low"]) / prev["close"] * 100, 2) if prev and prev["close"] else None
        ),
        "volume": last["volume"],
        "turnover_est": last["turnover_est"],
        "chg_5d": _change(closes, 5),
        "chg_20d": _change(closes, 20),
        "chg_60d": _change(closes, 60),
        "chg_ytd": round((last["close"] / ytd_base - 1) * 100, 2) if ytd_base else None,
        "high_52w": round(high_52w, 3),
        "low_52w": round(low_52w, 3),
        "ma5": last["ma5"],
        "ma10": last["ma10"],
        "ma20": last["ma20"],
        "ma60": last["ma60"],
        "rsi_14": last["rsi_14"],
        "macd_dif": last["macd_dif"],
        "macd_dea": last["macd_dea"],
        "macd_hist": last["macd_hist"],
        "bars": len(bars),
    }


def overview(symbols: list[str]) -> dict[str, Any]:
    """一篮子概览。上游限速是全局的，所以并发只用来摊平网络等待，不提速。"""
    cleaned: list[str] = []
    for s in symbols:
        try:
            cleaned.append(normalize_symbol(s))
        except HkDataError:
            continue
    if not cleaned:
        cleaned = list(DEFAULT_BASKET)

    def one(symbol: str) -> dict[str, Any] | None:
        try:
            return quote(symbol)
        except HkDataError as exc:
            logger.warning("hk_market overview 跳过 %s: %s", symbol, exc)
            return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = [r for r in pool.map(one, cleaned) if r]

    rows.sort(key=lambda r: cleaned.index(r["symbol"]))
    return {"items": rows, "failed": len(cleaned) - len(rows)}


def kline(symbol: str, count: int = 260) -> dict[str, Any]:
    symbol = normalize_symbol(symbol)
    bars = daily_bars(symbol)
    count = max(20, min(int(count), len(bars)))
    return {
        "symbol": symbol,
        "name": bars[-1].get("name") or symbol,
        "bars": bars[-count:],
        "total": len(bars),
    }
