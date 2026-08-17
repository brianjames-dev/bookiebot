from __future__ import annotations

from collections.abc import Awaitable, Callable
import logging
from typing import Any, Literal

from langchain.tools import ToolRuntime, tool

from bookiebot.agent.context import ConversationContext
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
    """Read the current user's monthly income, spending, remaining budget, daily pace, and burn rate."""
    return await _safe_read_tool(
        "get_budget_snapshot",
        lambda: load_budget_snapshot(runtime.context),
    )


@tool
async def get_spending_by_category(
    category: Literal["needs", "grocery", "gas", "food", "shopping"],
    runtime: ToolRuntime[ConversationContext],
) -> dict[str, Any]:
    """Read the current user's current-month spending total for one expense category."""
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
        get_spending_by_category,
        get_largest_expenses,
        get_expenses_on_date,
        get_subscriptions,
        get_bill_status,
        get_store_spending,
    ]
