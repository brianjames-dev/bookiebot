from types import SimpleNamespace
from unittest.mock import Mock
from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reports import phone_app, phone_bills, bill_settings as service
from unit_tests.reports.test_bill_settings import saved as saved, command, B
from unit_tests.reports.test_goals_store import access as access

HEADERS = {"Origin": "http://127.0.0.1", "X-BookieBot-App": "1", "Content-Type": "application/json"}


@pytest_asyncio.fixture
async def client(monkeypatch, saved):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "http://127.0.0.1")
    monkeypatch.setattr(phone_app, "build_app_access_store", lambda: saved.commands.access)
    monkeypatch.setattr(service, "build_commands", lambda: saved.commands)
    app = web.Application()
    phone_bills.register_phone_bill_routes(app)
    http = TestClient(TestServer(app), cookie_jar=CookieJar(unsafe=True))
    await http.start_server()
    token = saved.commands.access.issue_pairing(B, "brian")
    cookie, _ = saved.commands.access.consume_pairing(token)
    def connect():
        http.session.cookie_jar.update_cookies({phone_app._cookie_name(): cookie})
    yield SimpleNamespace(http=http, saved=saved, connect=connect, access=saved.commands.access)
    await http.close()


@pytest.mark.asyncio
async def test_cookie_and_same_origin_before_any_bill_service(client, monkeypatch):
    read, write = Mock(side_effect=AssertionError("No read")), Mock(side_effect=AssertionError("No write"))
    monkeypatch.setattr(service, "listing", read)
    monkeypatch.setattr(service.BillCommands, "command", write)
    for path in ["/app/bills", "/app/bills/commands/request", "/app/bills/plan/charge"]:
        assert (await client.http.get(path)).status == 401
    for path in ["/app/bills", "/app/bills/review"]:
        assert (await client.http.post(path, headers=HEADERS, json={})).status == 401
    client.connect()
    for headers in [{}, {**HEADERS, "Origin": "https://foreign.invalid"}, {**HEADERS, "Sec-Fetch-Site": "cross-site"}]:
        assert (await client.http.post("/app/bills", headers=headers, json={})).status == 403
    assert (await client.http.post("/app/bills", headers=HEADERS, data="x" * 8193)).status == 400
    assert (await client.http.post("/app/bills/review", headers=HEADERS, json=[])).status == 400
    read.assert_not_called()
    write.assert_not_called()


@pytest.mark.asyncio
async def test_private_bill_listing_review_confirm_and_idempotent_status(client):
    client.connect()
    response = await client.http.get("/app/bills")
    value = await response.json()
    assert response.status == 200 and response.headers["Cache-Control"] == "private, no-store"
    assert len(value["bills"]) == 1
    assert not {"spreadsheetId", "source_range", "source_row"} & value["bills"][0].keys()
    body = command(client.saved)
    assert (await client.http.post("/app/bills/review", headers=HEADERS, json={**body, "owner": "hannah"})).status == 400
    review = await client.http.post("/app/bills/review", headers=HEADERS, json=body)
    assert review.status == 200 and not client.saved.client.http_client.sent
    first = await client.http.post("/app/bills", headers=HEADERS, json=body)
    result = await first.json()
    assert first.status == 200 and result["success"]
    assert await (await client.http.post("/app/bills", headers=HEADERS, json=body)).json() == result
    assert await (await client.http.get("/app/bills/commands/" + body["requestId"])).json() == result
    assert len(client.saved.client.http_client.sent) == 1


@pytest.mark.asyncio
async def test_revoked_during_read_never_returns_bills(client, monkeypatch):
    client.connect()
    def revoked(actor):
        client.access.revoke_owner("brian")
        return {"private": "not returned"}
    monkeypatch.setattr(service, "listing", revoked)
    response = await client.http.get("/app/bills")
    assert response.status == 401 and "private" not in await response.json()


@pytest.mark.asyncio
async def test_upstream_failure_is_not_an_empty_list_or_a_private_payload(client, monkeypatch):
    client.connect()
    monkeypatch.setattr(service, "listing", Mock(side_effect=TimeoutError("private source data")))
    response = await client.http.get("/app/bills")
    data = await response.json()
    assert response.status == 503 and "bills" not in data and "private source data" not in str(data)
