from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
import logging
from typing import Any, Literal

from langchain.tools import ToolRuntime, tool

from bookiebot.agent.context import ConversationContext
from bookiebot.reports.expense_breakdown import (
    build_expense_breakdown_report,
    expense_breakdown_client_payload,
    parse_budget_month,
)
import bookiebot.sheets.utils as su
from bookiebot.sheets.routing import (
    DiscordUserConfig,
    UnknownDiscordUserError,
    get_user_config,
    sheet_user_context,
)


logger = logging.getLogger(__name__)


_CATEGORY_MAP = {
    "needs": "need_expenses",
    "grocery": "grocery",
    "gas": "gas",
    "food": "food",
    "shopping": "shopping",
}


def _profile(context: ConversationContext) -> tuple[DiscordUserConfig | None, dict[str, str] | None]:
    try:
        return get_user_config(context.actor_key), None
    except UnknownDiscordUserError:
        return None, {
            "error": (
                "This Discord account is not mapped to a BookieBot budget profile, "
                "so no private financial data was read."
            )
        }


async def load_budget_snapshot(context: ConversationContext) -> dict[str, Any]:
    profile, error = _profile(context)
    if profile is None:
        return error or {"error": "Budget profile unavailable."}

    with sheet_user_context(context.actor_key):
        income = await su.total_income()
        remaining = await su.remaining_budget()
        average = await su.average_daily_spend(list(profile.expense_persons))
        burn_rate, burn_rate_context = await su.calculate_burn_rate()
        breakdown = await su.expense_breakdown_percentages(list(profile.expense_persons))

    return {
        "owner": profile.name,
        "period": "current month",
        "income": income,
        "remaining_budget": remaining,
        "average_daily_spend": average,
        "burn_rate": burn_rate,
        "burn_rate_context": burn_rate_context,
        "expense_breakdown": breakdown,
    }


async def load_spending_by_category(context: ConversationContext, category: str) -> dict[str, Any]:
    profile, error = _profile(context)
    if profile is None:
        return error or {"error": "Budget profile unavailable."}

    normalized = category.strip().lower()
    sheet_category = _CATEGORY_MAP.get(normalized)
    if sheet_category is None:
        return {
            "error": "Category must be one of: needs, grocery, gas, food, or shopping."
        }

    with sheet_user_context(context.actor_key):
        total = await su.total_for_category(sheet_category, profile.expense_persons)
    return {
        "owner": profile.name,
        "period": "current month",
        "category": normalized,
        "total": total,
    }


async def load_largest_expenses(context: ConversationContext, limit: int = 5) -> dict[str, Any]:
    profile, error = _profile(context)
    if profile is None:
        return error or {"error": "Budget profile unavailable."}

    safe_limit = max(1, min(int(limit), 10))
    with sheet_user_context(context.actor_key):
        expenses = await su.top_n_expenses_all_categories(profile.expense_persons, safe_limit)
    return {
        "owner": profile.name,
        "period": "current month",
        "limit": safe_limit,
        "expenses": expenses,
    }


async def load_expenses_on_date(context: ConversationContext, date: str) -> dict[str, Any]:
    profile, error = _profile(context)
    if profile is None:
        return error or {"error": "Budget profile unavailable."}

    with sheet_user_context(context.actor_key):
        entries, total = await su.expenses_on_day(date, profile.expense_persons)
    return {
        "owner": profile.name,
        "date": date,
        "total": total or 0.0,
        "expenses": entries or [],
    }


async def load_subscriptions(context: ConversationContext) -> dict[str, Any]:
    profile, error = _profile(context)
    if profile is None:
        return error or {"error": "Budget profile unavailable."}

    with sheet_user_context(context.actor_key):
        needs, needs_total, wants, wants_total = await su.list_subscriptions()
    return {
        "owner": profile.name,
        "needs": [{"name": name, "amount": amount} for name, amount in needs],
        "needs_total": needs_total,
        "wants": [{"name": name, "amount": amount} for name, amount in wants],
        "wants_total": wants_total,
        "total": round(needs_total + wants_total, 2),
    }


async def load_bill_status(context: ConversationContext) -> dict[str, Any]:
    profile, error = _profile(context)
    if profile is None:
        return error or {"error": "Budget profile unavailable."}

    with sheet_user_context(context.actor_key):
        rent = await su.check_rent_paid()
        pge = await su.check_pge_paid()
        recology = await su.check_recology_paid()
        water = await su.check_water_paid()
    return {
        "owner": profile.name,
        "period": "current month",
        "bills": {
            "rent": {"paid": rent[0], "amount": rent[1]},
            "pge": {"paid": pge[0], "amount": pge[1]},
            "recology": {"paid": recology[0], "amount": recology[1]},
            "water": {"paid": water[0], "amount": water[1]},
        },
    }


async def load_store_spending(context: ConversationContext, store: str) -> dict[str, Any]:
    profile, error = _profile(context)
    if profile is None:
        return error or {"error": "Budget profile unavailable."}

    with sheet_user_context(context.actor_key):
        result = await su.total_spent_at_store(store, profile.expense_persons, top_n=10)
    if isinstance(result, tuple):
        total, matches = result
    else:
        total, matches = result, []
    return {
        "owner": profile.name,
        "period": "current month",
        "store": store,
        "total": total,
        "matches": [
            {
                "date": date.strftime("%Y-%m-%d"),
                "location": location,
                "amount": amount,
                "category": category,
            }
            for date, location, amount, category in matches
        ],
    }


async def load_financial_report(
    context: ConversationContext,
    *,
    section: str,
    mode: str,
    month: str,
    limit: int,
) -> dict[str, Any]:
    """Load a focused slice of the canonical web expense-report payload."""
    profile, error = _profile(context)
    if profile is None:
        return error or {"error": "Budget profile unavailable."}

    normalized_section = section.strip().lower()
    valid_sections = {
        "overview",
        "categories",
        "cash_flow",
        "commitments",
        "burn_rate",
        "activity",
        "reimbursements",
    }
    if normalized_section not in valid_sections:
        return {"error": f"Section must be one of: {', '.join(sorted(valid_sections))}."}

    normalized_mode = mode.strip().lower()
    if normalized_mode not in {"current", "projected", "comparison"}:
        return {"error": "Mode must be current, projected, or comparison."}
    try:
        selected_month = parse_budget_month(month)
    except ValueError as exc:
        return {"error": str(exc)}

    def build_report() -> Any:
        with sheet_user_context(context.actor_key):
            return build_expense_breakdown_report(
                actor_key=context.actor_key,
                owner_name=profile.name,
                persons=list(profile.expense_persons),
                month=selected_month,
            )

    report = await asyncio.to_thread(build_report)
    payload = expense_breakdown_client_payload(report)
    safe_limit = max(1, min(int(limit), 50))
    result: dict[str, Any] = {
        "source": "expense_breakdown_report",
        "owner": payload["ownerName"],
        "month": payload["monthLabel"],
        "generated_at": payload["generatedAt"],
        "elapsed_days": payload["elapsedDays"],
        "days_in_month": payload["daysInMonth"],
        "section": normalized_section,
        "mode": normalized_mode,
        "interpretation_note": (
            "Current contains logged/elapsed-month values. Projected uses the same calculations "
            "as the web report's Projected button, including full expected income, scheduled "
            "commitments, 50/30/20 budgets, cascade coverage, and savings targets."
        ),
    }
    mode_views = payload["modeViews"]
    if normalized_mode == "comparison":
        current = _financial_report_section(
            payload,
            mode_views["current"],
            section=normalized_section,
            mode="current",
            limit=safe_limit,
        )
        projected = _financial_report_section(
            payload,
            mode_views["projected"],
            section=normalized_section,
            mode="projected",
            limit=safe_limit,
        )
        result.update(
            {
                "current": current,
                "projected": projected,
                "changes": _financial_metric_changes(
                    mode_views["current"]["metrics"],
                    mode_views["projected"]["metrics"],
                ),
            }
        )
        return result

    result[normalized_mode] = _financial_report_section(
        payload,
        mode_views[normalized_mode],
        section=normalized_section,
        mode=normalized_mode,
        limit=safe_limit,
    )
    return result


def _financial_report_section(
    payload: dict[str, Any],
    view: dict[str, Any],
    *,
    section: str,
    mode: str,
    limit: int,
) -> dict[str, Any]:
    if section == "overview":
        return {
            "metrics": view["metrics"],
            "categoryBudgets": view["categoryBudgets"],
            "categorySpending": view["categorySpending"],
            "categoryBalances": view["categoryBalances"],
            "burnRate": _burn_rate_summary(view.get("burnRate")),
            "fixedCommitments": _fixed_commitments_from_breakdown(view["breakdown"]),
            "loggedReportMetrics": {
                key: payload["metrics"].get(key)
                for key in (
                    "sharedExpenses",
                    "personalOutflows",
                    "needsRollover",
                    "wantsRollover",
                )
            },
        }
    if section == "categories":
        return {
            "breakdown": view["breakdown"],
            "categoryBudgets": view["categoryBudgets"],
            "categorySpending": view["categorySpending"],
            "categoryBalances": view["categoryBalances"],
            "needExpenses": payload["needExpenses"],
        }
    if section == "cash_flow":
        events = list(view["calendarEvents"])
        if mode == "current":
            events = [event for event in events if not event.get("projectedOnly")]
        return {
            "metrics": view["metrics"],
            "incomeProjection": payload["incomeProjection"],
            "savingsProjection": payload["savingsProjection"],
            "calendarEvents": events,
            "dailyTotals": payload["dailyTotals"],
        }
    if section == "commitments":
        bill_events = [
            event
            for event in view["calendarEvents"]
            if event.get("kind") == "bill" and (mode == "projected" or not event.get("projectedOnly"))
        ]
        subscription_events = [
            event
            for event in view["calendarEvents"]
            if event.get("kind") == "subscription"
            and (mode == "projected" or not event.get("projectedOnly"))
        ]
        return {
            "fixedCommitments": _fixed_commitments_from_breakdown(view["breakdown"]),
            "bills": bill_events,
            "subscriptionEvents": subscription_events,
            "subscriptionsNeeds": payload["subscriptionsNeeds"],
            "subscriptionsWants": payload["subscriptionsWants"],
            "utilityHistory": view["utilityHistory"],
        }
    if section == "burn_rate":
        return {"burnRate": view.get("burnRate")}
    if section == "activity":
        return {
            "topExpenses": payload["topEntries"][:limit],
            "transactions": payload["dailyEntries"][:limit],
            "dailyTotals": payload["dailyTotals"],
            "merchantTotals": payload["merchantTotals"][:limit],
            "merchantOccurrences": payload["merchantOccurrences"][:limit],
            "personTotals": payload["personTotals"][:limit],
        }
    return {"sharedReimbursements": payload["sharedReimbursements"][:limit]}


def _burn_rate_summary(burn_rate: dict[str, Any] | None) -> dict[str, Any] | None:
    if burn_rate is None:
        return None
    return {key: value for key, value in burn_rate.items() if key != "series"}


def _fixed_commitments_from_breakdown(breakdown: list[dict[str, Any]]) -> float:
    fixed_keys = {
        "rent",
        "bills_utilities",
        "static_bills_subscriptions_needs",
        "subscriptions_wants",
    }
    return round(
        sum(
            float(item.get("amount") or 0.0)
            for item in breakdown
            if item.get("key") in fixed_keys
        ),
        2,
    )


def _financial_metric_changes(
    current: dict[str, Any],
    projected: dict[str, Any],
) -> dict[str, float]:
    return {
        key: round(float(projected.get(key) or 0.0) - float(current.get(key) or 0.0), 2)
        for key in (
            "totalExpenses",
            "monthlyIncome",
            "incomeAfterExpenses",
            "amountSaved",
            "savingsIdeal",
            "savingsMinimum",
        )
    }


async def _safe_read_tool(
    tool_name: str,
    operation: Callable[[], Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    try:
        return await operation()
    except Exception:
        logger.exception("Conversational read tool failed", extra={"tool_name": tool_name})
        return {
            "error": (
                "BookieBot could not read that financial data right now. "
                "No changes were made."
            )
        }


@tool
async def get_budget_snapshot(runtime: ToolRuntime[ConversationContext]) -> dict[str, Any]:
    """Read a lightweight current-only snapshot. For affordability, planning, or projections use get_financial_report."""
    return await _safe_read_tool(
        "get_budget_snapshot",
        lambda: load_budget_snapshot(runtime.context),
    )


@tool
async def get_financial_report(
    runtime: ToolRuntime[ConversationContext],
    section: Literal[
        "overview",
        "categories",
        "cash_flow",
        "commitments",
        "burn_rate",
        "activity",
        "reimbursements",
    ] = "overview",
    mode: Literal["current", "projected", "comparison"] = "comparison",
    month: str = "current month",
    limit: int = 10,
) -> dict[str, Any]:
    """Read canonical expense-report data. Use comparison for planning; sections cover budgets, categories, cash flow, commitments, burn rate, activity, and reimbursements."""
    return await _safe_read_tool(
        "get_financial_report",
        lambda: load_financial_report(
            runtime.context,
            section=section,
            mode=mode,
            month=month,
            limit=limit,
        ),
    )


@tool
async def get_spending_by_category(
    category: Literal["needs", "grocery", "gas", "food", "shopping"],
    runtime: ToolRuntime[ConversationContext],
) -> dict[str, Any]:
    """Read only a category's current spending total. For category health or budget comparisons use get_financial_report categories."""
    return await _safe_read_tool(
        "get_spending_by_category",
        lambda: load_spending_by_category(runtime.context, category),
    )


@tool
async def get_largest_expenses(
    runtime: ToolRuntime[ConversationContext],
    limit: int = 5,
) -> dict[str, Any]:
    """Read up to ten of the current user's largest expenses in the current month."""
    return await _safe_read_tool(
        "get_largest_expenses",
        lambda: load_largest_expenses(runtime.context, limit),
    )


@tool
async def get_expenses_on_date(
    date: str,
    runtime: ToolRuntime[ConversationContext],
) -> dict[str, Any]:
    """Read the current user's expenses on a date such as 2026-08-17 or August 17."""
    return await _safe_read_tool(
        "get_expenses_on_date",
        lambda: load_expenses_on_date(runtime.context, date),
    )


@tool
async def get_subscriptions(runtime: ToolRuntime[ConversationContext]) -> dict[str, Any]:
    """Read all current subscriptions and their Needs/Wants totals for the current user."""
    return await _safe_read_tool(
        "get_subscriptions",
        lambda: load_subscriptions(runtime.context),
    )


@tool
async def get_bill_status(runtime: ToolRuntime[ConversationContext]) -> dict[str, Any]:
    """Read whether Rent, PG&E, Recology, and Water are logged as paid this month."""
    return await _safe_read_tool(
        "get_bill_status",
        lambda: load_bill_status(runtime.context),
    )


@tool
async def get_store_spending(
    store: str,
    runtime: ToolRuntime[ConversationContext],
) -> dict[str, Any]:
    """Read current-month spending and matching transactions for a merchant or store."""
    return await _safe_read_tool(
        "get_store_spending",
        lambda: load_store_spending(runtime.context, store),
    )


def read_only_tools() -> list[Any]:
    return [
        get_budget_snapshot,
        get_financial_report,
        get_spending_by_category,
        get_largest_expenses,
        get_expenses_on_date,
        get_subscriptions,
        get_bill_status,
        get_store_spending,
    ]
