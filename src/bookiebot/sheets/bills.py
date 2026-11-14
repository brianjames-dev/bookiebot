from __future__ import annotations

from calendar import monthrange
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
import re
from typing import Any, Literal, Protocol

from openpyxl.utils import get_column_letter

from bookiebot.sheets.repo import get_sheets_repo
from bookiebot.sheets.routing import now_pacific

BillRecurrence = Literal["monthly", "quarterly", "yearly"]
BillTrackingMode = Literal["manual", "automatic"]


class _WorksheetWithUpdate(Protocol):
    def update(self, *args: Any, **kwargs: Any) -> Any:
        ...

BILL_SCHEDULE_HEADERS = [
    "bill_key",
    "display_name",
    "recurrence",
    "pull_day",
    "pull_months",
    "source_label",
    "account",
    "notes",
    "updated_at",
    "expected_amount",
]

DEFAULT_BILL_TEMPLATE_ROWS = [
    ("rent", "Rent", "monthly", "", "", "Rent", "", ""),
    ("pge", "PG&E", "monthly", "", "", "PG&E", "", ""),
    ("recology", "Recology", "quarterly", "", "", "Recology", "", ""),
    ("water", "Water", "quarterly", "", "", "Water", "", ""),
]

RETIRED_BILL_KEYS = {"student_loan", "student_loan_payment"}


@dataclass(frozen=True)
class BillSchedule:
    bill_key: str
    display_name: str
    recurrence: BillRecurrence
    pull_day: int
    pull_months: tuple[int, ...] = ()
    source_label: str = ""
    account: str = ""
    notes: str = ""
    source_range: str = ""
    updated_at: str = ""
    expected_amount: float | None = None
    tracking_mode: BillTrackingMode = "manual"
    active: bool = True
    category: str = ""
    plan_id: str = ""
    effective_from: str = "0001-01"
    effective_until: str = "9999-12"
    recorded_months: str = ""
    bill_type: str = ""


@dataclass(frozen=True)
class BillPaymentState:
    """Timing of an entered monthly amount, not evidence of a bank posting."""
    withdrawal_date: date | None
    paid: bool
    reason: str = ""


def bill_label_key(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]", "", value.casefold())
    return "studentloan" if normalized == "studentloanpayment" else normalized


def bill_payment_state(
    label: str, year: int, month: int, schedules: list[BillSchedule], *, as_of: date,
    recorded_on: date | None = None,
) -> BillPaymentState:
    if recorded_on and recorded_on <= as_of and (recorded_on.year, recorded_on.month) == (year, month):
        return BillPaymentState(recorded_on, True, "confirmed_repayment")
    target = bill_label_key(label)
    matches = [bill for bill in schedules if target and target in {
        bill_label_key(bill.bill_key), bill_label_key(bill.display_name), bill_label_key(bill.source_label),
    }]
    if len(matches) != 1:
        return BillPaymentState(None, False, "ambiguous_schedule" if matches else "missing_schedule")
    bill = matches[0]
    if bill.recurrence != "monthly" and month not in bill.pull_months:
        return BillPaymentState(None, False, "outside_billing_month")
    withdrawal = _clamped_date(year, month, bill.pull_day)
    return BillPaymentState(withdrawal, withdrawal <= as_of)


@dataclass(frozen=True)
class BillReminder:
    bill: BillSchedule
    pull_date: date
    days_until: int
    amount: float | None
    amount_entered: bool
    overdue: bool = False

    @property
    def key(self) -> str:
        status = "overdue" if self.overdue else str(self.days_until)
        return f"{self.bill.bill_key}|{self.pull_date.isoformat()}|{status}"


@dataclass(frozen=True)
class BillScheduleWarning:
    source_range: str
    reason: str
    values: tuple[str, ...] = ()

    def format(self) -> str:
        detail = f" ({', '.join(value for value in self.values if value)})" if any(self.values) else ""
        return f"{self.source_range}: {self.reason}{detail}"


def _cell(row: list[str], index: int) -> str:
    if index >= len(row):
        return ""
    return str(row[index]).strip()


def _normalize_header(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


def _parse_day(value: str) -> int | None:
    text = value.strip().lower()
    if not text:
        return None
    if text in {"last", "last_day", "eom", "end_of_month"}:
        return 31
    match = re.search(r"\b([1-9]|[12][0-9]|3[01])(?:st|nd|rd|th)?\b", text)
    if not match:
        return None
    return int(match.group(1))


def _parse_pull_months(value: str) -> tuple[int, ...]:
    months = sorted({int(match) for match in re.findall(r"\d+", value)})
    return tuple(month for month in months if 1 <= month <= 12)


def _parse_recurrence(value: str) -> BillRecurrence | None:
    text = value.strip().lower()
    if text in {"monthly", "month"}:
        return "monthly"
    if text in {"quarterly", "quarter"}:
        return "quarterly"
    if text in {"yearly", "annual"}:
        return "yearly"
    return None


def _source_range(row_index: int, column_count: int) -> str:
    return f"_BookieBot Bill Schedule!A{row_index}:{get_column_letter(column_count)}{row_index}"


def _parse_bill_amount(value: str, *, allow_zero: bool = False) -> float | None:
    text = value.strip()
    if not text:
        return None
    if not re.fullmatch(r"\$?\s*(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", text):
        raise ValueError("invalid expected amount")
    try:
        amount = Decimal(text.replace("$", "").replace(",", "").strip())
        if not amount.is_finite() or amount < 0 or amount > Decimal("1000000000000") or (amount == 0 and not allow_zero):
            raise ValueError("invalid expected amount")
        cents = amount * 100
        if cents != cents.to_integral_value():
            raise ValueError("invalid expected amount")
        return float(amount)
    except InvalidOperation as exc:
        raise ValueError("invalid expected amount") from exc


def _row_is_empty(row: list[str]) -> bool:
    return not any(str(value).strip() for value in row)


def _row_is_blank_template(fields: dict[str, str]) -> bool:
    return bool(fields.get("display_name") or fields.get("source_label")) and not fields.get("pull_day", "").strip()


def _bill_from_fields(fields: dict[str, str], source_range: str) -> tuple[BillSchedule | None, BillScheduleWarning | None]:
    if not any(value.strip() for value in fields.values()):
        return None, None
    try:
        expected_amount = _parse_bill_amount(fields.get("expected_amount", ""))
    except ValueError:
        return None, BillScheduleWarning(
            source_range, "invalid expected amount", (fields.get("display_name", ""), fields.get("expected_amount", "")),
        )
    mode = fields.get("tracking_mode", "").strip().lower() or "manual"
    if mode not in {"manual", "automatic"}:
        return None, BillScheduleWarning(source_range, "invalid tracking mode", (fields.get("display_name", ""), mode))
    if mode == "automatic" and expected_amount is None:
        return None, BillScheduleWarning(source_range, "automatic bill requires expected amount", (fields.get("display_name", ""),))
    if expected_amount is None and _row_is_blank_template(fields):
        return None, None

    display_name = fields.get("display_name", "")
    source_label = fields.get("source_label", "") or display_name
    recurrence = _parse_recurrence(fields.get("recurrence", ""))
    pull_day = _parse_day(fields.get("pull_day", ""))
    pull_months = _parse_pull_months(fields.get("pull_months", ""))

    if not display_name:
        return None, BillScheduleWarning(source_range, "missing display name", tuple(fields.values()))
    if recurrence is None:
        return None, BillScheduleWarning(source_range, "invalid recurrence", (display_name, fields.get("recurrence", "")))
    if pull_day is None:
        return None, BillScheduleWarning(source_range, "missing or invalid pull day", (display_name, fields.get("pull_day", "")))
    if recurrence == "quarterly" and not pull_months:
        return None, BillScheduleWarning(source_range, "quarterly bill missing pull months", (display_name,))

    bill_key = fields.get("bill_key", "") or _slug(display_name)
    return (
        BillSchedule(
            bill_key=bill_key,
            display_name=display_name,
            recurrence=recurrence,
            pull_day=pull_day,
            pull_months=pull_months,
            source_label=source_label,
            account=fields.get("account", ""),
            notes=fields.get("notes", ""),
            source_range=("billplan:" + fields["plan_id"] if fields.get("plan_id") and not fields.get("source_range", "").startswith("billplan-receipt:")
                          else fields.get("source_range") or source_range),
            updated_at=fields.get("updated_at", ""),
            expected_amount=expected_amount,
            tracking_mode="automatic" if mode == "automatic" else "manual",
            active=fields.get("active", "true").casefold() != "false",
            category=fields.get("category", ""),
            plan_id=fields.get("plan_id", ""),
            effective_from=fields.get("effective_from", "0001-01"), effective_until=fields.get("effective_until", "9999-12"),
            recorded_months=fields.get("recorded_months", ""),
            bill_type=fields.get("bill_type") or ("fixed" if mode == "automatic" or bill_label_key(source_label) in {"rent", "studentloan"} else "variable"),
        ),
        None,
    )


def _update_range(ws: _WorksheetWithUpdate, start_row: int, start_col: int, values: list[list[str]]) -> None:
    if not values:
        return
    end_row = start_row + len(values) - 1
    end_col = start_col + max(len(row) for row in values) - 1
    range_name = f"{get_column_letter(start_col)}{start_row}:{get_column_letter(end_col)}{end_row}"
    try:
        ws.update(values, range_name=range_name, raw=False)
    except TypeError:
        ws.update(range_name, values, raw=False)


def _template_rows() -> list[list[str]]:
    updated_at = now_pacific().isoformat(timespec="seconds")
    return [list(row) + [updated_at, ""] for row in DEFAULT_BILL_TEMPLATE_ROWS]


def ensure_bill_schedule_sheet() -> None:
    ws = get_sheets_repo().bill_schedule_sheet()
    rows = ws.get_all_values()
    if rows and any(any(str(value).strip() for value in row) for row in rows):
        return
    column_count = getattr(ws, "col_count", len(BILL_SCHEDULE_HEADERS))
    if isinstance(column_count, int) and column_count < len(BILL_SCHEDULE_HEADERS):
        ws.resize(cols=len(BILL_SCHEDULE_HEADERS))
    _update_range(ws, 1, 1, [BILL_SCHEDULE_HEADERS] + _template_rows())


def parse_bill_schedules_with_warnings(rows: list[list[str]] | None = None, *, period: str | None = None, all_versions: bool = False) -> tuple[list[BillSchedule], list[BillScheduleWarning]]:
    if rows is None:
        ensure_bill_schedule_sheet()
        rows = get_sheets_repo().bill_schedule_sheet().get_all_values()
        sub_sheet = getattr(get_sheets_repo(), "find_subscription_schedule_sheet", lambda: None)()
        charge_sheet = getattr(get_sheets_repo(), "find_bill_charges_sheet", lambda: None)()
        sub_rows = sub_sheet.get_all_values() if sub_sheet is not None else []
        charge_rows = charge_sheet.get_all_values() if charge_sheet is not None else []
        from bookiebot.sheets.recurring_rows import managed
        if managed(rows or []) or managed(sub_rows) or charge_rows:
            from bookiebot.sheets.recurring_rows import runtime_tables
            from bookiebot.sheets.routing import get_current_discord_user_id, get_user_config
            rows, _, _ = runtime_tables(get_user_config(get_current_discord_user_id()).budget_owner_key,
                rows or [], sub_rows, get_sheets_repo().subscriptions_sheet().get_all_values(), charge_rows)
    if not rows:
        return [], []
    from bookiebot.sheets.recurring_rows import period_rows
    from bookiebot.sheets.recurring_rows import managed, decode
    if managed(rows):
        from bookiebot.sheets.recurring import BILL_TAB
        decode(rows, BILL_TAB)
    if not all_versions:
        rows = period_rows(rows, period or now_pacific().strftime("%Y-%m"))

    header = [_normalize_header(value) for value in rows[0]]
    if not {"display_name", "recurrence", "pull_day", "source_label"} <= set(header):
        return [], [
            BillScheduleWarning(
                "_BookieBot Bill Schedule!A1:I1",
                "missing expected bill schedule headers",
                tuple(rows[0]),
            )
        ]

    bills: list[BillSchedule] = []
    warnings: list[BillScheduleWarning] = []
    for row_index, row in enumerate(rows[1:], start=2):
        if _row_is_empty(row):
            continue
        fields = {
            column: _cell(row, index)
            for index, column in enumerate(header)
            if column
        }
        legacy_keys = {
            _slug(fields.get("bill_key", "")),
            _slug(fields.get("display_name", "")),
            _slug(fields.get("source_label", "")),
        }
        if (legacy_keys & RETIRED_BILL_KEYS and not fields.get("expected_amount", "").strip()
                and fields.get("tracking_mode", "").strip().lower() in {"", "manual"}):
            continue
        bill, warning = _bill_from_fields(fields, _source_range(row_index, len(header)))
        if bill:
            bills.append(bill)
        if warning:
            warnings.append(warning)
    return bills, warnings


def list_bill_schedules(rows: list[list[str]] | None = None, *, period: str | None = None, all_versions: bool = False) -> list[BillSchedule]:
    bills, _warnings = parse_bill_schedules_with_warnings(rows, period=period, all_versions=all_versions)
    return bills


def bill_source_amount(rows: list[list[str]], source_label: str, *, amount_column: int | None = None) -> float | None:
    """Read one exact bill row; zero is unrecorded, None is unverified."""
    target = _slug(source_label)
    if not target:
        return None
    matches = [_cell(row, amount_column - 1) for row in rows if _slug(_cell(row, 1)) == target] if amount_column else [
        _cell(row, index + 1)
        for row in rows
        for index, value in enumerate(row)
        if _slug(str(value)) == target
    ]
    if len(matches) != 1:
        return None
    try:
        return _parse_bill_amount(matches[0], allow_zero=True) or 0.0
    except ValueError:
        return None


def bill_amount_for_source_label(source_label: str) -> tuple[bool, float]:
    try:
        amount = bill_source_amount(get_sheets_repo().income_sheet().get_all_values(), source_label)
    except Exception:
        return False, 0.0
    return (True, amount) if amount is not None and amount > 0 else (False, 0.0)


def _clamped_date(year: int, month: int, day: int) -> date:
    last_day = monthrange(year, month)[1]
    return date(year, month, min(day, last_day))


def _next_allowed_month(current_month: int, months: tuple[int, ...]) -> int:
    for month in months:
        if month >= current_month:
            return month
    return months[0]


def next_bill_pull_date(bill: BillSchedule, today: date) -> date | None:
    if not bill.active:
        return None
    if bill.plan_id:
        from bookiebot.sheets.recurring import BillPlan, BILL_TAB
        return BillPlan(bill.plan_id, "fixed" if bill.tracking_mode == "automatic" else "variable", bill.display_name,
            round(bill.expected_amount * 100) if bill.expected_amount is not None else None, bill.recurrence,
            bill.pull_day, bill.pull_months, bill.category, bill.account, bill.source_label, BILL_TAB,
            effective_from=bill.effective_from, effective_until=bill.effective_until).next_date(today)
    if bill.recurrence == "monthly":
        candidate = _clamped_date(today.year, today.month, bill.pull_day)
        if candidate < today:
            month = today.month + 1
            year = today.year
            if month == 13:
                month = 1
                year += 1
            candidate = _clamped_date(year, month, bill.pull_day)
        return candidate

    if not bill.pull_months:
        return None
    month = _next_allowed_month(today.month, bill.pull_months)
    year = today.year
    candidate = _clamped_date(year, month, bill.pull_day)
    if candidate < today:
        next_months = [allowed for allowed in bill.pull_months if allowed > today.month]
        if next_months:
            candidate = _clamped_date(today.year, next_months[0], bill.pull_day)
        else:
            candidate = _clamped_date(today.year + 1, bill.pull_months[0], bill.pull_day)
    return candidate


def overdue_bill_pull_date(bill: BillSchedule, today: date) -> date | None:
    if not bill.active:
        return None
    if bill.plan_id and not bill.effective_from <= today.strftime("%Y-%m") < bill.effective_until:
        return None
    if bill.recurrence == "monthly":
        candidate = _clamped_date(today.year, today.month, bill.pull_day)
    elif today.month in bill.pull_months:
        candidate = _clamped_date(today.year, today.month, bill.pull_day)
    else:
        return None
    return candidate if candidate < today else None


def due_bill_reminders_for_bills(bills: list[BillSchedule], today: date) -> list[BillReminder]:
    reminders: list[BillReminder] = []
    managed_rows: list[list[str]] | None = None
    recorded_ids: set[str] = set()
    recorded_labels: set[str] = set()
    if any(bill.plan_id for bill in bills):
        managed_rows = get_sheets_repo().income_sheet().get_all_values()
        from bookiebot.sheets.recurring_charges import decode_charges
        charges_ws = getattr(get_sheets_repo(), "find_bill_charges_sheet", lambda: None)()
        if charges_ws is not None:
            recorded_ids.update(c.plan_id for c in decode_charges(charges_ws.get_all_values())
                                if c.recorded and c.month == today.strftime("%Y-%m"))
        from bookiebot.reimbursements import service
        if service.enabled():
            from bookiebot.sheets.routing import get_current_discord_user_id, get_user_config
            owner = get_user_config(get_current_discord_user_id()).budget_owner_key
            for value in service.build_reimbursement_store().snapshot(owner, include_inactive=True)["allocations"]:
                if value["payerOwner"] == owner and value["sourceYear"] == today.year and value["sourceWorksheet"] == "income" and value.get("sourceSheetTitle") == today.strftime("%B"):
                    recorded_ids.add(value.get("billPlanId", ""))
                    recorded_labels.add(value.get("sourceValues", {}).get("item", ""))
    for bill in bills:
        if bill.plan_id and managed_rows is not None:
            column = 3 if bill.category == "subscriptions_wants" else 2
            cells = [_cell(row, column) for row in managed_rows if _cell(row, 1) == bill.source_label]
            amount = _parse_bill_amount(cells[0], allow_zero=True) or 0 if len(cells) == 1 else 0
            amount_entered = amount > 0 or bill.plan_id in recorded_ids or bill.source_label in recorded_labels
        else:
            amount_entered, amount = bill_amount_for_source_label(bill.source_label)
        automatic = bill.tracking_mode == "automatic"
        reminder_amount = bill.expected_amount if automatic else amount if amount_entered else bill.expected_amount
        pull_date = next_bill_pull_date(bill, today)
        if pull_date is not None:
            if bill.plan_id and (pull_date.year, pull_date.month) != (today.year, today.month):
                amount_entered = False
                reminder_amount = bill.expected_amount
            days_until = (pull_date - today).days
            if 0 <= days_until <= 7:
                reminders.append(BillReminder(bill, pull_date, days_until, reminder_amount, amount_entered))

        overdue_date = overdue_bill_pull_date(bill, today)
        if overdue_date is not None and not amount_entered and not automatic:
            reminders.append(BillReminder(bill, overdue_date, (overdue_date - today).days, reminder_amount, False, overdue=True))

    return sorted(reminders, key=lambda reminder: (reminder.overdue, reminder.pull_date, reminder.bill.display_name.lower()))


def due_bill_reminders(today: date) -> tuple[list[BillReminder], list[BillScheduleWarning]]:
    bills, warnings = parse_bill_schedules_with_warnings(all_versions=True)
    return due_bill_reminders_for_bills(bills, today), warnings
