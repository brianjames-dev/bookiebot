"""Same-origin transfer configuration; owner identity always comes from session."""
from __future__ import annotations

import asyncio
import json
import logging
from aiohttp import web

from bookiebot.reports import savings_transfers as service
from bookiebot.sheets.recurring import BillConflict, BillValidation

logger = logging.getLogger(__name__)


async def _transfers(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _session, _json, _same_origin_action
    from bookiebot.reports.bill_settings import build_commands, review
    if request.method != 'GET' and not _same_origin_action(request):
        return _json({'error': 'Make transfer changes from BookieBot.'}, status=403)
    try:
        session = await _session(request)
        if session is None:
            return _json({'error': 'Reconnect BookieBot using /expense_app in Discord.'}, status=401)
        if request.method == 'GET':
            if 'request_id' in request.match_info:
                result = await asyncio.to_thread(lambda: build_commands().saved(session.actor_key, request.match_info['request_id']))
                if result is None:
                    return _json({'error': 'No saved transfer request was found.'}, status=404)
            else:
                result = await asyncio.to_thread(service.listing, session.actor_key)
                pending = await asyncio.to_thread(lambda: build_commands().pending(session.owner_key))
                if pending:
                    if pending.get('operation') in service.OPERATIONS:
                        result['pendingCommand'] = pending
                    else:
                        result['blockedReason'] = 'Finish checking your previous Bills change before editing transfers.'
        else:
            raw = bytearray()
            async for chunk in request.content.iter_chunked(1024):
                raw.extend(chunk)
                if len(raw) > 4096:
                    raise BillValidation('The transfer request is too large.')
            body = json.loads(raw)
            if not isinstance(body, dict) or body.get('operation') not in service.OPERATIONS:
                raise BillValidation('Choose a transfer action.')
            if request.path.endswith('/review'):
                result = {'review': await asyncio.to_thread(review, session.actor_key, body)}
            else:
                result = await asyncio.to_thread(lambda: build_commands().command(session.actor_key, body))
        current = await _session(request)
        if current is None or (current.owner_key, current.actor_key) != (session.owner_key, session.actor_key):
            return _json({'error': 'Reconnect BookieBot using /expense_app in Discord.'}, status=401)
        return _json(result)
    except BillConflict as exc:
        return _json({'error': str(exc)}, status=409)
    except (ValueError, TypeError) as exc:
        return _json({'error': str(exc) if isinstance(exc, BillValidation) else 'Invalid transfer request.'}, status=400)
    except Exception:
        logger.exception('Savings transfers unavailable')
        return _json({'error': 'Could not verify transfers. Check saved status before repeating a change.'}, status=503)


def register_phone_transfer_routes(app: web.Application):
    app.router.add_get('/app/transfers', _transfers)
    app.router.add_get('/app/transfers/commands/{request_id}', _transfers)
    app.router.add_post('/app/transfers/review', _transfers)
    app.router.add_post('/app/transfers', _transfers)
