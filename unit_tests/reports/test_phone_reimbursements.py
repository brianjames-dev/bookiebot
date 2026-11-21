from types import SimpleNamespace
import asyncio
from threading import Event
from uuid import uuid4

from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reimbursements import batch_projection, projection, service
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
    monkeypatch.setattr(batch_projection, "sync_received", lambda _store, _ids: False)
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
@pytest.mark.parametrize("kind", ["payment", "offset", "reset"])
async def test_queued_undo_is_responsive_durable_and_refreshes_both_accounts(client, monkeypatch, kind):
    from unit_tests.reimbursements.test_store import payload
    connect(client)
    original = client.allocation
    client.store.mark_projected(original["id"], original["version"])
    if kind == "offset":
        other = client.store.register_allocation(payload(payerOwner="hannah", partnerOwner="brian", payerPerson="Hannah"))
        client.store.mark_projected(other["id"], other["version"])
        body = {"operation": "offset", "requestId": uuid4().hex, "date": now_pacific().date().isoformat(), "entries": [
            {"allocationId": row["id"], "version": row["version"], "amountCents": 1025} for row in (original, other)]}
    elif kind == "reset":
        body = {"operation": "reset", "requestId": uuid4().hex, "expectedState": client.store.snapshot("brian")["resetState"]}
    else:
        body = payment(client)
    saved = await (await client.http.post("/app/reimbursements", json=body, headers=HEADERS)).json()
    assert saved["projectionPending"]
    gate = Event()
    recover = service.recover_queued_undos
    def delayed():
        assert gate.wait(5)
        return recover()
    def project(store):
        for row in store.pending_projections():
            store.mark_projected(row["id"], row["version"])
        return True
    monkeypatch.setattr(service, "recover_queued_undos", delayed)
    monkeypatch.setattr(projection, "sync_pending", project)
    target = {"action": "undo_reset", "resetId": saved["reset"]["id"], "version": saved["reset"]["version"]} if kind == "reset" else {"action": "reverse_operation", "operationId": saved["operationId"]}
    undo = {"operation": "queue_undo", "requestId": uuid4().hex, "expectedUndoState": saved["undoState"], **target}
    try:
        response = await asyncio.wait_for(client.http.post("/app/reimbursements", json=undo, headers=HEADERS), 1)
        assert response.status == 200
        queued = await response.json()
        assert queued["undoJob"]["status"] == "queued"
        for actor, owner in ((HANNAH, "hannah"), (BRIAN, "brian")):
            connect(client, actor, owner)
            refreshed = await asyncio.wait_for(client.http.get("/app/reimbursements?snapshot=1"), 1)
            current = await refreshed.json()
            assert current["allocations"] == saved["allocations"]
            assert current["undoJobs"][0]["status"] == "queued"
        gate.set()
        # The canonical inverse commits before its final projection. Await the
        # worker, not merely the job's SQL status, before comparing complete
        # snapshots that include the mutable projectedVersion metadata.
        task = client.http.server.app[phone_reimbursements._UNDO_RECOVERY].task
        if task is not None:
            await asyncio.wait_for(asyncio.shield(task), 5)
        assert not client.store.pending_undo_jobs()
        for actor, owner in ((HANNAH, "hannah"), (BRIAN, "brian")):
            connect(client, actor, owner)
            current = await (await client.http.get("/app/reimbursements?snapshot=1")).json()
            row = next(row for row in current["allocations"] if row["id"] == original["id"])
            assert row["grossCents"] == original["grossCents"] and row["outstandingCents"] == 4000
            assert row["settledCents"] == 0 and row["clearedCents"] == 0
            assert current["undoJobs"][0]["status"] == "completed"
        replay = await (await client.http.post("/app/reimbursements", json=undo, headers=HEADERS)).json()
        assert replay["allocations"] == current["allocations"]
        assert replay["undoJob"]["id"] == queued["undoJob"]["id"]
    finally:
        gate.set()


@pytest.mark.asyncio
async def test_server_restart_resumes_accepted_undo_without_another_phone_write(client, monkeypatch):
    original = client.allocation
    client.store.mark_projected(original["id"], original["version"])
    saved = client.store.command("brian", payment(client))
    job = client.store.command("brian", {"operation": "queue_undo", "requestId": uuid4().hex,
        "action": "reverse_operation", "operationId": saved["operationId"],
        "expectedUndoState": client.store.snapshot("brian")["undoState"]})["undoJob"]
    def project(store):
        for row in store.pending_projections():
            store.mark_projected(row["id"], row["version"])
        return True
    monkeypatch.setattr(projection, "sync_pending", project)
    app = web.Application()
    phone_reimbursements.register_phone_reimbursement_routes(app)
    async with TestClient(TestServer(app)):
        for _ in range(100):
            if not client.store.pending_undo_jobs():
                break
            await asyncio.sleep(.01)
        assert client.store.pending_undo_jobs() == []
        current = client.store.snapshot("hannah")
        assert current["undoJobs"][0]["id"] == job["id"] and current["undoJobs"][0]["status"] == "completed"
        assert current["allocations"][0]["outstandingCents"] == 4000


@pytest.mark.asyncio
async def test_new_undo_at_worker_completion_is_not_stranded_or_retried_by_polling(monkeypatch):
    from bookiebot.reports import phone_shared_bills
    publishing, release = asyncio.Event(), asyncio.Event()
    calls = []
    def recover():
        calls.append(True)
        return {"completed": [], "pending": []}
    async def publish(_owner):
        if len(calls) == 1:
            publishing.set()
            await release.wait()
    monkeypatch.setattr(service, "recover_queued_undos", recover)
    monkeypatch.setattr(phone_shared_bills, "publish_change", publish)
    worker = phone_reimbursements._UndoRecovery()
    first = {"id": "first", "actorOwner": "brian", "status": "queued"}
    second = {"id": "second", "actorOwner": "hannah", "status": "queued"}
    try:
        worker.start([first])
        await asyncio.wait_for(publishing.wait(), 1)
        # The current pass already saw no pending work; the new POST and its
        # duplicate status polls arrive during the final publication await.
        for _ in range(4):
            worker.start([first, second])
        release.set()
        for _ in range(100):
            if worker.task is None:
                break
            await asyncio.sleep(.01)
        assert len(calls) == 2 and not worker.waiting
        worker.start([second])
        assert worker.task is None, "Old status polls respect the retry backoff"
    finally:
        release.set()
        await worker.close()


@pytest.mark.asyncio
async def test_fast_display_snapshot_never_waits_for_sheets_recovery(client, monkeypatch):
    calls = []
    monkeypatch.setattr(projection, "sync_pending", lambda store: calls.append(store) or False)
    assert (await client.http.get("/app/reimbursements?snapshot=1")).status == 401
    connect(client)
    before = client.store.snapshot("brian")
    response = await client.http.get("/app/reimbursements?snapshot=1")
    assert response.status == 200 and response.headers["Cache-Control"] == "private, no-store"
    data = await response.json()
    assert data["allocations"] == before["allocations"] and data["events"] == before["events"]
    assert data["projectionPending"] is True
    assert calls == [], "Display reads must not touch Sheets, even with pending projection"
    assert (await client.http.get("/app/reimbursements")).status == 200
    assert calls == [client.store], "An explicit refresh retains full recovery"
    assert client.store.snapshot("brian")["allocations"] == before["allocations"]


@pytest.mark.asyncio
async def test_snapshot_flag_cannot_skip_command_projection_or_duplicate_receipt(client, monkeypatch):
    calls = []
    monkeypatch.setattr(projection, "sync_pending", lambda store: calls.append(store) or False)
    connect(client)
    client.store.mark_projected(client.allocation["id"], client.allocation["version"])
    body = payment(client)
    for _ in range(2):
        response = await client.http.post("/app/reimbursements?snapshot=1", json=body, headers=HEADERS)
        assert response.status == 200 and (await response.json())["projectionPending"] is True
    assert calls == [client.store, client.store]
    assert len(client.store.snapshot("brian")["events"]) == 1
    assert client.store.get_allocation(client.allocation["id"])["settledCents"] == body["amountCents"]


@pytest.mark.asyncio
async def test_deferred_receipt_returns_authoritative_payment_before_sheet_recovery(client, monkeypatch):
    calls = []
    monkeypatch.setattr(projection, "sync_pending", lambda store: calls.append(store) or False)
    connect(client)
    client.store.mark_projected(client.allocation["id"], client.allocation["version"])
    body = payment(client)
    for _ in range(2):
        response = await client.http.post("/app/reimbursements?deferredReceipt=1", json=body, headers=HEADERS)
        assert response.status == 200
        data = await response.json()
        assert data["projectionPending"] and data["undoState"]
        assert len(data["events"]) == 1
        assert data["allocations"][0]["settledCents"] == body["amountCents"]
    assert calls == []
    assert (await client.http.get("/app/reimbursements")).status == 200
    assert calls == [client.store]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation,lifecycle", [("cancel", "void"), ("delete", "deleted")])
async def test_fast_snapshot_reports_inactive_projection_backlog(client, monkeypatch, operation, lifecycle):
    connect(client)
    original = client.allocation
    client.store.mark_projected(original["id"], original["version"])
    pending = client.store.revise_allocation("brian", original["id"], original["version"], {"lifecycle": lifecycle}, operation=operation)
    calls = []

    def recover(store):
        calls.append(store)
        for item in store.pending_projections():
            store.mark_projected(item["id"], item["version"])
        return True

    monkeypatch.setattr(projection, "sync_pending", recover)
    first = await client.http.get("/app/reimbursements?snapshot=1")
    data = await first.json()
    assert first.status == 200 and data["allocations"] == [] and data["events"] == []
    assert data["projectionPending"] is True, "Inactive corrections still require recovery"
    assert calls == [], "Detecting the complete backlog remains SQL-only"
    assert client.store.get_allocation(original["id"])["projectedVersion"] < pending["version"]
    full = await client.http.get("/app/reimbursements")
    synced = await full.json()
    assert full.status == 200 and synced["projectionPending"] is False
    assert synced["resetState"] != data["resetState"], "The existing complete cursor includes inactive projection progress"
    assert calls == [client.store]
    after = client.store.get_allocation(original["id"])
    assert after["projectedVersion"] == pending["version"]
    assert all(after[key] == original[key] for key in ("grossCents", "payerShareCents", "partnerShareCents", "settledCents"))


@pytest.mark.asyncio
async def test_native_split_income_preview_and_confirm_use_same_exact_cents(client):
    from bookiebot.sheets.collaboration import split_amounts
    connect(client)
    client.store.mark_projected(client.allocation["id"], client.allocation["version"])
    before = client.store.get_allocation(client.allocation["id"])
    response = await client.http.get("/app/reimbursements")
    assert response.status == 200
    data = await response.json()
    payer = data["splitOptions"][before["id"]]["incomePayerCents"]
    assert payer == round(split_amounts(before["grossCents"] / 100, "income", "brian")[0] * 100)
    assert data["allocations"][0] == before
    body = {"operation": "edit_split", "requestId": uuid4().hex, "allocationId": before["id"], "version": before["version"],
            "method": "income", "grossCents": before["grossCents"], "payerShareCents": payer}
    first = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert first.status == 200
    saved = (await first.json())["allocations"][0]
    assert saved["method"] == "income" and saved["payerShareCents"] == payer
    assert saved["settledCents"] == 0
    assert (await client.http.post("/app/reimbursements", json=body, headers=HEADERS)).status == 200
    assert client.store.get_allocation(before["id"])["version"] == before["version"] + 1
    connect(client, HANNAH, "hannah")
    debtor = await client.http.get("/app/reimbursements")
    assert (await debtor.json())["splitOptions"] == {}


@pytest.mark.asyncio
async def test_report_all_is_authenticated_pending_and_retry_safe(client):
    client.store.mark_projected(client.allocation["id"], client.allocation["version"])
    connect(client, HANNAH, "hannah")
    before = client.store.snapshot("hannah")
    body = {"operation": "report_all", "requestId": uuid4().hex, "expectedState": before["resetState"],
            "date": now_pacific().date().isoformat(), "note": ""}
    first = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert first.status == 200
    result = await first.json()
    assert result["ownerKey"] == "hannah"
    assert result["events"][0]["kind"] == "report_payment"
    assert result["events"][0]["status"] == "pending"
    assert result["allocations"] == before["allocations"]
    again = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert again.status == 200
    assert len(client.store.snapshot("hannah")["events"]) == 1
    assert client.store.snapshot("hannah")["allocations"] == before["allocations"]


@pytest.mark.asyncio
async def test_bulk_received_uses_authenticated_payee_and_safe_repeat_request(client):
    connect(client)
    client.store.mark_projected(client.allocation["id"], client.allocation["version"])
    body = {"operation": "receive_all", "requestId": uuid4().hex,
            "expectedState": client.store.snapshot("brian")["resetState"],
            "date": now_pacific().date().isoformat(), "note": "Already received"}
    response = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert response.status == 200
    result = await response.json()
    assert result["allocations"][0]["settledCents"] == 4000
    assert result["projectionPending"] is True
    assert (await client.http.post("/app/reimbursements", json=body, headers=HEADERS)).status == 200
    assert len(client.store.snapshot("brian")["events"]) == 1


@pytest.mark.asyncio
async def test_bulk_received_cannot_record_money_for_the_other_payee(client):
    connect(client, HANNAH, "hannah")
    client.store.mark_projected(client.allocation["id"], client.allocation["version"])
    body = {"operation": "receive_all", "requestId": uuid4().hex,
            "expectedState": client.store.snapshot("hannah")["resetState"],
            "date": now_pacific().date().isoformat()}
    assert (await client.http.post("/app/reimbursements?owner=brian", json=body, headers=HEADERS)).status == 409
    assert_unchanged(client)


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
@pytest.mark.parametrize("query", ["", "?snapshot=1"])
async def test_revoked_session_during_read_drops_personal_data(client, monkeypatch, query):
    connect(client)
    original = service.snapshot

    def revoke_during_read(owner, **kwargs):
        result = original(owner, **kwargs)
        client.access.revoke_owner(owner)
        return result

    monkeypatch.setattr(service, "snapshot", revoke_during_read)
    result = await client.http.get("/app/reimbursements" + query)
    assert result.status == 401
    assert "Private shared expense" not in await result.text()


def sync_fixture(store):
    for allocation in store.pending_projections():
        store.mark_projected(allocation["id"], allocation["version"])
    return True


@pytest.mark.asyncio
async def test_reset_and_grouped_undo_redo_reach_both_authenticated_phones(client, monkeypatch):
    monkeypatch.setattr(projection, "sync_pending", sync_fixture)
    connect(client)
    before = await (await client.http.get("/app/reimbursements")).json()
    body = {"operation": "reset", "requestId": uuid4().hex, "expectedState": before["resetState"],
            "note": "Settled together outside BookieBot"}
    saved = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert saved.status == 200
    cleared = await saved.json()
    assert cleared["projectionPending"] is False
    assert cleared["allocations"][0]["outstandingCents"] == 0
    assert cleared["allocations"][0]["clearedCents"] == 4000
    assert cleared["allocations"][0]["settledCents"] == 0
    assert cleared["events"] == []
    reset = cleared["resets"][0]
    assert reset["actorOwner"] == "brian" and reset["canUndo"]
    retry = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert retry.status == 200
    assert len((await retry.json())["resets"]) == 1

    connect(client, HANNAH, "hannah")
    partner = await (await client.http.get("/app/reimbursements")).json()
    assert partner["ownerKey"] == "hannah" and partner["resets"] == cleared["resets"]
    undone = await client.http.post("/app/reimbursements", json={
        "operation": "undo_reset", "requestId": uuid4().hex, "resetId": reset["id"], "version": reset["version"],
    }, headers=HEADERS)
    assert undone.status == 200
    reopened = await undone.json()
    assert reopened["allocations"][0]["outstandingCents"] == 4000
    assert reopened["resets"][0]["status"] == "undone"
    assert reopened["resets"][0]["canRedo"]
    redone = await client.http.post("/app/reimbursements", json={
        "operation": "redo_reset", "requestId": uuid4().hex,
        "resetId": reset["id"], "version": reopened["resets"][0]["version"],
    }, headers=HEADERS)
    assert redone.status == 200
    result = await redone.json()
    assert result["allocations"][0]["outstandingCents"] == 0
    assert result["allocations"][0]["settledCents"] == 0 and result["events"] == []


@pytest.mark.asyncio
async def test_reset_stale_preview_and_spoofed_actor_are_rejected(client, monkeypatch):
    monkeypatch.setattr(projection, "sync_pending", sync_fixture)
    connect(client)
    before = await (await client.http.get("/app/reimbursements")).json()
    body = {"operation": "reset", "requestId": uuid4().hex, "expectedState": before["resetState"]}
    spoofed = await client.http.post("/app/reimbursements", json={**body, "actorOwner": "hannah"}, headers=HEADERS)
    assert spoofed.status == 400
    assert client.store.snapshot("brian")["resets"] == []
    assert (await client.http.post("/app/reimbursements", json=payment(client), headers=HEADERS)).status == 200
    stale = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert stale.status == 409
    assert client.store.snapshot("brian")["resets"] == []
    assert client.store.get_allocation(client.allocation["id"])["outstandingCents"] == 2975


@pytest.mark.asyncio
async def test_reset_lost_projection_response_reuses_committed_request(client, monkeypatch):
    connect(client)
    sync_fixture(client.store)
    before = client.store.snapshot("brian")
    body = {"operation": "reset", "requestId": uuid4().hex, "expectedState": before["resetState"]}

    def lost_response(store):
        assert len(store.snapshot("brian")["resets"]) == 1
        raise RuntimeError("Lost projection response")

    monkeypatch.setattr(projection, "sync_pending", lost_response)
    result = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert result.status == 503
    assert client.store.get_allocation(client.allocation["id"])["outstandingCents"] == 0
    monkeypatch.setattr(projection, "sync_pending", sync_fixture)
    retry = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert retry.status == 200
    state = await retry.json()
    assert len(state["resets"]) == 1 and state["projectionPending"] is False
    assert state["allocations"][0]["version"] == 2


@pytest.mark.asyncio
async def test_split_editor_authenticates_payer_and_replays_combined_change(client):
    body = {"operation": "edit_split", "requestId": uuid4().hex, "allocationId": client.allocation["id"],
            "version": client.allocation["version"], "grossCents": 12345, "payerBasisPoints": 6525}
    assert (await client.http.post("/app/reimbursements", json=body, headers=HEADERS)).status == 401
    connect(client, HANNAH, "hannah")
    client.store.mark_projected(client.allocation["id"], client.allocation["version"])
    assert (await client.http.post("/app/reimbursements?owner=brian", json=body, headers=HEADERS)).status == 400
    connect(client)
    assert (await client.http.post("/app/reimbursements", json=body)).status == 403
    result = await client.http.post("/app/reimbursements", json=body, headers=HEADERS)
    assert result.status == 200
    changed = (await result.json())["allocations"][0]
    assert (changed["grossCents"], changed["payerShareCents"], changed["partnerShareCents"]) == (12345, 8055, 4290)
    assert changed["method"] == "custom" and changed["customPayerBasisPoints"] == 6525
    assert (await client.http.post("/app/reimbursements", json=body, headers=HEADERS)).status == 200
    assert client.store.snapshot("brian")["events"] == []
    assert client.store.get_allocation(changed["id"])["version"] == changed["version"]


@pytest.mark.asyncio
async def test_timed_operation_undo_uses_authenticated_canonical_projection(client, monkeypatch):
    def recover(store):
        for row in store.pending_projections():
            store.mark_projected(row['id'], row['version'])
        return True
    monkeypatch.setattr(projection, 'sync_pending', recover)
    connect(client)
    recover(client.store)
    received = await client.http.post('/app/reimbursements', json=payment(client), headers=HEADERS)
    assert received.status == 200
    receipt = await received.json()
    body = {'operation': 'reverse_operation', 'requestId': uuid4().hex,
            'operationId': receipt['operationId'], 'expectedState': receipt['resetState']}
    response = await client.http.post('/app/reimbursements', json=body, headers=HEADERS)
    assert response.status == 200
    restored = await response.json()
    assert restored['projectionPending'] is False
    assert restored['allocations'][0]['settledCents'] == 0
    assert restored['events'][0]['status'] == 'reversed'
    replay = await client.http.post('/app/reimbursements', json=body, headers=HEADERS)
    assert replay.status == 200
    assert (await replay.json())['operationId'] == restored['operationId']
    assert len(client.store.snapshot('brian')['events']) == 1
