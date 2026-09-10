"""Actual HTTP and SQLite review contracts; no live bank or sheet writes."""
import asyncio
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.banking.config import BankingConfig
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import BankAccount
from bookiebot.banking.reconciliation import ActionLogCandidate
from bookiebot.banking.service import BankingService
from bookiebot.banking.store import BankStore
from bookiebot.banking import service as banking
from bookiebot.reports import phone_app, phone_reconciliation as review
from bookiebot.reports.app_access import AppAccessStore
from bookiebot.sheets.routing import now_pacific
from bookiebot.sheets.undo import LoggedAction, UndoAction

BRIAN = "676638528590970917"
HANNAH = "830984827904851969"
HEADERS = {"X-BookieBot-App": "1", "Origin": "http://127.0.0.1"}


def logged(amount="12.34", label="Coffee", action_id="coffee", row=12):
    today = now_pacific().date()
    return LoggedAction(id=action_id, created_at=today.isoformat() + "T12:00:00", user_key=BRIAN,
                        action=UndoAction(worksheet="expense", kind="clear_cells", row=row,
                                          columns=[14, 15, 16, 17, 18], previous_values=[""] * 5,
                                          new_values=[today.strftime("%m/%d/%Y"), label, amount, "Starbucks", "Brian (BofA)"],
                                          metadata={"type": "expense", "category": "food", "person": "Brian (BofA)"},
                                          description="Recorded coffee"))


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "http://127.0.0.1")
    access = AppAccessStore(tmp_path / "phone.sqlite3")
    access.initialize()
    store = BankStore(tmp_path / "bank.sqlite3", TokenCipher("test-review-key"))
    store.initialize()
    config = BankingConfig("test-client", "test-secret", "sandbox", "test-review-key", tmp_path / "bank.sqlite3")
    service = BankingService(config, store, SimpleNamespace())
    actions = [logged()]
    actors = []
    def source(actor):
        actors.append(actor)
        return actions if actor == BRIAN else []
    monkeypatch.setattr(phone_app, "build_app_access_store", lambda: access)
    monkeypatch.setattr(review, "build_banking_service", lambda: service)
    monkeypatch.setattr(review, "read_active_logged_actions", source)
    monkeypatch.setattr(banking, "read_active_logged_actions", source)
    monkeypatch.setattr(review, "_scheduled_pulls_for_transactions", lambda *args, **kwargs: [])
    monkeypatch.setattr(banking, "_scheduled_pulls_for_transactions", lambda *args, **kwargs: [])
    # Every prohibited sheet-write entry point fails loudly if accidentally used.
    def no_write(*args, **kwargs):
        raise AssertionError("Phone reconciliation must not write sheet expenses")
    monkeypatch.setattr(banking, "update_recent_action", no_write)
    monkeypatch.setattr(service, "import_reconciliation_item", no_write)
    monkeypatch.setattr(service, "sync_owner", AsyncMock(return_value=[]))
    app = web.Application()
    review.register_phone_reconciliation_routes(app)
    async with TestClient(TestServer(app), cookie_jar=CookieJar(unsafe=True)) as http:
        yield SimpleNamespace(http=http, access=access, store=store, service=service,
                              actions=actions, actors=actors)
    for task in list(review._checks.values()):
        task.cancel()
    review._checks.clear()


def connect(client, actor=BRIAN, owner="brian"):
    result = client.access.consume_pairing(client.access.issue_pairing(actor, owner))
    assert result is not None
    client.http.session.cookie_jar.update_cookies({"bb_phone_local": result[0]})


def seed(client, owner="brian", pending=False, reviewed=True, status="needs_review", amount=12.34, age=0):
    item = client.store.upsert_item(owner_key=owner, provider="plaid", item_id=f"item-{owner}",
                                    access_token="private-bank-token", institution_name="Example bank")
    client.store.upsert_accounts([BankAccount(item.id, f"account-{owner}", owner, "Checking", "1234",
                                              "depository", "checking", None, 100, 100)])
    client.store.upsert_transactions([{
        "transaction_id": f"transaction-{owner}", "account_id": f"account-{owner}",
        "date": (now_pacific().date() - timedelta(days=age)).isoformat(),
        "name": f"Starbucks {owner}", "merchant_name": "Starbucks", "amount": amount, "pending": pending,
    }], owner)
    transaction = client.store.recent_transactions(owner)[0]
    if reviewed:
        return client.store.upsert_reconciliation_item(owner_key=owner, transaction=transaction,
                                                       classification="expense", status=status,
                                                       confidence=0.6, notes="Needs review")
    return transaction


async def list_rows(client):
    result = await client.http.get("/app/reconciliation")
    assert result.status == 200, await result.text()
    assert result.headers["Cache-Control"] == "private, no-store"
    return await result.json()


async def details(client, row_id):
    result = await client.http.get(f"/app/reconciliation/{row_id}")
    assert result.status == 200, await result.text()
    return (await result.json())["item"]


@pytest.mark.asyncio
async def test_auth_owner_scope_and_fast_list_never_reads_sheets(client):
    seed(client)
    seed(client, owner="hannah")
    assert (await client.http.get("/app/reconciliation")).status == 401
    assert (await client.http.post("/app/reconciliation", json={"operation": "check"}, headers=HEADERS)).status == 401
    connect(client)
    data = await list_rows(client)
    assert data["enabled"] and len(data["items"]) == 1
    assert client.actors == []
    assert "private-bank-token" not in str(data)
    assert "provider_transaction_id" not in str(data)
    row = await details(client, data["items"][0]["id"])
    assert row["suggestions"][0]["id"] == "coffee"
    assert client.actors == [BRIAN]
    connect(client, HANNAH, "hannah")
    assert (await client.http.get(f"/app/reconciliation/{row['id']}?owner=brian")).status == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("headers", [{}, {**HEADERS, "Origin": "null"}, {**HEADERS, "Origin": "https://wrong.example"},
                                        {**HEADERS, "Sec-Fetch-Site": "cross-site"}])
async def test_cross_origin_rejected_before_sync(client, headers):
    seed(client)
    connect(client)
    result = await client.http.post("/app/reconciliation", json={"operation": "check"}, headers=headers)
    assert result.status == 403
    client.service.sync_owner.assert_not_called()


@pytest.mark.asyncio
async def test_tab_requires_connected_watched_account(client):
    connect(client)
    assert (await list_rows(client))["enabled"] is False
    seed(client)
    assert (await list_rows(client))["enabled"] is True
    account = client.service.accounts("brian")[0]
    client.store.set_account_watched("brian", account.id, False)
    assert (await list_rows(client))["enabled"] is False
    client.store.set_account_watched("brian", account.id, True)
    client.service.disconnect_item("brian", account.item_id)
    assert (await list_rows(client))["enabled"] is False


@pytest.mark.asyncio
async def test_pending_is_visible_tentative_and_cannot_be_confirmed(client):
    seed(client, pending=True, reviewed=False)
    connect(client)
    row = (await list_rows(client))["items"][0]
    assert row["id"] < 0 and row["status"] == "pending"
    expanded = await details(client, row["id"])
    assert expanded["suggestions"] and not expanded["suggestions"][0]["confirmable"]
    result = await client.http.post("/app/reconciliation", headers=HEADERS,
                                   json={"operation": "confirm", "id": row["id"], "version": expanded["version"], "suggestionId": "coffee"})
    assert result.status == 400


@pytest.mark.asyncio
async def test_exact_confirmation_is_metadata_only_and_repeat_is_safe(client):
    item = seed(client)
    connect(client)
    row = await details(client, item.id)
    body = {"operation": "confirm", "id": item.id, "version": row["version"], "suggestionId": "coffee"}
    result = await client.http.post("/app/reconciliation", json=body, headers=HEADERS)
    assert result.status == 200, await result.text()
    assert (await result.json())["items"][0]["status"] == "checked"
    saved = client.store.get_reconciliation_item("brian", item.id)
    assert saved.status == "confirmed" and saved.matched_action_log_id == "coffee"
    assert (await client.http.post("/app/reconciliation", json=body, headers=HEADERS)).status == 409


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["amount", "label", "removed", "bank_amount"])
async def test_changed_bank_or_logged_candidate_requires_fresh_review(client, change):
    item = seed(client)
    connect(client)
    row = await details(client, item.id)
    if change == "amount":
        client.actions[:] = [logged(amount="13.34")]
    elif change == "label":
        client.actions[:] = [logged(label="Other purchase")]
    elif change == "removed":
        client.actions.clear()
    else:
        seed(client, amount=20)
    result = await client.http.post("/app/reconciliation", headers=HEADERS,
                                   json={"operation": "confirm", "id": item.id, "version": row["version"], "suggestionId": "coffee"})
    assert result.status == 409
    assert client.store.get_reconciliation_item("brian", item.id).status == "needs_review"


@pytest.mark.asyncio
async def test_amount_difference_is_visible_but_never_writes_sheet(client):
    item = seed(client, amount=14)
    connect(client)
    row = await details(client, item.id)
    suggestion = row["suggestions"][0]
    assert suggestion["amountCents"] == 1234 and row["amountCents"] == 1400
    assert suggestion["amountMismatch"] and not suggestion["confirmable"]
    result = await client.http.post("/app/reconciliation", headers=HEADERS,
                                   json={"operation": "confirm", "id": item.id, "version": row["version"], "suggestionId": "coffee", "adjustAmount": True})
    assert result.status == 409


@pytest.mark.asyncio
async def test_ignore_reopen_and_outdated_review_conflict(client):
    item = seed(client)
    connect(client)
    row = await details(client, item.id)
    result = await client.http.post("/app/reconciliation", headers=HEADERS,
                                   json={"operation": "ignore", "id": item.id, "version": row["version"]})
    assert result.status == 200, await result.text()
    ignored = (await result.json())["items"][0]
    assert ignored["status"] == "ignored"
    result = await client.http.post("/app/reconciliation", headers=HEADERS,
                                   json={"operation": "reopen", "id": item.id, "version": ignored["version"]})
    assert result.status == 200, await result.text()
    assert (await result.json())["items"][0]["status"] == "needs_review"


@pytest.mark.asyncio
async def test_old_items_hidden_and_unreviewed_items_need_check(client):
    seed(client, reviewed=False, age=61)
    connect(client)
    assert (await list_rows(client))["items"] == []
    seed(client, reviewed=False)
    row = (await list_rows(client))["items"][0]
    assert row["needsCheck"] and row["id"] < 0
    result = await client.http.post("/app/reconciliation", headers=HEADERS, json={"operation": "check"})
    assert result.status == 200, await result.text()
    client.service.sync_owner.assert_awaited_once_with("brian")
    row = (await result.json())["items"][0]
    assert row["id"] > 0 and row["status"] == "checked"


@pytest.mark.asyncio
async def test_parallel_phone_checks_share_sync_and_failure_recovers(client):
    seed(client)
    connect(client)
    entered, release = asyncio.Event(), asyncio.Event()
    async def delayed(_owner):
        entered.set()
        await release.wait()
    client.service.sync_owner.side_effect = delayed
    first = asyncio.create_task(client.http.post("/app/reconciliation", headers=HEADERS, json={"operation": "check"}))
    await entered.wait()
    second = asyncio.create_task(client.http.post("/app/reconciliation", headers=HEADERS, json={"operation": "check"}))
    await asyncio.sleep(.05)
    release.set()
    responses = await asyncio.gather(first, second)
    assert [response.status for response in responses] == [200, 200]
    client.service.sync_owner.assert_awaited_once()
    client.service.sync_owner.side_effect = RuntimeError("private bank diagnostic")
    failed = await client.http.post("/app/reconciliation", headers=HEADERS, json={"operation": "check"})
    assert failed.status == 503 and "private bank diagnostic" not in await failed.text()
    assert (await list_rows(client))["items"]
    client.service.sync_owner.side_effect = None
    assert (await client.http.post("/app/reconciliation", headers=HEADERS, json={"operation": "check"})).status == 200


@pytest.mark.asyncio
async def test_invalid_oversized_and_import_requests_are_rejected(client):
    seed(client)
    connect(client)
    for body in [[], {"operation": "import"}, {"operation": "ignore", "id": True, "version": "x" * 64},
                 {"operation": "check", "extra": "x" * 5000}]:
        result = await client.http.post("/app/reconciliation", headers=HEADERS, json=body)
        assert result.status == 400


@pytest.mark.asyncio
@pytest.mark.parametrize("recorded", [False, True])
async def test_schedule_confirmation_requires_recorded_evidence(client, monkeypatch, recorded):
    item = seed(client)
    connect(client)
    candidate = ActionLogCandidate("schedule:bill:loan#pull=2026-09", "loan#pull=2026-09", "schedule",
                                   now_pacific().date(), 12.34, "Loan", .9, "Schedule", amount_recorded=recorded)
    monkeypatch.setattr(client.service, "reconciliation_match_candidates", lambda *args, **kwargs: (item, [candidate], []))
    row = await details(client, item.id)
    assert row["suggestions"][0]["confirmable"] is recorded
    result = await client.http.post("/app/reconciliation", headers=HEADERS,
                                   json={"operation": "confirm", "id": item.id, "version": row["version"], "suggestionId": candidate.action_id})
    assert result.status == (200 if recorded else 409)
    assert client.store.get_reconciliation_item("brian", item.id).status == ("confirmed" if recorded else "needs_review")


@pytest.mark.asyncio
async def test_response_failure_after_applied_confirmation_is_recoverable(client, monkeypatch):
    item = seed(client)
    connect(client)
    row = await details(client, item.id)
    body = {"operation": "confirm", "id": item.id, "version": row["version"], "suggestionId": "coffee"}
    original_snapshot = review.snapshot
    def failed(*args):
        raise RuntimeError("Response lost after database decision")
    monkeypatch.setattr(review, "snapshot", failed)
    result = await client.http.post("/app/reconciliation", headers=HEADERS, json=body)
    assert result.status == 503
    assert client.store.get_reconciliation_item("brian", item.id).status == "confirmed"
    monkeypatch.setattr(review, "snapshot", original_snapshot)
    assert (await list_rows(client))["items"][0]["status"] == "checked"
    assert (await client.http.post("/app/reconciliation", headers=HEADERS, json=body)).status == 409


@pytest.mark.asyncio
async def test_import_recovery_row_and_revoked_session_cannot_be_changed(client):
    item = seed(client, status="import_requested")
    connect(client)
    row = await details(client, item.id)
    assert row["readOnly"] and row["suggestions"] == []
    assert "recovery" in row["matchLabel"]
    result = await client.http.post("/app/reconciliation", headers=HEADERS,
                                   json={"operation": "ignore", "id": item.id, "version": row["version"]})
    assert result.status == 409
    client.access.revoke_owner("brian")
    assert (await client.http.get("/app/reconciliation")).status == 401
    assert (await client.http.get(f"/app/reconciliation/{item.id}")).status == 401


@pytest.mark.asyncio
async def test_confirm_invalidates_cached_schedule_before_comparing_review(client, monkeypatch):
    item = seed(client)
    connect(client)
    cache = {"amount": 12.34}
    def candidates(*args, **kwargs):
        candidate = ActionLogCandidate("schedule:loan", "loan#pull=2026-09", "schedule", now_pacific().date(),
                                       cache["amount"], "Loan", .9, "Recorded bill", amount_recorded=True)
        return item, [candidate], []
    def invalidate(actor):
        assert actor == BRIAN
        cache["amount"] = 24.68
    monkeypatch.setattr(client.service, "reconciliation_match_candidates", candidates)
    monkeypatch.setattr(review, "clear_schedule_source_cache", invalidate)
    row = await details(client, item.id)
    result = await client.http.post("/app/reconciliation", headers=HEADERS,
                                   json={"operation": "confirm", "id": item.id, "version": row["version"], "suggestionId": "schedule:loan"})
    assert result.status == 409
    assert client.store.get_reconciliation_item("brian", item.id).status == "needs_review"


@pytest.mark.asyncio
async def test_bad_source_is_retryable_not_an_invalid_user_request(client, monkeypatch):
    item = seed(client)
    connect(client)
    def unavailable(*args, **kwargs):
        raise ValueError("Private source header diagnostic")
    monkeypatch.setattr(client.service, "reconciliation_match_candidates", unavailable)
    result = await client.http.get(f"/app/reconciliation/{item.id}")
    assert result.status == 503 and "Private source" not in await result.text()
    assert (await client.http.get("/app/reconciliation/not-an-id")).status == 400
    assert client.store.get_reconciliation_item("brian", item.id).status == "needs_review"
