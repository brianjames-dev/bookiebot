"""Planning-only bill estimates from verified personal monthly source amounts."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Iterable

from bookiebot.sheets.bills import bill_label_key, bill_source_amount, list_bill_schedules


@dataclass(frozen=True)
class BillPrediction:
    amount_cents: int
    source: str
    samples: tuple[tuple[str, int], ...] = ()

    def public(self) -> dict[str, Any]:
        value: dict[str, Any] = {"amountCents": self.amount_cents, "source": self.source,
                                 "sampleCount": len(self.samples), "basis": "personal_bill_amount"}
        if self.samples:
            value.update(firstMonth=self.samples[0][0], lastMonth=self.samples[-1][0])
        return value


def predict_bill(source_label: str, history: Iterable[tuple[str, list[list[str]]]],
                 period: str, *, as_of: date, override_cents: int | None = None,
                 amount_column: int | None = None) -> BillPrediction | None:
    """Average positive entered amounts in available, completed prior months.

    Read original budget sources, never another prediction or a projected
    total. A zero can mean no charge or fully reimbursed exposure, so it is
    not evidence of a typical bill price. Duplicate periods/sources and sheet
    errors cannot silently influence the average. No values are persisted.
    """
    if override_cents is not None and override_cents > 0:
        return BillPrediction(override_cents, "configured")
    cutoff = min(period, as_of.strftime("%Y-%m"))
    periods: dict[str, list[list[list[str]]]] = {}
    for month, rows in history:
        if month < cutoff:
            periods.setdefault(month, []).append(rows)
    samples = []
    for month, candidates in sorted(periods.items()):
        if len(candidates) != 1:
            continue
        amount = bill_source_amount(candidates[0], source_label, amount_column=amount_column)
        if amount is not None and amount > 0:
            samples.append((month, int((Decimal(str(amount)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))))
    if not samples:
        return None
    mean = int((Decimal(sum(cents for _, cents in samples)) / len(samples)).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    return BillPrediction(mean, "history", tuple(samples))


def scheduled_predictions(schedule: list[list[str]], history: list[tuple[str, list[list[str]]]],
                          period: str, *, as_of: date) -> dict[str, BillPrediction]:
    bills = list_bill_schedules(schedule, period=period)
    result = {}
    for bill in bills:
        key = bill_label_key(bill.source_label)
        if (not bill.active or bill.bill_type != "variable"
                or sum(bill_label_key(other.source_label) == key for other in bills) != 1):
            continue
        value = predict_bill(bill.source_label, history, period, as_of=as_of,
            override_cents=round(bill.expected_amount * 100) if bill.expected_amount is not None else None,
            amount_column=4 if bill.category == "subscriptions_wants" else None)
        if value is not None:
            result[key] = value
    return result
