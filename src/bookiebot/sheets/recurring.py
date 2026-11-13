"""Effective-dated bill plans stored in the existing hidden schedule tabs.

This module is pure: inspection and period selection never provision a sheet or
change a payment. Original schedule columns retain their meanings.
"""
from __future__ import annotations

import calendar
from dataclasses import asdict, dataclass, replace
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import hashlib
import json
import re
from typing import Any

BILL_TAB = "_BookieBot Bill Schedule"
SUBSCRIPTION_TAB = "_BookieBot Subscription Schedule"
SETTINGS_LOG_TAB = "_BookieBot Bill Settings Log"
VERSION_HEADERS = (
    "plan_id", "effective_from", "effective_until", "active", "bill_type",
    "category", "split_method", "payer_basis_points", "version", "request_id", "monthly_source", "split_starts_on",
)
FIRST_MONTH, LAST_MONTH = "0001-01", "9999-12"
CATEGORIES = {"rent", "bills_utilities", "static_bills_subscriptions_needs", "subscriptions_wants"}
VIRTUAL_SUBSCRIPTION_CATEGORIES = {"static_bills_subscriptions_needs", "subscriptions_wants"}
KINDS = {"subscription", "variable", "fixed"}
CADENCES = {"monthly", "quarterly", "yearly"}
SPLITS = {"none", "income", "equal", "fronted", "custom"}


class BillValidation(ValueError):
    pass


class BillConflict(ValueError):
    pass


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def month_key(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", value) or value[:4] == "0000":
        raise BillValidation("Choose a valid starting month.")
    return value


def money_cents(value: Any, *, optional: bool = False) -> int | None:
    if optional and value in (None, ""):
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise BillValidation("Enter an amount in dollars and cents.")
    text = str(value).strip().replace("$", "").replace(",", "")
    if not re.fullmatch(r"\d{1,9}(?:\.\d{1,2})?", text):
        raise BillValidation("Enter a nonnegative amount with up to two decimal places.")
    try:
        amount = Decimal(text)
    except InvalidOperation as exc:
        raise BillValidation("Enter an amount in dollars and cents.") from exc
    return int(amount * 100)


def text(value: Any, label: str, *, maximum: int = 100, required: bool = False) -> str:
    if not isinstance(value, str) or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise BillValidation(f"Enter a valid {label.lower()}.")
    result = value.strip()
    if required and not result:
        raise BillValidation(f"Enter a {label.lower()}.")
    return result


def boolean(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if str(value).strip().casefold() in {"true", "yes", "1"}:
        return True
    if str(value).strip().casefold() in {"false", "no", "0"}:
        return False
    raise BillConflict("A saved bill has an invalid active status. Check its schedule.")


@dataclass(frozen=True)
class BillPlan:
    id: str
    kind: str
    name: str
    amount_cents: int | None
    cadence: str
    pull_day: int
    pull_months: tuple[int, ...]
    category: str
    account: str
    source_label: str
    source_tab: str
    source_range: str = ""
    effective_from: str = FIRST_MONTH
    effective_until: str = LAST_MONTH
    active: bool = True
    split_method: str = "none"
    payer_basis_points: int = 10000
    version: str = ""
    request_id: str = ""
    monthly_source: bool = False
    split_starts_on: str = "0001-01-01"

    def public(self, period: str, *, as_of: date | None = None) -> dict[str, Any]:
        start = date.fromisoformat(month_key(period) + "-01")
        if as_of is not None and as_of.strftime("%Y-%m") == period:
            start = max(start, as_of)
        next_date = self.next_date(start)
        return {"id": self.id, "type": self.kind, "name": self.name,
                "amountCents": self.amount_cents, "cadence": self.cadence,
                "pullDay": self.pull_day or None, "pullMonths": list(self.pull_months),
                "category": self.category, "account": self.account, "active": self.active,
                "effectiveFrom": self.effective_from, "effectiveUntil": self.effective_until,
                "splitMethod": self.split_method, "payerBasisPoints": self.payer_basis_points,
                "version": self.version, "nextDate": next_date.isoformat() if next_date else None,
                "needsSetup": not self.pull_day or (self.kind != "variable" and not self.amount_cents)
                    or self.cadence == "yearly" and len(self.pull_months) != 1
                    or self.cadence == "quarterly" and len(self.pull_months) != 4}

    def due_date(self, period: str) -> date | None:
        period = month_key(period)
        if not self.active or not self.effective_from <= period < self.effective_until or not 1 <= self.pull_day <= 31:
            return None
        year, month = map(int, period.split("-"))
        if self.cadence != "monthly" and month not in self.pull_months:
            return None
        return date(year, month, min(self.pull_day, calendar.monthrange(year, month)[1]))

    def next_date(self, start: date) -> date | None:
        if not self.active or not 1 <= self.pull_day <= 31:
            return None
        start = max(start, date.fromisoformat(self.effective_from + "-01"))
        for offset in range(25):
            number = start.year * 12 + start.month - 1 + offset
            year, zero_month = divmod(number, 12)
            if year > 9999:
                return None
            candidate = self.due_date(f"{year:04d}-{zero_month + 1:02d}")
            if candidate is not None and candidate >= start:
                return candidate
        return None


def normalize_plan(body: dict[str, Any], *, current: BillPlan | None, today: date,
                   plan_id: str) -> BillPlan:
    """Validate UI intent; identity/source authority always comes from the server."""
    allowed = {"name", "type", "amount", "cadence", "pullDay", "pullMonths", "category",
               "account", "effectiveFrom", "splitMethod", "payerBasisPoints"}
    if not isinstance(body, dict) or set(body) - allowed:
        raise BillValidation("Invalid bill settings.")
    kind, cadence = body.get("type"), body.get("cadence")
    if not isinstance(kind, str) or not isinstance(cadence, str) or kind not in KINDS or cadence not in CADENCES:
        raise BillValidation("Choose a bill type and billing frequency.")
    if kind == "subscription" and cadence == "quarterly":
        raise BillValidation("Subscriptions can repeat monthly or yearly.")
    name = text(body.get("name"), "bill name", required=True)
    account = text(body.get("account", ""), "account", maximum=80)
    amount = money_cents(body.get("amount"), optional=kind == "variable")
    if kind != "variable" and not amount:
        raise BillValidation("Enter the recurring amount.")
    day = body.get("pullDay")
    if isinstance(day, bool) or not isinstance(day, int) or not 1 <= day <= 31:
        raise BillValidation("Choose a payment day from 1 to 31.")
    months = body.get("pullMonths", [])
    if (not isinstance(months, list) or any(isinstance(m, bool) or not isinstance(m, int) or not 1 <= m <= 12 for m in months)
            or len(set(months)) != len(months)):
        raise BillValidation("Choose the billing months.")
    if cadence == "yearly" and len(months) != 1 or cadence == "quarterly" and len(months) != 4:
        raise BillValidation("Choose one month for yearly bills or four months for quarterly bills.")
    if cadence == "quarterly" and any((sorted(months)[(i + 1) % 4] - sorted(months)[i]) % 12 != 3 for i in range(4)):
        raise BillValidation("Quarterly billing months must be three months apart.")
    months = [] if cadence == "monthly" else sorted(months)
    category = body.get("category")
    if not isinstance(category, str) or category not in CATEGORIES:
        raise BillValidation("Choose a Needs or Wants category.")
    if kind != "subscription" and category == "subscriptions_wants":
        raise BillValidation("Variable and fixed bills belong to Needs.")
    effective = month_key(body.get("effectiveFrom"))
    if effective >= LAST_MONTH:
        raise BillValidation("Choose an earlier starting month.")
    if effective < today.strftime("%Y-%m"):
        raise BillValidation("Choose this month or a later month. Earlier months stay unchanged.")
    method, basis = body.get("splitMethod", "none"), body.get("payerBasisPoints", 5000)
    if not isinstance(method, str) or method not in SPLITS or isinstance(basis, bool) or not isinstance(basis, int) or not 0 <= basis <= 10000:
        raise BillValidation("Choose a valid split.")
    basis = 5000 if method == "equal" else 0 if method == "fronted" else 10000 if method == "none" else basis
    result = BillPlan(plan_id, kind, name, amount, cadence, day, tuple(months), category, account,
                    current.source_label if current else name,
                    current.source_tab if current else SUBSCRIPTION_TAB if kind == "subscription" else BILL_TAB,
                    current.source_range if current else "", effective, LAST_MONTH, True, method, basis)
    return replace(result, monthly_source=bool(current and current.monthly_source) or
                   result.source_tab == BILL_TAB or kind != "subscription" or method != "none"
                   or category not in VIRTUAL_SUBSCRIPTION_CATEGORIES)


def versioned(plans: list[BillPlan], replacement: BillPlan, request_id: str) -> list[BillPlan]:
    """Replace this plan from the chosen month onward, keeping earlier values."""
    start = replacement.effective_from
    result = []
    for plan in plans:
        if plan.id != replacement.id:
            result.append(plan)
        elif plan.effective_from < start:
            result.append(replace(plan, effective_until=min(plan.effective_until, start)))
    replacement = replace(replacement, effective_until=LAST_MONTH, request_id=request_id)
    replacement = replace(replacement, version=fingerprint(asdict(replacement)))
    return [*result, replacement]


def selected(plans: list[BillPlan], period: str, *, include_inactive: bool = False) -> list[BillPlan]:
    period = month_key(period)
    found: dict[str, BillPlan] = {}
    for plan in plans:
        if plan.effective_from <= period < plan.effective_until:
            if plan.id in found:
                raise BillConflict("A bill has overlapping versions. Check its schedule before making changes.")
            found[plan.id] = plan
    return sorted((p for p in found.values() if p.active or include_inactive), key=lambda p: (p.kind, p.name.casefold(), p.id))


def split_cents(plan: BillPlan, gross: int, *, income_basis_points: int) -> tuple[int, int]:
    """Schedule preview; actual postings use the existing canonical split writer."""
    if isinstance(gross, bool) or not isinstance(gross, int) or gross < 0:
        raise BillValidation("Enter a valid payment amount.")
    basis = (income_basis_points if plan.split_method == "income" else 10000 if plan.split_method == "none"
             else 5000 if plan.split_method == "equal" else 0 if plan.split_method == "fronted" else plan.payer_basis_points)
    if not 0 <= basis <= 10000:
        raise BillConflict("Income shares are unavailable. Refresh before reviewing this payment.")
    payer = int((Decimal(gross) * basis / 10000).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    return payer, gross - payer
