"""Explain canonical totals and compare only verifiably dated report activity."""
from __future__ import annotations

import calendar
from datetime import datetime
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from bookiebot.reports.expense_breakdown import ExpenseBreakdownReport


def _money(value: Any) -> float:
    return round(float(value or 0), 2)


def _total(values) -> float:
    return round(sum(float(value or 0) for value in values), 2)


def _date(value: str, year: int, month: int) -> str | None:
    for format in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(value.strip(), format).date()
            return parsed.isoformat() if (parsed.year, parsed.month) == (year, month) else None
        except ValueError:
            continue
    return None


def comparison_data(report: ExpenseBreakdownReport, payload: dict[str, Any]) -> dict[str, Any]:
    """Never use a scheduled bill date or synthetic undated-income day as fact."""
    from bookiebot.reports.expense_breakdown import CATEGORY_LABELS

    def entry(label: str, amount: float, category: str, raw_date: str) -> dict[str, Any]:
        return {"label": label, "amount": _money(amount), "category": category,
                "date": _date(raw_date, report.month.year, report.month.month)}

    recorded = [entry(item.item or item.location or CATEGORY_LABELS.get(item.category, item.category),
                      item.amount, item.category, item.date) for item in report.entries]
    if not any(item.category == "need_expenses" for item in report.entries):
        recorded.extend(entry(item.label, item.amount, item.group, item.date) for item in report.need_expenses)
    recorded.extend(entry(item.label, item.amount, item.group, item.date) for item in report.payments)
    income = [entry(item.label, item.amount, "income", item.date) for item in report.income_entries]
    scheduled = [
        entry(item.label, item.amount, item.group, f"{report.month.year}-{report.month.month:02d}-{item.day:02d}")
        for item in report.calendar_events if item.kind == "subscription" and not item.projected_only
    ]
    return {
        "recordedExpenses": recorded,
        "scheduledExpenses": scheduled,
        "recordedIncome": income,
        "unitemizedExpenses": _money(payload["modeViews"]["current"]["metrics"]["totalExpenses"]
                                      - _total(item["amount"] for item in recorded)
                                      - _total(item["amount"] for item in scheduled)),
        "unitemizedIncome": _money(report.income_total - _total(item["amount"] for item in income)),
    }


def metric_explanations(report: ExpenseBreakdownReport, payload: dict[str, Any]) -> dict[str, Any]:
    explanations = {}
    for mode in ("current", "projected"):
        view = payload["modeViews"][mode]
        metrics = view["metrics"]
        incomes = [
            {"label": item.label, "amount": _money(item.amount), "source": "recorded",
             "date": _date(item.date, report.month.year, report.month.month)}
            for item in report.income_entries
        ]
        income_remainder = _money(report.income_total - _total(item["amount"] for item in incomes))
        if income_remainder:
            incomes.append({"label": "Other recorded income from the sheet", "amount": income_remainder,
                            "source": "sheet", "date": None})
        projected_remainder = _money(metrics["monthlyIncome"] - report.income_total)
        if projected_remainder:
            expected = [{"label": item.label, "amount": _money(item.amount), "source": "scheduled",
                         "date": _date(f"{report.month.year}-{report.month.month:02d}-{item.day:02d}", report.month.year, report.month.month)}
                        for item in report.calendar_events if item.kind == "income" and item.projected_only]
            if expected and _total(item["amount"] for item in expected) == projected_remainder:
                incomes.extend(expected)
            else:
                incomes.append({"label": "Expected income still to arrive", "amount": projected_remainder,
                                "source": "scheduled", "date": None})

        current_amounts = {item["key"]: _money(item["amount"]) for item in payload["modeViews"]["current"]["breakdown"]}
        spent = []
        for item in view["breakdown"]:
            amount = _money(item["amount"])
            if "subscriptions" in item["key"]:
                spent.append({"label": item["label"], "amount": amount, "source": "scheduled", "date": None})
                continue
            extra = max(_money(amount - current_amounts.get(item["key"], 0)), 0) if mode == "projected" else 0
            if amount - extra:
                spent.append({"label": item["label"], "amount": _money(amount - extra), "source": "sheet", "date": None})
            if extra:
                spent.append({"label": f"{item['label']} · expected remainder", "amount": extra, "source": "scheduled", "date": None})
        spending_remainder = _money(metrics["totalExpenses"] - _total(item["amount"] for item in spent))
        if spending_remainder:
            spent.append({"label": "Other sheet outflows", "amount": spending_remainder, "source": "sheet", "date": None})

        balances = view["categoryBalances"]
        left = [{"label": f"{category.title()} remaining", "amount": _money(balances["remaining"][category]),
                 "source": "sheet", "date": None} for category in ("needs", "wants", "savings")]
        saved = [{"label": f"Savings contribution {item.number}", "amount": _money(item.actual),
                  "source": "recorded", "date": None} for item in report.savings_deposits if item.actual]
        saved_remainder = _money(metrics["amountSaved"] - _total(item["amount"] for item in saved))
        if saved_remainder:
            saved.append({"label": "Other saved amount from the sheet", "amount": saved_remainder,
                          "source": "sheet", "date": None})
        left_notes = [
            "Remaining category funds already account for recorded savings contributions.",
            "Projected category budgets use 50% Needs, 30% Wants and 20% Savings of projected income."
            if mode == "projected" else "Current category budgets come from the selected month's sheet settings.",
        ]
        for category in ("needs", "wants", "savings"):
            left_notes.append(
                f"{category.title()}: ${view['categoryBudgets'][category]:,.2f} allocated − "
                f"${view['categorySpending'][category]:,.2f} used = ${balances['raw'][category]:,.2f} before coverage."
            )
        left_notes.extend(f"${transfer['amount']:,.2f} of {transfer['from'].title()} covers {transfer['to'].title()} overspending."
                          for transfer in balances["transfers"])

        def detail(title: str, value: float, equation: str, components: list, notes: list[str]):
            # Explain the exact displayed total, including legacy sheet fallbacks.
            difference = _money(value - _total(item["amount"] for item in components))
            if difference:
                components = [*components, {"label": "Sheet rounding adjustment" if abs(difference) <= .01 else "Additional balance from the sheet", "amount": difference,
                                             "source": "sheet", "date": None}]
            return {"title": title, "value": _money(value), "equation": equation,
                    "components": components, "notes": notes}

        explanations[mode] = {
            "income": detail("Income", metrics["monthlyIncome"],
                "Recorded income + expected income still to arrive" if mode == "projected" else "Sum of recorded income",
                incomes, [payload["incomeProjectionSettings"]["description"],
                          "Expected income is an estimate; it is not a received deposit." if projected_remainder else "Only received income contributes to this total."]),
            "spent": detail("Spent", metrics["totalExpenses"], "Sum of expense categories", spent, [
                "Savings contributions are shown separately in Saved.",
                "Subscription amounts are based on their schedule, not confirmation from your bank.",
                "Projected includes full scheduled commitments for the month." if mode == "projected" else "Current includes recorded costs and subscription schedules elapsed so far.",
            ]),
            "left": detail("Left", metrics["incomeAfterExpenses"], "Needs remaining + Wants remaining + Savings remaining", left, left_notes),
            "saved": detail("Saved", metrics["amountSaved"], "Sum of recorded savings contributions", saved, [
                "This is the selected month's saved amount, not a bank-account balance.",
                f"Minimum target: ${metrics['savingsMinimum']:,.2f}. Ideal target: ${metrics['savingsIdeal']:,.2f}.",
                "Projected adjusts the targets with projected income; it does not invent future savings deposits.",
            ]),
        }
    return explanations


def compare_report_periods(
    selected: dict[str, Any], baseline: dict[str, Any] | None, *, baseline_month: str,
    baseline_kind: str, as_of: datetime,
) -> dict[str, Any]:
    from bookiebot.sheets.routing import PACIFIC_TZ
    as_of = as_of.replace(tzinfo=PACIFIC_TZ) if as_of.tzinfo is None else as_of.astimezone(PACIFIC_TZ)
    selected_month = f"{selected['year']:04d}-{selected['month']:02d}"
    requested_day = (as_of.day if (selected["year"], selected["month"]) == (as_of.year, as_of.month)
                     else calendar.monthrange(selected["year"], selected["month"])[1])
    base_year, base_number = map(int, baseline_month.split("-"))
    through_day = min(requested_day, calendar.monthrange(base_year, base_number)[1])
    result: dict[str, Any] = {
        "selectedMonth": selected_month, "baselineMonth": baseline_month, "baselineKind": baseline_kind,
        "throughDay": through_day, "shortMonthAdjusted": through_day != requested_day,
        "selected": None, "baseline": None, "changeAmount": None, "changePercent": None,
        "status": "unavailable", "coverageNote": "The comparison month is unavailable.",
    }
    if not selected.get("comparisonData"):
        result["coverageNote"] = "Refresh this report to load dated comparison data."
        return result
    result["selected"] = _period(selected, through_day)
    if baseline is None or not baseline.get("comparisonData"):
        return result
    if selected.get("ownerName") != baseline.get("ownerName"):
        raise ValueError("Comparison reports must belong to the same owner.")
    if f"{baseline['year']:04d}-{baseline['month']:02d}" != baseline_month:
        raise ValueError("Comparison report month did not match the requested period.")
    result["baseline"] = _period(baseline, through_day)
    result["changeAmount"] = _money(result["selected"]["datedSpending"] - result["baseline"]["datedSpending"])
    if result["baseline"]["datedSpending"] > 0:
        result["changePercent"] = round(result["changeAmount"] / result["baseline"]["datedSpending"] * 100, 1)
    partial = not result["selected"]["complete"] or not result["baseline"]["complete"]
    result["status"] = "partial" if partial else "complete"
    result["coverageNote"] = (
        "Compares dated recorded expenses only. Undated costs, sheet adjustments and scheduled subscriptions are excluded."
        if partial else "Compares recorded spending over matching days in each month."
    )
    if result["shortMonthAdjusted"]:
        result["coverageNote"] += f" Both periods end on day {through_day} because the comparison month is shorter."
    return result


def _period(payload: dict[str, Any], through_day: int) -> dict[str, Any]:
    data = payload["comparisonData"]
    month = f"{payload['year']:04d}-{payload['month']:02d}"
    def included(item):
        value = item.get("date")
        return bool(value and value.startswith(month + "-") and int(value[-2:]) <= through_day)
    expenses = data["recordedExpenses"]
    income = data["recordedIncome"]
    undated_count = sum(1 for item in expenses if not item.get("date") and item["amount"])
    scheduled_count = sum(1 for item in data["scheduledExpenses"] if included(item) and item["amount"])
    undated_expenses = _total(item["amount"] for item in expenses if not item.get("date"))
    undated_income = _total(item["amount"] for item in income if not item.get("date"))
    scheduled = _total(item["amount"] for item in data["scheduledExpenses"] if included(item))
    adjustment = _money(data["unitemizedExpenses"])
    return {
        "fromDate": f"{month}-01", "throughDate": f"{month}-{through_day:02d}",
        "datedSpending": _total(item["amount"] for item in expenses if included(item)),
        "datedIncome": _total(item["amount"] for item in income if included(item)),
        "undatedSpending": undated_expenses, "undatedIncome": undated_income,
        "scheduledSpending": scheduled, "unitemizedSpending": adjustment,
        "unitemizedIncome": _money(data["unitemizedIncome"]),
        "expenseCount": sum(1 for item in expenses if included(item)),
        "undatedExpenseCount": undated_count,
        "complete": not any((undated_count, scheduled_count, adjustment)),
    }
