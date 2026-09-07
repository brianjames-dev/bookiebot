"""Opt-in Home Screen Web Push; all report reads retain the phone's identity."""
from __future__ import annotations

import asyncio
from contextlib import suppress
from datetime import datetime, timedelta
import importlib
import json
import logging
import os
from pathlib import Path
import time
from typing import Any, AsyncIterator

from aiohttp import web

from bookiebot.reports.app_access import AppSession
from bookiebot.reports.phone_notification_store import build_phone_notification_store, session_hash, validate_preferences, validate_subscription
from bookiebot.sheets.routing import now_pacific

logger = logging.getLogger(__name__)


async def _identity(request: web.Request):
    from bookiebot.reports.phone_app import _cookie_name, _session
    session = await _session(request)
    return session, session_hash(request.cookies.get(_cookie_name(), ""))


async def _settings(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json
    try:
        session, token_hash = await _identity(request)
        if session is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        def load():
            store = build_phone_notification_store()
            result = store.settings(token_hash)
            result["publicKey"] = store.keys()[1]
            return result
        return _json(await asyncio.to_thread(load))
    except Exception:
        logger.warning("Phone notification settings could not be loaded")
        return _json({"error": "Notification settings are temporarily unavailable."}, status=503)


async def _save(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json, _same_origin_action
    if not _same_origin_action(request):
        return _json({"error": "Change notifications from BookieBot."}, status=403)
    try:
        session, token_hash = await _identity(request)
        if session is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        if request.content_length is not None and request.content_length > 8192:
            raise ValueError("Notification request is too large.")
        raw = bytearray()
        async for chunk in request.content.iter_chunked(1024):
            raw.extend(chunk)
            if len(raw) > 8192:
                raise ValueError("Notification request is too large.")
        body = json.loads(raw)
        if not isinstance(body, dict):
            raise ValueError("Invalid notification request.")
        subscription = validate_subscription(body.get("subscription"))
        preferences = validate_preferences(body.get("preferences"))
        await asyncio.to_thread(lambda: build_phone_notification_store().subscribe(token_hash, session, subscription, preferences))
        return _json({"enabled": True, "preferences": preferences})
    except (ValueError, TypeError):
        return _json({"error": "Could not save notifications. Choose a supported phone, notification type, and hour, then try again."}, status=400)
    except Exception:
        logger.warning("Phone notification preferences could not be saved")
        return _json({"error": "Could not save notifications. Please try again."}, status=503)


async def _delete(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json, _same_origin_action
    if not _same_origin_action(request):
        return _json({"error": "Change notifications from BookieBot."}, status=403)
    try:
        session, token_hash = await _identity(request)
        if session is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        await asyncio.to_thread(lambda: build_phone_notification_store().unsubscribe(token_hash))
        return _json({"enabled": False})
    except Exception:
        logger.warning("Phone notifications could not be disabled")
        return _json({"error": "Could not turn notifications off. Please try again."}, status=503)


async def _worker(_request: web.Request) -> web.Response:
    return web.Response(text=Path(__file__).with_name("assets").joinpath("phone-notifications-worker.js").read_text(),
                        content_type="application/javascript", headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/app/", "X-Content-Type-Options": "nosniff"})


async def _test_notification(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _json, _same_origin_action
    if not _same_origin_action(request):
        return _json({"error": "Send a test from BookieBot."}, status=403)
    try:
        session, token_hash = await _identity(request)
        if session is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        store = await asyncio.to_thread(build_phone_notification_store)
        now = int(time.time())
        device = next((row for row in await asyncio.to_thread(store.active, now) if row["session_hash"] == token_hash), None)
        if device is None:
            return _json({"error": "Enable notifications on this phone first."}, status=400)
        # An explicit test tap sends only generic text, at most once per minute.
        event_key = f"test:{now // 60}"
        if not await asyncio.to_thread(store.claim, token_hash, event_key, now):
            return _json({"error": "A test was already requested. Please wait a minute before trying again."}, status=429)
        key = (await asyncio.to_thread(store.keys))[0]
        if not await asyncio.to_thread(store.still_matches, device, int(time.time())):
            return _json({"error": "Notifications were turned off for this phone."}, status=409)
        payload = {"title": "BookieBot", "body": "This phone is connected to BookieBot notifications.", "tag": event_key}
        accepted, retryable, expired = await asyncio.to_thread(_send_push, json.loads(device["subscription"]), payload, key)
        await asyncio.to_thread(store.complete, token_hash, event_key, now, accepted=accepted, retryable=retryable)
        if expired:
            await asyncio.to_thread(store.expire_subscription, device)
        if not accepted:
            return _json({"error": "The push service could not accept the test. Try again, or turn notifications off and on."}, status=503)
        return _json({"message": "Test accepted by the push service. Check your notifications; iPhone Focus settings may silence it."})
    except Exception:
        logger.warning("A phone notification test could not be processed")
        return _json({"error": "Could not send a test. Please try again."}, status=503)


def _send_push(subscription: dict, payload: dict, private_key: str) -> tuple[bool, bool, bool]:
    """Return accepted, retryable, expired; never include endpoint/keys in logs."""
    from bookiebot.reports.phone_app import _base_url
    import requests

    class PushSession(requests.Session):
        def request(self, method, url, **kwargs):
            # The allowlist is checked again at send time. Redirects cannot
            # turn the browser's push endpoint into an arbitrary network fetch.
            validate_subscription({**subscription, "endpoint": url})
            kwargs["allow_redirects"] = False
            return super().request(method, url, **kwargs)

    try:
        validate_subscription(subscription)
        push = importlib.import_module("pywebpush")
        with PushSession() as http:
            http.trust_env = False
            result = push.webpush(subscription_info=subscription, data=json.dumps(payload),
                                  vapid_private_key=private_key, vapid_claims={"sub": _base_url()},
                                  ttl=3600, timeout=15, requests_session=http)
        return 200 <= result.status_code < 300, False, False
    except Exception as exc:
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None)
        # Provider rejection is permanent except explicit transient responses.
        # A timeout is retried with the same notification tag, replacing it on
        # devices if acceptance happened before the connection was interrupted.
        return False, status is None or status == 429 or status >= 500, status in (404, 410)


def _due_kind(preferences: dict, current: datetime) -> list[str]:
    if current.hour != preferences["hour"]:
        return []
    kinds = []
    if preferences["weekly"] and current.weekday() == 0:
        kinds.append("weekly")
    if preferences["upcoming"]:
        kinds.append("upcoming")
    return kinds


def notification_payload(kind: str, report: dict, current: datetime, *, show_amounts: bool) -> dict | None:
    """Only explicit amount opt-in permits numbers on a lock screen."""
    key = f"{kind}:{current.date().isoformat()}"
    if kind == "weekly":
        body = "Your weekly spending check-in is ready. Open BookieBot for your latest report."
        if show_amounts:
            amount = report.get("modeViews", {}).get("current", {}).get("metrics", {}).get("totalExpenses")
            if amount is None:
                amount = report.get("metrics", {}).get("personalOutflows", 0)
            body = f"${float(amount):,.2f} spent this month. Open BookieBot for your weekly check-in."
    else:
        tomorrow = current.date() + timedelta(days=1)
        events = [event for event in report.get("calendarEvents", [])
                  if event.get("kind") in ("bill", "subscription") and event.get("day") == tomorrow.day]
        if not events:
            return None
        body = "You have scheduled payments tomorrow. Open BookieBot to review them."
        if show_amounts:
            amount = sum(float(event.get("amount", 0)) for event in events)
            body = f"{len(events)} scheduled payment{'s' if len(events) != 1 else ''} tomorrow, estimated ${amount:,.2f}."
    return {"title": "BookieBot", "body": body, "tag": key, "url": "/app/expenses"}


async def send_due_phone_notifications(app: web.Application, current: datetime | None = None) -> int:
    from bookiebot.reports.phone_app import _valid_owner
    from bookiebot.reports.scope import default_expense_report_persons
    from bookiebot.reports.web import _REPORT_BUILDS

    current = current or now_pacific()
    stamp = int(time.time())
    store = await asyncio.to_thread(build_phone_notification_store)
    await asyncio.to_thread(store.prune, stamp)
    devices = await asyncio.to_thread(store.active, stamp)
    accepted = 0
    reports: dict[tuple, dict] = {}
    private_key = ""
    for device in devices:
        try:
            preferences = validate_preferences(json.loads(device["preferences"]))
            kinds = _due_kind(preferences, current)
            if not kinds:
                continue
            session = AppSession(device["actor_key"], device["owner_key"], device["expires_at"])
            owner = _valid_owner(session)
            for kind in kinds:
                token_hash = device["session_hash"]
                event_key = f"{kind}:{current.date().isoformat()}"
                if not await asyncio.to_thread(store.can_attempt, token_hash, event_key, stamp):
                    continue
                month_date = current.date() + timedelta(days=1 if kind == "upcoming" else 0)
                report_key = (session.actor_key, month_date.year, month_date.month)
                if report_key not in reports:
                    reports[report_key] = await app[_REPORT_BUILDS].data(dict(
                        actor_key=session.actor_key, owner_name=owner.name,
                        persons=default_expense_report_persons(owner.name, list(owner.expense_persons)),
                        year=month_date.year, month=month_date.month))
                payload = notification_payload(kind, reports[report_key], current, show_amounts=preferences["showAmounts"])
                if payload is None:
                    if await asyncio.to_thread(store.claim, token_hash, event_key, stamp):
                        await asyncio.to_thread(store.complete, token_hash, event_key, stamp, accepted=False)
                    continue
                if not await asyncio.to_thread(store.still_matches, device, int(time.time())):
                    continue
                if not await asyncio.to_thread(store.claim, token_hash, event_key, stamp):
                    continue
                if not private_key:
                    private_key = (await asyncio.to_thread(store.keys))[0]
                # A slow sheet read must not deliver after sign-out or reset.
                if not await asyncio.to_thread(store.still_matches, device, int(time.time())):
                    await asyncio.to_thread(store.complete, token_hash, event_key, stamp, accepted=False)
                    continue
                success, retryable, expired = await asyncio.to_thread(_send_push, json.loads(device["subscription"]), payload, private_key)
                await asyncio.to_thread(store.complete, token_hash, event_key, stamp, accepted=success, retryable=retryable)
                if expired:
                    await asyncio.to_thread(store.expire_subscription, device)
                accepted += int(success)
        except Exception:
            # Do not log caught push errors: they can contain the entire private
            # endpoint, authentication keys, or lock-screen financial content.
            logger.warning("A phone notification could not be processed; it will be checked in the next eligible window")
    return accepted


async def _notification_lifecycle(app: web.Application) -> AsyncIterator[None]:
    async def run():
        while True:
            await asyncio.sleep(60)
            try:
                await send_due_phone_notifications(app)
            except Exception:
                logger.warning("Phone notification check is temporarily unavailable")
    task = asyncio.create_task(run())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


def register_phone_notification_routes(app: web.Application, *, start_scheduler: bool = True) -> None:
    app.router.add_get("/app/notifications", _settings)
    app.router.add_post("/app/notifications", _save)
    app.router.add_delete("/app/notifications", _delete)
    app.router.add_post("/app/notifications/test", _test_notification)
    app.router.add_get("/app/notifications/worker.js", _worker)
    if start_scheduler and os.getenv("BOOKIEBOT_PHONE_NOTIFICATIONS_ENABLED", "true").lower() != "false":
        app.cleanup_ctx.append(_notification_lifecycle)
