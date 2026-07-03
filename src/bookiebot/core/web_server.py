from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from aiohttp import web

from bookiebot.core.bank_link import create_bank_link_app
from bookiebot.banking.service import build_banking_service
from bookiebot.reports.web import register_report_routes

logger = logging.getLogger(__name__)

_WEB_SERVER_TASK: asyncio.Task | None = None
_PLAID_WEBHOOK_WORKER_TASK: asyncio.Task | None = None


def _webhook_poll_interval_seconds() -> int:
    raw = os.getenv("BOOKIEBOT_PLAID_WEBHOOK_POLL_SECONDS", "30").strip()
    try:
        return max(5, int(raw))
    except ValueError:
        return 30


async def run_plaid_webhook_worker() -> None:
    while True:
        try:
            service = build_banking_service()
            result = await service.process_plaid_webhook_inbox(limit=25)
            if result["processed"] or result["failed"] or result["skipped"]:
                logger.info("Processed Plaid webhook inbox", extra=result)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Plaid webhook inbox worker failed")
        await asyncio.sleep(_webhook_poll_interval_seconds())


async def run_web_server() -> None:
    global _PLAID_WEBHOOK_WORKER_TASK
    app = create_bank_link_app()
    register_report_routes(app)
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.getenv("PORT", "8080"))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    if _PLAID_WEBHOOK_WORKER_TASK is None or _PLAID_WEBHOOK_WORKER_TASK.done():
        _PLAID_WEBHOOK_WORKER_TASK = asyncio.create_task(run_plaid_webhook_worker())
    logger.info("BookieBot web server started", extra={"port": port})
    try:
        await asyncio.Event().wait()
    finally:
        if _PLAID_WEBHOOK_WORKER_TASK is not None:
            _PLAID_WEBHOOK_WORKER_TASK.cancel()
        await runner.cleanup()


def ensure_web_server(_client: Any = None) -> asyncio.Task | None:
    global _WEB_SERVER_TASK
    if _WEB_SERVER_TASK is None or _WEB_SERVER_TASK.done():
        _WEB_SERVER_TASK = asyncio.create_task(run_web_server())
    return _WEB_SERVER_TASK
