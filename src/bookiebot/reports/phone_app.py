"""Personal Home Screen access, independent of expiring shared report URLs."""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import web

from bookiebot.reports.app_access import AppSession, SESSION_TTL_SECONDS, build_app_access_store
from bookiebot.reports.scope import default_expense_report_persons
from bookiebot.reports.phone_version import app_version, frontend_version
from bookiebot.sheets.routing import APPLE_SHORTCUT_RELAY_USER_ID, get_user_config, now_pacific

logger = logging.getLogger(__name__)
_ASSETS = Path(__file__).with_name("assets")
_AVATAR = Path(__file__).resolve().parents[3] / "assets" / "avatars" / "avatar1.PNG"
_PRIVATE_HEADERS = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
}


def _base_url() -> str:
    from bookiebot.reports.web import public_base_url
    return public_base_url()


def _local_origin() -> bool:
    return urlsplit(_base_url()).hostname in {"localhost", "127.0.0.1", "::1"}


def _require_app_origin() -> None:
    parsed = urlsplit(_base_url())
    if not parsed.hostname or (parsed.scheme != "https" and not _local_origin()):
        raise ValueError("A public HTTPS URL is required for phone access.")


def _cookie_name() -> str:
    return "bb_phone_local" if _local_origin() else "__Host-bb_phone"


def _owner_for_actor(actor_key: str):
    if not actor_key.isdecimal() or actor_key == APPLE_SHORTCUT_RELAY_USER_ID:
        raise ValueError("Phone setup requires your mapped Discord account.")
    return get_user_config(actor_key)


def create_phone_setup_url(actor_key: str) -> str:
    _require_app_origin()
    owner = _owner_for_actor(actor_key)
    token = build_app_access_store().issue_pairing(actor_key, owner.budget_owner_key)
    # Fragments never reach request logs, referrers, or Discord link previews.
    return f"{_base_url()}/app/connect#{token}"


def reset_phone_access(actor_key: str) -> None:
    owner = _owner_for_actor(actor_key)
    build_app_access_store().revoke_owner(owner.budget_owner_key)


def _valid_owner(session: AppSession):
    owner = _owner_for_actor(session.actor_key)
    if owner.budget_owner_key != session.owner_key:
        raise ValueError("The phone's account mapping changed.")
    return owner


async def _session(request: web.Request) -> AppSession | None:
    token = request.cookies.get(_cookie_name(), "")
    if not token or len(token) > 128:
        return None
    session = await asyncio.to_thread(lambda: build_app_access_store().get_session(token))
    if session is not None:
        try:
            _valid_owner(session)
        except (ValueError, RuntimeError):
            return None
    return session


def _json(payload: dict, *, status: int = 200) -> web.Response:
    return web.json_response(payload, status=status, headers=_PRIVATE_HEADERS)


def _same_origin_action(request: web.Request) -> bool:
    if request.headers.get("X-BookieBot-App") != "1":
        return False
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        return False
    origin = request.headers.get("Origin")
    parsed = urlsplit(_base_url())
    expected = f"{parsed.scheme}://{parsed.netloc}"
    return origin is None or origin == expected


async def _pairing_token(request: web.Request) -> str:
    if request.content_length is not None and request.content_length > 1024:
        raise ValueError("Invalid setup request")
    body = await request.json()
    token = body.get("token", "") if isinstance(body, dict) else ""
    if not isinstance(token, str) or not token or len(token) > 128:
        raise ValueError("Invalid setup request")
    return token


async def _pairing_info(request: web.Request) -> web.Response:
    if not _same_origin_action(request):
        return _json({"error": "Open your setup link in Safari."}, status=403)
    try:
        token = await _pairing_token(request)
        session = await asyncio.to_thread(lambda: build_app_access_store().peek_pairing(token))
        if session is None:
            return _json({"error": "This setup link expired or was already used. Request /expense_app again in Discord."}, status=401)
        owner = _valid_owner(session)
        return _json({"ownerName": owner.name})
    except (ValueError, RuntimeError):
        return _json({"error": "Phone setup is unavailable. Request a new /expense_app link in Discord."}, status=400)
    except Exception:
        logger.exception("Could not read phone pairing")
        return _json({"error": "Phone setup is temporarily unavailable. Please try again."}, status=503)


async def _connect_phone(request: web.Request) -> web.Response:
    if not _same_origin_action(request):
        return _json({"error": "Open your setup link in Safari."}, status=403)
    try:
        _require_app_origin()
        token = await _pairing_token(request)
        previous = request.cookies.get(_cookie_name(), "")

        def redeem():
            store = build_app_access_store()
            pending = store.peek_pairing(token)
            if pending is None:
                return None
            _valid_owner(pending)
            result = store.consume_pairing(token)
            if result is not None:
                if previous:
                    store.revoke_session(previous)
            return result

        result = await asyncio.to_thread(redeem)
        if result is None:
            return _json({"error": "This setup link expired or was already used. Request /expense_app again in Discord."}, status=401)
        session_token, _ = result
        response = _json({"next": "/app/expenses"})
        response.set_cookie(_cookie_name(), session_token, max_age=SESSION_TTL_SECONDS,
                            secure=not _local_origin(), httponly=True, samesite="Lax", path="/")
        return response
    except (ValueError, RuntimeError):
        return _json({"error": "Phone setup is unavailable. Request a new /expense_app link in Discord."}, status=400)
    except Exception:
        logger.exception("Could not connect phone")
        return _json({"error": "Phone setup is temporarily unavailable. Please try again."}, status=503)


async def _report_data(request: web.Request) -> web.Response:
    from bookiebot.reports.web import _REPORT_BUILDS, _ReportBuildBusy
    from bookiebot.reports.phone_history import available_phone_month, InvalidReportMonthError, UnavailableReportMonthError
    try:
        session = await _session(request)
        if session is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        owner = _valid_owner(session)
        current = now_pacific()
        selected = await available_phone_month(request, session, request.query.get("month"), current=current)
        payload = dict(actor_key=session.actor_key, owner_name=owner.name,
                       persons=default_expense_report_persons(owner.name, list(owner.expense_persons)),
                       year=selected.year, month=selected.month)
        report = await request.app[_REPORT_BUILDS].data(payload)
        # A reset/sign-out while Sheets is loading must also revoke this response.
        if await _session(request) is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        return _json(report)
    except InvalidReportMonthError as exc:
        return _json({"error": str(exc)}, status=400)
    except UnavailableReportMonthError as exc:
        return _json({"error": str(exc)}, status=404)
    except _ReportBuildBusy:
        response = _json({"error": "Your report is busy refreshing. Please try again shortly."}, status=503)
        response.headers["Retry-After"] = "5"
        return response
    except Exception:
        logger.exception("Could not refresh phone expense report")
        # This endpoint deliberately never substitutes a saved snapshot.
        return _json({"error": "Could not refresh your expenses. Please try again."}, status=503)


async def _logout(request: web.Request) -> web.Response:
    if not _same_origin_action(request):
        return _json({"error": "Please sign out from BookieBot."}, status=403)
    try:
        token = request.cookies.get(_cookie_name(), "")
        if token:
            await asyncio.to_thread(lambda: build_app_access_store().revoke_session(token))
        response = web.Response(status=204, headers=_PRIVATE_HEADERS)
        response.del_cookie(_cookie_name(), path="/", secure=not _local_origin(), httponly=True, samesite="Lax")
        return response
    except Exception:
        logger.exception("Could not sign phone out")
        return _json({"error": "Could not sign out. Please try again."}, status=503)


def _asset_url(name: str) -> str:
    digest = hashlib.sha256((_ASSETS / name).read_bytes()).hexdigest()[:12]
    return f"/app/assets/{name}?v={digest}"


def _page_head() -> str:
    return f'''<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f5f3ed"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="BookieBot"><meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="robots" content="noindex,nofollow"><title>BookieBot</title>
<link rel="manifest" href="/app/manifest.webmanifest"><link rel="apple-touch-icon" href="/app/icon.png">
<link rel="icon" type="image/png" href="/app/icon.png"><script src="/app/assets/theme.js"></script>
<link rel="stylesheet" href="{_asset_url("expense-report-app.css")}">'''


async def _expense_app(_request: web.Request) -> web.Response:
    config = json.dumps({"reportUrl": "/app/expenses/data", "logoutUrl": "/app/logout", "ownerName": "BookieBot", "version": frontend_version()})
    html = f'''<!doctype html><html lang="en"><head>{_page_head()}</head><body>
<div id="bookiebot-expense-report-root"></div><noscript>Please enable JavaScript to open BookieBot.</noscript>
<script id="bookiebot-expense-app-config" type="application/json">{config}</script>
<script defer src="{_asset_url("expense-report-app.js")}"></script></body></html>'''
    return web.Response(text=html, content_type="text/html", headers=_PRIVATE_HEADERS)


async def _setup_page(_request: web.Request) -> web.Response:
    html = f'''<!doctype html><html lang="en"><head>{_page_head()}
<style>body{{padding: max(32px,env(safe-area-inset-top)) 24px;}} .bb-phone-setup{{max-width:440px;margin:8vh auto;}}
.bb-phone-setup img{{width:88px;height:88px;border-radius:22px;}} .bb-phone-setup h1{{font:38px/1.15 var(--bb-display-font);margin:24px 0 16px;}}
.bb-phone-setup p{{line-height:1.6;color:hsl(var(--muted-foreground));}} .bb-phone-setup button{{margin-top:16px;padding:14px 22px;background:hsl(var(--primary));color:hsl(var(--primary-foreground));border:0;border-radius:5px;font:inherit;cursor:pointer;}}
.bb-phone-setup button:disabled{{opacity:.6;}} .bb-phone-setup a{{color:hsl(var(--primary));}} .bb-phone-setup small{{display:block;margin-top:24px;line-height:1.6;}}
</style></head><body><main class="bb-phone-setup"><img src="/app/avatar.png" alt="BookieBot">
<h1>Your budget, one tap away.</h1><p id="setup-status" role="status" aria-live="polite">Checking your private setup link…</p>
<button id="connect-phone" type="button" hidden>Connect this phone</button>
<small>Open this page in Safari on your own iPhone. After connecting, add BookieBot to your Home Screen from Safari’s Share menu.</small>
<noscript>Enable JavaScript, then reopen your private setup link from Discord.</noscript>
</main><script defer src="{_asset_url("phone-setup.js")}"></script></body></html>'''
    return web.Response(text=html, content_type="text/html", headers=_PRIVATE_HEADERS)


async def _manifest(_request: web.Request) -> web.Response:
    return web.json_response({
        "id": "/app/expenses", "name": "BookieBot", "short_name": "BookieBot",
        "start_url": "/app/expenses", "scope": "/app/", "display": "standalone",
        "background_color": "#f5f3ed", "theme_color": "#f5f3ed",
        "description": "Your current expenses and budget, refreshed when you open it.",
        "icons": [{"src": "/app/icon.png", "sizes": "1254x1254", "type": "image/png", "purpose": "any"}],
    }, content_type="application/manifest+json", headers={"Cache-Control": "public, max-age=3600"})


async def _icon(_request: web.Request) -> web.FileResponse:
    return web.FileResponse(_AVATAR, headers={"Cache-Control": "public, max-age=86400", "Content-Type": "image/png"})


async def _avatar(_request: web.Request) -> web.FileResponse:
    from bookiebot.core.avatar_rotation import _avatar_files, _avatar_for_date
    files = _avatar_files()
    path = _avatar_for_date(now_pacific(), files) if files else _AVATAR
    return web.FileResponse(path, headers={"Cache-Control": "public, max-age=300"})


async def _asset(request: web.Request) -> web.StreamResponse:
    name = request.match_info["name"]
    if name == "theme.js":
        from bookiebot.reports.expense_breakdown import _theme_bootstrap_script
        return web.Response(text=_theme_bootstrap_script(), content_type="application/javascript",
                            headers={"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"})
    types = {"expense-report-app.js": "application/javascript", "expense-report-app.css": "text/css", "phone-setup.js": "application/javascript"}
    if name not in types:
        raise web.HTTPNotFound()
    return web.FileResponse(_ASSETS / name, headers={"Content-Type": types[name], "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff"})


def register_phone_app_routes(app: web.Application) -> None:
    from bookiebot.reports.phone_history import register_phone_history_routes
    register_phone_history_routes(app)
    from bookiebot.reports.phone_questions import register_phone_question_routes
    register_phone_question_routes(app)
    from bookiebot.reports.phone_notifications import register_phone_notification_routes
    register_phone_notification_routes(app)
    from bookiebot.reports.phone_goals import register_phone_goal_routes
    register_phone_goal_routes(app)
    app.router.add_get("/app/version", app_version)
    app.router.add_get("/app/expenses", _expense_app)
    app.router.add_get("/app/expenses/data", _report_data)
    app.router.add_get("/app/connect", _setup_page)
    app.router.add_post("/app/pairing", _pairing_info)
    app.router.add_post("/app/connect", _connect_phone)
    app.router.add_post("/app/logout", _logout)
    app.router.add_get("/app/manifest.webmanifest", _manifest)
    app.router.add_get("/app/icon.png", _icon)
    app.router.add_get("/app/avatar.png", _avatar)
    app.router.add_get("/app/assets/{name}", _asset)
