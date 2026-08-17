from unittest.mock import AsyncMock, MagicMock

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
        "get_financial_report",
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


@pytest.mark.asyncio
async def test_financial_report_tool_uses_canonical_mode_views_and_trusted_actor(monkeypatch):
    report = object()
    build_report = MagicMock(return_value=report)
    payload = {
        "ownerName": "Brian",
        "monthLabel": "August 2026",
        "generatedAt": "Aug 17, 2026 1:00 AM PDT",
        "elapsedDays": 17,
        "daysInMonth": 31,
        "metrics": {"fixedCommitments": 2500.0},
        "modeViews": {
            "current": {
                "metrics": {
                    "monthlyIncome": 3137.49,
                    "totalExpenses": 2671.9,
                    "incomeAfterExpenses": 465.59,
                    "amountSaved": 0.0,
                    "savingsIdeal": 627.5,
                    "savingsMinimum": 313.75,
                },
                "categoryBudgets": {"needs": 1568.75, "wants": 941.24, "savings": 627.5},
                "categorySpending": {"needs": 2417.25, "wants": 254.65, "savings": 0.0},
                "categoryBalances": {"remaining": {"needs": 0.0, "wants": 92.99, "savings": 372.6}},
                "burnRate": {"status": "over"},
                "breakdown": [],
                "calendarEvents": [],
                "utilityHistory": [],
            },
            "projected": {
                "metrics": {
                    "monthlyIncome": 6274.98,
                    "totalExpenses": 3935.56,
                    "incomeAfterExpenses": 2339.42,
                    "amountSaved": 0.0,
                    "savingsIdeal": 1255.0,
                    "savingsMinimum": 627.5,
                },
                "categoryBudgets": {"needs": 3137.49, "wants": 1882.49, "savings": 1255.0},
                "categorySpending": {"needs": 3417.25, "wants": 518.31, "savings": 0.0},
                "categoryBalances": {"remaining": {"needs": 0.0, "wants": 1084.93, "savings": 1254.49}},
                "burnRate": {"status": "under"},
                "breakdown": [],
                "calendarEvents": [],
                "utilityHistory": [],
            },
        },
    }
    monkeypatch.setattr(agent_tools, "build_expense_breakdown_report", build_report)
    monkeypatch.setattr(agent_tools, "expense_breakdown_client_payload", MagicMock(return_value=payload))

    result = await agent_tools.load_financial_report(
        _context(),
        section="overview",
        mode="comparison",
        month="August 2026",
        limit=10,
    )

    assert result["source"] == "expense_breakdown_report"
    assert result["owner"] == "Brian"
    assert result["section"] == "overview"
    assert result["current"]["metrics"]["incomeAfterExpenses"] == 465.59
    assert result["projected"]["metrics"]["incomeAfterExpenses"] == 2339.42
    assert result["changes"]["incomeAfterExpenses"] == 1873.83
    assert build_report.call_args.kwargs["actor_key"] == "676638528590970917"
    assert build_report.call_args.kwargs["owner_name"] == "Brian"
    assert build_report.call_args.kwargs["persons"] == ["Brian (BofA)", "Brian (AL)"]
    assert build_report.call_args.kwargs["month"].label == "August 2026"


@pytest.mark.asyncio
async def test_unknown_actor_cannot_build_canonical_financial_report(monkeypatch):
    build_report = MagicMock()
    monkeypatch.setattr(agent_tools, "build_expense_breakdown_report", build_report)

    result = await agent_tools.load_financial_report(
        _context("unknown-user"),
        section="overview",
        mode="comparison",
        month="current month",
        limit=10,
    )

    assert result["error"].startswith("This Discord account is not mapped")
    build_report.assert_not_called()
