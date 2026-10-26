"""Private recorded-transaction reads and separately reviewed financial commands."""
from __future__ import annotations

import asyncio
import json
import logging
from aiohttp import web

from bookiebot.reports import transactions as service

logger = logging.getLogger(__name__)


async def _transactions(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _session, _json, _same_origin_action
    if request.method != "GET" and not _same_origin_action(request):
        return _json({"error": "Make transaction changes from BookieBot."}, status=403)
    try:
        session = await _session(request)
        if session is None:
            return _json({"error": "Reconnect BookieBot using /expense_app in Discord."}, status=401)
        if request.method == "GET":
            if "request_id" in request.match_info:
                result = await asyncio.to_thread(lambda: service.build_transaction_commands().saved(session.owner_key, request.match_info["request_id"]))
                if result is None:
                    return _json({"error": "No saved request was found."}, status=404)
            else:
                result = await asyncio.to_thread(service.listing, session.actor_key, dict(request.query))
                result.update(await asyncio.to_thread(lambda: service.build_transaction_commands().overview(session.owner_key, result["month"])))
        else:
            raw = bytearray()
            async for chunk in request.content.iter_chunked(1024):
                raw.extend(chunk)
                if len(raw) > 8192:
                    raise service.TransactionValidation("The transaction request is too large.")
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise service.TransactionValidation("Choose a transaction action.")
            if request.path.endswith("/review"):
                result = (await asyncio.to_thread(service.review, session.actor_key, body))["review"]
                result = {"review": result}
            else:
                result = await asyncio.to_thread(lambda: service.build_transaction_commands().command(session.actor_key, body))
        current = await _session(request)
        if current is None or current.owner_key != session.owner_key or current.actor_key != session.actor_key:
            return _json({"error": "Reconnect BookieBot using /expense_app in Discord."}, status=401)
        return _json(result)
    except service.TransactionConflict as exc:
        return _json({"error": str(exc)}, status=409)
    except (ValueError, TypeError) as exc:
        return _json({"error": str(exc) if isinstance(exc, service.TransactionValidation) else "Invalid transaction request."}, status=400)
    except Exception as exc:
        from bookiebot.reports.read_errors import report_read_failure
        logger.exception("Transactions unavailable")
        return report_read_failure(exc, operation="refresh", message="Couldn't load or verify transactions. Check the saved status before repeating a change.")


def register_phone_transaction_routes(app: web.Application) -> None:
    app.router.add_get("/app/transactions", _transactions)
    app.router.add_post("/app/transactions/review", _transactions)
    app.router.add_post("/app/transactions", _transactions)
    app.router.add_get("/app/transactions/commands/{request_id}", _transactions)
