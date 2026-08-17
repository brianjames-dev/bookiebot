from unittest.mock import AsyncMock

from langchain_core.utils.function_calling import convert_to_openai_tool
import pytest

from bookiebot.agent.context import ConversationContext
from bookiebot.agent import tools as agent_tools


def _context(actor_key: str = "676638528590970917") -> ConversationContext:
    return ConversationContext(
        actor_key=actor_key,
        discord_user_id=actor_key,
        display_name="Brian",
        channel_id="200",
        guild_id="300",
        thread_id=f"discord:300:200:{actor_key}",
    )


def test_agent_exposes_only_read_only_tools():
    tools = agent_tools.read_only_tools()
    names = {tool.name for tool in tools}

    assert names == {
        "get_bill_status",
        "get_budget_snapshot",
        "get_expenses_on_date",
        "get_largest_expenses",
        "get_spending_by_category",
        "get_store_spending",
        "get_subscriptions",
    }
    assert not any(
        verb in name
        for name in names
        for verb in ("add", "create", "delete", "log", "move", "pay", "split", "update", "write")
    )
    schemas = [convert_to_openai_tool(tool) for tool in tools]
    assert all("runtime" not in schema["function"]["parameters"].get("properties", {}) for schema in schemas)


@pytest.mark.asyncio
async def test_budget_snapshot_uses_trusted_actor_scope(monkeypatch):
    entered_actor_keys: list[str] = []

    class _SheetContext:
        def __init__(self, actor_key):
            self.actor_key = actor_key

        def __enter__(self):
            entered_actor_keys.append(self.actor_key)

        def __exit__(self, *_args):
            return None

    monkeypatch.setattr(agent_tools, "sheet_user_context", _SheetContext)
    monkeypatch.setattr(agent_tools.su, "total_income", AsyncMock(return_value=4200.0))
    monkeypatch.setattr(agent_tools.su, "remaining_budget", AsyncMock(return_value=950.0))
    monkeypatch.setattr(agent_tools.su, "average_daily_spend", AsyncMock(return_value=31.25))
    monkeypatch.setattr(agent_tools.su, "calculate_burn_rate", AsyncMock(return_value=("$45/day", "On pace")))
    monkeypatch.setattr(
        agent_tools.su,
        "expense_breakdown_percentages",
        AsyncMock(return_value={"grand_total": 3250.0, "categories": {}}),
    )

    result = await agent_tools.load_budget_snapshot(_context())

    assert entered_actor_keys == ["676638528590970917"]
    assert result == {
        "owner": "Brian",
        "period": "current month",
        "income": 4200.0,
        "remaining_budget": 950.0,
        "average_daily_spend": 31.25,
        "burn_rate": "$45/day",
        "burn_rate_context": "On pace",
        "expense_breakdown": {"grand_total": 3250.0, "categories": {}},
    }


@pytest.mark.asyncio
async def test_unknown_actor_cannot_read_financial_tools(monkeypatch):
    total_income = AsyncMock(return_value=9999.0)
    monkeypatch.setattr(agent_tools.su, "total_income", total_income)

    result = await agent_tools.load_budget_snapshot(_context("unknown-user"))

    assert result["error"].startswith("This Discord account is not mapped")
    total_income.assert_not_awaited()


@pytest.mark.asyncio
async def test_category_tool_normalizes_needs_without_accepting_an_owner(monkeypatch):
    total_for_category = AsyncMock(return_value=125.5)
    monkeypatch.setattr(agent_tools.su, "total_for_category", total_for_category)

    result = await agent_tools.load_spending_by_category(_context(), "needs")

    assert result == {"owner": "Brian", "period": "current month", "category": "needs", "total": 125.5}
    total_for_category.assert_awaited_once_with("need_expenses", ("Brian (BofA)", "Brian (AL)"))
