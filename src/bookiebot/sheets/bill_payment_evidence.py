"""Read-only evidence that a shared bill was paid before its usual pull date."""
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
    """Use actual confirmed settlement, never a pending report or debt reset.

    The original bill date owns the occurrence. A later recurring schedule
    cannot hide it after the partner's whole share has already been repaid.
    Match exact normalized labels; ambiguous evidence stays unavailable.
    """
    candidates: dict[tuple[str, str], set[tuple[str, date]]] = {}
    for value in allocations:
        if (owner not in {value.get('payerOwner'), value.get('partnerOwner')}
                or value.get('sourceWorksheet') != 'income'
                or value.get('lifecycle', 'active') != 'active'
                or value.get('clearedCents', 0) or value.get('partnerShareCents', 0) <= 0
                or value.get('settledCents', 0) < value['partnerShareCents']):
            continue
        paid_on = parsed_date(value['expenseDate'])
        title = value['sourceSheetTitle']
        if (paid_on is None or paid_on > as_of or title not in calendar.month_name
                or not title or paid_on.year != value['sourceYear']
                or paid_on.month != list(calendar.month_name).index(title)):
            continue
        received = sum(event['amountCents'] for event in events
                       if event['allocationId'] == value['id'] and event['status'] == 'confirmed'
                       and (when := parsed_date(event['date'])) is not None and when <= as_of)
        if received < value['partnerShareCents']:
            continue
        labels = ({value.get('sourceValues', {}).get('item'), value.get('item'), value['category']}
                  if value['payerOwner'] == owner else {value.get('partnerSourceLabel') or value['category']})
        for label in labels:
            if key := bill_label_key(str(label or '')):
                candidates.setdefault((paid_on.strftime('%Y-%m'), key), set()).add((value['id'], paid_on))
    return {key: next(iter(values))[1] for key, values in candidates.items() if len(values) == 1}
