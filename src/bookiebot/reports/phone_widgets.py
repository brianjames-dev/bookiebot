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
from bookiebot.reports.widget_summaries import WIDGET_TYPES, GOAL_ID, database_snapshot, report_content, select_goal
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
    summaries = {}
    for kind in ("categories", "upcoming"):
        try:
            summaries[kind] = {mode: report_content(report, kind, mode, day) for mode in ("current", "projected")}
        except (ValueError, KeyError, TypeError):
            # Optional sections cannot break a valid existing budget widget.
            # Missing/invalid sections are unavailable, never a confirmed zero.
            summaries[kind] = None
    return {"schemaVersion": 1, "ownerName": report["ownerName"],
            "month": f"{payload['year']:04d}-{payload['month']:02d}", "asOfDate": day,
            "timezone": "America/Los_Angeles", "updatedAt": updated.astimezone(timezone.utc).isoformat(),
            "staleAfterSeconds": 1800, "refreshAfterSeconds": 900, "status": "fresh", "views": views,
            "summaries": summaries}


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


class _WidgetDatabaseSnapshots(_WidgetSnapshots):
    """Same bounded read lifecycle; one cache per database summary type."""
    def __init__(self, kind: str) -> None:
        super().__init__()
        self.kind = kind

    async def _build(self, app: web.Application, payload: dict[str, Any], day: str) -> dict[str, Any]:
        return await asyncio.to_thread(database_snapshot, self.kind, payload, day)


_WIDGET_DATABASE_SNAPSHOTS = web.AppKey("bookiebot_widget_database_snapshots", dict[str, _WidgetDatabaseSnapshots])


async def _data(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json
    from bookiebot.reports.phone_history import parse_phone_report_month, phone_report_payload
    unauthorized = {"error": "Reconnect this widget from BookieBot Settings → Widgets."}
    authorization = request.headers.get("Authorization", "")
    # Never accept cookies, query credentials, owner overrides or arbitrary dates.
    if not authorization.startswith("Bearer bbw_read_") or len(authorization) > 100:
        return _json(unauthorized, status=401)
    kind = request.match_info.get("kind", "budget")
    if kind != "budget" and kind not in WIDGET_TYPES:
        return _json({"error": "Choose a supported widget type."}, status=400)
    goal_id = None
    if request.query_string:
        if kind != "savings" or list(request.query.keys()) != ["goalId"] or len(request.query.getall("goalId")) != 1:
            return _json(unauthorized, status=401)
        goal_id = request.query["goalId"]
        if not GOAL_ID.fullmatch(goal_id):
            return _json({"error": "Choose a savings goal from BookieBot."}, status=400)
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
        if kind in {"savings", "shared"}:
            snapshot = await request.app[_WIDGET_DATABASE_SNAPSHOTS][kind].read(
                request.app, {**payload, "owner_key": grant.owner_key}, now.date().isoformat())
        else:
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
        result = {key: value for key, value in snapshot.items() if key not in {"views", "summaries"}}
        if kind == "budget":
            result.update(snapshot["views"][current.mode])
        elif kind in {"categories", "upcoming"}:
            section = snapshot["summaries"].get(kind)
            if section is None:
                raise ValueError("Widget section unavailable")
            result.update(schemaVersion=2, type=kind, content=section[current.mode])
        elif kind == "savings":
            result["content"] = select_goal(snapshot["content"], goal_id)
        if not await asyncio.to_thread(store.touch_grant, token):
            return _json(unauthorized, status=401)
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
<style>body{{font:16px/1.6 system-ui;background:#17201c;color:#edeae2;max-width:640px;margin:32px auto;padding:0 24px}}h1{{font:32px Georgia}}h2{{font-size:18px;margin:0 0 6px}}h3{{font-size:16px;margin:28px 0 6px}}a{{color:#9bc9b5}}ol{{padding-left:24px}}li{{margin:24px 0}}p{{margin:6px 0}}code{{overflow-wrap:anywhere}}.note{{font-size:14px;color:#b4b9af}}nav a{{display:inline-flex;align-items:center;min-height:44px}}nav:last-child{{margin:28px 0}}</style>
<nav aria-label="Return to BookieBot"><a href="/app/expenses#settings">← Back to Settings</a></nav>
<h1>Widget setup</h1><ol>
<li><h2>Copy to Scriptable</h2><p>Install <a href="https://apps.apple.com/app/scriptable/id1405459188" target="_blank" rel="noreferrer">Scriptable</a>. In <a href="/app/expenses#settings">Settings → Widgets → Setup &amp; widgets</a>, tap <strong>Copy script</strong>. In Scriptable, tap +, paste and name it BookieBot.</p><p class="note">Already installed? Replace the code in the same script and keep its name. Current version: 1.4.</p></li>
<li><h2>Pair your account</h2><p>In Settings → Widgets, tap <strong>Pair a widget</strong> and copy your setup code. Run BookieBot inside the Scriptable app, paste it when asked and choose <strong>Pair this phone</strong>.</p><p class="note">Use your own account. Keep the code private; it expires in 10 minutes. Opening a link here does not pair the widget.</p></li>
<li><h2>Add the widget</h2><p>Hold your Home Screen → <strong>Edit → Add Widget → Scriptable</strong>. Choose Small or Medium, then <strong>Edit Widget → Script → BookieBot</strong>.</p><p class="note">Both sizes can use the same script. Leave When Interacting at Open App.</p></li></ol>
<h3>Customize</h3><p>In <strong>Setup &amp; widgets → Customize</strong>, choose Budget, Upcoming payments, Savings goal, Category budgets or Shared balance, then Editorial or Two-tone. Copy the parameter into <strong>Edit Widget → Parameter</strong>. Savings can select a specific goal.</p><p>Preview in Scriptable → <strong>Widget &amp; preview</strong>. All types and sizes can share one pairing. Empty or theme-only parameters keep showing Budget; never paste a setup code into Parameter.</p>
<h3>Help</h3><p>Already paired? No new pairing is needed after an update. If “Pair this phone” remains, run the updated script and enter a fresh code only if asked. Check your name and figures, then select that exact script in Edit Widget.</p>
<p>iOS chooses refresh timing; check the timestamp. Tapping figures opens <a href="{origin}/app/expenses">BookieBot in your browser</a>, which may need its own sign-in.</p>
<p class="note">Read-only amounts are visible on your Home Screen. Manage access in Settings → Widgets → the connection’s ⋯ menu → Remove. Remove the Home Screen widget to hide its figures immediately.</p>
<nav aria-label="Return to BookieBot"><a href="/app/expenses#settings">← Back to Settings</a></nav></html>'''
    return web.Response(text=content, content_type="text/html", headers=_PRIVATE_HEADERS)


async def _close_widgets(app: web.Application) -> None:
    await app[_WIDGET_SNAPSHOTS].close()
    await asyncio.gather(*(cache.close() for cache in app[_WIDGET_DATABASE_SNAPSHOTS].values()))


def register_phone_widget_routes(app: web.Application) -> None:
    app[_WIDGET_SNAPSHOTS] = _WidgetSnapshots()
    app[_WIDGET_DATABASE_SNAPSHOTS] = {kind: _WidgetDatabaseSnapshots(kind) for kind in ("savings", "shared")}
    app.on_cleanup.append(_close_widgets)
    app.router.add_get("/app/widgets/settings", _settings)
    app.router.add_post("/app/widgets/settings", _settings)
    app.router.add_post("/app/widgets/pair", _pair)
    app.router.add_get("/app/widgets/data", _data)
    app.router.add_get("/app/widgets/data/{kind}", _data)
    app.router.add_get("/app/widgets/script", _script)
    app.router.add_get("/app/widgets/help", _help)
    # Opening a setup link only shows instructions; fragments stay on the phone.
    app.router.add_get("/app/widgets/connect", _help)
