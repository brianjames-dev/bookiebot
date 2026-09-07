"""Web Push contracts. All outbound delivery is mocked, never sent to a phone."""
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import os
from types import SimpleNamespace
import uuid

from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
import pytest
import pytest_asyncio

from bookiebot.reports import phone_app, phone_notifications as push
from bookiebot.reports import phone_notification_store as storage
from bookiebot.reports.app_access import AppAccessStore, PostgresAppAccessStore
from bookiebot.reports.web import _REPORT_BUILDS
from bookiebot.sheets.routing import DEFAULT_BRIAN_DISCORD_USER_IDS, DEFAULT_HANNAH_DISCORD_USER_IDS

BRIAN = DEFAULT_BRIAN_DISCORD_USER_IDS[0]
HANNAH = DEFAULT_HANNAH_DISCORD_USER_IDS[0]
HEADERS = {"X-BookieBot-App": "1", "Origin": "http://127.0.0.1"}


def subscription(suffix="one"):
    key = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {"endpoint": f"https://web.push.apple.com/{suffix}", "keys": {"p256dh": base64.urlsafe_b64encode(key).decode().rstrip("="), "auth": base64.urlsafe_b64encode(b"0123456789abcdef").decode().rstrip("=")}}


@pytest.fixture(params=["sqlite", "postgres"])
def store(request, tmp_path):
    if request.param == "sqlite":
        access = AppAccessStore(tmp_path / "push.sqlite3")
        access.initialize()
        yield storage.PhoneNotificationStore(access)
        return
    url = os.getenv("BOOKIEBOT_TEST_POSTGRES_URL", "").strip()
    if not url:
        pytest.skip("Set BOOKIEBOT_TEST_POSTGRES_URL for isolated PostgreSQL push contracts")
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo
    schema = "bookiebot_push_" + uuid.uuid4().hex
    with psycopg.connect(url, autocommit=True, connect_timeout=5) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            access = PostgresAppAccessStore(make_conninfo(url, options=f"-csearch_path={schema}", connect_timeout=5))
            access.initialize()
            yield storage.PhoneNotificationStore(access)
        finally:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def opt_in(store, actor=BRIAN, owner="brian", *, endpoint="one", preferences=None):
    token, session = store.access.consume_pairing(store.access.issue_pairing(actor, owner))
    digest = storage.session_hash(token)
    store.subscribe(digest, session, subscription(endpoint), preferences or dict(storage.DEFAULT_PREFERENCES))
    return token, session, digest


def test_vapid_key_persists_and_is_valid_under_concurrent_initialization(store):
    with ThreadPoolExecutor(max_workers=4) as pool:
        keys = list(pool.map(lambda _: store.keys(), range(4)))
    assert len(set(keys)) == 1
    assert storage.PhoneNotificationStore(store.access).keys() == keys[0]
    from py_vapid import Vapid
    vapid = Vapid.from_string(keys[0][0])
    claims = vapid.sign({"sub": "https://bookiebot.example", "aud": "https://web.push.apple.com"})
    assert "authorization" in {name.lower() for name in claims}


def test_preferences_are_device_scoped_and_revocation_removes_eligibility(store):
    assert store.active(0) == []
    brian, _, b_hash = opt_in(store)
    hannah, _, h_hash = opt_in(store, HANNAH, "hannah", endpoint="two", preferences={**storage.DEFAULT_PREFERENCES, "upcoming": True})
    assert store.settings(b_hash)["preferences"]["upcoming"] is False
    assert store.settings(h_hash)["preferences"]["upcoming"] is True
    store.access.revoke_session(brian)
    assert [row["session_hash"] for row in store.active(0)] == [h_hash]
    store.access.revoke_owner("hannah")
    assert store.active(0) == []
    assert not store.is_active(h_hash, 0)
    store.prune(0)
    assert store.settings(b_hash)["enabled"] is False
    assert store.settings(h_hash)["enabled"] is False


def test_endpoint_cannot_be_stolen_by_another_active_owner(store):
    token, _, first = opt_in(store)
    token2, session2 = store.access.consume_pairing(store.access.issue_pairing(HANNAH, "hannah"))
    with pytest.raises(ValueError, match="another phone session"):
        store.subscribe(storage.session_hash(token2), session2, subscription(), dict(storage.DEFAULT_PREFERENCES))
    assert store.settings(first)["enabled"] is True
    store.access.revoke_session(token)
    store.subscribe(storage.session_hash(token2), session2, subscription(), dict(storage.DEFAULT_PREFERENCES))
    assert store.settings(first)["enabled"] is False


def test_claim_is_atomic_retries_are_bounded_and_acceptance_is_durable(store):
    _, _, digest = opt_in(store)
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(lambda _: store.claim(digest, "weekly:2026-09-07", 100), range(4)))
    assert claims.count(True) == 1
    store.complete(digest, "weekly:2026-09-07", 100, accepted=False, retryable=True)
    assert not store.claim(digest, "weekly:2026-09-07", 399)
    assert store.claim(digest, "weekly:2026-09-07", 400)
    store.complete(digest, "weekly:2026-09-07", 400, accepted=False, retryable=True)
    assert store.claim(digest, "weekly:2026-09-07", 1000)
    store.complete(digest, "weekly:2026-09-07", 1000, accepted=False, retryable=True)
    assert not store.claim(digest, "weekly:2026-09-07", 99999)
    assert store.claim(digest, "upcoming:2026-09-07", 100)
    store.complete(digest, "upcoming:2026-09-07", 100, accepted=True)
    reopened = storage.PhoneNotificationStore(store.access)
    assert not reopened.can_attempt(digest, "upcoming:2026-09-07", 99999)
    assert not reopened.claim(digest, "upcoming:2026-09-07", 99999)


def test_privacy_change_and_expiry_invalidate_inflight_device(store):
    _, session, digest = opt_in(store)
    device = store.active(0)[0]
    assert store.still_matches(device, 0)
    assert not store.still_matches(device, session.expires_at)
    store.subscribe(digest, session, json.loads(device["subscription"]), {**storage.DEFAULT_PREFERENCES, "showAmounts": True})
    assert not store.still_matches(device, 0)
    store.unsubscribe(digest)
    assert not store.is_active(digest, 0)


@pytest.mark.parametrize("change", ["endpoint", "preferences", "unchanged"])
def test_expired_send_only_revokes_the_subscription_it_sent(store, change):
    _, session, digest = opt_in(store)
    device = store.active(0)[0]
    if change != "unchanged":
        replacement = subscription("replacement") if change == "endpoint" else json.loads(device["subscription"])
        preferences = {**storage.DEFAULT_PREFERENCES, "showAmounts": change == "preferences"}
        store.subscribe(digest, session, replacement, preferences)
    assert store.expire_subscription(device) is (change == "unchanged")
    assert store.settings(digest)["enabled"] is (change != "unchanged")


@pytest.mark.parametrize("url", ["http://web.push.apple.com/x", "https://127.0.0.1/x", "https://web.push.apple.com.evil.test/x", "https://web.push.apple.com@evil.test/x", "https://user@web.push.apple.com/x", "https://web.push.apple.com:8443/x", "https://web.push.apple.com/x#secret", "https://web.push.apple.com/\nfoo", "https://169.254.169.254/latest/meta-data"])
def test_untrusted_push_endpoints_are_rejected(url):
    with pytest.raises(ValueError):
        storage.validate_subscription({**subscription(), "endpoint": url})


def test_invalid_keys_and_preferences_are_rejected():
    valid = subscription()
    assert storage.validate_subscription(valid) == valid
    for value in (None, {}, {**valid, "keys": {"p256dh": "A" * 87, "auth": "A" * 22}}):
        with pytest.raises(ValueError):
            storage.validate_subscription(value)
    for value in ({}, {**storage.DEFAULT_PREFERENCES, "hour": True}, {**storage.DEFAULT_PREFERENCES, "hour": 23}, {**storage.DEFAULT_PREFERENCES, "weekly": False}):
        with pytest.raises(ValueError):
            storage.validate_preferences(value)


@pytest_asyncio.fixture
async def phone(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "http://127.0.0.1")
    access = AppAccessStore(tmp_path / "routes.sqlite3")
    access.initialize()
    store = storage.PhoneNotificationStore(access)
    monkeypatch.setattr(phone_app, "build_app_access_store", lambda: access)
    monkeypatch.setattr(push, "build_phone_notification_store", lambda: store)
    app = web.Application()
    push.register_phone_notification_routes(app, start_scheduler=False)
    builds = []
    async def report(payload):
        builds.append(payload)
        return {"metrics": {"personalOutflows": 1234}, "calendarEvents": [{"kind": "bill", "day": 1, "amount": 2000}, {"kind": "income", "day": 1, "amount": 3000}]}
    app[_REPORT_BUILDS] = SimpleNamespace(data=report)
    sends = []
    def send(*args):
        sends.append(args)
        return True, False, False
    monkeypatch.setattr(push, "_send_push", send)
    async with TestClient(TestServer(app), cookie_jar=CookieJar(unsafe=True)) as client:
        yield SimpleNamespace(client=client, store=store, app=app, builds=builds, sends=sends)


def cookie(token):
    return {**HEADERS, "Cookie": f"bb_phone_local={token}"}


@pytest.mark.asyncio
async def test_routes_require_phone_session_same_origin_and_no_owner_input(phone):
    assert (await phone.client.get("/app/notifications")).status == 401
    token, session = phone.store.access.consume_pairing(phone.store.access.issue_pairing(BRIAN, "brian"))
    body = {"subscription": subscription(), "preferences": dict(storage.DEFAULT_PREFERENCES), "owner": "hannah"}
    assert (await phone.client.post("/app/notifications", json=body, headers={"Cookie": cookie(token)["Cookie"]})).status == 403
    assert (await phone.client.post("/app/notifications", json=body, headers={**cookie(token), "Origin": "https://evil.test"})).status == 403
    result = await phone.client.post("/app/notifications", json=body, headers=cookie(token))
    assert result.status == 200
    assert phone.store.active(0)[0]["owner_key"] == "brian"
    settings = await phone.client.get("/app/notifications", headers=cookie(token))
    data = await settings.json()
    assert data["enabled"] is True and len(data["publicKey"]) == 87
    assert "private_key" not in data and "subscription" not in data
    assert settings.headers["Cache-Control"] == "private, no-store"
    assert (await phone.client.delete("/app/notifications", headers=cookie(token))).status == 200
    assert not phone.store.active(0)
    assert not phone.sends


@pytest.mark.asyncio
async def test_opt_in_weekly_timing_dedup_and_owner_report_scope(phone):
    assert await push.send_due_phone_notifications(phone.app, datetime(2026, 9, 7, 10)) == 0
    assert not phone.builds and not phone.sends
    token, _, _ = opt_in(phone.store, HANNAH, "hannah")
    assert await push.send_due_phone_notifications(phone.app, datetime(2026, 9, 7, 9)) == 0
    assert await push.send_due_phone_notifications(phone.app, datetime(2026, 9, 8, 10)) == 0
    assert await push.send_due_phone_notifications(phone.app, datetime(2026, 9, 7, 10)) == 1
    assert phone.builds[0]["actor_key"] == HANNAH and phone.builds[0]["owner_name"] == "Hannah"
    assert "$" not in phone.sends[0][1]["body"]
    assert await push.send_due_phone_notifications(phone.app, datetime(2026, 9, 7, 10, 5)) == 0
    assert len(phone.builds) == 1 and len(phone.sends) == 1
    phone.store.access.revoke_session(token)
    assert await push.send_due_phone_notifications(phone.app, datetime(2026, 9, 14, 10)) == 0


@pytest.mark.asyncio
async def test_upcoming_opt_in_reads_next_year_and_excludes_income(phone):
    opt_in(phone.store, preferences={**storage.DEFAULT_PREFERENCES, "weekly": False, "upcoming": True, "showAmounts": True})
    assert await push.send_due_phone_notifications(phone.app, datetime(2026, 12, 31, 10)) == 1
    assert phone.builds[0]["year"] == 2027 and phone.builds[0]["month"] == 1
    assert phone.sends[0][1]["body"] == "1 scheduled payment tomorrow, estimated $2,000.00."


@pytest.mark.asyncio
async def test_revoked_or_changed_preferences_during_sheet_read_never_send(phone):
    _, session, digest = opt_in(phone.store)
    async def report(payload):
        phone.store.unsubscribe(digest)
        return {"metrics": {"personalOutflows": 1234}}
    phone.app[_REPORT_BUILDS].data = report
    assert await push.send_due_phone_notifications(phone.app, datetime(2026, 9, 7, 10)) == 0
    assert not phone.sends


@pytest.mark.asyncio
async def test_transient_failure_not_marked_sent_and_expired_subscription_disabled(phone, monkeypatch):
    _, _, digest = opt_in(phone.store)
    monkeypatch.setattr(push, "_send_push", lambda *args: (False, True, False))
    assert await push.send_due_phone_notifications(phone.app, datetime(2026, 9, 7, 10)) == 0
    with phone.store.access.connect() as connection:
        row = connection.execute("SELECT status,attempts FROM app_push_deliveries").fetchone()
    assert row["status"] == "retry" and row["attempts"] == 1
    monkeypatch.setattr(push, "_send_push", lambda *args: (False, False, True))
    assert await push.send_due_phone_notifications(phone.app, datetime(2026, 9, 14, 10)) == 0
    assert phone.store.settings(digest)["enabled"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("delivery", ["scheduled", "test"])
async def test_old_expired_response_preserves_replacement_phone_opt_in(phone, monkeypatch, delivery):
    token, session, digest = opt_in(phone.store)
    replacement = subscription("replacement")

    def expired_old_send(*args):
        phone.store.unsubscribe(digest)
        phone.store.subscribe(digest, session, replacement, dict(storage.DEFAULT_PREFERENCES))
        return False, False, True

    monkeypatch.setattr(push, "_send_push", expired_old_send)
    if delivery == "test":
        assert (await phone.client.post("/app/notifications/test", headers=cookie(token))).status == 503
    else:
        assert await push.send_due_phone_notifications(phone.app, datetime(2026, 9, 7, 10)) == 0
    devices = phone.store.active(0)
    assert len(devices) == 1
    assert json.loads(devices[0]["subscription"]) == replacement


@pytest.mark.asyncio
async def test_explicit_generic_test_is_scoped_and_rate_limited(phone):
    token, _, _ = opt_in(phone.store)
    assert (await phone.client.post("/app/notifications/test", headers=cookie(token))).status == 200
    assert (await phone.client.post("/app/notifications/test", headers=cookie(token))).status == 429
    assert len(phone.sends) == 1 and "$" not in phone.sends[0][1]["body"]
    assert not phone.builds


@pytest.mark.asyncio
async def test_worker_is_scoped_and_has_no_cache_or_arbitrary_click_destination(phone):
    result = await phone.client.get("/app/notifications/worker.js")
    body = await result.text()
    assert result.headers["Service-Worker-Allowed"] == "/app/"
    assert 'addEventListener("fetch"' not in body and "caches." not in body
    assert 'showNotification("BookieBot"' in body
    assert 'openWindow("/app/expenses")' in body


def test_transport_encrypts_signs_and_disables_redirects(monkeypatch, tmp_path):
    import requests
    access = AppAccessStore(tmp_path / "keys.sqlite3")
    access.initialize()
    key = storage.PhoneNotificationStore(access).keys()[0]
    calls = []
    def request(self, method, url, **kwargs):
        calls.append((self, method, url, kwargs))
        return SimpleNamespace(status_code=201, text="", headers={}, reason="Created")
    monkeypatch.setattr(requests.Session, "request", request)
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "https://bookiebot.example")
    payload = {"body": "private test content"}
    assert push._send_push(subscription(), payload, key) == (True, False, False)
    client, method, url, kwargs = calls[0]
    assert client.trust_env is False and kwargs["allow_redirects"] is False and kwargs["timeout"] == 15
    assert "authorization" in {key.lower() for key in kwargs["headers"]}
    assert b"private test content" not in kwargs["data"]
