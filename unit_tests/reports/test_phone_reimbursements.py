from types import SimpleNamespace
from uuid import uuid4

from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reimbursements import projection, service
from bookiebot.reimbursements.store import ReimbursementStore
from bookiebot.reports import app_access, phone_app, phone_reimbursements
from bookiebot.reports.app_access import AppAccessStore
from bookiebot.sheets.routing import now_pacific

BRIAN = "676638528590970917"
HANNAH = "830984827904851969"
HEADERS = {"X-BookieBot-App": "1", "Origin": "http://127.0.0.1"}


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "http://127.0.0.1")
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "true")
    access = AppAccessStore(tmp_path / "access.sqlite3")
    access.initialize()
    store = ReimbursementStore(access)
    store.initialize()
    allocation = store.register_allocation({
        "id": uuid4().hex, "payerOwner": "brian", "partnerOwner": "hannah",
        "payerPerson": "Brian (BofA)", "item": "Private shared expense", "location": "Utility",
        "expenseDate": "2026-01-03", "category": "Need", "sourceWorksheet": "expense",
        "sourceRow": 10, "sourceActionId": uuid4().hex, "splitActionId": uuid4().hex,
        "sourceYear": 2026, "sourceSpreadsheetId": "", "grossCents": 10000,
        "payerShareCents": 6000, "partnerShareCents": 4000, "settledCents": 0,
        "method": "income", "accounting": "cash_v1",
    })
    monkeypatch.setattr(phone_app, "build_app_access_store", lambda: access)
    monkeypatch.setattr(service, "build_reimbursement_store", lambda: store)
    # Exercise real durable commands, but never access Google Sheets in API tests.
    monkeypatch.setattr(projection, "sync_pending", lambda _store: False)
    app = web.Application()
    phone_reimbursements.register_phone_reimbursement_routes(app)
    async with TestClient(TestServer(app), cookie_jar=CookieJar(unsafe=True)) as http:
        yield SimpleNamespace(http=http, access=access, store=store, allocation=allocation)


def connect(client, actor=BRIAN, owner="brian"):
    paired = client.access.consume_pairing(client.access.issue_pairing(actor, owner))
    assert paired is not None
    client.http.session.cookie_jar.update_cookies({"bb_phone_local": paired[0]})
    return paired


def payment(client, **changes):
    return {"operation": "receive", "requestId": uuid4().hex,
            "allocationId": client.allocation["id"], "version": client.allocation["version"],
            "amountCents": 1025, "date": now_pacific().date().isoformat(), "note": "Already received",
            **changes}


def assert_unchanged(client):
    assert client.store.get_allocation(client.allocation["id"])["settledCents"] == 0
    assert client.store.snapshot("brian")["events"] == []


@pytest.mark.asyncio
async def test_reimbursements_require_auth_and_force_session_identity(client):
    assert (await client.http.get("/app/reimbursements")).status == 401
    assert (await client.http.post("/app/reimbursements", json=payment(client), headers=HEADERS)).status == 401
    connect(client)
    result = await client.http.get("/app/reimbursements?owner=hannah&ownerKey=hannah")
    assert result.status == 200
    assert result.headers["Cache-Control"] == "private, no-store"
    assert (await result.json())["ownerKey"] == "brian"
    connect(client, HANNAH, "hannah")
    result = await client.http.get("/app/reimbursements?owner=brian")
    assert (await result.json())["ownerKey"] == "hannah"
    result = await client.http.post("/app/reimbursements?owner=brian", json=payment(client), headers=HEADERS)
    assert result.status == 400, "A debtor cannot select the payer through query parameters"
    assert_unchanged(client)


@pytest.mark.asyncio
@pytest.mark.parametrize("headers", [
    {}, {"Origin": "http://127.0.0.1"}, {**HEADERS, "X-BookieBot-App": "0"},
    {**HEADERS, "Origin": "https://attacker.test"}, {**HEADERS, "Origin": "null"},
    {**HEADERS, "Sec-Fetch-Site": "cross-site"},
])
async def test_cross_site_commands_never_mutate(client, headers):
    connect(client)
    result = await client.http.post("/app/reimbursements", json=payment(client), headers=headers)
    assert result.status == 403
    assert_unchanged(client)


@pytest.mark.asyncio
async def test_feature_off_returns_authenticated_legacy_signal(client, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false")
    assert (await client.http.get("/app/reimbursements")).status == 401
    connect(client)

    def unexpected(*_args, **_kwargs):
        raise AssertionError("Feature-off requests must not read or mutate the canonical ledger")

    monkeypatch.setattr(service, "snapshot", unexpected)
    monkeypatch.setattr(service, "command", unexpected)
    for result in [await client.http.get("/app/reimbursements"),
                   await client.http.post("/app/reimbursements", json=payment(client), headers=HEADERS)]:
        assert result.status == 200
        assert await result.json() == {"enabled": False}
        assert result.headers["Cache-Control"] == "private, no-store"
    assert_unchanged(client)


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["owner", "ownerKey", "owner_key", "actorOwner", "payerOwner"])
async def test_body_cannot_override_authenticated_owner(client, field):
    connect(client)
    result = await client.http.post("/app/reimbursements", json=payment(client, **{field: "hannah"}), headers=HEADERS)
    assert result.status == 400
    assert_unchanged(client)


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [b"", b"{", b"null", b"[]", b'"payment"', b"\xff"])
async def test_malformed_or_nonobject_body_returns_400(client, body):
    connect(client)
    result = await client.http.post("/app/reimbursements", data=body, headers=HEADERS)
    assert result.status == 400
    assert await result.json() == {"error": "Invalid settlement request."}
    assert_unchanged(client)


@pytest.mark.asyncio
@pytest.mark.parametrize("chunked", [False, True])
async def test_oversize_body_is_bounded_before_command(client, chunked):
    connect(client)

    async def chunks():
        for _ in range(17):
            yield b" " * 1024

    result = await client.http.post("/app/reimbursements", data=chunks() if chunked else b" " * 16_385, headers=HEADERS)
    assert result.status == 400
    assert "too large" in (await result.json())["error"]
    assert_unchanged(client)


@pytest.mark.asyncio
@pytest.mark.parametrize("changes,status", [
    ({"amountCents": 0}, 400), ({"allocationId": "missing-allocation"}, 404), ({"version": 0}, 409),
])
async def test_canonical_errors_keep_http_status_and_do_not_mutate(client, changes, status):
    connect(client)
    result = await client.http.post("/app/reimbursements", json=payment(client, **changes), headers=HEADERS)
    assert result.status == status
    assert (await result.json())["error"]
    assert_unchanged(client)


@pytest.mark.asyncio
async def test_command_persists_and_returns_full_snapshot_while_projection_is_pending(client):
    connect(client)
    body = payment(client)
    # Native same-origin requests without an Origin header still require the app header.
    result = await client.http.post("/app/reimbursements?owner=hannah", json=body, headers={"X-BookieBot-App": "1"})
    assert result.status == 200
    payload = await result.json()
    assert payload["enabled"] is True and payload["ownerKey"] == "brian" and payload["currency"] == "USD"
    assert payload["projectionPending"] is True
    assert payload["allocations"][0]["settledCents"] == 1025
    assert payload["allocations"][0]["outstandingCents"] == 2975
    assert payload["events"][0]["actorOwner"] == "brian"
    assert payload["events"][0]["status"] == "confirmed"
    reopened = ReimbursementStore(AppAccessStore(client.access.path))
    assert reopened.snapshot("brian")["events"] == payload["events"]
    retry = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert retry.status == 200
    assert (await retry.json())["events"] == payload["events"]
    assert len(reopened.snapshot("brian")["events"]) == 1


@pytest.mark.asyncio
async def test_projection_failure_after_commit_returns_503_and_retries_once(client, monkeypatch):
    connect(client)

    def lost_outcome(store):
        assert len(store.snapshot("brian")["events"]) == 1
        raise RuntimeError("Private infrastructure details")

    monkeypatch.setattr(projection, "sync_pending", lost_outcome)
    body = payment(client)
    result = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert result.status == 503
    assert "Retry the same action" in (await result.json())["error"]
    assert "Private infrastructure details" not in await result.text()
    assert client.store.get_allocation(client.allocation["id"])["settledCents"] == 1025
    monkeypatch.setattr(projection, "sync_pending", lambda _store: False)
    result = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert result.status == 200
    assert len((await result.json())["events"]) == 1
    assert client.store.get_allocation(client.allocation["id"])["version"] == 2


@pytest.mark.asyncio
async def test_read_unavailable_is_503_without_personal_data(client, monkeypatch):
    connect(client)

    def unavailable(*_args, **_kwargs):
        raise RuntimeError("Private database connection string")

    monkeypatch.setattr(service, "snapshot", unavailable)
    result = await client.http.get("/app/reimbursements")
    assert result.status == 503
    assert "Private" not in await result.text()
    assert_unchanged(client)


@pytest.mark.asyncio
@pytest.mark.parametrize("invalidate", ["revoke", "expire"])
async def test_session_invalidated_after_commit_hides_data_and_reconnect_retry_deduplicates(client, monkeypatch, invalidate):
    _, session = connect(client)
    original = service.command

    def commit_then_invalidate(owner, body):
        result = original(owner, body)
        if invalidate == "revoke":
            client.access.revoke_owner(owner)
        else:
            monkeypatch.setattr(app_access, "_now", lambda: session.expires_at)
        return result

    monkeypatch.setattr(service, "command", commit_then_invalidate)
    body = payment(client)
    result = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert result.status == 401
    assert "Private shared expense" not in await result.text()
    assert "allocations" not in await result.text()
    assert client.store.get_allocation(client.allocation["id"])["settledCents"] == 1025
    assert (await client.http.get("/app/reimbursements")).status == 401
    monkeypatch.setattr(service, "command", original)
    connect(client)
    retry = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert retry.status == 200
    payload = await retry.json()
    assert len(payload["events"]) == 1
    assert payload["allocations"][0]["version"] == 2
    assert payload["allocations"][0]["settledCents"] == 1025


@pytest.mark.asyncio
async def test_revoked_session_during_read_drops_personal_data(client, monkeypatch):
    connect(client)
    original = service.snapshot

    def revoke_during_read(owner, **kwargs):
        result = original(owner, **kwargs)
        client.access.revoke_owner(owner)
        return result

    monkeypatch.setattr(service, "snapshot", revoke_during_read)
    result = await client.http.get("/app/reimbursements")
    assert result.status == 401
    assert "Private shared expense" not in await result.text()
