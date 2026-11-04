"""Scheduled subscription occurrences join Transactions on their withdrawal day."""
from copy import deepcopy
from datetime import datetime
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from bookiebot.reports import expense_breakdown as reports, transactions as tx
from bookiebot.sheets import bills
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet

B, H = "676638528590970917", "830984827904851969"


@pytest.fixture
def subscriptions(monkeypatch):
    clock = [datetime(2026, 11, 4, tzinfo=PACIFIC_TZ)]
    source = [["cadence", "name", "amount", "pull_day", "pull_month", "kind", "active"],
        ["monthly", "Xfinity", "61.50", "2", "", "needs", "yes"],
        ["monthly", "Slate Digital All Access", "14.99", "4", "", "wants", "yes"],
        ["monthly", "YouTube Premium", "15.99", "5", "", "wants", "yes"],
        ["yearly", "Amazon Prime", "152.90", "29", "10", "needs", "yes"],
        ["monthly", "Canceled", "10", "1", "", "needs", "no"],
        ["monthly", "Missing date", "9", "", "", "needs", "yes"],
        ["monthly", "Free service", "0", "1", "", "wants", "yes"]]
    personal = [["", "Rent", "2103.73"]]
    expenses = [[], []]
    # An isolated source grid; no live sheets, credentials, or financial writes.
    for category, amount in [("grocery", "25.13"), ("gas", "10.00"), ("shopping", "13.00"), ("need_expenses", "464.72")]:
        from bookiebot.sheets import undo
        columns = undo._category_columns(category)
        values = {"date": "11/3/2026", "amount": amount, "person": "Brian (BofA)", "item": "Fixture purchase", "location": "Fixture merchant"}
        if len(expenses) == 2:
            expenses.append([""] * 45)
        for field, column in columns.items():
            expenses[2][column - 1] = values[field]
    schedule = [bills.BILL_SCHEDULE_HEADERS, ["rent", "Rent", "monthly", "1", "", "Rent", "", "", "", ""]]
    requests = []
    def read(_client, book, titles):
        requests.append((book, list(titles)))
        return ({"November": personal, "February": personal, "October": personal,
            "Subscriptions": source, "_BookieBot Bill Schedule": schedule} if book == "personal" else
            {"November": expenses, "February": expenses, "October": expenses})
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false")
    monkeypatch.setattr(tx, "get_gspread_client", lambda: SimpleNamespace())
    monkeypatch.setattr(tx, "read_workbook_tabs", read)
    monkeypatch.setattr(tx, "get_budget_spreadsheet_id_for_user", lambda *args: "personal")
    monkeypatch.setattr(tx, "get_shared_expenses_spreadsheet_id", lambda *args: "shared")
    monkeypatch.setattr(tx, "configured_reimbursement_workbooks", lambda *args: {2026: "personal"})
    monkeypatch.setattr(tx, "now_pacific", lambda: clock[0])
    monkeypatch.setattr(reports, "now_pacific", lambda: clock[0])
    from bookiebot.reports import phone_history
    monkeypatch.setattr(phone_history, "now_pacific", lambda: clock[0])
    tx._CACHE.clear()
    yield SimpleNamespace(clock=clock, source=source, personal=personal, expenses=expenses, schedule=schedule, requests=requests)
    tx._CACHE.clear()


def listing(actor=B, **query):
    return tx.listing(actor, {"month": "2026-11", "view": "daily", "scope": "spending", **query})


def current(subscriptions, year=2026, month=11):
    return reports.expense_breakdown_client_payload(reports.build_expense_breakdown_report(
        actor_key=B, owner_name="Brian", persons=["Brian (BofA)"], month=reports.BudgetMonth(year, month),
        worksheets=reports.ReportWorksheets(shared_expenses=InMemoryWorksheet(subscriptions.expenses),
            personal_budget=InMemoryWorksheet(subscriptions.personal), subscriptions=InMemoryWorksheet(subscriptions.source),
            bill_schedule=InMemoryWorksheet(subscriptions.schedule))))


@pytest.mark.parametrize("day,expected", [(1, 0), (2, 6150), (3, 6150), (4, 7649), (5, 9248)])
def test_elapsed_subscriptions_close_the_current_vs_transactions_gap(subscriptions, day, expected):
    subscriptions.clock[0] = subscriptions.clock[0].replace(day=day)
    before = deepcopy([subscriptions.personal, subscriptions.expenses, subscriptions.source])
    result, report = listing(), current(subscriptions)
    sources = [row for row in result["items"] if row["kind"] == "subscription"]
    assert sum(row["amountCents"] for row in sources) == expected
    assert result["totalAmountCents"] == round(report["modeViews"]["current"]["metrics"]["totalExpenses"] * 100)
    assert sum(day["totalCents"] for day in result["days"]) == result["totalAmountCents"]
    assert [subscriptions.personal, subscriptions.expenses, subscriptions.source] == before
    assert all(not row["actionId"] for row in sources)
    assert len(subscriptions.requests) == 2 and "Subscriptions" in subscriptions.requests[0][1]
    if day == 4:
        assert result["totalAmountCents"] == 269307  # The reported $76.49 gap.
        assert {row["title"]: row["date"] for row in sources} == {"Xfinity": "2026-11-02", "Slate Digital All Access": "2026-11-04"}
        if target := os.getenv("BOOKIEBOT_PAID_SUBSCRIPTIONS_FIXTURE"):
            variants = {"all": result, "wants": listing(bucket="wants"), "needs": listing(bucket="needs"),
                "category": listing(category="subscriptions_wants"), "search": listing(search="slate"), "income": listing(kind="income", scope="")}
            Path(target).write_text(json.dumps({"results": variants, "report": report}))


def test_midnight_cache_and_refresh_keep_one_stable_occurrence(subscriptions):
    subscriptions.clock[0] = subscriptions.clock[0].replace(day=3, hour=23, minute=59, second=59)
    before = listing()
    xfinity = next(row for row in before["items"] if row["kind"] == "subscription")
    subscriptions.clock[0] = datetime(2026, 11, 4, tzinfo=PACIFIC_TZ)
    after = listing()
    assert after["totalAmountCents"] - before["totalAmountCents"] == 1499
    assert xfinity == next(row for row in after["items"] if row["title"] == "Xfinity")
    assert listing() == listing(fresh="1") == after
    subscriptions.source[1][2] = "62.50"
    changed = next(row for row in listing(fresh="1")["items"] if row["title"] == "Xfinity")
    assert changed["id"] == xfinity["id"] and changed["version"] != xfinity["version"]
    assert changed["amountCents"] == 6250
    subscriptions.source[1][3] = "3"
    redated = next(row for row in listing(fresh="1")["items"] if row["title"] == "Xfinity")
    assert redated["id"] == changed["id"] and redated["version"] != changed["version"]
    assert redated["date"] == "2026-11-03"


def test_needs_wants_search_category_and_owner_isolation(subscriptions):
    wants = listing(bucket="wants")
    assert wants["totalAmountCents"] == 1300 + 1499
    assert sum(day["wantsCents"] for day in wants["days"]) == wants["totalAmountCents"]
    assert listing(category="subscriptions_wants")["totalAmountCents"] == 1499
    assert listing(search="slate")["totalAmountCents"] == 1499
    assert listing(split="shared")["totalAmountCents"] == 0
    brian = next(row for row in listing()["items"] if row["title"] == "Xfinity")
    hannah = next(row for row in listing(H)["items"] if row["title"] == "Xfinity")
    assert brian["id"] != hannah["id"] and hannah["person"] == "Hannah"


@pytest.mark.parametrize("operation", ["update", "move", "split", "cancel_split", "delete"])
def test_schedule_occurrence_cannot_be_adopted_as_an_editable_purchase(subscriptions, operation):
    source = next(row for row in listing()["items"] if row["kind"] == "subscription")
    assert not any(source["capabilities"].values()) and source["editableFields"] == []
    with pytest.raises(tx.TransactionValidation, match="subscription schedule"):
        tx.review(B, {"id": source["id"], "version": source["version"], "month": "2026-11", "operation": operation})


@pytest.mark.parametrize("year,month,day,expected", [(2026, 2, 27, 0), (2026, 2, 28, 700), (2028, 2, 28, 0), (2028, 2, 29, 700), (2026, 11, 30, 500)])
def test_annual_and_month_end_occurrences_match_current(subscriptions, year, month, day, expected):
    subscriptions.expenses[:] = [[], []]
    subscriptions.source[:] = [subscriptions.source[0],
        ["yearly", "Annual test", "7", "29", "2", "wants", "yes"],
        ["monthly", "Month end test", "5", "31", "", "needs", "yes"]]
    subscriptions.clock[0] = datetime(year, month, day, tzinfo=PACIFIC_TZ)
    result = listing(month=f"{year:04d}-{month:02d}")
    rows = [row for row in result["items"] if row["kind"] == "subscription"]
    annual = sum(row["amountCents"] for row in rows if row["title"] == "Annual test")
    assert annual == (expected if month == 2 else 0)
    assert sum(row["amountCents"] for row in rows) == (1200 if month == 2 and expected else expected)
    assert result["totalAmountCents"] == round(current(subscriptions, year, month)["modeViews"]["current"]["metrics"]["totalExpenses"] * 100)


def test_all_months_and_pagination_aggregate_each_occurrence_once(subscriptions):
    subscriptions.source[1:] = [["monthly", f"Service {n}", "1.01", "2", "", "wants", "yes"] for n in range(45)]
    first, second = listing(), listing(offset="40")
    assert first["total"] == 50 and len(second["items"]) == 10
    assert first["totalAmountCents"] == second["totalAmountCents"] == 261658 + 4545
    assert first["days"] == second["days"] and first["snapshotVersion"] == second["snapshotVersion"]
    all_months = listing(month="all")
    assert all_months["total"] == 150  # Three existing fixture months only.
    assert len({row["id"] for row in tx.load_transactions(B, "all")}) == 150


def test_duplicate_saved_lines_retain_current_totals_and_distinct_occurrences(subscriptions):
    subscriptions.source.append(list(subscriptions.source[1]))
    first = listing()
    rows = [row for row in first["items"] if row["title"] == "Xfinity"]
    assert len(rows) == len({row["id"] for row in rows}) == 2
    assert first["totalAmountCents"] == 269307 + 6150
    assert listing(fresh="1") == first


def test_completed_month_has_one_annual_occurrence_in_its_own_month(subscriptions):
    subscriptions.expenses[:] = [[], []]
    result = listing(month="2026-10")
    annual = [row for row in result["items"] if row["title"] == "Amazon Prime"]
    assert len(annual) == 1 and annual[0]["date"] == "2026-10-29"
    assert annual[0]["amountCents"] == 15290
    assert result["totalAmountCents"] == round(current(subscriptions, 2026, 10)["modeViews"]["current"]["metrics"]["totalExpenses"] * 100)


