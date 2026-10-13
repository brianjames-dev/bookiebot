"""Sheet-configured payroll savings, with ESPP kept outside spendable cash."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import re
from typing import Any, Iterable


PLAN_LABELS = (
    "ESPP Income Source", "ESPP Rate", "ESPP First Paycheck Date",
    "ESPP Cash Ideal Rate", "ESPP Cash Minimum Rate", "ESPP Last Paycheck Date",
)
PAYROLL_SUFFIXES = ("income", "paycheck", "payroll", "salary", "wages")
CENT = Decimal("0.01")
SETTINGS_TAB = "ESPP Settings"
SETTINGS_HEADERS = ("First eligible paycheck", "Last eligible paycheck", "Payroll source", "ESPP rate")
ESPP_LABEL = "SpaceX ESPP this month"


def normalized_source(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def matches_payroll(label: str, source: str) -> bool:
    normalized = normalized_source(source)
    return bool(normalized) and normalized_source(label) in {
        normalized, *(f"{normalized} {suffix}" for suffix in PAYROLL_SUFFIXES),
    }


def money(value: Any) -> Decimal:
    try:
        result = Decimal(str(value).replace("$", "").replace(",", "").strip())
        return result.quantize(CENT, rounding=ROUND_HALF_UP) if result.is_finite() else Decimal(0)
    except (InvalidOperation, ValueError):
        return Decimal(0)


def parse_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    for pattern in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(str(value).strip(), pattern).date()
        except ValueError:
            pass
    return None


def _rate(value: Any) -> Decimal | None:
    try:
        text = str(value).strip()
        rate = Decimal(text.rstrip("%")) / (100 if text.endswith("%") else 1)
        return rate if rate.is_finite() and 0 <= rate < 1 else None
    except InvalidOperation:
        return None


@dataclass(frozen=True)
class SavingsPlan:
    present: bool = False
    source: str = ""
    rate: Decimal = Decimal(0)
    first_paycheck: date | None = None
    last_paycheck: date | None = None
    cash_ideal_rate: Decimal = Decimal("0.15")
    cash_minimum_rate: Decimal = Decimal("0.075")
    status: str = "off"
    periods: tuple[SavingsPlan, ...] = ()

    def for_paycheck(self, label: str, received: date | None) -> SavingsPlan | None:
        if self.periods:
            if self.status != "active" or not received:
                return None
            # A new dated row supersedes the earlier version from that date onward.
            applicable = [plan for plan in self.periods if plan.first_paycheck and plan.first_paycheck <= received]
            plan = applicable[-1] if applicable else None
            return plan if plan and plan.includes(label, received) else None
        return self if self.includes(label, received) else None

    def matches_source(self, label: str) -> bool:
        return any(matches_payroll(label, plan.source) for plan in self.periods or (self,))

    def includes(self, label: str, received: date | None) -> bool:
        return bool(self.status == "active" and received and self.first_paycheck
                    and received >= self.first_paycheck
                    and (self.last_paycheck is None or received <= self.last_paycheck)
                    and matches_payroll(label, self.source))

    def payload(self) -> dict[str, Any]:
        return {"status": self.status, "source": self.source, "rate": float(self.rate),
                "firstPaycheckDate": self.first_paycheck.isoformat() if self.first_paycheck else None,
                "lastPaycheckDate": self.last_paycheck.isoformat() if self.last_paycheck else None,
                "cashIdealRate": float(self.cash_ideal_rate), "cashMinimumRate": float(self.cash_minimum_rate),
                "otherCashIdealRate": .2, "otherCashMinimumRate": .1}


def inline_enrollment_rows(rows: list[list[Any]]) -> list[list[Any]] | None:
    for index, row in enumerate(rows):
        for column in range(max(0, len(row) - 3)):
            if tuple(row[column:column + 4]) == SETTINGS_HEADERS:
                end = next((i for i in range(index + 1, len(rows))
                            if normalized_source(rows[i][column] if len(rows[i]) > column else "") == "date"), len(rows))
                return [r[column:column + 4] for r in rows[index:end]]
    return None


def read_savings_plan(rows: list[list[Any]], settings_rows: list[list[Any]] | None = None,
                      *, as_of: date | None = None) -> SavingsPlan:
    # Monthly snapshots win over the transitional separate-tab layout and old
    # labels, which also contain the four-column header's "ESPP Rate" label.
    inline = inline_enrollment_rows(rows)
    if inline is not None:
        return read_enrollment_settings(inline, as_of=as_of)
    values: dict[str, Any] = {}
    labels = {normalized_source(label): label for label in PLAN_LABELS}
    for row_index, row in enumerate(rows):
        horizontal = sum(normalized_source(cell) in labels for cell in row) > 1
        for column, cell in enumerate(row):
            key = labels.get(normalized_source(cell))
            if key:
                source = rows[row_index + 1] if horizontal and row_index + 1 < len(rows) else row
                index = column if horizontal else column + 1
                values[key] = source[index] if index < len(source) else ""
    if not values:
        if any(str(cell).startswith(ESPP_LABEL) for row in rows for cell in row):
            return read_enrollment_settings(settings_rows, as_of=as_of)
        return SavingsPlan()
    rate = _rate(values.get("ESPP Rate", "0"))
    ideal = _rate(values.get("ESPP Cash Ideal Rate", ".15"))
    minimum = _rate(values.get("ESPP Cash Minimum Rate", ".075"))
    first_text = values.get("ESPP First Paycheck Date", "")
    first = parse_date(first_text)
    last_text = values.get("ESPP Last Paycheck Date", "")
    last = parse_date(last_text)
    source = str(values.get("ESPP Income Source", "")).strip()
    invalid = (rate is None or ideal is None or minimum is None
               or bool(first_text and first is None)
               or bool(last_text and last is None)
               or bool(first and last and last < first)
               or bool(rate and ideal is not None and rate + ideal != Decimal(".2"))
               or bool(ideal is not None and minimum is not None and minimum > ideal))
    status = "invalid" if invalid else "off" if not rate else "pending" if not first or not source else "active"
    return SavingsPlan(True, source, rate or Decimal(0), first, last,
                       ideal if ideal is not None else Decimal(".15"),
                       minimum if minimum is not None else Decimal(".075"), status)


def read_enrollment_settings(rows: list[list[Any]] | None, *, as_of: date | None = None) -> SavingsPlan:
    if not rows or tuple(rows[0][:4]) != SETTINGS_HEADERS:
        return SavingsPlan(present=True, status="invalid")
    periods = []
    for row in rows[1:]:
        if not any(str(value).strip() for value in row[:4]):
            continue
        first_raw, last_raw, source, rate_raw = (list(row[:4]) + [""] * 4)[:4]
        first, last, rate = parse_date(first_raw), parse_date(last_raw), _rate(rate_raw)
        if (not first or not str(source).strip() or rate is None or rate > Decimal(".2")
                or bool(last_raw and not last) or bool(last and last < first)):
            return SavingsPlan(present=True, status="invalid")
        ideal = Decimal(".2") - rate
        periods.append(SavingsPlan(True, str(source).strip(), rate, first, last, ideal, ideal / 2,
                                   "active" if rate else "off"))
    periods.sort(key=lambda plan: plan.first_paycheck or date.min)
    if len({plan.first_paycheck for plan in periods}) != len(periods):
        return SavingsPlan(present=True, status="invalid")
    if not periods:
        return SavingsPlan(present=True, status="invalid")
    applicable = [plan for plan in periods if not as_of or (plan.first_paycheck and plan.first_paycheck <= as_of)]
    selected = applicable[-1] if applicable else periods[0]
    return SavingsPlan(True, selected.source, selected.rate, periods[0].first_paycheck,
                       selected.last_paycheck, selected.cash_ideal_rate, selected.cash_minimum_rate,
                       "active", tuple(periods))


def calculate_savings(
    plan: SavingsPlan, income_total: float, entries: Iterable[tuple[str, float, Any]],
    period_start: date, period_end: date,
) -> dict[str, Any]:
    """Round each payroll deduction to cents; conserve deposited cash exactly."""
    deposited = money(income_total)
    eligible = Decimal(0)
    espp = Decimal(0)
    enrolled_ideal = enrolled_minimum = Decimal(0)
    undated = 0
    for label, amount, raw_date in entries:
        received = parse_date(raw_date)
        value = money(amount)
        if value <= 0:
            continue
        if not received and plan.status == "active" and plan.matches_source(label):
            undated += 1
        enrolled = plan.for_paycheck(label, received)
        if received and period_start <= received <= period_end and enrolled:
            eligible += value
            deduction = (value * enrolled.rate / (1 - enrolled.rate)).quantize(CENT, rounding=ROUND_HALF_UP)
            espp += deduction
            enrolled_ideal += (value + deduction) * enrolled.cash_ideal_rate
            enrolled_minimum += (value + deduction) * enrolled.cash_minimum_rate
    warnings = []
    if plan.status in {"invalid", "pending"}:
        warnings.append("Check ESPP enrollment settings before relying on savings targets.")
    if undated:
        warnings.append(f"{undated} payroll entries need dates before ESPP can be calculated.")
    if eligible > deposited:
        warnings.append("Income total is smaller than eligible paycheck entries; check the sheet total.")
        eligible = espp = enrolled_ideal = enrolled_minimum = Decimal(0)
    other = deposited - eligible
    base = deposited + espp
    ideal = (enrolled_ideal + other * Decimal(".2")).quantize(CENT, rounding=ROUND_HALF_UP)
    minimum = (enrolled_minimum + other * Decimal(".1")).quantize(CENT, rounding=ROUND_HALF_UP)
    needs = (base * Decimal(".5")).quantize(CENT, rounding=ROUND_HALF_UP)
    wants = deposited - needs - ideal
    return {"depositedIncome": float(deposited), "eligibleDeposits": float(eligible),
            "otherIncome": float(other), "takeHomeBeforeEspp": float(base),
            "esppContribution": float(espp), "cashIdeal": float(ideal), "cashMinimum": float(minimum),
            "categoryBudgets": {"needs": float(needs), "wants": float(wants), "savings": float(ideal)},
            "warnings": warnings, "source": "Calculated from payroll"}
