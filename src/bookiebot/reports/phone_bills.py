"""Authenticated same-origin Bills settings and monthly entry routes."""
from __future__ import annotations

import asyncio
import json
import logging
from aiohttp import web
from bookiebot.reports import bill_settings as service
from bookiebot.sheets.recurring import BillConflict, BillValidation

logger = logging.getLogger(__name__)


async def _bills(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _session, _json, _same_origin_action
    if request.method != "GET" and not _same_origin_action(request):
        return _json({"error": "Make bill changes from BookieBot."}, status=403)
    try:
        session = await _session(request)
        if session is None:
            return _json({"error": "Reconnect BookieBot using /expense_app in Discord."}, status=401)
        actor = session.actor_key
        if request.method == "GET":
            if "request_id" in request.match_info:
                result = await asyncio.to_thread(lambda: service.build_commands().saved(actor, request.match_info["request_id"]))
                if result is None:
                    return _json({"error": "No saved bill request was found."}, status=404)
            elif "id" in request.match_info:
                result = await asyncio.to_thread(service.charge_transaction, actor, request.match_info["id"], request.query.get("month", ""))
            else:
                result = await asyncio.to_thread(service.listing, actor)
                pending = await asyncio.to_thread(lambda: service.build_commands().pending(session.owner_key))
                if pending:
                    result["pendingCommand"] = pending
        else:
            raw = bytearray()
            async for chunk in request.content.iter_chunked(1024):
                raw.extend(chunk)
                if len(raw) > 8192:
                    raise BillValidation("The bill request is too large.")
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise BillValidation("Choose a bill action.")
            result = {"review": await asyncio.to_thread(service.review, actor, body)} if request.path.endswith("/review") else await asyncio.to_thread(lambda: service.build_commands().command(actor, body))
        current = await _session(request)
        if current is None or (current.owner_key, current.actor_key) != (session.owner_key, session.actor_key):
            return _json({"error": "Reconnect BookieBot using /expense_app in Discord."}, status=401)
        return _json(result)
    except BillConflict as exc:
        return _json({"error": str(exc)}, status=409)
    except (ValueError, TypeError) as exc:
        return _json({"error": str(exc) if isinstance(exc, BillValidation) else "Invalid bill request."}, status=400)
    except Exception as exc:
        from bookiebot.reports.read_errors import report_read_failure
        logger.exception("Bills unavailable")
        return report_read_failure(exc, operation="refresh", message="Couldn't load or verify Bills. Check saved status before repeating a change.")


def register_phone_bill_routes(app: web.Application):
    app.router.add_get("/app/bills", _bills)
    app.router.add_get("/app/bills/commands/{request_id}", _bills)
    app.router.add_get("/app/bills/{id}/charge", _bills)
    app.router.add_post("/app/bills/review", _bills)
    app.router.add_post("/app/bills", _bills)
