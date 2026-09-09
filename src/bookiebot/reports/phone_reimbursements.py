"""Authenticated reimbursement commands; recording payments never transfers money."""
from __future__ import annotations

import asyncio
import json
import logging
from aiohttp import web

from bookiebot.reimbursements import service
from bookiebot.reimbursements.store import ReimbursementConflictError, ReimbursementNotFoundError, ReimbursementValidationError

logger = logging.getLogger(__name__)


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
            result = await asyncio.to_thread(service.snapshot, session.owner_key, retry_projection=True)
        current = await _session(request)
        if current is None or current.owner_key != session.owner_key:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
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
    app.router.add_get("/app/reimbursements", _reimbursements)
    app.router.add_post("/app/reimbursements", _reimbursements)
