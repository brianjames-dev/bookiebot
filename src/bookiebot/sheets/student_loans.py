"""Opt-in standalone student loans; subscription-only profiles never get a write."""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
import re
from typing import Any

from bookiebot.sheets.bills import BillSchedule, RETIRED_BILL_KEYS, parse_bill_schedules_with_warnings
from bookiebot.sheets.repo import get_sheets_repo
from bookiebot.sheets.routing import (
    SheetRoutingError, SpreadsheetQuotaError, get_current_discord_user_id,
    get_user_config, is_google_sheets_quota_error, spreadsheet_read_quota_error,
)
from bookiebot.sheets.undo import UndoAction, record_undo_action
from bookiebot.sheets.subscriptions import (
    _parse_visible_subscription_schedule_drafts, parse_visible_subscription_schedules_with_warnings,
)
from bookiebot.reimbursements.projection import ProjectionConflictError, SheetsProjection, _name

SUBSCRIPTION_ONLY_MESSAGE = (
    "No standalone student loan is configured for your budget. Student loans tracked as "
    "subscription autopay stay in Subscriptions; no separate payment was logged."
)


def _key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower()).strip("_")


def configured_student_loan() -> BillSchedule | None:
    # Do not create a schedule sheet or infer an owner from a source-row label.
    get_user_config(get_current_discord_user_id())
    ws = get_sheets_repo().find_bill_schedule_sheet()
    if ws is None:
        return None
    bills, warnings = parse_bill_schedules_with_warnings(ws.get_all_values())
    loans = [bill for bill in bills if RETIRED_BILL_KEYS & {
        _key(bill.bill_key), _key(bill.source_label), _key(bill.display_name),
    }]
    if any(any(_key(value) in RETIRED_BILL_KEYS for value in warning.values) for warning in warnings):
        raise SheetRoutingError("Your student-loan schedule needs correction before its payment can be read or logged.")
    if not loans:
        return None
    if len(loans) != 1 or loans[0].expected_amount is None or _key(loans[0].source_label) not in RETIRED_BILL_KEYS:
        raise SheetRoutingError("Your budget must have one standalone student-loan schedule with an exact source label.")
    # A separate actual row must not duplicate an active autopay subscription.
    # Read the visible owner-scoped source directly; never sync/create schedules.
    try:
        subscription_rows = get_sheets_repo().subscriptions_sheet().get_all_values()
        _subscriptions, sub_warnings = parse_visible_subscription_schedules_with_warnings(subscription_rows)
        # A saved autopay row is still a conflict while its pull day is missing.
        subscriptions = _parse_visible_subscription_schedule_drafts(subscription_rows)
    except Exception as exc:
        if isinstance(exc, SpreadsheetQuotaError):
            raise
        if is_google_sheets_quota_error(exc):
            raise spreadsheet_read_quota_error() from exc
        raise SheetRoutingError("I couldn't verify the loan against your Subscriptions sheet. No payment was changed.") from exc
    aliases = RETIRED_BILL_KEYS | {_key(loans[0].source_label), _key(loans[0].display_name)}
    if any(subscription.active and _key(subscription.name) in aliases for subscription in subscriptions):
        raise SheetRoutingError("This student loan is already tracked as subscription autopay. Resolve the duplicate standalone schedule before logging a separate payment; no payment was changed.")
    if any(_key(value) in aliases for warning in sub_warnings for value in warning.values):
        raise SheetRoutingError("A matching student-loan subscription needs review before a separate payment can be logged. No payment was changed.")
    return loans[0]


def _loan_row(ws: Any, loan: BillSchedule) -> tuple[int, str]:
    matches = [(index, str(row[2]) if len(row) > 2 else "")
               for index, row in enumerate(ws.get_all_values(), start=1)
               if len(row) > 1 and str(row[1]).strip().casefold() == loan.source_label.strip().casefold()]
    if len(matches) != 1:
        raise SheetRoutingError("I need exactly one matching student-loan row in this month's budget. No payment was changed.")
    return matches[0]


def _amount(value: Any, *, allow_empty: bool = False) -> Decimal:
    text = str(value).strip().replace("$", "").replace(",", "")
    if allow_empty and not text:
        return Decimal(0)
    try:
        amount = Decimal(text)
    except InvalidOperation as exc:
        raise SheetRoutingError("The student-loan payment amount is invalid; check the budget row.") from exc
    if not amount.is_finite() or amount < 0 or amount > 1_000_000_000 or amount != amount.quantize(Decimal("0.01")):
        raise SheetRoutingError("Enter a valid student-loan payment amount in dollars and cents.")
    return amount


def student_loan_status() -> dict[str, Any]:
    loan = configured_student_loan()
    if loan is None:
        return {"configured": False, "note": SUBSCRIPTION_ONLY_MESSAGE}
    _row, value = _loan_row(get_sheets_repo().income_sheet(), loan)
    actual = _amount(value, allow_empty=True)
    return {"configured": True, "label": loan.display_name, "amount": float(actual),
            "paid": actual > 0, "expectedAmount": loan.expected_amount, "pullDay": loan.pull_day,
            "note": "Recorded current-month payment; a schedule alone does not confirm a payment."}


def log_standalone_student_loan(amount: Any, *, return_action_id: bool = False):
    value = _amount(amount)
    if value <= 0:
        raise SheetRoutingError("Please specify a positive amount you actually paid for your student loan.")
    # Read quota retries are safe only before an attempted write.
    try:
        loan = configured_student_loan()
        if loan is None:
            raise SheetRoutingError(SUBSCRIPTION_ONLY_MESSAGE)
        ws = get_sheets_repo().income_sheet()
        row, previous = _loan_row(ws, loan)
        # Reuse the established source+amount anchors. Row insertion after this
        # read moves the named target, rather than redirecting an absolute C row.
        book = ws.spreadsheet
        identity = f"{ws.id}:{loan.source_label.strip().casefold()}"
        full, target = _name("loan_source", identity), _name("loan_amount", identity)
        projector = SheetsProjection(None)
        names = projector._ranges(book)
        if full not in names and target not in names:
            book.batch_update({"requests": [
                projector._range_request(full, ws.id, row, 2, 3),
                projector._range_request(target, ws.id, row, 3, 3),
            ]})
        projector._validate_anchors(book, ws.id, full, {"label": 2, "amount": 3}, {"amount": target})
        current = projector._read(book, full)
        if (str(current[0]).strip().casefold() != loan.source_label.strip().casefold()
                or _amount(current[1] if len(current) > 1 else "", allow_empty=True) != _amount(previous, allow_empty=True)):
            raise SheetRoutingError("The student-loan row changed before logging. No payment was changed; check the budget row.")
    except SpreadsheetQuotaError:
        raise
    except ProjectionConflictError as exc:
        raise SheetRoutingError("The student-loan row anchor needs review. No payment was changed.") from exc
    except Exception as exc:
        if is_google_sheets_quota_error(exc):
            raise spreadsheet_read_quota_error() from exc
        raise
    new_value = format(value, ".2f")
    try:
        book.values_batch_update({"valueInputOption": "RAW", "data": [{"range": target, "values": [[float(value)]]}]})
    except Exception as exc:
        raise SheetRoutingError("I couldn't confirm the student-loan write. Check the budget row before retrying.") from exc
    try:
        verified_values = projector._read(book, full)
        verified = (str(verified_values[0]).strip().casefold() == loan.source_label.strip().casefold()
                    and _amount(verified_values[1] if len(verified_values) > 1 else "") == value)
        # Record the current anchored row, including any insertion during write.
        row = projector._ranges(book)[full]["range"]["startRowIndex"] + 1
    except Exception as exc:
        raise SheetRoutingError("The student-loan write was sent, but I couldn't verify it. Check the budget row before retrying.") from exc
    if not verified:
        raise SheetRoutingError("The student-loan write was sent, but its row changed before verification. Check the budget before retrying.")
    action_id = record_undo_action(get_current_discord_user_id(), UndoAction(
        worksheet="income", kind="restore_cells", row=row, columns=[3],
        previous_values=[previous], new_values=[new_value],
        metadata={"type": "payment", "category": loan.source_label, "exact_source_label": loan.source_label},
        description=f"{loan.display_name} payment ${new_value}",
    ))
    return (True, action_id) if return_action_id else True
