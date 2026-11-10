"""港股看板的 HTTP 面。仅读操作，全部挂在 /api/custom/hk-market 下。"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from . import service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/custom/hk-market", tags=["custom-hk-market"])


def _bad_symbol(exc: Exception) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


def _upstream(exc: Exception) -> HTTPException:
    logger.warning("hk_market upstream error: %s", exc)
    return HTTPException(status_code=502, detail=str(exc))


@router.get("/meta")
def meta() -> dict:
    """数据源能力说明，前端用来渲染页头提示与免责口径。"""
    return {
        "source": "TickFlow 免费层",
        "realtime": False,
        "minute_bars": False,
        "daily_bars": True,
        "turnover_is_estimate": True,
        "notes": [
            "行情为最近一个交易日收盘价，盘中不更新",
            "价格为前复权口径（已含分红拆股调整），与交易软件原始价可能有微小差异",
            "免费层不提供实时行情与分钟 K",
            "成交额按「收盘价 × 成交量」估算，仅供参考",
            "仅覆盖港股，与 A 股板块/策略/回测完全隔离",
        ],
        "default_basket": list(service.DEFAULT_BASKET),
    }


@router.get("/instruments")
def instruments(
    q: str = Query(default="", max_length=40, description="代码或名称片段"),
    limit: int = Query(default=30, ge=1, le=100),
) -> dict:
    try:
        return service.search_instruments(q, limit)
    except service.HkDataError as exc:
        raise _upstream(exc) from exc


@router.get("/quote")
def quote(symbol: str = Query(min_length=1, max_length=16)) -> dict:
    try:
        service.normalize_symbol(symbol)
    except service.HkDataError as exc:
        raise _bad_symbol(exc) from exc
    try:
        return service.quote(symbol)
    except service.HkDataError as exc:
        raise _upstream(exc) from exc


@router.get("/kline")
def kline(
    symbol: str = Query(min_length=1, max_length=16),
    count: int = Query(default=260, ge=20, le=500),
) -> dict:
    try:
        service.normalize_symbol(symbol)
    except service.HkDataError as exc:
        raise _bad_symbol(exc) from exc
    try:
        return service.kline(symbol, count)
    except service.HkDataError as exc:
        raise _upstream(exc) from exc


@router.get("/overview")
def overview(
    symbols: str = Query(default="", max_length=600, description="逗号分隔，空则用默认篮子"),
) -> dict:
    wanted = [s.strip() for s in symbols.split(",") if s.strip()] or list(service.DEFAULT_BASKET)
    if len(wanted) > 24:
        raise HTTPException(status_code=400, detail="一次最多 24 只")
    try:
        return service.overview(wanted)
    except service.HkDataError as exc:
        raise _upstream(exc) from exc


def build_router() -> APIRouter:
    return router
