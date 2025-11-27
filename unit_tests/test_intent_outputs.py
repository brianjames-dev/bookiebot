import asyncio
import contextlib
from dataclasses import dataclass
from typing import Callable, Optional

from openpyxl.utils import column_index_from_string

from bookiebot.intent_handlers import handle_intent
from unit_tests.support.scenario_runner import FakeMessage, run_scenario
from unit_tests.support.fixture_loader import build_repo_from_fixture


async def _echo_handler(intent, entities, message: FakeMessage):
    await message.channel.send(f"{intent}:{entities.get('category')}")


@dataclass
class ScenarioCase:
    name: str
    prompt: str
    llm_fixture: str
    handler: Callable = handle_intent
    sheet_fixture: Optional[str] = None
    assert_fn: Optional[Callable] = None


def make_assert_log_expense(expected_amount: float):
    def _assert(result, repo):
        assert result.replies, "No reply captured for log_expense"
        reply = result.replies[0]
        assert "Food expense logged" in reply
        # Extract numeric portion after '$' and before the next space/punctuation.
        try:
            amt_part = reply.split("$", 1)[1].split(" ", 1)[0].replace(",", "")
            assert abs(float(amt_part) - expected_amount) < 1e-6
        except Exception:
            raise AssertionError(f"Could not parse amount from reply: {reply}")
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
        assert float(amount_cell.value) == expected_amount
        assert person_cell.value == "Hannah"
        return True

    return _assert


SCENARIOS = [
    # =========================================================================
    # Logging Actions
    # =========================================================================
    ScenarioCase(
        name="log_expense__natural",
        prompt="Paid $18.50 for coffee",
        llm_fixture="unit_tests/fixtures/llm/logging_actions/log_expense/log_expense__natural.json",
        sheet_fixture="base_month",
        assert_fn=make_assert_log_expense(18.5),
    ),
    ScenarioCase(
        name="log_expense__short",
        prompt="coffee 5",
        llm_fixture="unit_tests/fixtures/llm/logging_actions/log_expense/log_expense__short.json",
        sheet_fixture="base_month",
        assert_fn=make_assert_log_expense(5.0),
    ),
    ScenarioCase(
        name="log_expense__typo",
        prompt="Payd 12 for cofee",
        llm_fixture="unit_tests/fixtures/llm/logging_actions/log_expense/log_expense__typo.json",
        sheet_fixture="base_month",
        assert_fn=make_assert_log_expense(12.0),
    ),
    ScenarioCase(
        name="log_rent_paid__natural",
        prompt="Log rent payment 2000",
        llm_fixture="unit_tests/fixtures/llm/logging_actions/log_rent_paid/log_rent_paid__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="log_smud_paid__natural",
        prompt="SMUD payment 140",
        llm_fixture="unit_tests/fixtures/llm/logging_actions/log_smud_paid/log_smud_paid__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="log_student_loan_paid__natural",
        prompt="Student loan payment 325",
        llm_fixture="unit_tests/fixtures/llm/logging_actions/log_student_loan_paid/log_student_loan_paid__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="log_income__natural",
        prompt="Log income 1000 from Acme",
        llm_fixture="unit_tests/fixtures/llm/logging_actions/log_income/log_income__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: result.intent == "log_income",
    ),
    ScenarioCase(
        name="log_need_expense__natural",
        prompt="Need expense bus ticket 45",
        llm_fixture="unit_tests/fixtures/llm/logging_actions/log_need_expense/log_need_expense__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "Need expense" in result.replies[0],
    ),
    ScenarioCase(
        name="log_1st_savings__natural",
        prompt="log first savings 300",
        llm_fixture="unit_tests/fixtures/llm/logging_actions/log_1st_savings/log_1st_savings__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "savings" in result.replies[0].lower(),
    ),
    ScenarioCase(
        name="log_2nd_savings__natural",
        prompt="log second savings 250",
        llm_fixture="unit_tests/fixtures/llm/logging_actions/log_2nd_savings/log_2nd_savings__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "savings" in result.replies[0].lower(),
    ),
    ScenarioCase(
        name="harness_echo_log_expense",
        prompt="Paid $18.50 for coffee",
        llm_fixture="unit_tests/fixtures/llm/logging_actions/log_expense/log_expense__natural.json",
        handler=_echo_handler,
        assert_fn=lambda result, repo: (
            result.intent == "log_expense"
            and result.entities["category"] == "food"
            and result.replies == ["log_expense:food"]
        ),
    ),
    # =========================================================================
    # Checking Payments
    # =========================================================================
    ScenarioCase(
        name="query_rent_paid__natural",
        prompt="Did we already pay rent?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_rent_paid/query_rent_paid__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: result.replies
        == ["✅ You paid $2000.00 for rent this month."],
    ),
    ScenarioCase(
        name="query_rent_paid__short",
        prompt="Is rent already paid this month?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_rent_paid/query_rent_paid__short.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: result.replies
        == ["✅ You paid $2000.00 for rent this month."],
    ),
    ScenarioCase(
        name="query_rent_paid__typo",
        prompt="did we pay rentt?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_rent_paid/query_rent_paid__typo.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: result.replies
        == ["✅ You paid $2000.00 for rent this month."],
    ),
    ScenarioCase(
        name="query_smud_paid__natural",
        prompt="Did we pay SMUD?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_smud_paid/query_smud_paid__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "SMUD" in result.replies[0],
    ),
    ScenarioCase(
        name="query_smud_paid__short",
        prompt="smud paid?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_smud_paid/query_smud_paid__short.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "SMUD" in result.replies[0],
    ),
    ScenarioCase(
        name="query_smud_paid__typo",
        prompt="did we pay smd?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_smud_paid/query_smud_paid__typo.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "SMUD" in result.replies[0],
    ),
    ScenarioCase(
        name="query_student_loans_paid__natural",
        prompt="Have we paid the student loan?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_student_loans_paid/query_student_loans_paid__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "student loan" in result.replies[0].lower(),
    ),
    ScenarioCase(
        name="query_student_loans_paid__short",
        prompt="student loan paid?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_student_loans_paid/query_student_loans_paid__short.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "student loan" in result.replies[0].lower(),
    ),
    ScenarioCase(
        name="query_student_loans_paid__typo",
        prompt="did we pay the studnt loan?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_student_loans_paid/query_student_loans_paid__typo.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "student loan" in result.replies[0].lower(),
    ),
    ScenarioCase(
        name="query_subscriptions__natural",
        prompt="What subscriptions do we have?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_subscriptions/query_subscriptions__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "subscriptions" in result.replies[0].lower(),
    ),
    ScenarioCase(
        name="query_subscriptions__short",
        prompt="subs?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_subscriptions/query_subscriptions__short.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "subscriptions" in result.replies[0].lower(),
    ),
    ScenarioCase(
        name="query_subscriptions__typo",
        prompt="subscrptions?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_subscriptions/query_subscriptions__typo.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: "subscriptions" in result.replies[0].lower(),
    ),
    ScenarioCase(
        name="query_1st_savings__natural",
        prompt="Did we deposit 1st savings?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_1st_savings/query_1st_savings__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_2nd_savings__natural",
        prompt="Did we deposit 2nd savings?",
        llm_fixture="unit_tests/fixtures/llm/checking_payments/query_2nd_savings/query_2nd_savings__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    # =========================================================================
    # Category & Totals
    # =========================================================================
    ScenarioCase(
        name="query_total_for_store__natural",
        prompt="How much have we spent at Trader Joe's?",
        llm_fixture="unit_tests/fixtures/llm/category_item_totals/query_total_for_store/query_total_for_store__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: (
            bool(result.replies)
            and "Trader Joe's" in result.replies[0]
            and "$120.00" in result.replies[0]
        ),
    ),
    ScenarioCase(
        name="query_total_for_store__short",
        prompt="How much spent at trader joes?",
        llm_fixture="unit_tests/fixtures/llm/category_item_totals/query_total_for_store/query_total_for_store__short.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: (
            bool(result.replies)
            and ("TJ" in result.replies[0] or "Trader Joe" in result.replies[0])
            and "$120.00" in result.replies[0]
        ),
    ),
    ScenarioCase(
        name="query_total_for_store__typo",
        prompt="total spent at trader joes?",
        llm_fixture="unit_tests/fixtures/llm/category_item_totals/query_total_for_store/query_total_for_store__typo.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: (
            bool(result.replies)
            and "Trader" in result.replies[0]
            and "$120.00" in result.replies[0]
        ),
    ),
    ScenarioCase(
        name="query_total_for_category__natural",
        prompt="How much on food this month?",
        llm_fixture="unit_tests/fixtures/llm/category_item_totals/query_total_for_category/query_total_for_category__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_total_for_category__short",
        prompt="total food?",
        llm_fixture="unit_tests/fixtures/llm/category_item_totals/query_total_for_category/query_total_for_category__short.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_total_for_category__typo",
        prompt="how much on fud",
        llm_fixture="unit_tests/fixtures/llm/category_item_totals/query_total_for_category/query_total_for_category__typo.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_total_for_item__natural",
        prompt="How much on coffee?",
        llm_fixture="unit_tests/fixtures/llm/category_item_totals/query_total_for_item/query_total_for_item__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_total_for_item__short",
        prompt="spent on coffee?",
        llm_fixture="unit_tests/fixtures/llm/category_item_totals/query_total_for_item/query_total_for_item__short.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_total_for_item__typo",
        prompt="how much on coffe",
        llm_fixture="unit_tests/fixtures/llm/category_item_totals/query_total_for_item/query_total_for_item__typo.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    # =========================================================================
    # Largest / Most Frequent
    # =========================================================================
    ScenarioCase(
        name="query_highest_expense_category__natural",
        prompt="What's the highest expense category?",
        llm_fixture="unit_tests/fixtures/llm/largest_most_frequent/query_highest_expense_category/query_highest_expense_category__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_top_n_expenses__natural",
        prompt="Top expenses?",
        llm_fixture="unit_tests/fixtures/llm/largest_most_frequent/query_top_n_expenses/query_top_n_expenses__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_most_frequent_purchases__natural",
        prompt="Most frequent purchases?",
        llm_fixture="unit_tests/fixtures/llm/largest_most_frequent/query_most_frequent_purchases/query_most_frequent_purchases__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_largest_single_expense__natural",
        prompt="Largest single expense?",
        llm_fixture="unit_tests/fixtures/llm/largest_most_frequent/query_largest_single_expense/query_largest_single_expense__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    # =========================================================================
    # Time-based analysis
    # =========================================================================
    ScenarioCase(
        name="query_spent_this_week__natural",
        prompt="How much have we spent this week?",
        llm_fixture="unit_tests/fixtures/llm/time_based_analysis/query_spent_this_week/query_spent_this_week__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_no_spend_days__natural",
        prompt="How many no-spend days?",
        llm_fixture="unit_tests/fixtures/llm/time_based_analysis/query_no_spend_days/query_no_spend_days__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_longest_no_spend_streak__natural",
        prompt="Longest no-spend streak?",
        llm_fixture="unit_tests/fixtures/llm/time_based_analysis/query_longest_no_spend_streak/query_longest_no_spend_streak__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_days_budget_lasts__natural",
        prompt="How many days will budget last?",
        llm_fixture="unit_tests/fixtures/llm/time_based_analysis/query_days_budget_lasts/query_days_budget_lasts__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_expenses_on_day__natural",
        prompt="What did we spend on 05/10/2025?",
        llm_fixture="unit_tests/fixtures/llm/time_based_analysis/query_expenses_on_day/query_expenses_on_day__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_daily_spending_calendar__natural",
        prompt="Show the daily spending calendar",
        llm_fixture="unit_tests/fixtures/llm/time_based_analysis/query_daily_spending_calendar/query_daily_spending_calendar__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: any("daily spending" in reply.lower() for reply in result.replies),
    ),
    ScenarioCase(
        name="query_weekend_vs_weekday__natural",
        prompt="Weekend vs weekday spending?",
        llm_fixture="unit_tests/fixtures/llm/time_based_analysis/query_weekend_vs_weekday/query_weekend_vs_weekday__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_best_worst_day_of_week__natural",
        prompt="Best and worst spending days?",
        llm_fixture="unit_tests/fixtures/llm/time_based_analysis/query_best_worst_day_of_week/query_best_worst_day_of_week__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    # =========================================================================
    # Spending & budget overview
    # =========================================================================
    ScenarioCase(
        name="query_burn_rate__natural",
        prompt="What's our burn rate?",
        llm_fixture="unit_tests/fixtures/llm/spending_budget_overview/query_burn_rate/query_burn_rate__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_remaining_budget__natural",
        prompt="How much budget remains?",
        llm_fixture="unit_tests/fixtures/llm/spending_budget_overview/query_remaining_budget/query_remaining_budget__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_projected_spending__natural",
        prompt="What's our projected spending?",
        llm_fixture="unit_tests/fixtures/llm/spending_budget_overview/query_projected_spending/query_projected_spending__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_total_income__natural",
        prompt="Total income this month?",
        llm_fixture="unit_tests/fixtures/llm/spending_budget_overview/query_total_income/query_total_income__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_average_daily_spend__natural",
        prompt="Average daily spend?",
        llm_fixture="unit_tests/fixtures/llm/spending_budget_overview/query_average_daily_spend/query_average_daily_spend__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
    ScenarioCase(
        name="query_expense_breakdown_percentages__natural",
        prompt="Give me an expense breakdown",
        llm_fixture="unit_tests/fixtures/llm/spending_budget_overview/query_expense_breakdown_percentages/query_expense_breakdown_percentages__natural.json",
        sheet_fixture="base_month",
        assert_fn=lambda result, repo: bool(result.replies),
    ),
]


def test_intent_scenarios(llm_client_factory):
    for case in SCENARIOS:
        repo = build_repo_from_fixture(case.sheet_fixture) if case.sheet_fixture else None
        llm_client = llm_client_factory(case.llm_fixture)

        async def _run():
            ctx = repo.patched() if repo else contextlib.nullcontext()
            with ctx:
                return await run_scenario(
                    case.prompt,
                    llm_client=llm_client,
                    handler=case.handler,
                )

        result = asyncio.run(_run())
        if case.assert_fn:
            assert case.assert_fn(result, repo)
