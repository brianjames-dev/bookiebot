"""Authenticated same-origin Bills settings and monthly entry routes."""
from __future__ import annotations

import asyncio
import json
import logging
from aiohttp import web
from bookiebot.reports import bill_settings as service
from bookiebot.sheets.recurring import BillConflict, BillValidation
from bookiebot.reports.accounts import AccountConflict
from bookiebot.reports.bill_listing_cache import BillListingCache

logger = logging.getLogger(__name__)
_BILL_LISTINGS = web.AppKey('bookiebot_bill_listings',BillListingCache)


async def _close_listings(app: web.Application) -> None:
    await app[_BILL_LISTINGS].close()


async def _bills(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _session, _json, _same_origin_action
    if request.method != "GET" and not _same_origin_action(request):
        return _json({"error": "Make bill changes from BookieBot."}, status=403)
    try:
        session = await _session(request)
        if session is None:
            return _json({"error": "Reconnect BookieBot using /expense_app in Discord."}, status=401)
        actor = session.actor_key
        checkin = request.path.startswith('/app/bills/check-in')
        if request.method == "GET":
            if checkin:
                from bookiebot.reports import bill_checkin
                result = await asyncio.to_thread(bill_checkin.candidates, actor)
            elif "request_id" in request.match_info:
                result = await asyncio.to_thread(lambda: service.build_commands().saved(actor, request.match_info["request_id"]))
                if result is None:
                    return _json({"error": "No saved bill request was found."}, status=404)
            elif "id" in request.match_info:
                result = await asyncio.to_thread(service.charge_transaction, actor, request.match_info["id"], request.query.get("month", ""))
            else:
                from bookiebot.reports.shared_bills import enrich_listing
                from bookiebot.reports.phone_shared_bills import change_cursor
                for attempt in range(2):
                    cursor = await asyncio.to_thread(change_cursor,session.owner_key)
                    key = (actor,session.owner_key,service.now_pacific().date().isoformat(),cursor['revision'],cursor['ledgerVersion'])
                    result = await request.app[_BILL_LISTINGS].read(key,
                        lambda:enrich_listing(actor,service.listing(actor)),fresh=attempt>0 or request.query.get('fresh')=='1')
                    if cursor == await asyncio.to_thread(change_cursor,session.owner_key):
                        break
                else:
                    raise BillConflict('Shared bills changed while loading. Refresh Bills.')
                # Preferences, uncertain commands and recovery are never cached.
                from bookiebot.reports.bill_checkin import build_store, DEFAULT_LEAD_DAYS
                prefs = await asyncio.to_thread(lambda: build_store().preferences(session.owner_key))
                for bill in result.get('bills', []):
                    bill['checkInLeadDays'] = prefs.get(bill['id'], DEFAULT_LEAD_DAYS)
                pending = await asyncio.to_thread(lambda: service.build_commands().pending(session.owner_key))
                if pending:
                    result["pendingCommand"] = pending
                recover = getattr(service.build_commands(), 'recoverable_flow', None)
                if callable(recover):
                    flow = await asyncio.to_thread(recover, session.owner_key)
                    if flow:
                        result['pendingFlow'] = flow
        else:
            raw = bytearray()
            async for chunk in request.content.iter_chunked(1024):
                raw.extend(chunk)
                if len(raw) > 8192:
                    raise BillValidation("The bill request is too large.")
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise BillValidation("Choose a bill action.")
            if checkin:
                from bookiebot.reports import bill_checkin
                if request.path.endswith('/preferences'):
                    result = await asyncio.to_thread(bill_checkin.preference, actor, body)
                else:
                    if set(body) != {'action', 'token'} or body.get('action') not in {'claim', 'shown', 'release'}:
                        raise BillValidation('Choose a bill check-in action.')
                    checkin_now = bill_checkin.now_pacific()
                    eligible = await asyncio.to_thread(bill_checkin.candidates, actor, current=checkin_now) if body['action'] == 'claim' else {}
                    result = await asyncio.to_thread(lambda: bill_checkin.build_store().day(session.owner_key, body['token'], body['action'], checkin_now)) if body['action'] != 'claim' or eligible.get('bills') else {'day': checkin_now.strftime('%Y-%m-%d'), 'claimed': False, 'reason': 'no_bills'}
                    if result.get('claimed'):
                        result['bills'] = eligible['bills']
            else:
                result = {"review": await asyncio.to_thread(service.review, actor, body)} if request.path.endswith("/review") else await asyncio.to_thread(lambda: service.build_commands().command(actor, body))
        current = await _session(request)
        if current is None or (current.owner_key, current.actor_key) != (session.owner_key, session.actor_key):
            return _json({"error": "Reconnect BookieBot using /expense_app in Discord."}, status=401)
        if request.method == 'POST' and not checkin and not request.path.endswith('/review'):
            from bookiebot.reports.phone_shared_bills import publish_change
            await publish_change(session.owner_key)
        return _json(result)
    except (BillConflict, AccountConflict) as exc:
        return _json({"error": str(exc)}, status=409)
    except (ValueError, TypeError) as exc:
        return _json({"error": str(exc) if isinstance(exc, BillValidation) else "Invalid bill request."}, status=400)
    except Exception as exc:
        from bookiebot.reports.read_errors import report_read_failure
        logger.exception("Bills unavailable")
        return report_read_failure(exc, operation="refresh", message="Couldn't load or verify Bills. Check saved status before repeating a change.")


def register_phone_bill_routes(app: web.Application):
    app[_BILL_LISTINGS] = BillListingCache()
    app.on_cleanup.append(_close_listings)
    app.router.add_get("/app/bills", _bills)
    app.router.add_get("/app/bills/check-in", _bills)
    app.router.add_post("/app/bills/check-in", _bills)
    app.router.add_post("/app/bills/check-in/preferences", _bills)
    app.router.add_get("/app/bills/commands/{request_id}", _bills)
    app.router.add_get("/app/bills/{id}/charge", _bills)
    app.router.add_post("/app/bills/review", _bills)
    app.router.add_post("/app/bills", _bills)
