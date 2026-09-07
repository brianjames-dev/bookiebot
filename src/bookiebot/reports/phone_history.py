"""Authenticated phone month discovery and matching-period comparisons."""
from __future__ import annotations

import calendar
from datetime import datetime
import re
from typing import Any

from aiohttp import web

from bookiebot.reports.expense_breakdown import BudgetMonth
from bookiebot.reports.report_insights import compare_report_periods
from bookiebot.reports.scope import default_expense_report_persons
from bookiebot.sheets.reimbursement_history import configured_reimbursement_workbooks
from bookiebot.sheets.routing import (
    PACIFIC_TZ, get_budget_spreadsheet_id_for_user, get_shared_expenses_spreadsheet_id,
    get_user_config, now_pacific,
)


class InvalidReportMonthError(ValueError):
    pass


class UnavailableReportMonthError(ValueError):
    pass


def parse_phone_report_month(value: str | None, *, current: datetime | None = None) -> BudgetMonth:
    now = current or now_pacific()
    now = now.replace(tzinfo=PACIFIC_TZ) if now.tzinfo is None else now.astimezone(PACIFIC_TZ)
    if value is None:
        return BudgetMonth(now.year, now.month)
    if not re.fullmatch(r"[1-9]\d{3}-(?:0[1-9]|1[0-2])", value):
        raise InvalidReportMonthError("Choose a month in YYYY-MM format.")
    year, month = map(int, value.split("-"))
    if (year, month) > (now.year, now.month):
        raise InvalidReportMonthError("Choose the current month or an earlier month.")
    return BudgetMonth(year, month)


def load_phone_month_catalog(actor_key: str, *, current: datetime | None = None) -> dict[str, Any]:
    """One metadata read per configured personal/shared annual workbook."""
    from bookiebot.sheets.auth import get_gspread_client
    now = current or now_pacific()
    now = now.replace(tzinfo=PACIFIC_TZ) if now.tzinfo is None else now.astimezone(PACIFIC_TZ)
    get_user_config(actor_key)
    gc = get_gspread_client()
    months = []
    unavailable = []
    checked = []
    for year in configured_reimbursement_workbooks(actor_key, now.year):
        try:
            personal_id = get_budget_spreadsheet_id_for_user(actor_key, year)
            shared_id = get_shared_expenses_spreadsheet_id(year)
            personal = _worksheet_titles(gc, personal_id)
            shared = _worksheet_titles(gc, shared_id)
            checked.append(year)
            for month in range(1, 13):
                title = calendar.month_name[month]
                if (year, month) <= (now.year, now.month) and title in personal and title in shared:
                    months.append({"value": f"{year:04d}-{month:02d}", "label": f"{title} {year}"})
        except Exception:
            unavailable.append(year)
    return {
        "currentMonth": f"{now.year:04d}-{now.month:02d}",
        "months": sorted(months, key=lambda item: item["value"], reverse=True),
        "coverage": {"status": "partial" if unavailable and checked else "unavailable" if unavailable else "complete",
                     "unavailableYears": unavailable},
    }


def _worksheet_titles(gc: Any, spreadsheet_id: str) -> set[str]:
    transport = getattr(gc, "http_client", None)
    fetch_metadata = getattr(transport, "fetch_sheet_metadata", None)
    if callable(fetch_metadata):
        metadata: Any = fetch_metadata(spreadsheet_id)
        if not isinstance(metadata.get("sheets"), list):
            raise ValueError("Incomplete month metadata")
        return {sheet["properties"]["title"] for sheet in metadata["sheets"]}
    return {worksheet.title for worksheet in gc.open_by_key(spreadsheet_id).worksheets()}


def baseline_for_month(selected: BudgetMonth, kind: str) -> BudgetMonth:
    if kind == "previous-year":
        return BudgetMonth(selected.year - 1, selected.month)
    if kind == "previous-month":
        return BudgetMonth(selected.year - 1, 12) if selected.month == 1 else BudgetMonth(selected.year, selected.month - 1)
    raise InvalidReportMonthError("Compare with the previous month or the same month last year.")


def phone_report_payload(session: Any, month: BudgetMonth) -> dict[str, Any]:
    from bookiebot.reports.phone_app import _valid_owner
    owner = _valid_owner(session)
    return dict(actor_key=session.actor_key, owner_name=owner.name,
                persons=default_expense_report_persons(owner.name, list(owner.expense_persons)),
                year=month.year, month=month.month)


async def phone_month_catalog(request: web.Request, session: Any, *, current: datetime | None = None) -> dict[str, Any]:
    from bookiebot.reports.web import _REPORT_BUILDS
    month = parse_phone_report_month(None, current=current)
    return await request.app[_REPORT_BUILDS].catalog(phone_report_payload(session, month))


async def available_phone_month(
    request: web.Request, session: Any, value: str | None, *, current: datetime | None = None,
) -> BudgetMonth:
    selected = parse_phone_report_month(value, current=current)
    if selected == parse_phone_report_month(None, current=current):
        return selected
    catalog = await phone_month_catalog(request, session, current=current)
    if f"{selected.year:04d}-{selected.month:02d}" not in {item["value"] for item in catalog["months"]}:
        if selected.year in catalog["coverage"]["unavailableYears"]:
            raise RuntimeError("Historical reports could not be checked. Try again shortly.")
        raise UnavailableReportMonthError("That month's report is not available.")
    return selected


async def _months(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _session, _json
    try:
        session = await _session(request)
        if session is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        catalog = await phone_month_catalog(request, session)
        if await _session(request) is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        return _json(catalog)
    except Exception:
        return _json({"error": "Could not load your report months. Please try again."}, status=503)


async def _comparison(request: web.Request) -> web.Response:
    from bookiebot.reports.phone_app import _session, _valid_owner, _json
    from bookiebot.reports.web import _REPORT_BUILDS, _ReportBuildBusy
    try:
        session = await _session(request)
        if session is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        _valid_owner(session)
        current = now_pacific()
        raw_month = request.query.get("month")
        kind = request.query.get("baseline", "previous-month")
        selected_month = parse_phone_report_month(raw_month, current=current)
        baseline_month = baseline_for_month(selected_month, kind)
        catalog = await phone_month_catalog(request, session, current=current)
        available = {item["value"] for item in catalog["months"]}
        selected_key = f"{selected_month.year:04d}-{selected_month.month:02d}"
        baseline_key = f"{baseline_month.year:04d}-{baseline_month.month:02d}"
        if selected_key not in available:
            if selected_month.year in catalog["coverage"]["unavailableYears"]:
                return _json({"error": "Could not check this report month. Please try again."}, status=503)
            raise UnavailableReportMonthError("That month's report is not available.")
        selected = await request.app[_REPORT_BUILDS].data(phone_report_payload(session, selected_month))
        baseline = (await request.app[_REPORT_BUILDS].data(phone_report_payload(session, baseline_month))
                    if baseline_key in available else None)
        if await _session(request) is None:
            return _json({"error": "Reconnect this phone using /expense_app in Discord."}, status=401)
        result = compare_report_periods(selected, baseline, baseline_month=baseline_key, baseline_kind=kind, as_of=current)
        if baseline is None and baseline_month.year in catalog["coverage"]["unavailableYears"]:
            result["coverageNote"] = "The comparison month could not be checked. Please try again shortly."
        return _json(result)
    except InvalidReportMonthError as exc:
        return _json({"error": str(exc)}, status=400)
    except UnavailableReportMonthError as exc:
        return _json({"error": str(exc)}, status=404)
    except _ReportBuildBusy:
        return _json({"error": "Your report is busy refreshing. Please try again shortly."}, status=503)
    except Exception:
        return _json({"error": "Could not compare your reports. Please try again."}, status=503)


def register_phone_history_routes(app: web.Application) -> None:
    app.router.add_get("/app/expenses/months", _months)
    app.router.add_get("/app/expenses/comparison", _comparison)
