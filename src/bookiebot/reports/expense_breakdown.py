from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
import calendar
import html
import json
from pathlib import Path
import re
import secrets
from typing import Any

from openpyxl.utils import column_index_from_string

from bookiebot.sheets.config import get_category_columns
from bookiebot.sheets.repo import get_sheets_repo
from bookiebot.sheets.routing import PACIFIC_TZ, now_pacific, resolve_sheet_context
from bookiebot.sheets.utils import clean_money


@dataclass(frozen=True)
class BudgetMonth:
    year: int
    month: int

    @property
    def name(self) -> str:
        return calendar.month_name[self.month]

    @property
    def label(self) -> str:
        return f"{self.name} {self.year}"

    def as_datetime(self) -> datetime:
        return datetime(self.year, self.month, 1, tzinfo=PACIFIC_TZ)


@dataclass(frozen=True)
class ReportWorksheets:
    shared_expenses: Any
    personal_budget: Any
    subscriptions: Any | None = None
    bill_schedule: Any | None = None


@dataclass(frozen=True)
class ExpenseEntry:
    date: str
    category: str
    amount: float
    person: str
    item: str = ""
    location: str = ""


@dataclass(frozen=True)
class PaymentItem:
    label: str
    amount: float
    group: str
    status: str = "entered"


@dataclass(frozen=True)
class SubscriptionItem:
    name: str
    amount: float
    cadence: str
    kind: str = ""
    pull_day: int | None = None
    pull_month: int | None = None


@dataclass(frozen=True)
class RawSheet:
    title: str
    rows: list[list[str]]


@dataclass
class ExpenseBreakdownReport:
    actor_key: str
    owner_name: str
    month: BudgetMonth
    persons: list[str]
    generated_at: datetime
    breakdown: dict[str, dict[str, Any]]
    grand_total: float
    shared_total: float
    personal_total: float
    income_total: float
    remaining_budget: float | None
    remaining_wants_budget: float | None
    amount_saved: float | None
    entries: list[ExpenseEntry] = field(default_factory=list)
    payments: list[PaymentItem] = field(default_factory=list)
    subscriptions: list[SubscriptionItem] = field(default_factory=list)
    income_entries: list[PaymentItem] = field(default_factory=list)
    raw_sheets: list[RawSheet] = field(default_factory=list)


@dataclass(frozen=True)
class ExpenseReportPage:
    path: Path
    url: str


CATEGORY_LABELS = {
    "rent": "Rent",
    "bills_utilities": "Bills & Utilities",
    "static_bills_subscriptions_needs": "Subscriptions (Needs)",
    "subscriptions_wants": "Subscriptions (Wants)",
    "grocery": "Grocery",
    "gas": "Gas",
    "food": "Food",
    "shopping": "Shopping",
}

CATEGORY_COLORS = {
    "rent": "#dc2626",
    "bills_utilities": "#0d9488",
    "static_bills_subscriptions_needs": "#2563eb",
    "subscriptions_wants": "#7c3aed",
    "grocery": "#16a34a",
    "gas": "#f59e0b",
    "food": "#db2777",
    "shopping": "#0891b2",
}

PAYMENT_GROUPS = {
    "rent": ("rent", "Rent"),
    "pg&e": ("bills_utilities", "PG&E"),
    "pge": ("bills_utilities", "PGE"),
    "recology": ("bills_utilities", "Recology"),
    "trash": ("bills_utilities", "Trash"),
    "garbage": ("bills_utilities", "Garbage"),
    "waste": ("bills_utilities", "Waste"),
    "water": ("bills_utilities", "Water"),
    "student loan payment": ("bills_utilities", "Student Loan Payment"),
    "student loan": ("bills_utilities", "Student Loan"),
}

BUDGET_SHARED_CATEGORY_LABELS = {
    "grocery": ("Groceries", "Grocery"),
    "gas": ("Auto/Gas", "Gas"),
    "food": ("Eating out", "Food"),
    "shopping": ("Shopping",),
}

NEEDS_BREAKDOWN_KEYS = (
    "rent",
    "bills_utilities",
    "static_bills_subscriptions_needs",
    "grocery",
    "gas",
)
WANTS_BREAKDOWN_KEYS = (
    "subscriptions_wants",
    "food",
    "shopping",
)


def parse_budget_month(value: Any = None, *, now: datetime | None = None) -> BudgetMonth:
    current = now or now_pacific()
    if current.tzinfo is None:
        current = current.replace(tzinfo=PACIFIC_TZ)
    else:
        current = current.astimezone(PACIFIC_TZ)

    if value is None or str(value).strip() == "":
        return BudgetMonth(current.year, current.month)

    text = str(value).strip()
    lowered = text.lower()
    if lowered in {"this month", "current month", "now"}:
        return BudgetMonth(current.year, current.month)
    if lowered == "last month":
        month = current.month - 1
        year = current.year
        if month == 0:
            month = 12
            year -= 1
        return BudgetMonth(year, month)

    month_names = {name.lower(): index for index, name in enumerate(calendar.month_name) if name}
    month_names.update({name.lower(): index for index, name in enumerate(calendar.month_abbr) if name})

    name_match = re.search(
        r"\b("
        + "|".join(re.escape(name) for name in sorted(month_names, key=len, reverse=True))
        + r")\b(?:\s+(\d{4}))?",
        lowered,
    )
    if name_match:
        month = month_names[name_match.group(1)]
        year = int(name_match.group(2) or current.year)
        return BudgetMonth(year, month)

    iso_match = re.search(r"\b(\d{4})[-/](0?[1-9]|1[0-2])\b", text)
    if iso_match:
        return BudgetMonth(int(iso_match.group(1)), int(iso_match.group(2)))

    slash_match = re.search(r"\b(0?[1-9]|1[0-2])[-/](\d{4})\b", text)
    if slash_match:
        return BudgetMonth(int(slash_match.group(2)), int(slash_match.group(1)))

    raise ValueError(f"Could not parse budget month from '{text}'.")


def month_from_entities_or_message(entities: dict[str, Any], message_content: str) -> BudgetMonth:
    for key in ("month", "month_name", "date", "period"):
        if entities.get(key):
            return parse_budget_month(entities[key])
    return _month_from_message(message_content)


def _month_from_message(content: str) -> BudgetMonth:
    current = now_pacific()
    lowered = content.lower()
    if "last month" in lowered:
        return parse_budget_month("last month", now=current)
    if "this month" in lowered or "current month" in lowered:
        return parse_budget_month(None, now=current)

    try:
        return parse_budget_month(content, now=current)
    except ValueError:
        return parse_budget_month(None, now=current)


def load_report_worksheets(actor_key: str, month: BudgetMonth) -> ReportWorksheets:
    if _is_current_month(month):
        repo = get_sheets_repo()
        return ReportWorksheets(
            shared_expenses=repo.expense_sheet(),
            personal_budget=repo.income_sheet(),
            subscriptions=_optional_sheet(repo.subscriptions_sheet),
            bill_schedule=_optional_sheet(repo.bill_schedule_sheet),
        )

    from bookiebot.sheets.auth import get_gspread_client

    gc = get_gspread_client()
    context = resolve_sheet_context(actor_key, gc, month.as_datetime())
    personal_spreadsheet = gc.open_by_key(context.personal_budget_spreadsheet_id)
    return ReportWorksheets(
        shared_expenses=context.shared_expenses_worksheet,
        personal_budget=context.personal_budget_worksheet,
        subscriptions=_worksheet_by_name(personal_spreadsheet, "Subscriptions"),
        bill_schedule=_worksheet_by_name(personal_spreadsheet, "_BookieBot Bill Schedule"),
    )


def build_expense_breakdown_report(
    *,
    actor_key: str,
    owner_name: str,
    persons: list[str],
    month: BudgetMonth,
    worksheets: ReportWorksheets | None = None,
) -> ExpenseBreakdownReport:
    selected = worksheets or load_report_worksheets(actor_key, month)
    shared_rows = _rows(selected.shared_expenses)
    personal_rows = _rows(selected.personal_budget)
    subscription_rows = _rows(selected.subscriptions) if selected.subscriptions is not None else []
    bill_schedule_rows = _rows(selected.bill_schedule) if selected.bill_schedule is not None else []

    entries = _shared_expense_entries(shared_rows, persons, month)
    payments = _payment_items(personal_rows, bill_schedule_rows, month)
    subscriptions = _subscription_items(subscription_rows, month)
    income_entries, income_total = _income_entries(personal_rows)
    remaining_budget, remaining_wants_budget = _margin_amounts(personal_rows)
    amount_saved = _amount_saved(personal_rows)
    static_needs_total, wants_total = _subscription_bucket_totals(personal_rows, subscriptions)
    payment_totals = _payment_totals_by_group(payments)
    budget_shared_totals = _budget_shared_category_totals(personal_rows)
    itemized_shared_totals = _entry_totals_by_category(entries)

    breakdown_amounts = _ordered_breakdown_amounts()
    breakdown_amounts["rent"] = payment_totals["rent"]
    breakdown_amounts["bills_utilities"] = payment_totals["bills_utilities"]
    breakdown_amounts["static_bills_subscriptions_needs"] = static_needs_total
    breakdown_amounts["subscriptions_wants"] = wants_total
    for category in BUDGET_SHARED_CATEGORY_LABELS:
        if category in budget_shared_totals:
            breakdown_amounts[category] = budget_shared_totals[category]
        else:
            breakdown_amounts[category] = itemized_shared_totals[category]

    grand_total = round(sum(breakdown_amounts.values()), 2)
    breakdown = {
        key: {
            "amount": round(amount, 2),
            "percentage": round((amount / grand_total * 100), 2) if grand_total else 0.0,
            "label": CATEGORY_LABELS[key],
        }
        for key, amount in breakdown_amounts.items()
    }

    shared_total = round(sum(entry.amount for entry in entries), 2)
    personal_total = grand_total

    return ExpenseBreakdownReport(
        actor_key=actor_key,
        owner_name=owner_name,
        month=month,
        persons=persons,
        generated_at=now_pacific(),
        breakdown=breakdown,
        grand_total=grand_total,
        shared_total=shared_total,
        personal_total=personal_total,
        income_total=income_total,
        remaining_budget=remaining_budget,
        remaining_wants_budget=remaining_wants_budget,
        amount_saved=amount_saved,
        entries=entries,
        payments=payments,
        subscriptions=subscriptions,
        income_entries=income_entries,
        raw_sheets=[
            RawSheet("Shared Expenses", _compact_rows(shared_rows)),
            RawSheet("Personal Budget", _compact_rows(personal_rows)),
            RawSheet("Subscriptions", _compact_rows(subscription_rows)),
        ],
    )


def write_expense_breakdown_report(report: ExpenseBreakdownReport, *, report_dir: Path | None = None) -> ExpenseReportPage:
    from bookiebot.reports.web import create_expense_report_token, public_expense_report_url, reports_dir

    directory = report_dir or reports_dir()
    directory.mkdir(parents=True, exist_ok=True)
    filename = _report_filename(report)
    path = directory / filename
    path.write_text(render_expense_breakdown_html(report), encoding="utf-8")
    token = create_expense_report_token(
        actor_key=report.actor_key,
        owner_name=report.owner_name,
        persons=report.persons,
        year=report.month.year,
        month=report.month.month,
        filename=filename,
    )
    return ExpenseReportPage(path=path, url=public_expense_report_url(token))


def render_expense_breakdown_html(report: ExpenseBreakdownReport) -> str:
    non_zero_breakdown = [
        (key, info)
        for key, info in report.breakdown.items()
        if float(info.get("amount") or 0.0) > 0
    ]
    top_entries = sorted(report.entries, key=lambda entry: entry.amount, reverse=True)[:10]
    person_totals = _person_totals(report.entries)
    merchant_totals = _merchant_totals(report.entries)
    daily_totals = _daily_totals(report.entries)
    budget_group_totals = _budget_group_totals(report.breakdown)
    balance_after_expenses = report.income_total - report.grand_total if report.income_total else None
    payload = _report_client_payload(
        report=report,
        breakdown_items=non_zero_breakdown,
        daily_totals=daily_totals,
        budget_group_totals=budget_group_totals,
        person_totals=person_totals,
        merchant_totals=merchant_totals,
        top_entries=top_entries,
        balance_after_expenses=balance_after_expenses,
    )

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Expense Breakdown - {_escape(report.month.label)}</title>
  <style>{_report_asset_text("expense-report-app.css")}</style>
</head>
<body>
  <div id="bookiebot-expense-report-root"></div>
  <noscript>This report requires JavaScript to render the React expense dashboard.</noscript>
  <script id="bookiebot-expense-report-data" type="application/json">{_json_script_payload(payload)}</script>
  <script>window.process = window.process || {{ env: {{ NODE_ENV: "production" }} }}; window.process.env = window.process.env || {{ NODE_ENV: "production" }};</script>
  <script>{_report_asset_text("expense-report-app.js")}</script>
</body>
</html>
"""


def _is_current_month(month: BudgetMonth) -> bool:
    current = now_pacific()
    return current.year == month.year and current.month == month.month


def _optional_sheet(factory: Any) -> Any | None:
    try:
        return factory()
    except Exception:
        return None


def _worksheet_by_name(spreadsheet: Any, title: str) -> Any | None:
    try:
        return spreadsheet.worksheet(title)
    except Exception:
        return None


def _rows(ws: Any) -> list[list[str]]:
    if ws is None:
        return []
    rows = ws.get_all_values()
    return [[str(value) for value in row] for row in rows]


def _ordered_breakdown_amounts() -> dict[str, float]:
    return {key: 0.0 for key in CATEGORY_LABELS}


def _shared_expense_entries(rows: list[list[str]], persons: list[str], month: BudgetMonth) -> list[ExpenseEntry]:
    person_filter = set(persons)
    entries: list[ExpenseEntry] = []
    for category, config in get_category_columns.items():
        columns = config["columns"]
        date_idx = column_index_from_string(columns["date"]) - 1
        amount_idx = column_index_from_string(columns["amount"]) - 1
        person_idx = column_index_from_string(columns["person"]) - 1
        item_idx = column_index_from_string(columns["item"]) - 1 if columns.get("item") else None
        location_idx = column_index_from_string(columns["location"]) - 1 if columns.get("location") else None
        required = [date_idx, amount_idx, person_idx]
        if item_idx is not None:
            required.append(item_idx)
        if location_idx is not None:
            required.append(location_idx)

        for row in rows[config["start_row"] - 1 :]:
            if not row or max(required) >= len(row):
                continue
            amount = clean_money(_cell(row, amount_idx))
            person = _cell(row, person_idx)
            if amount <= 0 or not person or person not in person_filter:
                continue
            date_text = _cell(row, date_idx)
            if date_text and not _date_belongs_to_month(date_text, month):
                continue
            entries.append(
                ExpenseEntry(
                    date=date_text,
                    category=category,
                    amount=round(amount, 2),
                    person=person,
                    item=_cell(row, item_idx) if item_idx is not None else "",
                    location=_cell(row, location_idx) if location_idx is not None else "",
                )
            )
    return sorted(entries, key=lambda entry: (_entry_sort_date(entry.date), entry.amount), reverse=True)


def _payment_items(rows: list[list[str]], bill_schedule_rows: list[list[str]], month: BudgetMonth) -> list[PaymentItem]:
    items_by_label: dict[str, PaymentItem] = {}
    labels = dict(PAYMENT_GROUPS)
    labels.update(_bill_schedule_labels(bill_schedule_rows, month))

    for row in rows:
        for index, value in enumerate(row):
            label_text = _normalize_label(value)
            if not label_text:
                continue
            matched = _matched_payment_label(label_text, labels)
            if matched is None:
                continue
            group, display_label = matched
            amount = _next_money(row, index + 1)
            if amount <= 0:
                continue
            key = _normalize_label(display_label)
            items_by_label[key] = PaymentItem(display_label, round(amount, 2), group)
    return sorted(items_by_label.values(), key=lambda item: (item.group, item.label.lower()))


def _bill_schedule_labels(rows: list[list[str]], month: BudgetMonth) -> dict[str, tuple[str, str]]:
    if not rows:
        return {}
    try:
        from bookiebot.sheets.bills import list_bill_schedules

        labels: dict[str, tuple[str, str]] = {}
        for bill in list_bill_schedules(rows):
            if bill.recurrence == "quarterly" and month.month not in bill.pull_months:
                continue
            for label in {bill.bill_key, bill.display_name, bill.source_label}:
                normalized = _normalize_label(label)
                if normalized:
                    group = _payment_group_for_label(normalized) or "bills_utilities"
                    labels[normalized] = (
                        group,
                        bill.display_name or bill.source_label or bill.bill_key,
                    )
        return labels
    except Exception:
        return {}


def _subscription_bucket_totals(
    rows: list[list[str]],
    subscriptions: list[SubscriptionItem],
) -> tuple[float, float]:
    static_needs_found, static_needs_total = _amount_for_any_label(rows, ("Static Bills & Subscriptions (Needs)",))
    wants_found, wants_total = _amount_for_any_label(rows, ("Subscriptions (Wants)",))

    if not static_needs_found:
        static_needs_total = round(
            sum(item.amount for item in subscriptions if _subscription_bucket(item) == "static_bills_subscriptions_needs"),
            2,
        )
    if not wants_found:
        wants_total = round(
            sum(item.amount for item in subscriptions if _subscription_bucket(item) == "subscriptions_wants"),
            2,
        )

    return round(static_needs_total, 2), round(wants_total, 2)


def _payment_totals_by_group(payments: list[PaymentItem]) -> dict[str, float]:
    totals = {"rent": 0.0, "bills_utilities": 0.0}
    for payment in payments:
        if payment.group not in totals:
            continue
        totals[payment.group] += payment.amount
    return {group: round(amount, 2) for group, amount in totals.items()}


def _budget_shared_category_totals(rows: list[list[str]]) -> dict[str, float]:
    totals: dict[str, float] = {}
    for category, labels in BUDGET_SHARED_CATEGORY_LABELS.items():
        found, amount = _amount_for_any_label(rows, labels)
        if found:
            totals[category] = amount
    return totals


def _entry_totals_by_category(entries: list[ExpenseEntry]) -> dict[str, float]:
    totals = {category: 0.0 for category in BUDGET_SHARED_CATEGORY_LABELS}
    for entry in entries:
        if entry.category not in totals:
            continue
        totals[entry.category] += entry.amount
    return {category: round(amount, 2) for category, amount in totals.items()}


def _amount_for_label(rows: list[list[str]], label: str) -> float:
    _found, amount = _amount_for_any_label(rows, (label,))
    return amount


def _amount_for_any_label(rows: list[list[str]], labels: tuple[str, ...]) -> tuple[bool, float]:
    targets = tuple(_normalize_label(label) for label in labels)
    for row in rows:
        for index, value in enumerate(row):
            normalized = _normalize_label(value)
            if not normalized:
                continue
            if any(_labels_match(normalized, target) for target in targets):
                return True, round(_next_money(row, index + 1), 2)
    return False, 0.0


def _subscription_bucket(item: SubscriptionItem) -> str:
    kind = _normalize_label(item.kind)
    if kind in {"want", "wants"}:
        return "subscriptions_wants"
    return "static_bills_subscriptions_needs"


def _subscription_items(rows: list[list[str]], month: BudgetMonth) -> list[SubscriptionItem]:
    if not rows:
        return []
    try:
        from bookiebot.sheets.subscriptions import list_subscription_schedules

        items: list[SubscriptionItem] = []
        for subscription in list_subscription_schedules(rows):
            if subscription.cadence == "yearly" and subscription.pull_month != month.month:
                continue
            if subscription.amount <= 0:
                continue
            items.append(
                SubscriptionItem(
                    name=subscription.name,
                    amount=round(subscription.amount, 2),
                    cadence=subscription.cadence,
                    kind=subscription.kind,
                    pull_day=subscription.pull_day,
                    pull_month=subscription.pull_month,
                )
            )
        return sorted(items, key=lambda item: (item.kind, item.name.lower()))
    except Exception:
        return []


def _income_entries(rows: list[list[str]]) -> tuple[list[PaymentItem], float]:
    summary_total = _monthly_income_summary(rows)
    marker_index = _monthly_income_marker_index(rows)
    items: list[PaymentItem] = []

    if marker_index is not None:
        for row in rows[:marker_index]:
            item = _income_entry_from_row(row)
            if item:
                items.append(item)
    else:
        for row in rows:
            item = _income_entry_from_row(row, require_income_like_label=True)
            if item:
                items.append(item)

    total = summary_total or round(sum(item.amount for item in items), 2)
    return items, round(total, 2)


def _monthly_income_summary(rows: list[list[str]]) -> float:
    summary_total = 0.0
    for row in rows:
        for index, value in enumerate(row):
            normalized = _normalize_label(value)
            if "monthly income" not in normalized:
                continue
            amount = _next_money(row, index + 1)
            if amount > 0:
                summary_total = max(summary_total, amount)
    return round(summary_total, 2)


def _monthly_income_marker_index(rows: list[list[str]]) -> int | None:
    for row_index, row in enumerate(rows):
        if any(str(value).strip().lower() == "monthly income:" for value in row):
            return row_index
    return None


def _income_entry_from_row(row: list[str], *, require_income_like_label: bool = False) -> PaymentItem | None:
    for amount_index, value in enumerate(row):
        amount = clean_money(str(value))
        if amount <= 0:
            continue
        label = _nearest_left_label(row, amount_index)
        if not label or _is_non_income_label(label):
            continue
        if require_income_like_label and not _looks_like_income_label(label):
            continue
        return PaymentItem(label=label, amount=round(amount, 2), group="income")
    return None


def _nearest_left_label(row: list[str], index: int) -> str:
    for value in reversed(row[:index]):
        text = str(value).strip()
        if text:
            return text
    return ""


def _is_non_income_label(label: str) -> bool:
    normalized = _normalize_label(label)
    if not normalized:
        return True
    if "monthly income" in normalized or "margin" in normalized:
        return True
    if any(key and (normalized == key or key in normalized or normalized in key) for key in PAYMENT_GROUPS):
        return True
    return False


def _remaining_budget(rows: list[list[str]]) -> float | None:
    remaining_needs_budget, _remaining_wants_budget = _margin_amounts(rows)
    return remaining_needs_budget


def _margin_amounts(rows: list[list[str]]) -> tuple[float | None, float | None]:
    for row in rows:
        for index, value in enumerate(row):
            if "margins" not in str(value).strip().lower():
                continue
            amounts = _money_values(row, index + 1)
            needs_budget = amounts[0] if amounts else None
            wants_budget = amounts[1] if len(amounts) > 1 else None
            return needs_budget, wants_budget
    return None, None


def _amount_saved(rows: list[list[str]]) -> float | None:
    total = 0.0
    found_checks: set[int] = set()
    for row in rows:
        normalized_cells = [_normalize_label(value) for value in row]
        row_text = " ".join(cell for cell in normalized_cells if cell)
        if "deposit" not in row_text:
            continue
        for check_number in (1, 2):
            if check_number in found_checks:
                continue
            for index, normalized in enumerate(normalized_cells):
                if not _is_check_deposit_label(normalized_cells, index, check_number):
                    continue
                amount = _next_money(row, index + 1, window=max(len(row) - index - 1, 0))
                if amount:
                    total += amount
                    found_checks.add(check_number)
                break
    return round(total, 2) if found_checks else None


def _is_check_deposit_label(normalized_cells: list[str], index: int, check_number: int) -> bool:
    normalized = normalized_cells[index]
    if not _contains_normalized_phrase(normalized, f"check {check_number}"):
        return False
    nearby_label = " ".join(normalized_cells[index : index + 3])
    return "deposit" in nearby_label


def _money_values(row: list[str], start_index: int) -> list[float]:
    values: list[float] = []
    for value in row[start_index:]:
        text = str(value).strip()
        if not text or not re.search(r"\d", text):
            continue
        amount = clean_money(text)
        if amount:
            values.append(round(amount, 2))
    return values


def _looks_like_income_label(label: str) -> bool:
    text = label.strip().lower()
    if not text or any(key in text for key in PAYMENT_GROUPS):
        return False
    if any(term in text for term in {"income", "paycheck", "deposit", "salary", "refund"}):
        return True
    return False


def _matched_payment_label(label_text: str, labels: dict[str, tuple[str, str]]) -> tuple[str, str] | None:
    for label, value in labels.items():
        if _labels_match(label_text, label):
            return value
    return None


def _payment_group_for_label(label_text: str) -> str | None:
    for label, value in PAYMENT_GROUPS.items():
        if _labels_match(label_text, _normalize_label(label)):
            return value[0]
    return None


def _labels_match(label_text: str, label: str) -> bool:
    if not label_text or not label:
        return False
    return (
        label_text == label
        or _contains_normalized_phrase(label_text, label)
        or _contains_normalized_phrase(label, label_text)
    )


def _contains_normalized_phrase(text: str, phrase: str) -> bool:
    return re.search(rf"(?:^| ){re.escape(phrase)}(?: |$)", text) is not None


def _next_money(row: list[str], start_index: int, *, window: int = 4) -> float:
    for value in row[start_index : start_index + window]:
        amount = clean_money(str(value))
        if amount:
            return amount
    return 0.0


def _normalize_label(value: str) -> str:
    return re.sub(r"[^a-z0-9&]+", " ", str(value).strip().lower()).strip()


def _cell(row: list[str], index: int | None) -> str:
    if index is None or index >= len(row):
        return ""
    return str(row[index]).strip()


def _date_belongs_to_month(value: str, month: BudgetMonth) -> bool:
    parsed = _parse_date(value)
    if parsed is None:
        return True
    return parsed.year == month.year and parsed.month == month.month


def _parse_date(value: str) -> datetime | None:
    text = str(value).strip()
    if not text:
        return None
    for fmt in ("%m/%d/%Y", "%-m/%-d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _entry_sort_date(value: str) -> datetime:
    return _parse_date(value) or datetime.min


def _compact_rows(rows: list[list[str]]) -> list[list[str]]:
    non_empty = [row for row in rows if any(str(value).strip() for value in row)]
    max_width = max((index + 1 for row in non_empty for index, value in enumerate(row) if str(value).strip()), default=0)
    return [row[:max_width] for row in non_empty]


def _person_totals(entries: list[ExpenseEntry]) -> list[tuple[str, float]]:
    totals: dict[str, float] = defaultdict(float)
    for entry in entries:
        totals[entry.person] += entry.amount
    return sorted(((person, round(amount, 2)) for person, amount in totals.items()), key=lambda item: item[1], reverse=True)


def _merchant_totals(entries: list[ExpenseEntry]) -> list[tuple[str, float]]:
    totals: Counter[str] = Counter()
    for entry in entries:
        merchant = entry.location or entry.item or entry.category
        totals[merchant] += entry.amount
    return [(name, round(amount, 2)) for name, amount in totals.most_common(10)]


def _report_filename(report: ExpenseBreakdownReport) -> str:
    owner = re.sub(r"[^a-z0-9]+", "-", report.owner_name.lower()).strip("-") or "budget"
    suffix = secrets.token_urlsafe(12)
    return f"expense-breakdown-{owner}-{report.month.year}-{report.month.month:02d}-{suffix}.html"


def _money(value: float | None) -> str:
    if value is None:
        return "N/A"
    return f"${value:,.2f}"


def _escape(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _metric_card(label: str, value: float | None, note: str = "") -> str:
    css_class = ""
    if value is not None and value < 0:
        css_class = " negative"
    elif value is not None and "Income After" in label and value >= 0:
        css_class = " positive"
    note_html = f'<div class="metric-note">{_escape(note)}</div>' if note else ""
    return f"""<div class="card">
  <div class="metric-label">{_escape(label)}</div>
  <div class="metric-value{css_class}">{_money(value)}</div>
  {note_html}
</div>"""


def _report_client_payload(
    *,
    report: ExpenseBreakdownReport,
    breakdown_items: list[tuple[str, dict[str, Any]]],
    daily_totals: list[tuple[str, float]],
    budget_group_totals: dict[str, float],
    person_totals: list[tuple[str, float]],
    merchant_totals: list[tuple[str, float]],
    top_entries: list[ExpenseEntry],
    balance_after_expenses: float | None,
) -> dict[str, Any]:
    return {
        "ownerName": report.owner_name,
        "monthLabel": report.month.label,
        "daysInMonth": calendar.monthrange(report.month.year, report.month.month)[1],
        "generatedAt": report.generated_at.strftime("%b %-d, %Y %-I:%M %p %Z"),
        "metrics": {
            "totalExpenses": report.grand_total,
            "sharedExpenses": report.shared_total,
            "personalOutflows": report.personal_total,
            "monthlyIncome": report.income_total,
            "remainingBudget": report.remaining_budget,
            "remainingNeedsBudget": report.remaining_budget,
            "remainingWantsBudget": report.remaining_wants_budget,
            "amountSaved": report.amount_saved,
            "incomeAfterExpenses": balance_after_expenses,
        },
        "breakdown": [
            {
                "key": key,
                "label": str(info.get("label") or key),
                "amount": round(float(info.get("amount") or 0.0), 2),
                "percentage": round(float(info.get("percentage") or 0.0), 2),
                "color": CATEGORY_COLORS.get(key, "#64748b"),
            }
            for key, info in breakdown_items
        ],
        "dailyTotals": [_amount_row(label, amount) for label, amount in daily_totals],
        "budgetGroups": [_amount_row(label, amount) for label, amount in budget_group_totals.items()],
        "personTotals": [_amount_row(label, amount) for label, amount in person_totals],
        "merchantTotals": [_amount_row(label, amount) for label, amount in merchant_totals],
        "topEntries": [_expense_entry_payload(entry) for entry in top_entries],
        "dailyEntries": [_expense_entry_payload(entry) for entry in report.entries],
        "rentPayments": [_payment_payload(item) for item in _payments_for_group(report.payments, "rent")],
        "utilityPayments": [_payment_payload(item) for item in _payments_for_group(report.payments, "bills_utilities")],
        "subscriptionsNeeds": [
            _subscription_payload(item)
            for item in _subscriptions_for_bucket(report.subscriptions, "static_bills_subscriptions_needs")
        ],
        "subscriptionsWants": [
            _subscription_payload(item)
            for item in _subscriptions_for_bucket(report.subscriptions, "subscriptions_wants")
        ],
        "incomeEntries": [_payment_payload(item) for item in report.income_entries],
    }


def _amount_row(label: str, amount: float) -> dict[str, Any]:
    return {"label": str(label), "amount": round(float(amount or 0.0), 2)}


def _expense_entry_payload(entry: ExpenseEntry) -> dict[str, Any]:
    return {
        "date": entry.date,
        "category": CATEGORY_LABELS.get(entry.category, entry.category.title()),
        "amount": round(entry.amount, 2),
        "person": entry.person,
        "item": entry.item,
        "location": entry.location,
    }


def _payment_payload(item: PaymentItem) -> dict[str, Any]:
    return {
        "label": item.label,
        "amount": round(item.amount, 2),
        "group": CATEGORY_LABELS.get(item.group, item.group.title()),
        "status": item.status,
    }


def _subscription_payload(item: SubscriptionItem) -> dict[str, Any]:
    return {
        "name": item.name,
        "label": item.name,
        "amount": round(item.amount, 2),
        "cadence": item.cadence,
        "kind": item.kind,
        "pullDay": item.pull_day,
        "pullMonth": item.pull_month,
    }


def _json_script_payload(payload: dict[str, Any]) -> str:
    return (
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
    )


def _report_asset_text(filename: str) -> str:
    path = Path(__file__).resolve().parent / "assets" / filename
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"Expense report frontend asset '{filename}' is missing. "
            "Run `npm install && npm run build` in web/expense-report."
        ) from exc


def _analytics_section(
    breakdown_items: list[tuple[str, dict[str, Any]]],
    daily_totals: list[tuple[str, float]],
    budget_group_totals: dict[str, float],
    report: ExpenseBreakdownReport,
) -> str:
    return f"""<section class="analytics">
  <div class="analytics-head">
    <div>
      <h2>Budget Charts</h2>
      <div class="analytics-meta">{_escape(report.month.label)} expense signal from Budget and Shared Expenses data.</div>
    </div>
    <div class="chart-tabs" role="tablist" aria-label="Budget charts">
      <button type="button" class="chart-tab is-active" role="tab" aria-selected="true" aria-controls="chart-category" data-chart-tab="category">Category Mix</button>
      <button type="button" class="chart-tab" role="tab" aria-selected="false" aria-controls="chart-daily" data-chart-tab="daily">Daily Spending</button>
      <button type="button" class="chart-tab" role="tab" aria-selected="false" aria-controls="chart-groups" data-chart-tab="groups">Needs vs Wants</button>
    </div>
  </div>
  {_category_chart_panel(breakdown_items, report.grand_total)}
  {_daily_chart_panel(daily_totals, report.shared_total, calendar.monthrange(report.month.year, report.month.month)[1])}
  {_budget_group_chart_panel(budget_group_totals)}
</section>"""


def _category_chart_panel(items: list[tuple[str, dict[str, Any]]], grand_total: float) -> str:
    return f"""<div id="chart-category" class="chart-panel is-active" role="tabpanel" data-chart-panel="category">
  <div class="chart-grid">
    <div class="pie" role="img" aria-label="Expense category donut chart"></div>
    <div class="chart-copy">
      <div>
        <div class="chart-kicker">Category Mix</div>
        <div class="chart-total">{_money(grand_total)}</div>
      </div>
      <div class="legend">
        {_legend_rows(items)}
      </div>
    </div>
  </div>
</div>"""


def _daily_chart_panel(daily_totals: list[tuple[str, float]], shared_total: float, days_in_month: int) -> str:
    return f"""<div id="chart-daily" class="chart-panel" role="tabpanel" data-chart-panel="daily" hidden>
  <div class="chart-grid">
    {_daily_bar_chart(daily_totals)}
    <div class="chart-copy">
      <div>
        <div class="chart-kicker">Daily Spending</div>
        <div class="chart-total">{_money(shared_total)}</div>
      </div>
      {_daily_stat_rows(daily_totals, days_in_month)}
    </div>
  </div>
</div>"""


def _budget_group_chart_panel(group_totals: dict[str, float]) -> str:
    total = round(sum(group_totals.values()), 2)
    needs = round(group_totals.get("Needs", 0.0), 2)
    wants = round(group_totals.get("Wants", 0.0), 2)
    needs_pct = _percentage(needs, total)
    wants_pct = _percentage(wants, total)
    return f"""<div id="chart-groups" class="chart-panel" role="tabpanel" data-chart-panel="groups" hidden>
  <div class="chart-grid">
    <div class="group-bars">
      <div class="stacked-bar" role="img" aria-label="Needs and wants spending split">
        <span class="stack-segment" style="width:{needs_pct:.2f}%; background:var(--chart-1)"></span>
        <span class="stack-segment" style="width:{wants_pct:.2f}%; background:var(--chart-3)"></span>
      </div>
      {_group_bar("Needs", needs, total, "var(--chart-1)")}
      {_group_bar("Wants", wants, total, "var(--chart-3)")}
    </div>
    <div class="chart-copy">
      <div>
        <div class="chart-kicker">Needs vs Wants</div>
        <div class="chart-total">{_money(total)}</div>
      </div>
      <div class="stat-list">
        <div class="stat-row"><span>Needs share</span><strong>{needs_pct:.2f}%</strong></div>
        <div class="stat-row"><span>Wants share</span><strong>{wants_pct:.2f}%</strong></div>
        <div class="stat-row"><span>Difference</span><strong>{_money(abs(needs - wants))}</strong></div>
      </div>
    </div>
  </div>
</div>"""


def _daily_bar_chart(daily_totals: list[tuple[str, float]]) -> str:
    if not daily_totals:
        return '<div class="empty">No daily spending found.</div>'
    max_total = max(amount for _label, amount in daily_totals)
    bars = "\n".join(
        f"""<div class="bar-item" title="{_escape(label)}: {_money(amount)}">
  <div class="bar-fill" style="height:{_percentage(amount, max_total):.2f}%"></div>
  <div class="bar-label">{_escape(_short_day_label(label))}</div>
</div>"""
        for label, amount in daily_totals
    )
    return f'<div class="chart-bars" role="img" aria-label="Daily spending bar chart">{bars}</div>'


def _daily_stat_rows(daily_totals: list[tuple[str, float]], days_in_month: int) -> str:
    if not daily_totals:
        return '<div class="empty">No daily spending found.</div>'
    total = round(sum(amount for _label, amount in daily_totals), 2)
    average = round(total / days_in_month, 2) if days_in_month else 0.0
    peak_label, peak_amount = max(daily_totals, key=lambda item: item[1])
    return f"""<div class="stat-list">
  <div class="stat-row"><span>Tracked days</span><strong>{len(daily_totals)}</strong></div>
  <div class="stat-row"><span>Average day</span><strong>{_money(average)}</strong></div>
  <div class="stat-row"><span>Highest day</span><strong>{_escape(peak_label)} - {_money(peak_amount)}</strong></div>
</div>"""


def _group_bar(label: str, amount: float, total: float, color: str) -> str:
    return f"""<div class="group-row">
  <div class="group-row-head"><span>{_escape(label)}</span><strong>{_money(amount)}</strong></div>
  <div class="group-track"><div class="group-fill" style="width:{_percentage(amount, total):.2f}%; background:{color}"></div></div>
</div>"""


def _chart_tabs_script() -> str:
    return """<script>
(() => {
  const tabs = Array.from(document.querySelectorAll("[data-chart-tab]"));
  const panels = Array.from(document.querySelectorAll("[data-chart-panel]"));
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const target = tab.dataset.chartTab;
      for (const item of tabs) {
        const active = item.dataset.chartTab === target;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      }
      for (const panel of panels) {
        const active = panel.dataset.chartPanel === target;
        panel.classList.toggle("is-active", active);
        panel.hidden = !active;
      }
    });
  }
})();
</script>"""


def _daily_totals(entries: list[ExpenseEntry]) -> list[tuple[str, float]]:
    grouped: dict[int, float] = defaultdict(float)
    undated = 0.0
    for entry in entries:
        parsed = _parse_date(entry.date)
        if parsed is None:
            undated += entry.amount
            continue
        grouped[parsed.day] += entry.amount

    totals = [(str(day), round(amount, 2)) for day, amount in sorted(grouped.items()) if amount > 0]
    if undated > 0:
        totals.append(("No date", round(undated, 2)))
    return totals


def _budget_group_totals(breakdown: dict[str, dict[str, Any]]) -> dict[str, float]:
    needs = sum(float(breakdown.get(key, {}).get("amount") or 0.0) for key in NEEDS_BREAKDOWN_KEYS)
    wants = sum(float(breakdown.get(key, {}).get("amount") or 0.0) for key in WANTS_BREAKDOWN_KEYS)
    return {"Needs": round(needs, 2), "Wants": round(wants, 2)}


def _percentage(amount: float, total: float) -> float:
    if total <= 0:
        return 0.0
    return max(0.0, min(100.0, amount / total * 100))


def _short_day_label(label: str) -> str:
    return label if label.isdigit() else "?"


def _pie_gradient(items: list[tuple[str, dict[str, Any]]]) -> str:
    if not items:
        return "#e5e7eb"
    cursor = 0.0
    stops: list[str] = []
    for key, info in items:
        pct = float(info.get("percentage") or 0.0)
        end = cursor + pct
        color = CATEGORY_COLORS.get(key, "#64748b")
        stops.append(f"{color} {cursor:.2f}% {end:.2f}%")
        cursor = end
    return f"conic-gradient({', '.join(stops)})"


def _legend_rows(items: list[tuple[str, dict[str, Any]]]) -> str:
    if not items:
        return '<div class="empty">No expenses found.</div>'
    return "\n".join(
        f"""<div class="legend-row">
  <span class="swatch" style="background:{CATEGORY_COLORS.get(key, "#64748b")}"></span>
  <span>{_escape(info.get("label", key))} ({float(info.get("percentage") or 0):.2f}%)</span>
  <span class="amount">{_money(float(info.get("amount") or 0))}</span>
</div>"""
        for key, info in items
    )


def _simple_amount_table(headers: list[str], rows: list[tuple[str, float]]) -> str:
    if not rows:
        return '<div class="empty">No data found.</div>'
    body = "\n".join(
        f"<tr><td>{_escape(label)}</td><td class=\"amount\">{_money(amount)}</td></tr>"
        for label, amount in rows
    )
    return f"""<div class="table-wrap"><table>
  <thead><tr><th>{_escape(headers[0])}</th><th>{_escape(headers[1])}</th></tr></thead>
  <tbody>{body}</tbody>
</table></div>"""


def _entries_table(entries: list[ExpenseEntry]) -> str:
    if not entries:
        return '<div class="empty">No shared expense entries found.</div>'
    rows = "\n".join(
        f"""<tr>
  <td>{_escape(entry.date)}</td>
  <td>{_escape(CATEGORY_LABELS.get(entry.category, entry.category.title()))}</td>
  <td>{_escape(entry.item)}</td>
  <td>{_escape(entry.location)}</td>
  <td>{_escape(entry.person)}</td>
  <td class="amount">{_money(entry.amount)}</td>
</tr>"""
        for entry in entries
    )
    return f"""<div class="table-wrap"><table>
  <thead><tr><th>Date</th><th>Category</th><th>Item</th><th>Location</th><th>Person</th><th>Amount</th></tr></thead>
  <tbody>{rows}</tbody>
</table></div>"""


def _payments_table(items: list[PaymentItem]) -> str:
    if not items:
        return '<div class="empty">No entries found.</div>'
    rows = "\n".join(
        f"<tr><td>{_escape(item.label)}</td><td>{_escape(CATEGORY_LABELS.get(item.group, item.group.title()))}</td><td class=\"amount\">{_money(item.amount)}</td></tr>"
        for item in items
    )
    return f"""<div class="table-wrap"><table>
  <thead><tr><th>Label</th><th>Group</th><th>Amount</th></tr></thead>
  <tbody>{rows}</tbody>
</table></div>"""


def _payments_for_group(items: list[PaymentItem], group: str) -> list[PaymentItem]:
    return [item for item in items if item.group == group]


def _subscriptions_table(items: list[SubscriptionItem]) -> str:
    if not items:
        return '<div class="empty">No matching subscriptions found for this month.</div>'
    rows = "\n".join(
        f"""<tr>
  <td>{_escape(item.name)}</td>
  <td>{_escape(item.kind or "-")}</td>
  <td>{_escape(item.cadence)}</td>
  <td>{_escape(item.pull_day or "-")}</td>
  <td class="amount">{_money(item.amount)}</td>
</tr>"""
        for item in items
    )
    return f"""<div class="table-wrap"><table>
  <thead><tr><th>Name</th><th>Kind</th><th>Cadence</th><th>Pull Day</th><th>Amount</th></tr></thead>
  <tbody>{rows}</tbody>
</table></div>"""


def _subscriptions_for_bucket(items: list[SubscriptionItem], bucket: str) -> list[SubscriptionItem]:
    return [item for item in items if _subscription_bucket(item) == bucket]


def _daily_spending_table(entries: list[ExpenseEntry]) -> str:
    if not entries:
        return '<div class="empty">No shared expense entries found.</div>'

    grouped: dict[int, list[ExpenseEntry]] = defaultdict(list)
    undated: list[ExpenseEntry] = []
    for entry in entries:
        parsed = _parse_date(entry.date)
        if parsed is None:
            undated.append(entry)
            continue
        grouped[parsed.day].append(entry)

    rows: list[str] = []
    for day in sorted(grouped):
        day_entries = sorted(grouped[day], key=lambda entry: entry.amount, reverse=True)
        total = round(sum(entry.amount for entry in day_entries), 2)
        rows.append(_daily_spending_row(str(day), total, day_entries))
    if undated:
        total = round(sum(entry.amount for entry in undated), 2)
        rows.append(_daily_spending_row("No date", total, undated))

    return f"""<div class="table-wrap"><table>
  <thead><tr><th>Day</th><th>Total</th><th>Transactions</th></tr></thead>
  <tbody>{''.join(rows)}</tbody>
</table></div>"""


def _daily_spending_row(day_label: str, total: float, entries: list[ExpenseEntry]) -> str:
    transactions = "\n".join(
        f"""<div class="txn">
  <strong>{_money(entry.amount)}</strong>
  <span>{_escape(entry.location or entry.item or CATEGORY_LABELS.get(entry.category, entry.category.title()))}</span>
  <span class="txn-meta">{_escape(CATEGORY_LABELS.get(entry.category, entry.category.title()))} / {_escape(entry.person)}</span>
</div>"""
        for entry in entries
    )
    return f"""<tr>
  <td>{_escape(day_label)}</td>
  <td class="amount">{_money(total)}</td>
  <td><div class="txn-list">{transactions}</div></td>
</tr>"""
