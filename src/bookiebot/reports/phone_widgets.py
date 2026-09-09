"""Read-only Scriptable capabilities; phone cookies only administer pairing."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import html
import json
import logging
import math
from pathlib import Path
import time
from typing import Any
from urllib.parse import urlsplit

from aiohttp import web

from bookiebot.reports.app_access import AppSession
from bookiebot.reports.widget_store import (
    WidgetGrant, WidgetLimitError, WidgetNotFoundError, WidgetValidationError, build_widget_store,
)
from bookiebot.sheets.routing import PACIFIC_TZ, now_pacific

logger = logging.getLogger(__name__)
_ASSETS = Path(__file__).with_name("assets")
_READ_TIMEOUT = 8.0
_SNAPSHOT_SECONDS = 300


def _origin() -> str:
    from bookiebot.reports.phone_app import _base_url
    value = _base_url()
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise WidgetValidationError("Widgets require BookieBot's public HTTPS address.")
    return f"https://{parsed.netloc}"


def _identity(grant: WidgetGrant):
    from bookiebot.reports.phone_app import _valid_owner
    return _valid_owner(AppSession(grant.actor_key, grant.owner_key, grant.expires_at))


async def _body(request: web.Request) -> dict[str, Any]:
    if request.content_length is not None and request.content_length > 2048:
        raise WidgetValidationError("Widget request is too large.")
    raw = bytearray()
    async for chunk in request.content.iter_chunked(1024):
        raw.extend(chunk)
        if len(raw) > 2048:
            raise WidgetValidationError("Widget request is too large.")
    body = json.loads(raw)
    if not isinstance(body, dict):
        raise WidgetValidationError("Invalid widget request.")
    return body


def _fields(body: dict[str, Any], names: set[str]) -> None:
    if set(body) != names:
        raise WidgetValidationError("Invalid widget request.")


async def _settings(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json, _same_origin_action, _session
    if request.method != "GET" and not _same_origin_action(request):
        return _json({"error": "Manage widgets from BookieBot Settings."}, status=403)
    created: str | None = None
    try:
        session = await _session(request)
        if session is None:
            return _json({"error": "Sign in to BookieBot to manage your widgets."}, status=401)
        origin = _origin()
        store = await asyncio.to_thread(build_widget_store)
        pairing = None
        if request.method == "POST":
            body = await _body(request)
            operation = body.get("operation")
            if operation == "pair":
                _fields(body, {"operation", "label", "mode"})
                issued = await asyncio.to_thread(store.issue_pairing, session.actor_key, session.owner_key, body["label"], body["mode"])
                created = issued["id"]
                pairing = {"id": created, "expiresAt": issued["expiresAt"],
                           "setupCode": f"{origin}/app/widgets/connect#{issued['pairingToken']}"}
            elif operation == "revoke":
                _fields(body, {"operation", "id"})
                await asyncio.to_thread(store.revoke, session.owner_key, body["id"])
            elif operation == "mode":
                _fields(body, {"operation", "id", "mode"})
                await asyncio.to_thread(store.set_mode, session.owner_key, body["id"], body["mode"])
            else:
                raise WidgetValidationError("Choose a widget action.")
        result = await asyncio.to_thread(store.list_connections, session.owner_key)
        current = await _session(request)
        if current is None or current != session:
            if created is not None:
                await asyncio.to_thread(store.revoke, session.owner_key, created)
            return _json({"error": "Sign in to BookieBot to manage your widgets."}, status=401)
        result.update(scriptUrl="/app/widgets/script", setupInstructionsUrl="/app/widgets/help")
        if pairing is not None:
            result["pairing"] = pairing
        return _json(result)
    except WidgetLimitError as exc:
        return _json({"error": str(exc)}, status=409)
    except WidgetNotFoundError as exc:
        return _json({"error": str(exc)}, status=404)
    except (ValueError, TypeError):
        return _json({"error": "Check the widget name, mode and setup request."}, status=400)
    except Exception as exc:
        # Provider errors can include SQL parameters or credentials; never log them.
        logger.warning("Widget settings unavailable error=%s", type(exc).__name__)
        return _json({"error": "Widgets are temporarily unavailable. Refresh before trying again."}, status=503)


async def _pair(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json
    try:
        _origin()
        body = await _body(request)
        _fields(body, {"pairingToken"})
        store = await asyncio.to_thread(build_widget_store)
        result = await asyncio.to_thread(store.consume_pairing, body["pairingToken"])
        if result is None:
            return _json({"error": "This setup code expired, was removed or was already used. Create a new one in Settings → Widgets."}, status=401)
        token, grant = result
        current = await asyncio.to_thread(store.get_grant, token)
        if current is None or (current.id, current.actor_key, current.owner_key) != (grant.id, grant.actor_key, grant.owner_key):
            return _json({"error": "This widget connection was removed. Pair again from BookieBot."}, status=401)
        try:
            owner = _identity(current)
        except (ValueError, RuntimeError):
            await asyncio.to_thread(store.revoke, grant.owner_key, grant.id)
            return _json({"error": "This account connection changed. Pair again from BookieBot."}, status=401)
        return _json({"token": token, "connectionId": current.id, "ownerName": owner.name, "mode": current.mode,
                      "expiresAt": datetime.fromtimestamp(current.expires_at, timezone.utc).isoformat()})
    except (ValueError, TypeError):
        return _json({"error": "Invalid widget setup code."}, status=400)
    except Exception as exc:
        logger.warning("Widget pairing unavailable error=%s", type(exc).__name__)
        return _json({"error": "Pairing could not finish. Refresh Widgets in BookieBot before creating a new code."}, status=503)


def _money(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError("Invalid financial snapshot")
    return float(value)


def _snapshot(report: dict[str, Any], payload: dict[str, Any], day: str) -> dict[str, Any]:
    """Select canonical UI values; no new budget, projection or pacing formula."""
    if (report["ownerName"] != payload["owner_name"] or report["year"] != payload["year"]
            or report["month"] != payload["month"]):
        raise ValueError("Mismatched financial snapshot")
    updated = datetime.fromisoformat(report["generatedAtIso"])
    if updated.tzinfo is None or updated.astimezone(PACIFIC_TZ).date().isoformat() != day:
        raise ValueError("Financial snapshot crossed a budget day")
    if updated.timestamp() > time.time() + 60:
        raise ValueError("Invalid financial snapshot time")
    views = {}
    for mode in ("current", "projected"):
        view = report["modeViews"][mode]
        burn = view["burnRate"]
        state = burn.get("status") if isinstance(burn, dict) else "unavailable"
        if state not in {"under", "over", "not_started", "unavailable"}:
            raise ValueError("Invalid financial snapshot state")
        difference = _money(burn["totalDifference"]) if state in {"under", "over"} else None
        views[mode] = {"budgetRemaining": _money(view["metrics"]["incomeAfterExpenses"]),
                       "availableToday": -difference if difference is not None else None,
                       "todayState": state}
    return {"schemaVersion": 1, "ownerName": report["ownerName"],
            "month": f"{payload['year']:04d}-{payload['month']:02d}", "asOfDate": day,
            "timezone": "America/Los_Angeles", "updatedAt": updated.astimezone(timezone.utc).isoformat(),
            "staleAfterSeconds": 1800, "refreshAfterSeconds": 900, "status": "fresh", "views": views}


class _WidgetSnapshots:
    """Bounded, minimal five-minute snapshots; disconnected reads stay coalesced."""
    def __init__(self) -> None:
        self.saved: dict[tuple, tuple[float, dict[str, Any]]] = {}
        self.tasks: dict[tuple, asyncio.Task[dict[str, Any]]] = {}

    async def read(self, app: web.Application, payload: dict[str, Any], day: str) -> dict[str, Any]:
        key = (payload["actor_key"], payload["owner_name"], tuple(payload["persons"]), day)
        self.saved = {key: value for key, value in self.saved.items() if time.monotonic() - value[0] < _SNAPSHOT_SECONDS}
        if key in self.saved:
            return self.saved[key][1]
        if key not in self.tasks:
            if len(self.tasks) >= 8:
                raise RuntimeError("Widget refresh busy")
            task = asyncio.create_task(self._build(app, payload, day))
            self.tasks[key] = task
            task.add_done_callback(lambda completed: self._finished(key, completed))
        return await asyncio.wait_for(asyncio.shield(self.tasks[key]), timeout=_READ_TIMEOUT)

    async def _build(self, app: web.Application, payload: dict[str, Any], day: str) -> dict[str, Any]:
        from bookiebot.reports.web import _REPORT_BUILDS
        return _snapshot(await app[_REPORT_BUILDS].data(payload), payload, day)

    def _finished(self, key: tuple, task: asyncio.Task[dict[str, Any]]) -> None:
        self.tasks.pop(key, None)
        if not task.cancelled() and task.exception() is None:
            result = task.result()
            # A delayed source read must not gain a new timestamp or cache lifetime.
            age = max(0, time.time() - datetime.fromisoformat(result["updatedAt"]).timestamp())
            if age < _SNAPSHOT_SECONDS:
                self.saved[key] = (time.monotonic() - age, result)
                while len(self.saved) > 32:
                    self.saved.pop(next(iter(self.saved)))

    async def close(self) -> None:
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        self.saved.clear()


_WIDGET_SNAPSHOTS = web.AppKey("bookiebot_widget_snapshots", _WidgetSnapshots)


async def _data(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json
    from bookiebot.reports.phone_history import parse_phone_report_month, phone_report_payload
    unauthorized = {"error": "Reconnect this widget from BookieBot Settings → Widgets."}
    authorization = request.headers.get("Authorization", "")
    # Never accept cookies, query credentials, owner overrides or arbitrary dates.
    if request.query_string or not authorization.startswith("Bearer bbw_read_") or len(authorization) > 100:
        return _json(unauthorized, status=401)
    token = authorization[7:]
    try:
        origin = _origin()
        store = await asyncio.to_thread(build_widget_store)
        grant = await asyncio.to_thread(store.get_grant, token)
        if grant is None:
            return _json(unauthorized, status=401)
        try:
            _identity(grant)
        except (ValueError, RuntimeError):
            return _json(unauthorized, status=401)
        now = now_pacific()
        month = parse_phone_report_month(None, current=now)
        payload = phone_report_payload(grant, month)
        snapshot = await request.app[_WIDGET_SNAPSHOTS].read(request.app, payload, now.date().isoformat())
        current = await asyncio.to_thread(store.get_grant, token)
        if current is None or (current.actor_key, current.owner_key) != (grant.actor_key, grant.owner_key):
            return _json(unauthorized, status=401)
        try:
            _identity(current)
            if phone_report_payload(current, month) != payload:
                return _json(unauthorized, status=401)
        except (ValueError, RuntimeError):
            return _json(unauthorized, status=401)
        if now_pacific().date() != now.date():
            raise ValueError("Widget read crossed a Pacific budget day")
        # Mode is read again so a settings change during the source read wins.
        if not await asyncio.to_thread(store.touch_grant, token):
            return _json(unauthorized, status=401)
        result = {key: value for key, value in snapshot.items() if key != "views"}
        result.update(snapshot["views"][current.mode])
        result.update(connectionId=current.id, mode=current.mode, appUrl=f"{origin}/app/expenses",
                      avatarUrl=f"{origin}/app/avatar.png?day={snapshot['asOfDate']}")
        return _json(result)
    except Exception as exc:
        logger.warning("Widget snapshot unavailable error=%s", type(exc).__name__)
        response = _json({"error": "Fresh figures are temporarily unavailable. Keep the original update time and try again later."}, status=503)
        response.headers["Retry-After"] = "60"
        return response


async def _script(_request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _PRIVATE_HEADERS
    try:
        origin = _origin()
    except ValueError:
        raise web.HTTPServiceUnavailable(text="Widgets require a public HTTPS address.")
    source = (_ASSETS / "bookiebot-widget.js").read_text().replace('"__BOOKIEBOT_ORIGIN__"', json.dumps(origin))
    return web.Response(text=source, headers={**_PRIVATE_HEADERS, "Content-Disposition": 'attachment; filename="BookieBot.js"'}, content_type="application/javascript")


async def _help(_request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _PRIVATE_HEADERS
    origin = html.escape(_origin(), quote=True)
    content = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BookieBot widget setup</title>
<style>body{{font:17px/1.6 system-ui;background:#17201c;color:#edeae2;max-width:640px;margin:40px auto;padding:0 24px}}h1{{font:34px Georgia}}a{{color:#9bc9b5}}li{{margin:16px 0}}code{{overflow-wrap:anywhere}}</style>
<h1>BookieBot on your Home Screen</h1><ol>
<li>Install <a href="https://apps.apple.com/app/scriptable/id1405459188">Scriptable</a> on your iPhone. No Apple developer account is needed.</li>
<li><a href="{origin}/app/widgets/script">Download BookieBot.js</a>. In Safari’s Downloads or Files, open its Share menu and choose Scriptable to import it. If that option is absent, open the file as text, copy it into a new Scriptable script and name it BookieBot.</li>
<li>In your signed-in BookieBot app, open <strong>Settings → Widgets → Pair a widget</strong>, choose a name and Current or Projected, and create a setup code. Copy it; it expires after 10 minutes.</li>
<li>Run the BookieBot script inside Scriptable and paste that code when asked. Allow its BookieBot network requests. Confirm your name and figures in the preview.</li>
<li>Long-press your Home Screen, choose <strong>Edit → Add Widget → Scriptable</strong>, and add a small or medium widget. Long-press it → Edit Widget → Script → BookieBot. Leave Parameter blank. The script sets the tap URL.</li>
<li>Repeat on the other phone from that person’s own BookieBot account. Each connection has its own mode and Remove action in Settings.</li></ol>
<h2>Reading the widget</h2><p>Budget remaining matches Left; Available today matches Burn Rate, with a negative value when over pace. It follows the current Pacific month. The avatar changes between refreshes, rather than animating.</p>
<p>iOS chooses refresh timing; 15 minutes is a request, not a guarantee. The server can reuse a snapshot for up to five minutes. The last-updated date and elapsed time identify the source snapshot. On a failed refresh, older figures are labeled stale; never assume it is live. Unknown values show a dash.</p>
<p>Tapping opens <a href="{origin}/app/expenses">BookieBot in the browser</a>. It cannot reliably open your installed Home Screen app. The browser may need its own /expense_app sign-in; widget pairing never signs it in.</p>
<h2>Privacy &amp; removal</h2><p>Widget amounts are visible on your Home Screen. The script keeps its read-only key in Scriptable Keychain and a small financial snapshot locally, not in iCloud. Remove a connection in Settings to stop reads. Already displayed figures disappear when iOS next runs the widget and it receives the revocation; remove the Home Screen widget to hide them immediately.</p>
<p>Connections expire after one year. Web sign-out leaves separately paired widgets active; /expense_app_reset revokes all phone and widget connections for that account. To clear this phone’s local copy immediately, run the script and choose Forget this phone, then remove the connection in BookieBot. Script updates require importing the new script again under the same name.</p></html>'''
    return web.Response(text=content, content_type="text/html", headers=_PRIVATE_HEADERS)


async def _close_widgets(app: web.Application) -> None:
    await app[_WIDGET_SNAPSHOTS].close()


def register_phone_widget_routes(app: web.Application) -> None:
    app[_WIDGET_SNAPSHOTS] = _WidgetSnapshots()
    app.on_cleanup.append(_close_widgets)
    app.router.add_get("/app/widgets/settings", _settings)
    app.router.add_post("/app/widgets/settings", _settings)
    app.router.add_post("/app/widgets/pair", _pair)
    app.router.add_get("/app/widgets/data", _data)
    app.router.add_get("/app/widgets/script", _script)
    app.router.add_get("/app/widgets/help", _help)
    # Opening a setup link only shows instructions; fragments stay on the phone.
    app.router.add_get("/app/widgets/connect", _help)
