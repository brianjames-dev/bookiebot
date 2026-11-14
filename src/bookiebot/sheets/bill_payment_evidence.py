"""Read-only dates for actual recipient repayments, separate from autopay."""
from __future__ import annotations

import calendar
from datetime import date, datetime
from typing import Any

from bookiebot.sheets.bills import bill_label_key

BillDates = dict[tuple[str, str], date]


def parsed_date(value: str) -> date | None:
    try:
        return datetime.fromisoformat(value).date()
    except ValueError:
        return None


def settled_bill_dates(allocations: list[dict[str, Any]], events: list[dict[str, Any]],
                       *, owner: str, as_of: date) -> BillDates:
    """Retain the recipient's confirmed cash without paying the payer's bill.

    A utility invoice can be split and reimbursed before its withdrawal. Only
    the recipient's real repayment belongs on a receipt date; the payer still
    uses the saved autopay date. Match partial cash to confirmed receipts too;
    a debt reset cannot erase real cash or create a new payment date.
    """
    candidates: dict[tuple[str, str], set[tuple[str, date]]] = {}
    for value in allocations:
        if (owner != value.get('partnerOwner')
                or value.get('sourceWorksheet') != 'income'
                or value.get('lifecycle', 'active') != 'active'
                or value.get('partnerShareCents', 0) <= 0 or value.get('settledCents', 0) <= 0):
            continue
        paid_on = parsed_date(value['expenseDate'])
        title = value['sourceSheetTitle']
        if (paid_on is None or paid_on > as_of or title not in calendar.month_name
                or not title or paid_on.year != value['sourceYear']
                or paid_on.month != list(calendar.month_name).index(title)):
            continue
        receipts = [(event['amountCents'], when) for event in events
                    if event['allocationId'] == value['id'] and event['status'] == 'confirmed'
                    and (when := parsed_date(event['date'])) is not None and when <= as_of]
        received = sum(amount for amount, _ in receipts)
        if received != value['settledCents']:
            continue
        paid_on = max(when for _, when in receipts)
        # A monthly source cannot be moved to another month by an inferred date.
        if paid_on.strftime('%Y-%m') != f"{value['sourceYear']:04d}-{list(calendar.month_name).index(title):02d}":
            continue
        labels = {value.get('partnerSourceLabel') or value['category']}
        for label in labels:
            if key := bill_label_key(str(label or '')):
                candidates.setdefault((paid_on.strftime('%Y-%m'), key), set()).add((value['id'], paid_on))
    return {key: next(iter(values))[1] for key, values in candidates.items() if len(values) == 1}
