"""Batch each report's existing workbook tabs into a fresh, read-only snapshot."""
from __future__ import annotations

import calendar
from dataclasses import dataclass
from typing import Any, TYPE_CHECKING

from bookiebot.reports.worksheet_reads import read_workbook_tabs
from bookiebot.sheets.reimbursement_history import (
    ReimbursementLedger, configured_reimbursement_workbooks, reimbursement_history_from_ledgers,
)
from bookiebot.sheets.routing import (
    MissingMonthWorksheetError, get_budget_spreadsheet_id_for_user,
    get_shared_expenses_spreadsheet_id, now_pacific,
)

if TYPE_CHECKING:
    from bookiebot.reports.expense_breakdown import BudgetMonth, ReportWorksheets


@dataclass(frozen=True)
class ReportWorksheetRows:
    """The report parser's worksheet interface, with no write methods or I/O."""
    title: str
    rows: list[list[str]]

    def get_all_values(self) -> list[list[str]]:
        return self.rows


def can_batch_report_reads(gc: Any) -> bool:
    transport = getattr(gc, "http_client", None)
    return callable(getattr(transport, "fetch_sheet_metadata", None)) and callable(getattr(transport, "values_batch_get", None))


def batched_report_worksheets(actor_key: str, month: BudgetMonth, gc: Any) -> ReportWorksheets:
    from bookiebot.reports.expense_breakdown import BudgetHistoryRows, BudgetMonth, ReportWorksheets

    current = now_pacific()
    personal_id = get_budget_spreadsheet_id_for_user(actor_key, month.year)
    shared_id = get_shared_expenses_spreadsheet_id(month.year)
    reimbursement_books = configured_reimbursement_workbooks(actor_key, current.year)
    selected_months = range(1, min(month.month + 1, 12) + 1)
    requested: dict[str, list[str]] = {
        personal_id: [*(calendar.month_name[number] for number in selected_months),
                      "Subscriptions", "_BookieBot Bill Schedule", "Shared Reimbursements"],
    }
    requested.setdefault(shared_id, []).append(month.name)
    history_books = {month.year: personal_id}
    for year in [month.year - 1, *([month.year + 1] if month.month == 12 else [])]:
        try:
            spreadsheet_id = get_budget_spreadsheet_id_for_user(actor_key, year)
        except Exception:
            continue  # Unconfigured adjacent years have no optional income history.
        history_books[year] = spreadsheet_id
        requested.setdefault(spreadsheet_id, []).extend(
            ["January"] if year > month.year else list(calendar.month_name)[1:]
        )
    for spreadsheet_id in reimbursement_books.values():
        if spreadsheet_id:
            requested.setdefault(spreadsheet_id, []).append("Shared Reimbursements")

    loaded: dict[str, dict[str, list[list[str]]]] = {}
    for spreadsheet_id, titles in requested.items():
        try:
            loaded[spreadsheet_id] = read_workbook_tabs(gc, spreadsheet_id, titles)
        except Exception:
            if spreadsheet_id in (personal_id, shared_id):
                raise
            # History is optional; reimbursement coverage below still records
            # the failed annual ledger instead of declaring old debts empty.
    personal = loaded[personal_id]
    shared = loaded[shared_id]
    if month.name not in personal or month.name not in shared:
        raise MissingMonthWorksheetError(f"The {month.label} budget and shared expense tabs are required.")

    history = []
    for year, spreadsheet_id in sorted(history_books.items()):
        numbers = range(1, 13) if year < month.year else [1] if year > month.year else selected_months
        tabs = loaded.get(spreadsheet_id, {})
        history.extend(BudgetHistoryRows(BudgetMonth(year, number), tabs[calendar.month_name[number]])
                       for number in numbers if calendar.month_name[number] in tabs)

    ledgers = []
    checked_years = []
    unavailable_years = []
    for year, spreadsheet_id in reimbursement_books.items():
        tabs = loaded.get(spreadsheet_id)
        if tabs is None:
            unavailable_years.append(year)
            continue
        checked_years.append(year)
        if "Shared Reimbursements" in tabs:
            rows = tabs["Shared Reimbursements"]
            ledgers.append(ReimbursementLedger(year, ReportWorksheetRows("Shared Reimbursements", rows), rows))

    def optional(title: str):
        return ReportWorksheetRows(title, personal[title]) if title in personal else None

    return ReportWorksheets(
        shared_expenses=ReportWorksheetRows(month.name, shared[month.name]),
        personal_budget=ReportWorksheetRows(month.name, personal[month.name]),
        subscriptions=optional("Subscriptions"),
        bill_schedule=optional("_BookieBot Bill Schedule"),
        shared_reimbursements=optional("Shared Reimbursements"),
        budget_history=tuple(history),
        reimbursement_history=reimbursement_history_from_ledgers(
            actor_key, ledgers, as_of=current, years=checked_years, unavailable_years=unavailable_years,
        ),
    )
