from dataclasses import replace

from bookiebot.reports import expense_breakdown as reports
from bookiebot.reports.expense_breakdown import BudgetMonth, ReportWorksheets
from bookiebot.sheets import reimbursement_history as history
from unit_tests.sheets.test_reimbursement_history import BRIAN, HANNAH, NOW, allocation, ledger
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


def build(month, reimbursement_history):
    return reports.build_expense_breakdown_report(
        actor_key=BRIAN, owner_name="Brian", persons=["Brian (BofA)"], month=month,
        worksheets=ReportWorksheets(
            shared_expenses=InMemoryWorksheet([]),
            personal_budget=InMemoryWorksheet([["Monthly Income", "$5,000.00"]]),
            reimbursement_history=reimbursement_history,
        ),
    )


def test_open_balances_survive_month_and_year_changes_without_changing_monthly_finances(monkeypatch):
    monkeypatch.setattr(reports, "now_pacific", lambda: NOW)
    all_ledgers = [
        ledger(2026, allocation(), allocation("november", expense_date="11/2/2026")),
        ledger(2027, allocation("january", expense_date="1/2/2027", received_amount=25)),
    ]
    snapshot = history.reimbursement_history_from_ledgers(BRIAN, all_ledgers, as_of=NOW)
    empty = history.reimbursement_history_from_ledgers(BRIAN, [], as_of=NOW)
    for month, selected in [(BudgetMonth(2026, 11), ["november"]),
                            (BudgetMonth(2026, 12), ["old"]),
                            (BudgetMonth(2027, 1), ["january"])]:
        report = build(month, snapshot)
        payload = reports.expense_breakdown_client_payload(report)
        baseline = reports.expense_breakdown_client_payload(build(month, empty))
        assert [item["id"] for item in payload["sharedReimbursements"]] == selected
        assert [item["id"] for item in payload["openSharedReimbursements"]] == ["november", "old", "january"]
        assert sum(item["outstandingAmount"] for item in payload["openSharedReimbursements"]) == 275
        assert payload["metrics"] == baseline["metrics"]
        assert payload["modeViews"] == baseline["modeViews"]
        assert payload["dailyEntries"] == baseline["dailyEntries"]
        assert payload["calendarEvents"] == baseline["calendarEvents"]
        assert payload["reimbursementCoverage"]["asOf"] == "2027-01-07"


def test_monthly_history_keeps_received_items_while_outstanding_uses_latest_lifecycle(monkeypatch):
    monkeypatch.setattr(reports, "now_pacific", lambda: NOW)
    receipt = allocation("received", status="reimbursed", received_amount=100,
                         updated_at="2027-01-06T10:00:00-08:00", received_at="2027-01-06T10:00:00-08:00")
    cancelled = allocation("cancelled", status="void", updated_at="2027-01-05T10:00:00-08:00")
    snapshot = history.reimbursement_history_from_ledgers(BRIAN, [
        ledger(2026, allocation("received"), allocation("cancelled")),
        ledger(2027, receipt, cancelled),
    ], as_of=NOW)
    payload = reports.expense_breakdown_client_payload(build(BudgetMonth(2026, 12), snapshot))
    assert payload["openSharedReimbursements"] == []
    assert [(item["id"], item["receivedAmount"]) for item in payload["sharedReimbursements"]] == [("received", 100)]
    assert payload["metrics"]["monthlyIncome"] == 5000


def test_cross_owner_rows_never_escape_in_either_reimbursement_field(monkeypatch):
    monkeypatch.setattr(reports, "now_pacific", lambda: NOW)
    snapshot = history.reimbursement_history_from_ledgers(BRIAN, [ledger(2026,
        allocation(),
        allocation("other", actor_key=HANNAH, owner_key="hannah", payer="Hannah", partner="Brian"),
    )], as_of=NOW)
    payload = reports.expense_breakdown_client_payload(build(BudgetMonth(2026, 12), snapshot))
    assert [item["id"] for item in payload["sharedReimbursements"]] == ["old"]
    assert [item["id"] for item in payload["openSharedReimbursements"]] == ["old"]


def test_incomplete_history_preserves_explicit_coverage_in_report_payload(monkeypatch):
    monkeypatch.setattr(reports, "now_pacific", lambda: NOW)
    snapshot = history.reimbursement_history_from_ledgers(BRIAN, [ledger(2027, allocation())],
        as_of=NOW, unavailable_years=[2026])
    payload = reports.expense_breakdown_client_payload(build(BudgetMonth(2027, 1), snapshot))
    assert len(payload["openSharedReimbursements"]) == 1
    assert payload["reimbursementCoverage"] == {
        "status": "partial", "asOf": "2027-01-07", "years": [2027],
        "unavailableYears": [2026], "excludedRecords": 0,
    }
    unavailable = replace(snapshot, records=(), ledgers=(), years=(), unavailable_years=(2026, 2027))
    payload = reports.expense_breakdown_client_payload(build(BudgetMonth(2027, 1), unavailable))
    assert payload["openSharedReimbursements"] == []
    assert payload["reimbursementCoverage"]["status"] == "unavailable"
