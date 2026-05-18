from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from aiohttp import web

from bookiebot.core.bank_link import create_bank_link_app

logger = logging.getLogger(__name__)

_WEB_SERVER_TASK: asyncio.Task | None = None


async def run_web_server() -> None:
    app = create_bank_link_app()
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.getenv("PORT", "8080"))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    logger.info("BookieBot web server started", extra={"port": port})
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


def ensure_web_server(_client: Any = None) -> asyncio.Task | None:
    global _WEB_SERVER_TASK
    if _WEB_SERVER_TASK is None or _WEB_SERVER_TASK.done():
        _WEB_SERVER_TASK = asyncio.create_task(run_web_server())
    return _WEB_SERVER_TASK
