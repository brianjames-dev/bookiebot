"""Google OIDC login/linking and private app account metadata.

Only Google `sub` binds an identity. Codes/tokens never reach logs, storage,
URLs after callback, or the browser app. Existing phone pairing stays usable.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import secrets
from typing import Any
from urllib.parse import urlencode

from aiohttp import ClientSession, ClientTimeout, web

from bookiebot.reports.accounts import AUTH_TTL, AccountConflict, account_store
from bookiebot.reports.app_access import SESSION_TTL_SECONDS

logger = logging.getLogger(__name__)


def _config() -> tuple[str, str]:
    return os.getenv('GOOGLE_OAUTH_CLIENT_ID', '').strip(), os.getenv('GOOGLE_OAUTH_CLIENT_SECRET', '').strip()


def _flow_cookie() -> str:
    from bookiebot.reports.phone_app import _local_origin
    return 'bb_google_local' if _local_origin() else '__Host-bb_google'


def _validate_actor(actor: str, owner: str) -> None:
    from bookiebot.reports.phone_app import _owner_for_actor
    if _owner_for_actor(actor).budget_owner_key != owner:
        raise AccountConflict('Your BookieBot workbook connection changed. Reconnect this account.')


def _store():
    # Use the same access factory as every phone route (including isolated tests).
    from bookiebot.reports.phone_app import build_app_access_store
    return account_store(build_app_access_store())


async def _options(_request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json
    client, secret = _config()
    return _json({'googleEnabled': bool(client and secret)})


async def _profile(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json
    authenticated = await account_session(request)
    if authenticated is None:
        return _json({'error': 'Sign in to BookieBot.'}, status=401)
    session, account = authenticated
    try:
        def read():
            store = _store()
            return store.profile(account)
        result = await asyncio.to_thread(read)
        if await account_session(request) != authenticated:
            return _json({'error': 'Sign in to BookieBot.'}, status=401)
        result['googleEnabled'] = all(_config())
        return _json(result)
    except Exception:
        logger.warning('BookieBot account metadata unavailable')
        return _json({'error': "Couldn't load your account. Try again."}, status=503)


async def _start(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import (
        _base_url, _cookie_name, _json, _local_origin, _require_app_origin,
        _same_origin_action, _session, _valid_owner,
    )
    if not _same_origin_action(request):
        return _json({'error': 'Start sign-in from BookieBot.'}, status=403)
    client, secret = _config()
    if not client or not secret:
        return _json({'error': 'Google sign-in is not configured yet. Your existing app access still works.'}, status=503)
    try:
        _require_app_origin()
        raw = bytearray()
        async for chunk in request.content.iter_chunked(1024):
            raw.extend(chunk)
            if len(raw) > 1024:
                raise ValueError('Invalid sign-in request.')
        body = json.loads(raw)
        if not isinstance(body, dict) or set(body) != {'action'} or body['action'] not in {'login', 'link'}:
            raise ValueError('Choose sign in or link Google.')
        session = await _session(request)
        if body['action'] == 'link' and session is None:
            return _json({'error': 'Reconnect BookieBot before linking Google.'}, status=401)
        browser = secrets.token_urlsafe(32)
        def prepare():
            store = _store()
            account = store.for_session(session, _valid_owner(session).name) if session and body['action'] == 'link' else None
            return store.start(browser, account=account, session_token=request.cookies.get(_cookie_name(), ''))
        flow = await asyncio.to_thread(prepare)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(flow['verifier'].encode()).digest()).rstrip(b'=').decode()
        query = urlencode({'client_id': client, 'redirect_uri': _base_url() + '/app/auth/google/callback',
            'response_type': 'code', 'scope': 'openid email profile', 'state': flow['state'],
            'nonce': flow['nonce'], 'code_challenge': challenge, 'code_challenge_method': 'S256',
            'prompt': 'select_account'})
        response = _json({'url': 'https://accounts.google.com/o/oauth2/v2/auth?' + query})
        response.set_cookie(_flow_cookie(), browser, max_age=AUTH_TTL, secure=not _local_origin(),
                            httponly=True, samesite='Lax', path='/')
        return response
    except (ValueError, AccountConflict):
        return _json({'error': 'Could not start sign-in. Refresh BookieBot and try again.'}, status=400)
    except Exception:
        logger.warning('Google sign-in start unavailable')
        return _json({'error': 'Sign-in is temporarily unavailable. Try again.'}, status=503)


async def _exchange(code: str, verifier: str, redirect: str, client: str, secret: str) -> str:
    async with ClientSession(timeout=ClientTimeout(total=12)) as http:
        async with http.post('https://oauth2.googleapis.com/token', data={
            'grant_type': 'authorization_code', 'code': code, 'client_id': client,
            'client_secret': secret, 'redirect_uri': redirect, 'code_verifier': verifier,
        }, allow_redirects=False) as response:
            # Never include the provider body in errors/logs.
            if response.status != 200:
                raise ValueError('Google sign-in was not completed.')
            raw = bytearray()
            async for chunk in response.content.iter_chunked(8192):
                raw.extend(chunk)
                if len(raw) > 65536:
                    raise ValueError('Invalid Google response.')
            result = json.loads(raw)
            token = result.get('id_token') if isinstance(result, dict) else None
            if not isinstance(token, str) or not token or len(token) > 16384:
                raise ValueError('Invalid Google response.')
            return token


def _verify(token: str, client: str, nonce: str) -> dict[str, Any]:
    from google.auth.transport.requests import Request
    from google.oauth2.id_token import verify_oauth2_token

    transport = Request()
    def bounded_request(url, method='GET', body=None, headers=None, **_kwargs):
        return transport(url, method=method, body=body, headers=headers, timeout=10)
    claims = verify_oauth2_token(token, bounded_request, audience=client, clock_skew_in_seconds=30)
    subject, email = claims.get('sub'), claims.get('email')
    if (not isinstance(subject, str) or not subject or len(subject) > 255
            or not isinstance(email, str) or len(email) > 320 or claims.get('email_verified') is not True
            or claims.get('nonce') != nonce
            or claims.get('azp', client) != client):
        raise ValueError('Invalid Google identity.')
    return {'subject': subject, 'email': email, 'name': claims.get('name', '') if isinstance(claims.get('name', ''), str) else ''}


async def _callback(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _base_url, _cookie_name, _local_origin, _PRIVATE_HEADERS
    status = 'failed'
    token = None
    try:
        state, browser = request.query.get('state', ''), request.cookies.get(_flow_cookie(), '')
        flow = await asyncio.to_thread(lambda: _store().consume(state, browser))
        if flow is None:
            raise ValueError('Expired sign-in.')
        client, secret = _config()
        if not client or not secret or request.query.get('error'):
            raise ValueError('Sign-in cancelled or unavailable.')
        code = request.query.get('code', '')
        if not code or len(code) > 4096:
            raise ValueError('Invalid code.')
        id_token = await _exchange(code, flow['verifier'], _base_url() + '/app/auth/google/callback', client, secret)
        claims = await asyncio.to_thread(_verify, id_token, client, flow['nonce'])
        token, _ = await asyncio.to_thread(lambda: _store().complete(flow, **claims,
            session_token=request.cookies.get(_cookie_name(), ''), validate_actor=_validate_actor, enroll=True))
        status = 'linked' if flow['user_id'] else 'signed-in'
    except AccountConflict:
        status = 'link-required'
    except Exception:
        # Codes, state, JWTs, provider errors and exception contents are secret.
        logger.warning('Google sign-in did not complete')
    response = web.Response(status=303, headers={**_PRIVATE_HEADERS, 'Location': '/app/expenses?auth=' + status})
    response.del_cookie(_flow_cookie(), path='/', secure=not _local_origin(), httponly=True, samesite='Lax')
    if token:
        response.set_cookie(_cookie_name(), token, max_age=SESSION_TTL_SECONDS,
                            secure=not _local_origin(), httponly=True, samesite='Lax', path='/')
    return response


def register_phone_account_routes(app: web.Application) -> None:
    app.router.add_get('/app/auth/options', _options)
    app.router.add_get('/app/account', _profile)
    app.router.add_post('/app/auth/google/start', _start)
    app.router.add_get('/app/auth/google/callback', _callback)


async def account_session(request: web.Request):
    """Identity authentication, including setup-only managed sessions.

    Financial Sheets routes deliberately continue using phone_app._session;
    a managed identity is never a valid legacy workbook adapter.
    """
    from bookiebot.reports.phone_app import _cookie_name, _valid_owner, build_app_access_store
    token = request.cookies.get(_cookie_name(), '')
    if not token or len(token) > 128:
        return None
    def read():
        access = build_app_access_store()
        session = access.get_session(token)
        if session is None:
            return None
        store = account_store(access)
        if session.owner_key.startswith('managed:'):
            account = store.from_session(session)
            if (account is None or account.owner != 'managed:' + account.id
                    or account.actor != 'app:' + account.id):
                return None
        else:
            try:
                account = store.for_session(session, _valid_owner(session).name)
            except (ValueError, RuntimeError):
                return None
        return session, account
    return await asyncio.to_thread(read)
