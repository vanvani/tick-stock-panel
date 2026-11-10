"""港股只读看板扩展。

刻意不接入 A 股核心链路（代码规范 / 交易日历 / 涨跌停 / 撮合都不复用），
只做一件事：把 TickFlow 免费层的港股日线取回来，算好指标给前端看。

放在 app/custom/ 下，由扩展加载器自动发现；删掉这个目录即彻底卸载。
"""

from app.extensions import BACKEND_EXTENSION_API_VERSION, BackendExtensionRegistrar

EXTENSION_ID = "custom.hk-market"
EXTENSION_API_VERSION = BACKEND_EXTENSION_API_VERSION


def setup(registrar: BackendExtensionRegistrar) -> None:
    from .routes import build_router

    registrar.include_router(build_router())
