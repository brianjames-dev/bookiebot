"""Google-first bootstrap and managed budgets, isolated from legacy routes."""
from __future__ import annotations

import asyncio
import json
import logging
from aiohttp import web

from bookiebot.reports.managed_budget import BudgetConflict, managed_store, _today
from bookiebot.reports.phone_accounts import _store, account_session

logger = logging.getLogger(__name__)


async def _bootstrap(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json
    try:
        authenticated = await account_session(request)
        if authenticated is None:
            return _json({'phase': 'signed-out'}, status=401)
        _, account = authenticated
        if account.owner.startswith('managed:'):
            value = await asyncio.to_thread(lambda: managed_store(_store()).bootstrap(account))
        else:
            value = {'phase': 'ready', 'provider': 'sheets', 'account': {'id': account.id, 'name': account.name}}
        if await account_session(request) != authenticated:
            return _json({'phase': 'signed-out'}, status=401)
        return _json(value)
    except Exception:
        logger.warning('Account bootstrap unavailable')
        return _json({'error': 'Could not open your account. Please try again.'}, status=503)


async def _managed(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _cookie_name, _json, _same_origin_action
    if request.method != 'GET' and not _same_origin_action(request):
        return _json({'error': 'Make budget changes from BookieBot.'}, status=403)
    try:
        authenticated = await account_session(request)
        if authenticated is None:
            return _json({'error': 'Sign in to BookieBot.'}, status=401)
        _, account = authenticated
        household_api = request.path.startswith('/app/household')
        if not account.owner.startswith('managed:') and not household_api:
            return _json({'error': 'Continue using your existing connected budget.'}, status=409)
        store = managed_store(_store())
        if request.method == 'GET':
            if 'review_id' in request.match_info:
                value = await asyncio.to_thread(store.household_recover if household_api else store.recover, account, request.match_info['review_id'])
            elif household_api:
                value = await asyncio.to_thread(store.household, account)
            else:
                month = request.query.get('month', _today().strftime('%Y-%m'))
                value = await asyncio.to_thread(store.state, account, month)
        else:
            raw = bytearray()
            async for chunk in request.content.iter_chunked(1024):
                raw.extend(chunk)
                if len(raw) > 8192:
                    return _json({'error': 'This budget request is too large.'}, status=400)
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError()
            if body.get('accountId', account.id) != account.id:
                return _json({'error': 'Your account changed. Reopen BookieBot before making changes.'}, status=409)
            token = request.cookies.get(_cookie_name(), '')
            action = request.match_info['action']
            if action == 'review':
                value = await asyncio.to_thread(lambda: (store.household_review if household_api else store.prepare)(account, body, session_token=token))
            elif action == 'confirm' and {'reviewId'} <= set(body) <= {'reviewId', 'accountId'} and isinstance(body['reviewId'], str):
                value = await asyncio.to_thread(lambda: (store.household_confirm if household_api else store.confirm)(account, body['reviewId'], session_token=token))
            elif action == 'invite' and set(body) <= {'accountId'}:
                value = await asyncio.to_thread(lambda: store.issue_invite(account, session_token=token))
            else:
                raise ValueError()
        current = await account_session(request)
        if current is None or current[0] != authenticated[0]:
            return _json({'error': 'Your session changed. Sign in again.'}, status=401)
        return _json(value)
    except BudgetConflict as exc:
        return _json({'error': str(exc)}, status=409)
    except (ValueError, TypeError):
        return _json({'error': 'Invalid budget request.'}, status=400)
    except Exception:
        logger.warning('Managed budget request unavailable')
        return _json({'error': 'Your budget is temporarily unavailable. Try again.'}, status=503)


def register_onboarding_routes(app: web.Application) -> None:
    app.router.add_get('/app/bootstrap', _bootstrap)
    app.router.add_get('/app/budget', _managed)
    app.router.add_get('/app/budget/reviews/{review_id:[a-f0-9]{32}}', _managed)
    app.router.add_post('/app/budget/{action:review|confirm|invite}', _managed)
    app.router.add_get('/app/household', _managed)
    app.router.add_get('/app/household/reviews/{review_id:[a-f0-9]{32}}', _managed)
    app.router.add_post('/app/household/{action:review|confirm|invite}', _managed)
