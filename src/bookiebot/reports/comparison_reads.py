"""Batch dated comparison inputs, without loading unrelated report history."""
from __future__ import annotations

import calendar
from typing import Any

from bookiebot.reports.batched_report_reads import ReportWorksheetRows
from bookiebot.reports.expense_breakdown import (
    BudgetMonth, ReportWorksheets, build_expense_breakdown_report, expense_breakdown_client_payload,
)
from bookiebot.reports.worksheet_reads import read_workbook_tabs
from bookiebot.sheets.routing import (
    get_budget_spreadsheet_id_for_user, get_shared_expenses_spreadsheet_id, now_pacific,
)


def load_comparison_year(payload: dict) -> dict[int, dict[str, Any]]:
    from bookiebot.sheets.auth import get_gspread_client

    actor, year = str(payload["actor_key"]), int(payload["year"])
    current = now_pacific()
    if year > current.year:
        return {}
    months = range(1, (current.month if year == current.year else 12) + 1)
    titles = [calendar.month_name[number] for number in months]
    gc = get_gspread_client()
    # All baseline months in this annual workbook share four actual HTTP reads.
    # Required batch failures propagate: a quota error is never an empty month.
    personal = read_workbook_tabs(gc, get_budget_spreadsheet_id_for_user(actor, year),
                                 [*titles, "Subscriptions", "_BookieBot Bill Schedule"])
    shared = read_workbook_tabs(gc, get_shared_expenses_spreadsheet_id(year), titles)
    results = {}
    for number in months:
        title = calendar.month_name[number]
        if title not in personal or title not in shared:
            continue
        # Reuse canonical recorded/scheduled/residual calculations. Comparison
        # does not use projections, utility history or reimbursement balances.
        report = build_expense_breakdown_report(
            actor_key=actor, owner_name=str(payload["owner_name"]),
            persons=[str(person) for person in payload["persons"]], month=BudgetMonth(year, number),
            worksheets=ReportWorksheets(
                shared_expenses=ReportWorksheetRows(title, shared[title]),
                personal_budget=ReportWorksheetRows(title, personal[title]),
                subscriptions=ReportWorksheetRows("Subscriptions", personal["Subscriptions"]) if "Subscriptions" in personal else None,
                bill_schedule=ReportWorksheetRows("_BookieBot Bill Schedule", personal["_BookieBot Bill Schedule"]) if "_BookieBot Bill Schedule" in personal else None,
            ),
        )
        canonical = expense_breakdown_client_payload(report)
        results[number] = {"ownerName": canonical["ownerName"], "year": year, "month": number,
                           "comparisonData": canonical["comparisonData"]}
    return results
