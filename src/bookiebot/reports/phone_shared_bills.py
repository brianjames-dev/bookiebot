"""Membership-only reviews; all financial writers remain in their own flows."""
from __future__ import annotations

import asyncio
import json
import hashlib
import logging
from typing import Any
from aiohttp import web

from bookiebot.reports import shared_bills
from bookiebot.reports.accounts import AccountConflict

logger = logging.getLogger(__name__)


def change_cursor(owner: str) -> dict[str, Any]:
    revision = shared_bills.build_store().revision(owner)
    from bookiebot.reimbursements import service
    ledger_version = ''
    if service.enabled():
        # Canonical-only reads also catch background receipts without a
        # membership write. Do not project or read Sheets to check freshness.
        ledger = service.build_reimbursement_store().snapshot(owner)
        values = sorted((a['id'],a['version'],a.get('projectedVersion',0)) for a in ledger['allocations'])
        resets = sorted((r['id'],r['version'],r['status']) for r in ledger.get('resets',[]))
        events = sorted((e['id'],e['status'],e.get('confirmedAt',''),e.get('reversedAt','')) for e in ledger.get('events',[]))
        ledger_version = hashlib.sha256(json.dumps([values,resets,events],sort_keys=True).encode()).hexdigest()
    return {'revision':revision,'ledgerVersion':ledger_version}


async def _changes(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json, _session
    session = await _session(request)
    if session is None:
        return _json({'error':'Sign in to BookieBot.'},status=401)
    try:
        result = await asyncio.to_thread(change_cursor,session.owner_key)
        if await _session(request) != session:
            return _json({'error':'Sign in to BookieBot.'},status=401)
        return _json(result)
    except Exception:
        return _json({'error':'Could not check shared updates.'},status=503)


async def _sharing(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json, _same_origin_action, _session, _cookie_name
    if request.method != 'GET' and not _same_origin_action(request):
        return _json({'error':'Manage shared bills from BookieBot.'},status=403)
    session = await _session(request)
    if session is None:
        return _json({'error':'Sign in to BookieBot.'},status=401)
    try:
        if request.method == 'GET':
            def recover():
                store = shared_bills.build_store()
                return store.recover(request.match_info['request_id'], shared_bills.account_for(session.actor_key,store=store))
            result = await asyncio.to_thread(recover)
            if await _session(request) != session:
                return _json({'error':'Sign in to BookieBot.'},status=401)
            return _json(result) if result is not None else _json({'error':'No saved sharing result yet.'},status=404)
        raw = bytearray()
        async for chunk in request.content.iter_chunked(1024):
            raw.extend(chunk)
            if len(raw) > 4096:
                raise AccountConflict('This bill-sharing request is too large.')
        body=json.loads(raw)
        if not isinstance(body,dict):
            raise AccountConflict('Choose a bill-sharing action.')
        if request.path.endswith('/review'):
            result={'review':shared_bills.public_review(await asyncio.to_thread(shared_bills.review,session.actor_key,body))}
        else:
            result=await asyncio.to_thread(shared_bills.command,session.actor_key,body,
                session_token=request.cookies.get(_cookie_name(),''))
        if await _session(request) != session:
            return _json({'error':'Sign in to BookieBot.'},status=401)
        return _json(result)
    except AccountConflict as exc:
        return _json({'error':str(exc),'notApplied':True},status=409)
    except (ValueError,TypeError):
        return _json({'error':'Invalid bill-sharing request.','notApplied':True},status=400)
    except Exception:
        logger.warning('Shared bill request needs a fresh read or original-request recovery')
        return _json({'error':'Could not verify this sharing change. Check its status before trying again.'},status=503)


async def publish_change(owner: str) -> None:
    try:
        await asyncio.to_thread(lambda: shared_bills.build_store().publish(owner))
    except Exception:
        # A failed refresh hint must never turn a successful financial mutation
        # into a false failure or encourage a second write. Focus/pull refresh
        # still reads authoritative data even without this optimization.
        logger.warning('Shared refresh hint unavailable')


def register_shared_bill_routes(app: web.Application) -> None:
    app.router.add_get('/app/account/changes',_changes)
    app.router.add_post('/app/bills/sharing/review',_sharing)
    app.router.add_post('/app/bills/sharing',_sharing)
    app.router.add_get('/app/bills/sharing/commands/{request_id}',_sharing)
