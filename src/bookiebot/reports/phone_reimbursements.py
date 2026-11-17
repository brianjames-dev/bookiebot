"""Authenticated reimbursement commands; recording payments never transfers money."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from aiohttp import web

from bookiebot.reimbursements import service
from bookiebot.reimbursements.store import ReimbursementConflictError, ReimbursementNotFoundError, ReimbursementValidationError

logger = logging.getLogger(__name__)


class _UndoRecovery:
    """Coalesce background work; failed projections back off instead of looping."""
    def __init__(self):
        self.task: asyncio.Task | None = None
        self.attempted: dict[str, float] = {}

    def start(self, jobs: list[dict]) -> None:
        queued = [job for job in jobs if job["status"] == "queued"]
        if not queued or self.task is not None and not self.task.done():
            return
        now = time.monotonic()
        if all(now - self.attempted.get(job["id"], -60) < 30 for job in queued):
            return
        self.attempted = {job["id"]: now for job in queued}
        self.task = asyncio.create_task(self.run(queued))

    async def run(self, jobs: list[dict]) -> None:
        from bookiebot.reports.phone_shared_bills import publish_change
        try:
            for delay in (0, 5, 30):
                if delay:
                    await asyncio.sleep(delay)
                self.attempted.update({job["id"]: time.monotonic() for job in jobs})
                try:
                    result = await asyncio.to_thread(service.recover_queued_undos)
                except Exception:
                    logger.exception("Queued reimbursement Undo remains recoverable")
                    continue
                await publish_change(jobs[0]["actorOwner"])
                jobs = result["pending"]
                if not jobs:
                    break
        except asyncio.CancelledError:
            raise

    async def close(self) -> None:
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)


_UNDO_RECOVERY = web.AppKey("bookiebot_reimbursement_undo_recovery", _UndoRecovery)


async def _resume_undo_jobs(app: web.Application) -> None:
    if not service.enabled():
        return
    try:
        jobs = await asyncio.to_thread(lambda: service.build_reimbursement_store().pending_undo_jobs())
        app[_UNDO_RECOVERY].start(jobs)
    except Exception:
        logger.warning("Queued reimbursement Undo will resume on the next refresh")


async def _close_undo_jobs(app: web.Application) -> None:
    await app[_UNDO_RECOVERY].close()



async def _reimbursements(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json, _same_origin_action, _session
    if request.method != "GET" and not _same_origin_action(request):
        return _json({"error": "Make reimbursement changes from BookieBot."}, status=403)
    try:
        session = await _session(request)
        if session is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        if not service.enabled():
            return _json({"enabled": False})
        if request.method == "POST":
            raw = bytearray()
            async for chunk in request.content.iter_chunked(1024):
                raw.extend(chunk)
                if len(raw) > 16_384:
                    raise ReimbursementValidationError("The settlement request is too large.")
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ReimbursementValidationError("Invalid settlement request.")
            result = await asyncio.to_thread(service.command, session.owner_key, body)
        else:
            result = await asyncio.to_thread(service.snapshot, session.owner_key,
                                            retry_projection=request.query.get("snapshot") != "1")
        current = await _session(request)
        if current is None or current.owner_key != session.owner_key:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        if request.method == 'POST':
            from bookiebot.reports.phone_shared_bills import publish_change
            await publish_change(session.owner_key)
        request.app[_UNDO_RECOVERY].start(result.get("undoJobs", []))
        return _json(result)
    except ReimbursementNotFoundError as exc:
        return _json({"error": str(exc)}, status=404)
    except ReimbursementConflictError as exc:
        return _json({"error": str(exc)}, status=409)
    except (ReimbursementValidationError, ValueError, TypeError) as exc:
        return _json({"error": str(exc) if isinstance(exc, ReimbursementValidationError) else "Invalid settlement request."}, status=400)
    except Exception:
        logger.exception("Reimbursement request is unavailable or its outcome needs recovery")
        return _json({"error": "Couldn't verify this request. Retry the same action to check it safely."}, status=503)


def register_phone_reimbursement_routes(app: web.Application) -> None:
    app[_UNDO_RECOVERY] = _UndoRecovery()
    app.on_startup.append(_resume_undo_jobs)
    app.on_cleanup.append(_close_undo_jobs)
    app.router.add_get("/app/reimbursements", _reimbursements)
    app.router.add_post("/app/reimbursements", _reimbursements)
