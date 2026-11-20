from contextlib import nullcontext
from copy import deepcopy
from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
import pytest

from bookiebot.reports import bill_settings as bills
from bookiebot.sheets import recurring_storage as storage
from bookiebot.sheets.recurring import BillConflict, BillValidation, BILL_TAB, SETTINGS_LOG_TAB, SUBSCRIPTION_TAB
from bookiebot.sheets.recurring_charges import CHARGES_TAB, BillCharge, decode_charges, encode_charges, source_anchor
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


@pytest.mark.parametrize("name,pull_months,tracked,via_schedule", [
    ("PG&E", (), False, False),
    ("Recology", (2, 5, 8, 11), True, False),
    ("Recology", (2, 5, 8, 11), True, True),
])
def test_change_recorded_utility_date_moves_one_charge_preserving_split_and_cash(saved, monkeypatch, name, pull_months, tracked, via_schedule):
    from bookiebot.reports import expense_breakdown as report, transactions
    from bookiebot.reports.reimbursement_overview import cash_calendar, normalize_cash
    from bookiebot.reimbursements import service
    from bookiebot.sheets.recurring_rows import runtime_tables

    month = "2026-11"
    bill = replace(saved.loan, name=name, source_label=name, kind="variable", source_tab=BILL_TAB,
                   category="bills_utilities", amount_cents=None, split_method="equal",
                   cadence="quarterly" if pull_months else "monthly", pull_months=pull_months)
    client, _ = fixture([bill])
    transport = client.http_client
    for data in (transport.rows, transport.formulas):
        data["November"][0][2] = "60.23"
    charge = BillCharge(bill.id, month, "2026-11-01", name, bill.category, transport.properties["November"]["sheetId"],
                        1, 3, source_anchor(bill.id, month), 6023, True, payer_owner="brian", payment_date="2026-11-12")
    if tracked:
        transport.properties[CHARGES_TAB] = {"title": CHARGES_TAB, "sheetId": 50, "gridProperties": {"rowCount": 1000, "columnCount": 32}}
        for data in (transport.rows, transport.formulas):
            data[CHARGES_TAB] = encode_charges([charge], [])
    allocation = {"id": "allocation-1", "version": 3, "projectedVersion": 3, "payerOwner": "brian", "partnerOwner": "hannah",
                  "sourceYear": 2026, "sourceWorksheet": "income", "sourceSheetTitle": "November", "sourceActionId": "bill-source",
                  "sourceRow": 1, "sourceColumnMap": {"amount": 3}, "sourceValues": {"item": name, "date": "2026-11-01"},
                  "expenseDate": "2026-11-01", "billPlanId": bill.id, "category": name,
                  "item": name, "location": "", "payerPerson": "Brian", "accounting": "cash_v1", "method": "equal",
                  "grossCents": 6023, "payerShareCents": 3012, "partnerShareCents": 3011,
                  "settledCents": 3011, "outstandingCents": 0}
    event = {"id": "repayment-1", "allocationId": allocation["id"], "kind": "cash", "status": "confirmed",
             "date": "2026-11-01", "amountCents": 3011}
    ledger = {"allocations": [allocation], "events": [event]}
    original_ledger = deepcopy(ledger)
    store = SimpleNamespace(snapshot=lambda *args, **kwargs: ledger)
    monkeypatch.setattr(service, "enabled", lambda: True)
    monkeypatch.setattr(service, "build_reimbursement_store", lambda: store)
    monkeypatch.setattr(bills, "read_workbook", lambda actor, today: storage.read_workbook(actor, today, client=client))
    monkeypatch.setattr(transactions, "now_pacific", lambda: datetime(2026, 11, 13, 12))
    monkeypatch.setattr(transactions, "get_gspread_client", lambda: client)
    monkeypatch.setattr(transactions, "get_shared_expenses_spreadsheet_id", lambda year: "shared")
    monkeypatch.setattr(transactions, "get_budget_spreadsheet_id_for_user", lambda actor, year: "personal")
    monkeypatch.setattr(transactions, "receipt_addresses", lambda *args: {})
    monkeypatch.setattr(transactions, "read_workbook_tabs",
                        lambda _, book, titles: {"November": []} if book == "shared" else {t: transport.rows[t] for t in titles if t in transport.rows})

    def dates():
        rows = transactions.load_transactions(B, month, fresh=True)
        assert len(rows) == 1
        schedules, _, _ = runtime_tables("brian", transport.rows[BILL_TAB], [], [], transport.rows.get(CHARGES_TAB, []))
        period = report.BudgetMonth(2026, 11)
        cash = normalize_cash(owner="brian", period=month, as_of=TODAY, ledger=ledger, shared=[],
                              personal=transport.rows["November"], schedules=schedules, forecasts=())
        payments = report._payment_items(cash.personal, schedules, period, as_of=TODAY)
        cash.basis(payments)
        events = cash_calendar(report._bill_calendar_events(payments, [], schedules, period, 13, cash.personal, set()), cash)
        assert len(events) == 1 and events[0].amount == 30.12
        return rows[0], events[0].day

    original, original_day = dates()
    assert (original["date"], original_day) == ("2026-11-12", 12)
    current = bills.read_workbook(B, TODAY).charge(bill, month)
    assert current["canEditPaymentDate"]
    body = {"operation": "payment-date", "id": bill.id, "month": month, "paymentDate": "2026-11-09",
            "chargeVersion": current["version"]}
    with pytest.raises(BillValidation, match="within this month"):
        bills.review(B, {**body, "paymentDate": "2026-12-01"})
    reviewed = bills.review(B, body)
    assert (reviewed["previousDate"], reviewed["date"]) == ("2026-11-12", "2026-11-09")
    if via_schedule:
        from unit_tests.sheets.test_recurring import form
        snapshot = bills.read_workbook(B, TODAY)
        body = {"operation": "update", "id": bill.id, "version": bill.version, "settingsVersion": snapshot.settings.version,
                "applyCurrentCharge": False, "bill": form(name=name, type="variable", amount="", pullDay=9,
                    cadence="quarterly", pullMonths=list(pull_months), splitMethod="equal",
                    category="bills_utilities", effectiveFrom=month)}
        recurring_only = bills.review(B, body)
        assert recurring_only["applyCurrentPaymentDate"] is False
        assert recurring_only["currentChange"] is None
        body["applyCurrentPaymentDate"] = True
        reviewed = bills.review(B, body)
        assert reviewed["reviewVersion"] != recurring_only["reviewVersion"]
        assert reviewed["currentPaymentDate"] == {"month": month, "previousDate": "2026-11-12",
                                                  "date": "2026-11-09", "chargeVersion": current["version"]}
        assert reviewed["applyCurrentPaymentDate"] is True
    assert not transport.sent
    changed_tables = {CHARGES_TAB, SETTINGS_LOG_TAB, *([BILL_TAB] if via_schedule else [])}
    unchanged = {t: deepcopy((transport.rows[t], transport.formulas[t]))
                 for t in transport.rows if t not in changed_tables and (not via_schedule or t == "November")}
    body.update(requestId="recorded-date-request-01", reviewVersion=reviewed["reviewVersion"])
    result = saved.commands.command(B, body)
    assert result["success"], result
    assert saved.commands.command(B, body) == result
    assert len(transport.sent) == 1
    written_tables = {r["updateCells"]["start"]["sheetId"] for r in transport.sent[0]["requests"] if "updateCells" in r}
    assert {transport.properties[t]["sheetId"] for t in changed_tables} <= written_tables
    assert via_schedule or written_tables == {transport.properties[t]["sheetId"] for t in changed_tables}
    assert all((transport.rows[t], transport.formulas[t]) == value for t, value in unchanged.items())
    moved, day = dates()
    assert (moved["date"], day) == ("2026-11-09", 9)
    for field in ("id", "amountCents", "displayAmountCents", "split", "repayment"):
        assert moved[field] == original[field]
    assert ledger == original_ledger
    updated, = decode_charges(transport.rows[CHARGES_TAB])
    assert updated.payment_date == "2026-11-09"
    if tracked and not via_schedule:
        assert updated == replace(charge, payment_date="2026-11-09")
    if via_schedule:
        assert updated.charge_date == charge.charge_date
        assert updated.initial_amount_cents == charge.initial_amount_cents
        assert updated.anchor == charge.anchor
        assert result["currentPaymentDate"] == reviewed["currentPaymentDate"]
        return
    with pytest.raises(BillConflict, match="bill charge changed"):
        bills.review(B, {**body, "paymentDate": "2026-11-08"})


def test_current_charge_inspection_exposes_only_the_canonical_public_row(saved, monkeypatch):
    from bookiebot.reports import transactions
    source = bills.read_workbook(B, TODAY)
    row = {"id": "2026-11:recorded-loan", "month": "2026-11", "date": "2026-11-01",
           "billPlanId": saved.loan.id, "version": "recorded-v1", "kind": "payment",
           "fields": {"amount": "60.23"}, "capabilities": {"update": True},
           "_logged": object(), "_manual": True}
    reader = Mock(return_value=[row])
    monkeypatch.setattr(transactions, "load_transactions", reader)
    value = bills.charge_transaction(B, saved.loan.id, source.settings.period)
    reader.assert_called_once_with(B, "2026-11", fresh=True, include_scheduled=True)
    assert value["transaction"]["id"] == row["id"]
    assert value["item"]["fields"] == {"amount": "60.23"}
    assert value["item"]["capabilities"]["update"]
    assert not any(key.startswith("_") for key in value["item"])
    assert not saved.client.http_client.sent


def test_current_charge_inspection_never_selects_another_bill_or_an_ambiguous_source(saved, monkeypatch):
    from bookiebot.reports import transactions
    with pytest.raises(BillConflict, match="unavailable"):
        bills.charge_transaction(B, "another-owners-bill", "2026-11")
    row = {"id": "2026-11:loan", "date": "2026-11-01", "billPlanId": saved.loan.id,
           "kind": "payment", "fields": {"amount": "60.23"}}
    for rows in ([], [row, dict(row)]):
        monkeypatch.setattr(transactions, "load_transactions", lambda *a, **kw: rows)
        with pytest.raises(BillConflict, match="not recorded"):
            bills.charge_transaction(B, saved.loan.id, "2026-11")
    assert not saved.client.http_client.sent


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
    with pytest.raises(transactions.TransactionConflict, match="bill or transfer change"):
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
