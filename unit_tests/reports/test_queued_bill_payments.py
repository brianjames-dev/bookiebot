"""Entered bill amounts change visibility at withdrawal without financial writes."""
from copy import deepcopy
from dataclasses import asdict, replace
from datetime import date, datetime
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from bookiebot.reports import expense_breakdown as reports, transactions as tx
from bookiebot.sheets import bills, undo
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet

B = "676638528590970917"


def schedule(day="15", expected="200", recurrence="monthly", months=""):
    return [bills.BILL_SCHEDULE_HEADERS,
            ["pge", "PG&E", recurrence, day, months, "PG&E", "", "", "", expected]]


def report(monkeypatch, *, today=4, amount="152.08", rows=None, schedules=None):
    clock = datetime(2026, 11, today, 0, tzinfo=PACIFIC_TZ)
    monkeypatch.setattr(reports, "now_pacific", lambda: clock)
    worksheets = reports.ReportWorksheets(
        shared_expenses=InMemoryWorksheet([]),
        personal_budget=InMemoryWorksheet(rows or [["Monthly Income", "1000"], ["", "PG&E", amount]]),
        bill_schedule=InMemoryWorksheet(schedule() if schedules is None else schedules),
    )
    before = deepcopy(worksheets.personal_budget._rows)
    result = reports.build_expense_breakdown_report(actor_key=B, owner_name="Brian", persons=["Brian"],
        month=reports.BudgetMonth(2026, 11), worksheets=worksheets)
    assert worksheets.personal_budget._rows == before
    return result, reports.expense_breakdown_client_payload(result)


@pytest.mark.parametrize("today,paid", [(4, False), (14, False), (15, True), (16, True)])
def test_entered_amount_counts_only_on_withdrawal_date(monkeypatch, today, paid):
    result, payload = report(monkeypatch, today=today)
    current, projected = (payload["modeViews"][mode] for mode in ("current", "projected"))
    assert current["metrics"]["totalExpenses"] == (152.08 if paid else 0)
    assert current["categorySpending"]["needs"] == (152.08 if paid else 0)
    assert projected["metrics"]["totalExpenses"] == 152.08
    assert projected["categorySpending"]["needs"] == 152.08
    assert len(result.payments) == int(paid)
    assert len(result.queued_bills) == int(not paid)
    event = next(e for e in payload["calendarEvents"] if e["kind"] == "bill")
    assert event["day"] == 15 and event["amount"] == 152.08
    assert event["projectedOnly"] is not paid
    assert not event.get("amountEstimated")
    assert payload["comparisonData"]["recordedExpenses"] == ([
        {"label": "PG&E", "amount": 152.08, "category": "bills_utilities", "date": "2026-11-15"},
    ] if paid else [])
    assert payload["comparisonData"]["modeExpenses"]["projected"]["unitemizedExpenses"] == 0


@pytest.mark.parametrize("today", [4, 15, 30])
def test_expected_amount_never_becomes_recorded_without_entered_amount(monkeypatch, today):
    result, payload = report(monkeypatch, amount="0", today=today)
    assert result.payments == result.queued_bills == []
    assert payload["modeViews"]["current"]["metrics"]["totalExpenses"] == 0
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 200
    assert all(e["projectedOnly"] and e.get("amountEstimated") for e in payload["calendarEvents"] if e["kind"] == "bill")


@pytest.mark.parametrize("schedules", [[], schedule(day=""), schedule() + schedule()[1:],
                                             schedule(recurrence="quarterly", months="2,5,8")])
def test_missing_ambiguous_and_off_cycle_dates_stay_queued_including_sheet_fallback(monkeypatch, schedules):
    result, payload = report(monkeypatch, schedules=schedules,
        rows=[["Monthly Income", "1000"], ["", "PG&E", "152.08"], ["Needs Subtotal", "152.08"]])
    assert result.payments == []
    assert result.queued_bills[0].date == ""
    assert payload["modeViews"]["current"]["metrics"]["totalExpenses"] == 0
    assert payload["modeViews"]["current"]["categorySpending"]["needs"] == 0
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 152.08
    assert not [e for e in payload["calendarEvents"] if e["kind"] == "bill"]


def test_payment_day_clamps_and_never_rolls_to_another_occurrence():
    plans = bills.list_bill_schedules(schedule(day="31"))
    state = bills.bill_payment_state("PG&E", 2028, 2, plans, as_of=date(2028, 2, 28))
    assert state.withdrawal_date == date(2028, 2, 29) and not state.paid
    assert bills.bill_payment_state("PG&E", 2028, 2, plans, as_of=date(2028, 3, 1)).paid
    assert not bills.bill_payment_state("Other PG&E reseller", 2028, 2, plans, as_of=date(2028, 3, 1)).paid


@pytest.mark.parametrize("logged", [True, False])
def test_transactions_transition_at_pacific_midnight_with_same_source_and_no_write(monkeypatch, logged):
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false")
    tx._CACHE.clear()
    clock = [datetime(2026, 11, 14, 23, 59, 59, tzinfo=PACIFIC_TZ)]
    monkeypatch.setattr(tx, "now_pacific", lambda: clock[0])
    action = undo.UndoAction(worksheet="income", kind="restore_cells", row=1, columns=[3],
        previous_values=[""], new_values=["152.08"], metadata={"type": "payment", "category": "PG&E"}, description="PG&E")
    personal = [["", "PG&E", "152.08"]]
    history = [undo._LOG_HEADERS, ["original-bill", "2026-11-01T12:00:00-08:00", B, "active", "", json.dumps(asdict(action))]] if logged else []
    snapshot = deepcopy([personal, history])
    requests = []
    def read(_client, book, titles):
        requests.append((book, titles))
        return ({"November": personal, "_BookieBot Bill Schedule": schedule()}
                if book == "personal" else {"November": [], "_BookieBot Action Log - 2026-11": history})
    monkeypatch.setattr(tx, "read_workbook_tabs", read)
    monkeypatch.setattr(tx, "get_gspread_client", lambda: SimpleNamespace())
    monkeypatch.setattr(tx, "get_budget_spreadsheet_id_for_user", lambda *args: "personal")
    monkeypatch.setattr(tx, "get_shared_expenses_spreadsheet_id", lambda *args: "shared")
    queued = tx.listing(B, {"month": "2026-11", "view": "daily"})
    assert queued["total"] == 0
    clock[0] = datetime(2026, 11, 15, tzinfo=PACIFIC_TZ)
    paid = tx.listing(B, {"month": "2026-11", "view": "daily"})
    assert paid["total"] == 1 and paid["totalAmountCents"] == 15208
    assert paid["items"][0]["date"] == "2026-11-15"
    assert paid["items"][0]["actionId"] == ("original-bill" if logged else "sheet-payment-1")
    assert paid["items"][0]["editableFields"] == ["amount"]
    assert tx.listing(B, {"month": "2026-11", "view": "daily"}) == paid
    assert len(requests) == 4  # One personal/shared batch per day, then cache.
    assert [personal, history] == snapshot
    if logged and (target := os.getenv("BOOKIEBOT_QUEUED_BILL_FIXTURE")):
        Path(target).write_text(json.dumps({"queued": queued, "paid": paid,
            "queuedReport": report(monkeypatch, today=14)[1], "paidReport": report(monkeypatch, today=15)[1]}))
    tx._CACHE.clear()


def test_later_bank_charge_matches_the_early_entered_bill_once():
    from bookiebot.banking.reconciliation import ScheduledPullCandidate, reconcile_transaction
    from unit_tests.banking.test_reconciliation import _transaction
    action = undo.LoggedAction(id="original-bill", created_at="2026-11-01T12:00:00-08:00", user_key=B,
        action=undo.UndoAction(worksheet="income", kind="restore_cells", row=22, columns=[3],
            previous_values=[""], new_values=["152.08"], metadata={"type": "payment", "category": "PG&E"}, description="PG&E payment"))
    pull = ScheduledPullCandidate(source_type="bill", name="PG&E", amount=152.08,
        pull_date=date(2026, 11, 15), source_ref="_BookieBot Bill Schedule!A3:J3", amount_recorded=True)
    charge = replace(_transaction("PG&E", 152.08), date="2026-11-15")
    matched = reconcile_transaction(charge, [action], [pull])
    assert matched.status == "matched" and matched.matched_action_log_id == action.id
    assert "income!row 22" in matched.matched_sheet_ref and pull.occurrence_ref in matched.matched_sheet_ref
    duplicate = reconcile_transaction(charge, [action], [pull], excluded_action_ids={action.id},
        excluded_sheet_refs={pull.occurrence_ref})
    assert duplicate.matched_action_log_id is None and not duplicate.matched_sheet_ref


@pytest.mark.asyncio
@pytest.mark.parametrize("today,paid", [(4, False), (15, True), (30, True)])
async def test_bill_status_queries_follow_the_same_withdrawal_rule(monkeypatch, today, paid):
    from bookiebot.sheets import utils, routing
    from unit_tests.support.sheets_repo_stub import SheetsRepoStub
    monkeypatch.setattr(routing, "now_pacific", lambda: datetime(2026, 11, today, tzinfo=PACIFIC_TZ))
    repo = SheetsRepoStub(income_rows=[["", "PG&E", "152.08"]], bill_schedule_rows=schedule())
    with repo.patched():
        assert await utils.check_pge_paid() == (paid, 152.08)
