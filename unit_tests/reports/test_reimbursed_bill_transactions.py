"""Bill presentation follows confirmed cash, without changing source gross."""
from copy import deepcopy
from dataclasses import asdict
from datetime import datetime
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from bookiebot.reimbursements import service, store as stores
from bookiebot.reports import transactions as tx
from bookiebot.sheets import bills, undo
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.reimbursements.test_store import access, payload, payment, command, reset_command  # noqa: F401

B, H = "676638528590970917", "830984827904851969"


@pytest.fixture
def bill(access, monkeypatch, request):
    actor, category, logged = getattr(request, "param", (B, "PG&E", True))
    owner, partner = ("brian", "hannah") if actor == B else ("hannah", "brian")
    store = stores.ReimbursementStore(access)
    store.initialize()
    allocation = store.register_allocation(payload(
        payerOwner=owner, partnerOwner=partner, payerPerson="Brian (BofA)" if actor == B else "Hannah",
        category=category, item=category, location="", expenseDate="2026-11-01",
        sourceWorksheet="income", sourceSheetTitle="November", sourceYear=2026, sourceRow=1,
        sourceColumnMap={"amount": 3, "item": 2}, sourceValues={"amount": "152.08", "item": category},
        grossCents=15208, payerShareCents=8000, partnerShareCents=7208))
    action = undo.UndoAction(worksheet="income", kind="restore_cells", row=1, columns=[3],
        previous_values=[""], new_values=["152.08"], metadata={"type": "payment", "category": category}, description=category)
    history = [undo._LOG_HEADERS, [allocation["sourceActionId"], "2026-11-01T12:00:00-08:00", actor,
        "active", "", json.dumps(asdict(action))]] if logged else []
    personal = [["", category, "152.08"]]
    clock = [datetime(2026, 11, 4, tzinfo=PACIFIC_TZ)]
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "true")
    monkeypatch.setattr(service, "build_reimbursement_store", lambda: store)
    monkeypatch.setattr(stores, "build_reimbursement_store", lambda: store)
    monkeypatch.setattr(tx, "now_pacific", lambda: clock[0])
    monkeypatch.setattr(tx, "get_gspread_client", lambda: SimpleNamespace())
    monkeypatch.setattr(tx, "get_budget_spreadsheet_id_for_user", lambda *a: "personal")
    monkeypatch.setattr(tx, "get_shared_expenses_spreadsheet_id", lambda *a: "shared")
    monkeypatch.setattr(tx, "read_workbook_tabs", lambda _client, book, titles:
        {"November": personal, "_BookieBot Bill Schedule": [bills.BILL_SCHEDULE_HEADERS,
            [category, category, "monthly", "1", "", category, "", "", "", "200"]]}
        if book == "personal" else {"November": [], "_BookieBot Action Log - 2026-11": history})
    tx._CACHE.clear()
    yield SimpleNamespace(store=store, allocation=allocation, actor=actor, owner=owner, partner=partner,
        personal=personal, history=history, clock=clock)
    tx._CACHE.clear()


def listing(bill, expected):
    before = deepcopy([bill.personal, bill.history, bill.store.snapshot(bill.owner)])
    result = tx.listing(bill.actor, {"month": "2026-11", "view": "daily", "scope": "spending", "fresh": "1"})
    assert len(result["items"]) == result["total"] == 1
    row = result["items"][0]
    assert row["amountCents"] == 15208  # Original charge remains the mutation/split authority.
    assert row["fields"]["amount"] == "152.08"
    assert row["displayAmountCents"] == result["totalAmountCents"] == expected
    assert result["days"][0]["totalCents"] == result["days"][0]["needsCents"] == expected
    assert [bill.personal, bill.history, bill.store.snapshot(bill.owner)] == before
    return result


@pytest.mark.parametrize("bill", [(actor, category, logged) for actor in (B, H)
    for category in ("PG&E", "Recology", "Water", "rent") for logged in (True, False)], indirect=True)
def test_confirmed_partial_full_and_reversed_receipts_control_bill_display(bill):
    initial = listing(bill, 15208)
    reported = bill.store.command(bill.partner, payment(bill.allocation, 2000, "report_payment"))
    assert listing(bill, 15208)["items"][0]["id"] == initial["items"][0]["id"]
    event = reported["events"][0]
    bill.store.command(bill.owner, command("confirm_payment", allocationId=bill.allocation["id"],
        version=bill.allocation["version"], eventId=event["id"]))
    partial = listing(bill, 13208)
    assert partial["snapshotVersion"] != initial["snapshotVersion"]
    # Canonical cash wins even while the sheet still contains its stale gross.
    assert bill.personal[0][2] == "152.08"
    current = bill.store.get_allocation(bill.allocation["id"])
    bill.store.command(bill.owner, payment(current, 5208))
    settled = listing(bill, 8000)
    assert settled["items"][0]["id"] == initial["items"][0]["id"]
    assert tx.listing(bill.actor, {"month": "2026-11", "search": "80.00"})["total"] == 1
    # Full gross is still available to match the original bank charge.
    logged = undo.LoggedAction(id=bill.allocation["sourceActionId"], created_at="2026-11-01",
        user_key=bill.actor, action=undo.UndoAction(worksheet="income", kind="restore_cells", row=1,
            columns=[3], previous_values=[], new_values=["152.08"], metadata={"type": "payment"}, description="bill"))
    bank = undo.canonical_logged_actions([logged], for_reconciliation=True)[0]
    assert undo._field_values_for_action(bank.action)["amount"] == "152.08"
    bill.store.command(bill.owner, command("reverse", eventId=event["id"]))
    listing(bill, 10000)
    if bill.actor == B and bill.allocation["category"] == "PG&E" and bill.history and os.getenv("BOOKIEBOT_NET_BILL_FIXTURE"):
        Path(os.environ["BOOKIEBOT_NET_BILL_FIXTURE"]).write_text(json.dumps({"initial": initial, "partial": partial, "settled": settled}))


def test_clearing_debt_does_not_invent_a_received_repayment(bill):
    bill.store.mark_projected(bill.allocation["id"], bill.allocation["version"])
    bill.store.command(bill.owner, reset_command(bill.store))
    listing(bill, 15208)


def test_receipts_do_not_release_queued_bill_before_its_withdrawal(bill):
    bill.store.command(bill.owner, payment(bill.allocation, 2000))
    bill.clock[0] = datetime(2026, 10, 31, tzinfo=PACIFIC_TZ)
    assert tx.listing(bill.actor, {"month": "2026-11", "fresh": "1"})["items"] == []


@pytest.mark.parametrize("bill", [(B, category, logged) for category in ("PG&E", "Recology", "Water")
                                  for logged in (True, False)], indirect=True)
def test_fully_reimbursed_bill_is_not_hidden_by_a_later_saved_pull_day(bill, monkeypatch):
    read = tx.read_workbook_tabs
    def later_schedule(client, book, titles):
        result = read(client, book, titles)
        if book == "personal":
            result["_BookieBot Bill Schedule"][1][3] = "22"
        return result
    monkeypatch.setattr(tx, "read_workbook_tabs", later_schedule)
    bill.clock[0] = datetime(2026, 11, 13, tzinfo=PACIFIC_TZ)
    assert tx.listing(bill.actor, {"month": "2026-11", "fresh": "1"})["items"] == []
    bill.store.command(bill.owner, {**payment(bill.allocation, 7208), "date": "2026-11-02"})
    result = listing(bill, 8000)
    assert result["items"][0]["date"] == "2026-11-01"
    assert result["items"][0]["repayment"]["outstandingCents"] == 0
    assert result["days"][0]["date"] == "2026-11-01"


@pytest.mark.parametrize("actor,amount", [(B, "80.00"), (H, "72.08")])
@pytest.mark.parametrize("display_name", ["PG&E", "Electricity"])
def test_overview_and_calendar_restore_settled_bill_cash_for_both_people(bill, monkeypatch, actor, amount, display_name):
    from bookiebot.reports import expense_breakdown as reports
    from unit_tests.support.sheets_repo_stub import InMemoryWorksheet
    bill.store.command(bill.owner, {**payment(bill.allocation, 7208), "date": "2026-11-02"})
    ledger = {**bill.store.snapshot("brian" if actor == B else "hannah"), "projectionPending": False}
    monkeypatch.setattr(service, "snapshot", lambda _: ledger)
    monkeypatch.setattr(reports, "now_pacific", lambda: datetime(2026, 11, 13, tzinfo=PACIFIC_TZ))
    sheets = reports.ReportWorksheets(shared_expenses=InMemoryWorksheet([]),
        personal_budget=InMemoryWorksheet([["Monthly Income", "1000"], ["", "PG&E", amount]]),
        bill_schedule=InMemoryWorksheet([bills.BILL_SCHEDULE_HEADERS, ["pge", display_name, "monthly", "22", "", "PG&E"]]))
    before = deepcopy(sheets.personal_budget._rows)
    result = reports.build_expense_breakdown_report(actor_key=actor,
        owner_name="Brian" if actor == B else "Hannah", persons=[], month=reports.BudgetMonth(2026, 11), worksheets=sheets)
    payload = reports.expense_breakdown_client_payload(result)
    assert payload["modeViews"]["current"]["metrics"]["totalExpenses"] == float(amount)
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == float(amount)
    assert result.queued_bills == []
    assert result.payments[0].label == display_name
    assert result.payments[0].date == "2026-11-01"
    event = next(e for e in payload["calendarEvents"] if e["kind"] == "bill")
    assert event["day"] == 1 and event["amount"] == float(amount)
    assert not event["projectedOnly"]
    assert sheets.personal_budget._rows == before


def test_recipient_recorded_bill_is_not_lost_after_full_repayment(bill, monkeypatch):
    bill.store.command(bill.owner, {**payment(bill.allocation, 7208), "date": "2026-11-02"})
    bill.personal[0][2] = "72.08"
    read = tx.read_workbook_tabs
    def later_schedule(client, book, titles):
        result = read(client, book, titles)
        if book == "personal":
            result["_BookieBot Bill Schedule"][1][3] = "22"
        return result
    monkeypatch.setattr(tx, "read_workbook_tabs", later_schedule)
    bill.clock[0] = datetime(2026, 11, 13, tzinfo=PACIFIC_TZ)
    before = deepcopy([bill.personal, bill.history, bill.store.snapshot("hannah")])
    result = tx.listing(H, {"month": "2026-11", "fresh": "1", "view": "daily", "scope": "spending"})
    assert result["total"] == 1 and result["totalAmountCents"] == 7208
    row = result["items"][0]
    assert row["date"] == "2026-11-01"
    assert not row.get("contextOnly") and not row["capabilities"]["split"]
    assert [bill.personal, bill.history, bill.store.snapshot("hannah")] == before


def test_confirmed_zero_exposure_keeps_the_paid_bill_and_its_identity(bill):
    # A valid all-partner custom bill; a missing manual log must not lose it
    # merely because the projected payer cell becomes zero.
    bill.store.mark_projected(bill.allocation["id"], bill.allocation["version"])
    value = bill.store.revise_allocation(bill.owner, bill.allocation["id"], bill.allocation["version"],
        {"payerShareCents": 0, "partnerShareCents": 15208, "method": "custom", "customPayerBasisPoints": 0}, operation="split")
    bill.store.mark_projected(value["id"], value["version"])
    bill.store.command(bill.owner, payment(value, 15208))
    bill.history.clear()
    bill.personal[0][2] = "0.00"
    zero = listing(bill, 0)
    if (target := os.getenv("BOOKIEBOT_NET_BILL_FIXTURE")) and Path(target).exists():
        Path(target).write_text(json.dumps({**json.loads(Path(target).read_text()), "zero": zero}))


@pytest.mark.parametrize("accounting,worksheet", [("cash_v1", "expense"), ("legacy_net", "income")])
def test_purchase_cash_uses_receipts_and_legacy_amount_contract_is_unchanged(bill, accounting, worksheet):
    value = {**bill.allocation, "sourceWorksheet": worksheet, "accounting": accounting, "settledCents": 2000,
             "category": "need_expenses" if worksheet == "expense" else "PG&E"}
    logged = undo.LoggedAction(id=value["sourceActionId"], created_at="2026-11-01", user_key=bill.actor,
        action=undo.UndoAction(worksheet=worksheet, kind="restore_cells", row=1, columns=[3],
            previous_values=[], new_values=["152.08"], metadata={"type": "payment" if worksheet == "income" else "expense"}, description="source"))
    current = undo._allocation_action(logged, value)
    assert current is not None
    public = tx._public(bill.actor, "2026-11", current, bill.personal)
    assert public["amountCents"] == 15208
    if accounting == "cash_v1":
        assert public["displayAmountCents"] == 13208
    else:
        assert "displayAmountCents" not in public


def test_recipient_bill_uses_its_existing_received_cell_without_second_deduction(bill):
    bill.store.command(bill.owner, payment(bill.allocation, 2000))
    bill.personal[0][2] = "20.00"
    result = tx.listing(H, {"month": "2026-11", "scope": "spending", "view": "daily", "fresh": "1"})
    assert result["totalAmountCents"] == result["items"][0]["amountCents"] == 2000
    assert "displayAmountCents" not in result["items"][0]
    assert not any(result["items"][0]["capabilities"].values())
