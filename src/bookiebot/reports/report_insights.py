"""Explain canonical totals and compare verifiably timed expense activity."""
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
    projected_scheduled = [
        entry(item.label, item.amount, item.group, f"{report.month.year}-{report.month.month:02d}-{item.day:02d}")
        for item in report.calendar_events
        if item.kind == "subscription" or (item.kind == "bill" and item.amount_estimated)
    ]
    return {
        "recordedExpenses": recorded,
        "scheduledExpenses": scheduled,
        "recordedIncome": income,
        "unitemizedExpenses": _money(payload["modeViews"]["current"]["metrics"]["totalExpenses"]
                                      - _total(item["amount"] for item in recorded)
                                      - _total(item["amount"] for item in scheduled)),
        "unitemizedIncome": _money(report.income_total - _total(item["amount"] for item in income)),
        "modeExpenses": {
            mode: {"scheduledExpenses": scheduled_items,
                   "unitemizedExpenses": _money(payload["modeViews"][mode]["metrics"]["totalExpenses"]
                                                 - _total(item["amount"] for item in recorded)
                                                 - _total(item["amount"] for item in scheduled_items))}
            for mode, scheduled_items in (("current", scheduled), ("projected", projected_scheduled))
        },
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
        investing = view.get("savingsInvesting")
        espp = investing["esppContribution"] if investing else 0
        estimated_espp = investing.get("estimatedEsppContribution", 0) if investing else 0
        projected_remainder = _money(metrics["monthlyIncome"] - report.income_total - espp)
        if projected_remainder:
            expected = [{"label": item.label, "amount": _money(item.amount), "source": "scheduled",
                         "date": _date(f"{report.month.year}-{report.month.month:02d}-{item.day:02d}", report.month.year, report.month.month)}
                        for item in report.calendar_events if item.kind == "income" and item.projected_only]
            if expected and _total(item["amount"] for item in expected) == projected_remainder:
                incomes.extend(expected)
            else:
                incomes.append({"label": "Expected income still to arrive", "amount": projected_remainder,
                                "source": "scheduled", "date": None})

        if espp - estimated_espp:
            incomes.append({"label": "ESPP withheld from payroll", "amount": _money(espp - estimated_espp), "source": "recorded" if report.savings_plan.recorded_withholding else "calculated", "date": None})
        if estimated_espp:
            incomes.append({"label": "Expected payroll ESPP", "amount": _money(estimated_espp), "source": "scheduled", "date": None})

        current_amounts = {item["key"]: _money(item["amount"]) for item in payload["modeViews"]["current"]["breakdown"]}
        spent = []
        for item in view["breakdown"]:
            if item["key"] in {"savings", "espp"}:
                continue
            amount = _money(item["amount"])
            if item["key"] == "static_bills_subscriptions_needs":
                # This category also contains real fixed bills. Keep their
                # payment records distinct from schedule-based subscriptions.
                fixed = [
                    {"label": payment.label, "amount": _money(payment.amount), "source": "recorded",
                     "date": _date(payment.date, report.month.year, report.month.month)}
                    for payment in report.payments if payment.group == item["key"]
                ]
                if mode == "projected":
                    fixed.extend(
                        {"label": f"{event.label} · expected", "amount": _money(event.amount),
                         "source": "scheduled", "date": None}
                        for event in report.calendar_events
                        if event.kind == "bill" and event.group == item["key"] and event.amount_estimated
                    )
                spent.extend(fixed)
                subscription_amount = _money(amount - _total(part["amount"] for part in fixed))
                if subscription_amount:
                    spent.append({"label": "Subscriptions (Needs)", "amount": subscription_amount,
                                  "source": "scheduled", "date": None})
                continue
            if item["key"] == "subscriptions_wants":
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
        # Spending remains expense-only; savings reduce available balances
        # through the existing category accounting and are explained in Saved.
        spent_total = _money(metrics["totalExpenses"])

        balances = view["categoryBalances"]
        left = [{"label": f"{category.title()} remaining", "amount": _money(balances["remaining"][category]),
                 "source": "sheet", "date": None} for category in ("needs", "wants", "savings")]
        saved = [{"label": f"Savings contribution {item.number}", "amount": _money(item.actual),
                  "source": "recorded", "date": None} for item in report.savings_deposits if item.actual]
        if espp - estimated_espp:
            saved.append({"label": "SpaceX ESPP", "amount": _money(espp - estimated_espp), "source": "calculated", "date": None})
        if estimated_espp:
            saved.append({"label": "SpaceX ESPP · expected", "amount": _money(estimated_espp), "source": "scheduled", "date": None})
        saved_remainder = _money(metrics["amountSaved"] - _total(item["amount"] for item in saved))
        if saved_remainder:
            saved.append({"label": "Other saved amount from the sheet", "amount": saved_remainder,
                          "source": "sheet", "date": None})
        left_notes = [
            "Remaining category funds already account for recorded savings contributions.",
            "ESPP is calculated from enrolled payroll; category budgets contain only deposited cash."
            if view.get("savingsInvesting") else
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
            "spent": detail("Spent", spent_total, "Expense outflows", spent, [
                "Cash savings and payroll ESPP are shown in Saved and excluded from Spent.",
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
        if investing:
            values = investing
            explanations[mode]["income"]["equation"] = "Deposited income + payroll ESPP" + (" + expected pay and ESPP" if mode == "projected" else "")
            explanations[mode]["income"]["notes"].append("Income includes payroll ESPP before withholding; Saved includes the same contribution once.")
            explanations[mode]["saved"]["equation"] = "Recorded cash savings + payroll ESPP" + (" (includes expected ESPP)" if estimated_espp else "")
            explanations[mode]["saved"]["notes"][-1] = "Projected retains recorded cash savings and separately labels ESPP from expected paychecks."
            explanations[mode]["saved"]["notes"].extend([
                ("Cash goal is 20% of total take-home minus recorded ESPP. Minimum cash is 7.5% on enrolled pay and 10% on other income."
                 if report.savings_plan.recorded_withholding else
                 "Cash targets use enrolled take-home before ESPP at 15% ideal / 7.5% minimum; other income uses 20% / 10%."),
                f"ESPP: ${values['esppContribution']:,.2f}, {'recorded' if report.savings_plan.recorded_withholding else 'calculated'} from payroll; already withheld before deposit.",
                f"Cash savings plus ESPP: ${values['combinedContributions']:,.2f}.",
                *values["warnings"],
            ])
            if estimated_espp:
                explanations[mode]["saved"]["notes"].append(f"${estimated_espp:,.2f} of Saved is estimated ESPP from expected paychecks.")
    return explanations


def compare_report_spending(
    selected: dict[str, Any], baseline: dict[str, Any] | None, *, baseline_month: str,
    baseline_kind: str, mode: str, as_of: datetime,
) -> dict[str, Any]:
    """Compare the expense-only Spent basis over the same days in both months."""
    from bookiebot.sheets.routing import PACIFIC_TZ
    if mode not in {"current", "projected"}:
        raise ValueError("Mode must be 'current' or 'projected'.")
    as_of = as_of.replace(tzinfo=PACIFIC_TZ) if as_of.tzinfo is None else as_of.astimezone(PACIFIC_TZ)
    selected_month = f"{selected['year']:04d}-{selected['month']:02d}"
    requested_day, through_day, short_month_adjusted = _comparison_window(selected, baseline_month, as_of)
    result: dict[str, Any] = {
        "selectedMonth": selected_month, "baselineMonth": baseline_month, "baselineKind": baseline_kind,
        "mode": mode, "selected": None, "baseline": None,
        "throughDay": through_day, "shortMonthAdjusted": short_month_adjusted,
        "changeAmount": None, "changePercent": None,
        "status": "unavailable", "coverageNote": "The comparison month is unavailable.",
    }

    def period(payload: dict[str, Any]) -> dict[str, Any] | None:
        metrics = payload.get("modeViews", {}).get(mode, {}).get("metrics", {})
        if ("totalExpenses" not in metrics or metrics["totalExpenses"] is None
                or mode not in payload.get("comparisonData", {}).get("modeExpenses", {})):
            return None  # Missing source data must never become zero spending.
        return _period(payload, through_day, mode=mode)

    if baseline is not None:
        if selected.get("ownerName") != baseline.get("ownerName"):
            raise ValueError("Comparison reports must belong to the same owner.")
        if f"{baseline['year']:04d}-{baseline['month']:02d}" != baseline_month:
            raise ValueError("Comparison report month did not match the requested period.")
    result["selected"] = period(selected)
    if result["selected"] is None:
        result["coverageNote"] = "Refresh this report to load its Spent comparison data."
        return result
    result["baseline"] = period(baseline) if baseline is not None else None
    if result["baseline"] is None:
        return result
    amount = _money(result["selected"]["spending"] - result["baseline"]["spending"])
    result["changeAmount"] = amount
    if result["baseline"]["spending"] > 0:
        result["changePercent"] = round(amount / result["baseline"]["spending"] * 100, 1)
    partial = not result["selected"]["complete"] or not result["baseline"]["complete"]
    result["status"] = "partial" if partial else "complete"
    result["coverageNote"] = (
        f"Compares {mode.title()} Spent over days 1–{through_day} in both months. "
        "Dated expenses and scheduled subscriptions use that window; recorded undated bills and sheet adjustments "
        "are included in full in each month because their payment dates are unknown. Savings and ESPP are excluded."
    )
    if through_day != requested_day:
        base_year, base_number = map(int, baseline_month.split("-"))
        reason = "the comparison month is still in progress" if (base_year, base_number) == (as_of.year, as_of.month) else "the comparison month is shorter"
        result["coverageNote"] += f" Both periods end on day {through_day} because {reason}."
    return result


def compare_report_periods(
    selected: dict[str, Any], baseline: dict[str, Any] | None, *, baseline_month: str,
    baseline_kind: str, as_of: datetime,
) -> dict[str, Any]:
    from bookiebot.sheets.routing import PACIFIC_TZ
    as_of = as_of.replace(tzinfo=PACIFIC_TZ) if as_of.tzinfo is None else as_of.astimezone(PACIFIC_TZ)
    selected_month = f"{selected['year']:04d}-{selected['month']:02d}"
    requested_day, through_day, short_month_adjusted = _comparison_window(selected, baseline_month, as_of)
    base_year, base_number = map(int, baseline_month.split("-"))
    result: dict[str, Any] = {
        "selectedMonth": selected_month, "baselineMonth": baseline_month, "baselineKind": baseline_kind,
        "throughDay": through_day, "shortMonthAdjusted": short_month_adjusted,
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
    if through_day != requested_day:
        reason = "the comparison month is still in progress" if (base_year, base_number) == (as_of.year, as_of.month) else "the comparison month is shorter"
        result["coverageNote"] += f" Both periods end on day {through_day} because {reason}."
    return result


def _comparison_window(selected: dict[str, Any], baseline_month: str, as_of: datetime) -> tuple[int, int, bool]:
    requested_day = (as_of.day if (selected["year"], selected["month"]) == (as_of.year, as_of.month)
                     else calendar.monthrange(selected["year"], selected["month"])[1])
    base_year, base_number = map(int, baseline_month.split("-"))
    through_day = min(requested_day, calendar.monthrange(base_year, base_number)[1])
    short_month_adjusted = through_day != requested_day
    if (base_year, base_number) == (as_of.year, as_of.month):
        through_day = min(through_day, as_of.day)
    return requested_day, through_day, short_month_adjusted


def _period(payload: dict[str, Any], through_day: int, *, mode: str | None = None) -> dict[str, Any]:
    data = payload["comparisonData"]
    month = f"{payload['year']:04d}-{payload['month']:02d}"
    def included(item):
        value = item.get("date")
        return bool(value and value.startswith(month + "-") and int(value[-2:]) <= through_day)
    expenses = data["recordedExpenses"]
    income = data["recordedIncome"]
    undated_count = sum(1 for item in expenses if not item.get("date") and item["amount"])
    timed = data["modeExpenses"][mode] if mode else data
    scheduled_count = sum(1 for item in timed["scheduledExpenses"] if included(item) and item["amount"])
    undated_expenses = _total(item["amount"] for item in expenses if not item.get("date"))
    undated_income = _total(item["amount"] for item in income if not item.get("date"))
    scheduled = _total(item["amount"] for item in timed["scheduledExpenses"] if included(item))
    adjustment = _money(timed["unitemizedExpenses"])
    result = {
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
    if mode:
        # Start with the authoritative Spent value, preserving signed sheet
        # adjustments. Remove only costs known to fall outside the window.
        # A bill's due date is never treated as its actual payment date.
        excluded = _total(item["amount"] for item in expenses if item.get("date") and not included(item))
        excluded_scheduled = _total(item["amount"] for item in timed["scheduledExpenses"] if not included(item))
        result["spending"] = _money(payload["modeViews"][mode]["metrics"]["totalExpenses"] - excluded - excluded_scheduled)
        result["complete"] = not any((undated_count, adjustment))
    return result
