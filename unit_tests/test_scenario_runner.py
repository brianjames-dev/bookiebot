import asyncio
from pathlib import Path

from openpyxl.utils import column_index_from_string

from bookiebot.intent_handlers import handle_intent
from unit_tests.support.scenario_runner import FakeMessage, run_scenario
from unit_tests.support.fixture_loader import build_repo_from_fixture


async def _echo_handler(intent, entities, message: FakeMessage):
    await message.channel.send(f"{intent}:{entities.get('category')}")


def test_run_scenario_uses_fixture(llm_client_factory):
    fixture_path = Path("unit_tests/fixtures/llm/log_expense.json")
    llm_client = llm_client_factory(fixture_path)
    result = asyncio.run(
        run_scenario(
            "Paid for coffee",
            llm_client=llm_client,
            handler=_echo_handler,
        )
    )

    assert result.intent == "log_expense"
    assert result.entities["category"] == "food"
    assert result.replies == ["log_expense:food"]


def test_log_expense_flow_writes_to_sheet(llm_client_factory):
    repo = build_repo_from_fixture("base_month")
    fixture_path = Path("unit_tests/fixtures/llm/log_expense.json")
    llm_client = llm_client_factory(fixture_path)

    async def _run():
        with repo.patched():
            return await run_scenario(
                "Paid for coffee",
                llm_client=llm_client,
                handler=handle_intent,
            )

    result = asyncio.run(_run())

    assert result.replies == ["✅ Food expense logged: $18.5 for Hannah"]

    amount_col = column_index_from_string("P")
    person_col = column_index_from_string("R")

    rows = repo.expense.get_all_values()
    target_row = max(
        idx
        for idx, row in enumerate(rows, start=1)
        if len(row) >= person_col and row[person_col - 1]
    )

    amount_cell = repo.expense.cell(target_row, amount_col)
    person_cell = repo.expense.cell(target_row, person_col)

    assert float(amount_cell.value) == 18.5
    assert person_cell.value == "Hannah"


def test_query_rent_paid(llm_client_factory):
    repo = build_repo_from_fixture("base_month")
    llm_client = llm_client_factory("unit_tests/fixtures/llm/query_rent.json")

    async def _run():
        with repo.patched():
            return await run_scenario(
                "Did we already pay rent?",
                llm_client=llm_client,
                handler=handle_intent,
            )

    result = asyncio.run(_run())
    assert result.replies == ["✅ You paid $2000.00 for rent this month."]


def test_query_total_for_store(llm_client_factory):
    repo = build_repo_from_fixture("base_month")
    llm_client = llm_client_factory("unit_tests/fixtures/llm/query_store.json")

    async def _run():
        with repo.patched():
            return await run_scenario(
                "How much have we spent at Trader Joe's?",
                llm_client=llm_client,
                handler=handle_intent,
            )

    result = asyncio.run(_run())
    assert result.replies
    assert "Trader Joe's" in result.replies[0]
    assert "$120.00" in result.replies[0]
