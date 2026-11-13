from contextlib import nullcontext
from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
import pytest

from bookiebot.reports import bill_settings as bills
from bookiebot.sheets import recurring_storage as storage
from bookiebot.sheets.recurring import BillConflict, BILL_TAB, SUBSCRIPTION_TAB
from bookiebot.sheets.recurring_rows import encode
from unit_tests.sheets.test_recurring_storage import fixture, TODAY, B, update
from unit_tests.sheets.test_recurring import plan
from unit_tests.reports.test_goals_store import access as access

H = "830984827904851969"


@pytest.fixture
def saved(monkeypatch, access):
    client, loan = fixture()
    access.initialize()
    monkeypatch.setattr(bills, "now_pacific", lambda: datetime(2026, 11, 13, 12))
    monkeypatch.setattr(bills, "read_workbook", lambda actor, today: storage.read_workbook(actor, today, client=client))
    monkeypatch.setattr("bookiebot.reimbursements.projection.projection_lock", lambda _: nullcontext())
    monkeypatch.setattr("bookiebot.reimbursements.service.build_reimbursement_store", lambda: SimpleNamespace(snapshot=lambda *a, **kw: {"allocations": []}))
    commands = bills.BillCommands(access)
    commands.initialize()
    return SimpleNamespace(client=client, loan=loan, commands=commands, monkeypatch=monkeypatch)


def command(saved, **changes):
    snapshot = bills.read_workbook(B, TODAY)
    body = update(snapshot, saved.loan)
    review = bills.review(B, body)
    return {**body, "requestId": "bill-request-1234567890", "reviewVersion": review["reviewVersion"], **changes}


def test_configuration_review_is_read_only_and_confirm_is_exactly_once(saved):
    body = command(saved)
    assert not saved.client.http_client.sent
    first = saved.commands.command(B, body)
    assert first["success"] and first["state"] == "done"
    assert len(saved.client.http_client.sent) == 1
    assert saved.commands.command(B, body) == first
    assert len(saved.client.http_client.sent) == 1
    with pytest.raises(BillConflict, match="different bill details"):
        saved.commands.command(B, {**body, "operation": "delete"})
    assert saved.commands.saved(H, body["requestId"]) is None


def test_stale_review_and_owner_injection_are_guaranteed_no_write(saved):
    body = command(saved, reviewVersion="stale")
    result = saved.commands.command(B, body)
    assert result["state"] == "done" and not result["success"]
    assert not saved.client.http_client.sent
    source = bills.read_workbook(B, TODAY)
    with pytest.raises(ValueError):
        bills.review(B, {**update(source, saved.loan), "owner": "hannah"})


def test_lost_response_recovers_from_same_atomic_sheet_receipt_without_repeating(saved):
    body = command(saved)
    writer = saved.client.http_client.batch_update
    def lost(identity, batch):
        writer(identity, batch)
        raise TimeoutError("lost response")
    saved.client.http_client.batch_update = lost
    assert saved.commands.command(B, body)["state"] == "uncertain"
    assert saved.commands.command(B, body)["state"] == "uncertain"
    assert len(saved.client.http_client.sent) == 1
    recovered = saved.commands.saved(B, body["requestId"])
    assert recovered and recovered["state"] == "done" and recovered["success"]
    assert len(saved.client.http_client.sent) == 1


def test_unverified_write_blocks_another_financial_request(saved):
    body = command(saved)
    saved.client.http_client.batch_update = Mock(side_effect=TimeoutError("no evidence"))
    assert saved.commands.command(B, body)["state"] == "uncertain"
    with pytest.raises(BillConflict, match="previous bill change"):
        saved.commands.command(B, {**body, "requestId": "other-request-1234567890"})
    assert saved.commands.saved(B, body["requestId"])["state"] == "uncertain"
    assert saved.client.http_client.batch_update.call_count == 1


def test_explicit_atomic_api_rejection_is_safe_to_review_again(saved):
    from gspread.exceptions import APIError
    response = Mock(status_code=429)
    response.json.return_value = {"error": {"code": 429, "message": "Quota exceeded"}}
    saved.client.http_client.batch_update = Mock(side_effect=APIError(response))
    body = command(saved)
    result = saved.commands.command(B, body)
    assert result["state"] == "done" and not result["success"]
    assert saved.commands.pending("brian") is None


def test_bill_and_transactions_commands_share_the_owner_uncertainty_boundary(saved, monkeypatch):
    body = command(saved)
    with saved.commands.access.connect(write=True) as db:
        db.execute("INSERT INTO app_transaction_commands VALUES (?,?,?,'uncertain','{}','{}','2026-11-13')", ("brian", "prior-transaction-123456", "x"))
    with pytest.raises(BillConflict, match="prior Transactions"):
        saved.commands.command(B, body)
    assert not saved.client.http_client.sent
    with saved.commands.access.connect(write=True) as db:
        db.execute("DELETE FROM app_transaction_commands")
        db.execute("INSERT INTO app_bill_commands VALUES (?,?,?,'uncertain','{}','{}','2026-11-13')", ("brian", "prior-bill-123456789", "x"))
    from bookiebot.reports import transactions
    reader = Mock(side_effect=AssertionError("No financial read or write"))
    monkeypatch.setattr(transactions, "review", reader)
    with pytest.raises(transactions.TransactionConflict, match="bill change"):
        transactions.TransactionCommands(saved.commands.access).command(B, {"requestId": "new-transaction-123456", "operation": "delete"})
    reader.assert_not_called()


def test_variable_amount_is_reviewed_and_default_split_uses_exact_current_shares(saved, monkeypatch):
    p = replace(saved.loan, kind="variable", source_label="PG&E", name="PG&E", split_method="income")
    t = saved.client.http_client
    t.rows[BILL_TAB] = t.formulas[BILL_TAB] = encode([p], BILL_TAB, [])
    t.rows["November"][0] = ["", "PG&E", ""]
    t.formulas["November"][0] = ["", "PG&E", ""]
    monkeypatch.setattr("bookiebot.reimbursements.service.enabled", lambda: True)
    source = bills.read_workbook(B, TODAY)
    info = source.charge(p, "2026-11")
    body = {"operation": "amount", "id": p.id, "month": "2026-11", "amount": "98.43", "settingsVersion": source.settings.version, "chargeVersion": info["version"]}
    preview = bills.review(B, body)
    assert preview["share"]["payerCents"] + preview["share"]["partnerCents"] == 9843
    assert preview["share"]["method"] == "income"
    assert not t.sent
    writer = Mock(return_value={"success": True, "detail": "Charge recorded."})
    monkeypatch.setattr(bills, "record_charge", writer)
    result = saved.commands.command(B, {**body, "reviewVersion": preview["reviewVersion"], "requestId": "amount-request-12345678"})
    assert result["success"]
    assert t.rows["November"][0][2] == "98.43"
    assert writer.call_args.args[1]["plan"].split_method == "income"
    assert bills.read_workbook(B, TODAY).charge(p, "2026-11")["recorded"]


def test_adopting_existing_subscription_never_applies_new_split_default(saved, monkeypatch):
    p = replace(saved.loan, id="xfinity_1234", kind="subscription", monthly_source=False, source_tab=SUBSCRIPTION_TAB, split_method="income", source_label="Xfinity", name="Xfinity")
    t = saved.client.http_client
    t.rows[SUBSCRIPTION_TAB] = t.formulas[SUBSCRIPTION_TAB] = encode([p], SUBSCRIPTION_TAB, [])
    t.properties[SUBSCRIPTION_TAB] = {"title": SUBSCRIPTION_TAB, "sheetId": 99, "hidden": True}
    source = bills.read_workbook(B, TODAY)
    body = {"operation": "adopt", "id": p.id, "month": "2026-11", "settingsVersion": source.settings.version, "chargeVersion": source.charge(p, "2026-11")["version"]}
    checked = bills._amount_review(source, body, TODAY)
    assert checked["plan"].split_method == "none"
    assert checked["review"]["share"]["partnerCents"] == 0


def test_a_new_bill_cannot_overwrite_an_existing_budget_aggregate(saved):
    t = saved.client.http_client
    t.rows["December"].append(["", "Groceries", "200"])
    t.formulas["December"].append(["", "Groceries", '=IMPORTRANGE("existing","Grocery")'])
    source = bills.read_workbook(B, TODAY)
    from unit_tests.sheets.test_recurring import form
    body = {"operation": "create", "draftId": "new-bill-draft-1234", "settingsVersion": source.settings.version,
        "bill": form(name="Groceries", splitMethod="none", effectiveFrom="2026-12")}
    with pytest.raises(BillConflict, match="already a budget row"):
        bills.review(B, body)
    assert not t.sent and t.rows["December"][-1][2] == "200"
