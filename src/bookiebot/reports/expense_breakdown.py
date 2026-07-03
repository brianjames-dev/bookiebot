from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
import calendar
import html
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
class NeedExpense:
    description: str
    amount: float


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
    entries: list[ExpenseEntry] = field(default_factory=list)
    payments: list[PaymentItem] = field(default_factory=list)
    subscriptions: list[SubscriptionItem] = field(default_factory=list)
    need_expenses: list[NeedExpense] = field(default_factory=list)
    income_entries: list[PaymentItem] = field(default_factory=list)
    raw_sheets: list[RawSheet] = field(default_factory=list)


@dataclass(frozen=True)
class ExpenseReportPage:
    path: Path
    url: str


CATEGORY_LABELS = {
    "rent": "Rent",
    "bills_utilities": "Bills & Utilities",
    "subscriptions": "Subscriptions",
    "need_expenses": "Need Expenses",
    "grocery": "Grocery",
    "gas": "Gas",
    "food": "Food",
    "shopping": "Shopping",
}

CATEGORY_COLORS = {
    "rent": "#2563eb",
    "bills_utilities": "#0f766e",
    "subscriptions": "#7c3aed",
    "need_expenses": "#dc2626",
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
    need_expenses = _need_expenses(personal_rows)
    income_entries, income_total = _income_entries(personal_rows)
    remaining_budget = _remaining_budget(personal_rows)

    breakdown_amounts = _ordered_breakdown_amounts()
    for entry in entries:
        breakdown_amounts[entry.category] += entry.amount
    for payment in payments:
        breakdown_amounts[payment.group] += payment.amount
    for subscription in subscriptions:
        breakdown_amounts["subscriptions"] += subscription.amount
    for need in need_expenses:
        breakdown_amounts["need_expenses"] += need.amount

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
    personal_total = round(
        sum(payment.amount for payment in payments)
        + sum(subscription.amount for subscription in subscriptions)
        + sum(need.amount for need in need_expenses),
        2,
    )

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
        entries=entries,
        payments=payments,
        subscriptions=subscriptions,
        need_expenses=need_expenses,
        income_entries=income_entries,
        raw_sheets=[
            RawSheet("Shared Expenses", _compact_rows(shared_rows)),
            RawSheet("Personal Budget", _compact_rows(personal_rows)),
            RawSheet("Subscriptions", _compact_rows(subscription_rows)),
        ],
    )


def write_expense_breakdown_report(report: ExpenseBreakdownReport, *, report_dir: Path | None = None) -> ExpenseReportPage:
    from bookiebot.reports.web import public_report_url, reports_dir

    directory = report_dir or reports_dir()
    directory.mkdir(parents=True, exist_ok=True)
    filename = _report_filename(report)
    path = directory / filename
    path.write_text(render_expense_breakdown_html(report), encoding="utf-8")
    return ExpenseReportPage(path=path, url=public_report_url(filename))


def render_expense_breakdown_html(report: ExpenseBreakdownReport) -> str:
    non_zero_breakdown = [
        (key, info)
        for key, info in report.breakdown.items()
        if float(info.get("amount") or 0.0) > 0
    ]
    top_entries = sorted(report.entries, key=lambda entry: entry.amount, reverse=True)[:10]
    person_totals = _person_totals(report.entries)
    daily_totals = _daily_totals(report.entries)
    merchant_totals = _merchant_totals(report.entries)
    balance_after_expenses = report.income_total - report.grand_total if report.income_total else None

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Expense Breakdown - {_escape(report.month.label)}</title>
  <style>
    :root {{
      color-scheme: light;
      --bg: #f8fafc;
      --panel: #ffffff;
      --ink: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --accent: #2563eb;
      --good: #15803d;
      --bad: #b91c1c;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }}
    header {{
      padding: 32px 24px 20px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }}
    main {{
      width: min(1180px, calc(100vw - 32px));
      margin: 24px auto 48px;
    }}
    h1, h2, h3 {{ margin: 0; letter-spacing: 0; }}
    h1 {{ font-size: 30px; }}
    h2 {{ font-size: 18px; margin-bottom: 14px; }}
    h3 {{ font-size: 15px; margin-bottom: 10px; }}
    .subhead {{ margin-top: 6px; color: var(--muted); }}
    .grid {{ display: grid; gap: 16px; }}
    .cards {{ grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }}
    .two {{ grid-template-columns: minmax(280px, 0.9fr) minmax(320px, 1.1fr); align-items: stretch; }}
    section, .card {{
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }}
    section {{ margin-top: 16px; }}
    .metric-label {{ color: var(--muted); font-size: 13px; }}
    .metric-value {{ margin-top: 5px; font-size: 24px; font-weight: 750; }}
    .metric-note {{ margin-top: 4px; color: var(--muted); font-size: 12px; }}
    .pie {{
      width: min(340px, 72vw);
      aspect-ratio: 1;
      border-radius: 50%;
      margin: 8px auto 18px;
      background: {_pie_gradient(non_zero_breakdown)};
      border: 1px solid var(--line);
    }}
    .legend {{ display: grid; gap: 8px; }}
    .legend-row, .bar-row {{
      display: grid;
      grid-template-columns: 18px minmax(110px, 1fr) auto;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }}
    .swatch {{ width: 12px; height: 12px; border-radius: 3px; }}
    .amount {{ font-variant-numeric: tabular-nums; }}
    .bar-row {{ grid-template-columns: minmax(110px, 150px) 1fr auto; margin: 8px 0; }}
    .bar-track {{ height: 9px; background: #e5e7eb; border-radius: 999px; overflow: hidden; }}
    .bar-fill {{ height: 100%; border-radius: 999px; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
    th, td {{ padding: 9px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }}
    th {{ color: var(--muted); font-weight: 650; background: #f8fafc; }}
    tr:last-child td {{ border-bottom: 0; }}
    .table-wrap {{ overflow-x: auto; }}
    .empty {{ color: var(--muted); font-size: 13px; }}
    .raw td {{ white-space: nowrap; }}
    .positive {{ color: var(--good); }}
    .negative {{ color: var(--bad); }}
    @media (max-width: 820px) {{
      .two {{ grid-template-columns: 1fr; }}
      header {{ padding: 24px 16px 18px; }}
      main {{ width: min(100vw - 20px, 1180px); margin-top: 12px; }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>Expense Breakdown</h1>
    <div class="subhead">{_escape(report.month.label)} budget report for {_escape(report.owner_name)}. Generated {_escape(report.generated_at.strftime("%b %-d, %Y %-I:%M %p %Z"))}.</div>
  </header>
  <main>
    <div class="grid cards">
      {_metric_card("Total Expenses", report.grand_total)}
      {_metric_card("Shared Expenses", report.shared_total, "from the shared expense tab")}
      {_metric_card("Personal Outflows", report.personal_total, "from the personal budget tab")}
      {_metric_card("Monthly Income", report.income_total)}
      {_metric_card("Remaining Budget", report.remaining_budget)}
      {_metric_card("Income After Expenses", balance_after_expenses)}
    </div>

    <section class="grid two">
      <div>
        <h2>Category Mix</h2>
        <div class="pie" role="img" aria-label="Expense category pie chart"></div>
        <div class="legend">
          {_legend_rows(non_zero_breakdown)}
        </div>
      </div>
      <div>
        <h2>Category Totals</h2>
        {_category_bars(non_zero_breakdown)}
      </div>
    </section>

    <section class="grid two">
      <div>
        <h2>Spending By Person / Card</h2>
        {_simple_amount_table(["Person", "Amount"], [(person, total) for person, total in person_totals])}
      </div>
      <div>
        <h2>Daily Shared Spending</h2>
        {_simple_amount_table(["Day", "Amount"], [(str(day), amount) for day, amount in daily_totals])}
      </div>
    </section>

    <section>
      <h2>Largest Shared Expenses</h2>
      {_entries_table(top_entries)}
    </section>

    <section class="grid two">
      <div>
        <h2>Frequent Merchants / Locations</h2>
        {_simple_amount_table(["Merchant", "Amount"], merchant_totals)}
      </div>
      <div>
        <h2>Bills, Utilities, Rent</h2>
        {_payments_table(report.payments)}
      </div>
    </section>

    <section class="grid two">
      <div>
        <h2>Subscriptions</h2>
        {_subscriptions_table(report.subscriptions)}
      </div>
      <div>
        <h2>Need Expenses</h2>
        {_needs_table(report.need_expenses)}
      </div>
    </section>

    <section>
      <h2>Income Entries</h2>
      {_payments_table(report.income_entries)}
    </section>

    <section>
      <h2>All Shared Expense Transactions</h2>
      {_entries_table(report.entries)}
    </section>

    <section>
      <h2>Source Sheet Data</h2>
      {_raw_sheets(report.raw_sheets)}
    </section>
  </main>
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
            group = "rent" if _normalize_label(bill.bill_key) == "rent" else "bills_utilities"
            for label in {bill.bill_key, bill.display_name, bill.source_label}:
                normalized = _normalize_label(label)
                if normalized:
                    labels[normalized] = (group, bill.display_name or bill.source_label or bill.bill_key)
        return labels
    except Exception:
        return {}


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


def _need_expenses(rows: list[list[str]]) -> list[NeedExpense]:
    marker_index = _need_marker_index(rows)
    if marker_index is not None:
        needs_from_marker: list[NeedExpense] = []
        for row in reversed(rows[:marker_index]):
            description = _cell(row, 1)
            amount = clean_money(_cell(row, 2))
            if amount <= 0:
                if needs_from_marker:
                    break
                continue
            if not description or description.lower() in {"description", "need", "needs"}:
                continue
            needs_from_marker.append(NeedExpense(description=description, amount=round(amount, 2)))
        return list(reversed(needs_from_marker))

    needs: list[NeedExpense] = []
    for row in rows:
        for index, value in enumerate(row[:-1]):
            description = str(value).strip()
            if not description or description.lower() in {"<enter transaction>", "description"}:
                continue
            amount = clean_money(row[index + 1])
            if amount > 0 and _looks_like_need_row(row, index):
                needs.append(NeedExpense(description=description, amount=round(amount, 2)))
    return needs


def _looks_like_need_row(row: list[str], index: int) -> bool:
    left_context = " ".join(row[max(0, index - 3) : index + 1]).lower()
    right_context = " ".join(row[index : min(len(row), index + 4)]).lower()
    context = f"{left_context} {right_context}"
    excluded = {
        "rent",
        "pg&e",
        "pge",
        "recology",
        "water",
        "student loan",
        "income",
        "paycheck",
        "deposit",
        "salary",
        "refund",
        "margins",
    }
    if any(term in context for term in excluded):
        return False
    return True


def _need_marker_index(rows: list[list[str]]) -> int | None:
    for row_index, row in enumerate(rows):
        if any(str(value).strip().lower() == "<enter transaction>" for value in row):
            return row_index
    return None


def _income_entries(rows: list[list[str]]) -> tuple[list[PaymentItem], float]:
    items: list[PaymentItem] = []
    summary_total = 0.0
    for row in rows:
        for index, value in enumerate(row[:-1]):
            label = str(value).strip()
            normalized = _normalize_label(label)
            if not normalized:
                continue
            amount = _next_money(row, index + 1)
            if "monthly income" in normalized and amount > 0:
                summary_total = max(summary_total, amount)
                continue
            if amount > 0 and _looks_like_income_label(label):
                items.append(PaymentItem(label=label, amount=round(amount, 2), group="income"))
    total = summary_total or round(sum(item.amount for item in items), 2)
    return items, round(total, 2)


def _remaining_budget(rows: list[list[str]]) -> float | None:
    for row in rows:
        for index, value in enumerate(row):
            if "margins" not in str(value).strip().lower():
                continue
            amount = _next_money(row, index + 1)
            return round(amount, 2)
    return None


def _looks_like_income_label(label: str) -> bool:
    text = label.strip().lower()
    if not text or any(key in text for key in PAYMENT_GROUPS):
        return False
    if any(term in text for term in {"income", "paycheck", "deposit", "salary", "refund"}):
        return True
    return False


def _matched_payment_label(label_text: str, labels: dict[str, tuple[str, str]]) -> tuple[str, str] | None:
    for label, value in labels.items():
        if label and (label_text == label or label in label_text or label_text in label):
            return value
    return None


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


def _daily_totals(entries: list[ExpenseEntry]) -> list[tuple[int, float]]:
    totals: dict[int, float] = defaultdict(float)
    for entry in entries:
        parsed = _parse_date(entry.date)
        if parsed:
            totals[parsed.day] += entry.amount
    return sorted((day, round(amount, 2)) for day, amount in totals.items())


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


def _category_bars(items: list[tuple[str, dict[str, Any]]]) -> str:
    if not items:
        return '<div class="empty">No expenses found.</div>'
    max_amount = max(float(info.get("amount") or 0.0) for _key, info in items) or 1.0
    rows = []
    for key, info in items:
        amount = float(info.get("amount") or 0.0)
        width = amount / max_amount * 100
        rows.append(
            f"""<div class="bar-row">
  <span>{_escape(info.get("label", key))}</span>
  <span class="bar-track"><span class="bar-fill" style="width:{width:.1f}%; background:{CATEGORY_COLORS.get(key, "#64748b")}"></span></span>
  <span class="amount">{_money(amount)}</span>
</div>"""
        )
    return "\n".join(rows)


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


def _subscriptions_table(items: list[SubscriptionItem]) -> str:
    if not items:
        return '<div class="empty">No active subscriptions found for this month.</div>'
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


def _needs_table(items: list[NeedExpense]) -> str:
    if not items:
        return '<div class="empty">No need expenses found.</div>'
    rows = "\n".join(
        f"<tr><td>{_escape(item.description)}</td><td class=\"amount\">{_money(item.amount)}</td></tr>"
        for item in items
    )
    return f"""<div class="table-wrap"><table>
  <thead><tr><th>Description</th><th>Amount</th></tr></thead>
  <tbody>{rows}</tbody>
</table></div>"""


def _raw_sheets(sheets: list[RawSheet]) -> str:
    parts: list[str] = []
    for sheet in sheets:
        if not sheet.rows:
            continue
        rows = "\n".join(
            "<tr>"
            + "".join(f"<td>{_escape(value)}</td>" for value in row)
            + "</tr>"
            for row in sheet.rows
        )
        parts.append(
            f"""<h3>{_escape(sheet.title)}</h3>
<div class="table-wrap"><table class="raw"><tbody>{rows}</tbody></table></div>"""
        )
    return "\n".join(parts) if parts else '<div class="empty">No source rows found.</div>'
