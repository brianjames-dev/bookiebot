import asyncio
from datetime import datetime
from types import SimpleNamespace
from urllib.parse import urlsplit

from aiohttp import CookieJar
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reports import phone_app, web as reports_web
from bookiebot.reports.app_access import AppAccessStore
from bookiebot.sheets.routing import DEFAULT_BRIAN_DISCORD_USER_IDS, DEFAULT_HANNAH_DISCORD_USER_IDS

BRIAN = DEFAULT_BRIAN_DISCORD_USER_IDS[0]
HANNAH = DEFAULT_HANNAH_DISCORD_USER_IDS[0]
HEADERS = {"X-BookieBot-App": "1", "Origin": "http://127.0.0.1"}


@pytest_asyncio.fixture
async def phone(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "http://127.0.0.1")
    monkeypatch.setenv("BOOKIEBOT_PHONE_NOTIFICATIONS_ENABLED", "false")
    store = AppAccessStore(tmp_path / "access.sqlite3")
    store.initialize()
    monkeypatch.setattr(phone_app, "build_app_access_store", lambda: store)
    monkeypatch.setattr(phone_app, "now_pacific", lambda: datetime(2026, 9, 30, 23, 59))
    calls = []
    def data(payload):
        calls.append(payload)
        return {"ownerName": payload["owner_name"], "year": payload["year"], "month": payload["month"], "persons": payload["persons"], "revision": len(calls)}
    monkeypatch.setattr(reports_web, "_render_live_report_data", data)
    app = reports_web.web.Application()
    reports_web.register_report_routes(app)
    async with TestClient(TestServer(app), cookie_jar=CookieJar(unsafe=True)) as client:
        yield SimpleNamespace(client=client, store=store, calls=calls, app=app)


async def connect(phone, actor=BRIAN):
    url = phone_app.create_phone_setup_url(actor)
    token = urlsplit(url).fragment
    response = await phone.client.post("/app/connect", json={"token": token}, headers=HEADERS)
    assert response.status == 200
    return token, response


@pytest.mark.asyncio
async def test_setup_link_is_private_one_time_and_preview_safe(phone):
    url = phone_app.create_phone_setup_url(BRIAN)
    parsed = urlsplit(url)
    assert parsed.path == "/app/connect" and not parsed.query
    token = parsed.fragment
    for _ in range(2):
        page = await phone.client.get("/app/connect")
        assert page.status == 200
        assert token not in await page.text()
        preview = await phone.client.post("/app/pairing", json={"token": token}, headers=HEADERS)
        assert (await preview.json())["ownerName"] == "Brian"
    assert phone.store.peek_pairing(token) is not None
    response = await phone.client.post("/app/connect", json={"token": token}, headers=HEADERS)
    assert response.status == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    cookie = response.cookies["bb_phone_local"]
    assert cookie["httponly"] and cookie["samesite"] == "Lax" and cookie["path"] == "/"
    assert int(cookie["max-age"]) == phone_app.SESSION_TTL_SECONDS
    assert phone.store.peek_pairing(token) is None
    assert (await phone.client.post("/app/connect", json={"token": token}, headers=HEADERS)).status == 401


@pytest.mark.asyncio
async def test_phone_data_ignores_caller_identity_and_selects_current_month(phone, monkeypatch):
    await connect(phone)
    first = await phone.client.get(f"/app/expenses/data?actor_key={HANNAH}&owner_name=Hannah&year=2025")
    assert await first.json() == {"ownerName": "Brian", "year": 2026, "month": 9, "persons": ["Brian (BofA)"], "revision": 1}
    assert first.headers["Cache-Control"] == "private, no-store"
    monkeypatch.setattr(phone_app, "now_pacific", lambda: datetime(2026, 10, 1))
    second = await phone.client.get("/app/expenses/data")
    assert (await second.json())["month"] == 10
    assert len(phone.calls) == 2
    await connect(phone, HANNAH)
    third = await phone.client.get("/app/expenses/data")
    assert (await third.json())["persons"] == ["Hannah"]
    assert phone.calls[-1]["actor_key"] == HANNAH


@pytest.mark.asyncio
async def test_phone_history_validates_selection_without_accepting_owner_overrides(phone, monkeypatch):
    await connect(phone)
    catalog_calls = []
    def catalog(payload):
        catalog_calls.append(payload)
        return {"months": [{"value": "2026-08"}], "coverage": {"status": "complete", "unavailableYears": []}}
    monkeypatch.setattr(reports_web, "_render_live_report_catalog", catalog)
    malformed = await phone.client.get("/app/expenses/data?month=1")
    future = await phone.client.get("/app/expenses/data?month=2026-10")
    assert malformed.status == future.status == 400
    assert phone.calls == catalog_calls == []
    missing = await phone.client.get("/app/expenses/data?month=2026-07")
    assert missing.status == 404
    assert phone.calls == []
    selected = await phone.client.get(f"/app/expenses/data?month=2026-08&actor_key={HANNAH}&owner_name=Hannah&persons=Hannah")
    assert selected.status == 200
    assert (await selected.json())["month"] == 8
    assert phone.calls[0]["persons"] == ["Brian (BofA)"]
    assert phone.calls[0]["actor_key"] == BRIAN


@pytest.mark.asyncio
async def test_shell_is_public_but_data_requires_session_not_report_token(phone):
    page = await phone.client.get("/app/expenses")
    html = await page.text()
    assert page.status == 200 and "bookiebot-expense-app-config" in html
    assert "bookiebot-expense-report-data" not in html
    assert "manifest.webmanifest" in html and "apple-touch-icon" in html
    assert "frame-ancestors 'none'" in page.headers["Content-Security-Policy"]
    token = reports_web.create_expense_report_token(actor_key=BRIAN, owner_name="Brian", persons=["Brian (BofA)"], year=2026, month=9)
    response = await phone.client.get(f"/app/expenses/data?token={token}")
    assert response.status == 401
    assert not phone.calls


@pytest.mark.asyncio
async def test_all_registered_private_phone_features_require_a_phone_session(phone, monkeypatch):
    from bookiebot.reports import phone_goals, phone_notifications, phone_questions

    forbidden_calls = []

    def forbidden(*args, **kwargs):
        forbidden_calls.append("private work")
        raise AssertionError("An unauthorized phone request reached private work")

    monkeypatch.setattr(reports_web, "_render_live_report_catalog", forbidden)
    monkeypatch.setattr(phone_goals, "build_goals_store", forbidden)
    monkeypatch.setattr(phone_notifications, "build_phone_notification_store", forbidden)
    monkeypatch.setattr(phone_notifications, "_send_push", forbidden)
    monkeypatch.setattr(phone_questions, "answer_report_question", forbidden)
    token = reports_web.create_expense_report_token(
        actor_key=BRIAN, owner_name="Brian", persons=["Brian (BofA)"], year=2026, month=9)
    endpoints = [
        ("GET", "/app/expenses/data"),
        ("GET", "/app/expenses/months"),
        ("GET", "/app/expenses/comparison"),
        ("POST", "/app/expenses/ask"),
        ("GET", "/app/notifications"),
        ("POST", "/app/notifications"),
        ("DELETE", "/app/notifications"),
        ("POST", "/app/notifications/test"),
        ("GET", "/app/goals"),
        ("POST", "/app/goals"),
        ("GET", "/app/goals/example/contributions"),
    ]
    for suffix in ("", f"?token={token}"):
        for method, endpoint in endpoints:
            response = await phone.client.request(method, endpoint + suffix, headers=HEADERS)
            assert response.status == 401, (method, endpoint)
            assert response.headers["Cache-Control"] == "private, no-store"
    await connect(phone)
    for method, endpoint in endpoints:
        if method != "GET":
            response = await phone.client.request(method, endpoint, headers={**HEADERS, "Origin": "https://untrusted.test"})
            assert response.status == 403, (method, endpoint)
    phone_app.reset_phone_access(BRIAN)
    for method, endpoint in endpoints:
        assert (await phone.client.request(method, endpoint, headers=HEADERS)).status == 401
    assert forbidden_calls == []
    assert phone.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("headers", [{}, {"X-BookieBot-App": "1", "Origin": "https://untrusted.test"},
                                     {**HEADERS, "Origin": "null"}, {**HEADERS, "Sec-Fetch-Site": "cross-site"}])
async def test_cross_origin_pairing_and_logout_are_rejected(phone, headers):
    token = urlsplit(phone_app.create_phone_setup_url(BRIAN)).fragment
    for endpoint in ("/app/pairing", "/app/connect", "/app/logout"):
        assert (await phone.client.post(endpoint, json={"token": token}, headers=headers)).status == 403
    assert phone.store.peek_pairing(token) is not None


@pytest.mark.asyncio
async def test_secure_cookie_and_account_mapping_change(phone, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "https://bookiebot.example")
    token = urlsplit(phone_app.create_phone_setup_url(BRIAN)).fragment
    response = await phone.client.post("/app/connect", json={"token": token}, headers={**HEADERS, "Origin": "https://bookiebot.example"})
    cookie = response.cookies["__Host-bb_phone"]
    assert cookie["secure"] and cookie["httponly"] and not cookie["domain"] and cookie["path"] == "/"
    session_token = cookie.value
    monkeypatch.setattr(phone_app, "get_user_config", lambda actor: SimpleNamespace(budget_owner_key="hannah"))
    result = await phone.client.get("/app/expenses/data", headers={"Cookie": f"__Host-bb_phone={session_token}"})
    assert result.status == 401 and not phone.calls
    logout = await phone.client.post("/app/logout", headers={"X-BookieBot-App": "1", "Origin": "https://bookiebot.example", "Cookie": f"__Host-bb_phone={session_token}"})
    deleted = logout.cookies["__Host-bb_phone"]
    assert deleted["secure"] and deleted["httponly"] and deleted["max-age"] == "0"


@pytest.mark.asyncio
async def test_revocation_and_logout_invalidate_access(phone):
    await connect(phone)
    assert (await phone.client.get("/app/expenses/data")).status == 200
    assert (await phone.client.post("/app/logout", headers=HEADERS)).status == 204
    assert (await phone.client.get("/app/expenses/data")).status == 401
    await connect(phone)
    pending = urlsplit(phone_app.create_phone_setup_url(BRIAN)).fragment
    phone_app.reset_phone_access(BRIAN)
    assert phone.store.peek_pairing(pending) is None
    assert (await phone.client.get("/app/expenses/data")).status == 401


@pytest.mark.asyncio
async def test_revocation_during_build_drops_result(phone, monkeypatch):
    await connect(phone)
    async def data(payload):
        phone.store.revoke_owner("brian")
        return {"secret": "must not be returned"}
    monkeypatch.setattr(phone.app[reports_web._REPORT_BUILDS], "data", data)
    result = await phone.client.get("/app/expenses/data")
    assert result.status == 401 and "secret" not in await result.text()


@pytest.mark.asyncio
async def test_refresh_failures_never_return_snapshot_or_exception_details(phone, monkeypatch):
    await connect(phone)
    def fail(payload):
        raise RuntimeError("private internal exception")
    monkeypatch.setattr(reports_web, "_render_live_report_data", fail)
    result = await phone.client.get("/app/expenses/data")
    assert result.status == 503
    assert "private internal" not in await result.text()
    assert result.headers["Cache-Control"] == "private, no-store"


@pytest.mark.asyncio
async def test_asset_allowlist_manifest_and_existing_rotating_avatar(phone):
    manifest = await (await phone.client.get("/app/manifest.webmanifest")).json()
    assert manifest["start_url"] == "/app/expenses" and manifest["display"] == "standalone"
    icon = await phone.client.get("/app/icon.png")
    assert await icon.read() == phone_app._AVATAR.read_bytes()
    avatar = await phone.client.get("/app/avatar.png")
    assert avatar.status == 200 and avatar.headers["Content-Type"].startswith("image/")
    assert (await phone.client.get("/app/assets/phone-setup.js")).status == 200
    assert (await phone.client.get("/app/assets/not-public.py")).status == 404


@pytest.mark.asyncio
async def test_invalid_inputs_expiry_and_mapped_actor_only(phone, monkeypatch):
    for actor in ("shortcut:brian", phone_app.APPLE_SHORTCUT_RELAY_USER_ID, "not-an-id", "12345"):
        with pytest.raises((ValueError, RuntimeError)):
            phone_app.create_phone_setup_url(actor)
    for token in (None, {}, "x" * 129, "bad-token"):
        response = await phone.client.post("/app/connect", json={"token": token}, headers=HEADERS)
        assert response.status in (400, 401)
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "http://public.example")
    with pytest.raises(ValueError, match="HTTPS"):
        phone_app.create_phone_setup_url(BRIAN)


@pytest.mark.asyncio
async def test_frontend_update_version_matches_shell_and_contains_no_private_data(phone):
    import json
    import re
    response = await phone.client.get('/app/version')
    assert response.status == 200
    assert response.headers['Cache-Control'] == 'no-store'
    version = await response.json()
    assert set(version) == {'version'}
    assert re.fullmatch(r'[a-f0-9]{24}', version['version'])
    shell = await (await phone.client.get('/app/expenses')).text()
    config = json.loads(re.search(r'id="bookiebot-expense-app-config" type="application/json">(.*?)</script>', shell).group(1))
    assert config['version'] == version['version']
    assert not phone.calls
