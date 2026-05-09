import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import bookiebot.intents.handlers as ih
from bookiebot.sheets.routing import SpreadsheetAccessError
from unit_tests.support.sheets_repo_stub import SheetsRepoStub


class DummyChannel:
    def __init__(self):
        self.sent = []

    async def send(self, content=None, **kwargs):
        self.sent.append((content, kwargs))


@pytest.fixture(autouse=True)
def _patch_resolver(monkeypatch):
    monkeypatch.setattr(ih, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    yield


@pytest.fixture
def message():
    return SimpleNamespace(
        content="hi",
        author=SimpleNamespace(name="hannerish", id=830984827904851969),
        channel=DummyChannel(),
    )


# Logging intents
@pytest.mark.asyncio
async def test_log_expense_calls_writer(monkeypatch, message):
    writer = AsyncMock()
    monkeypatch.setattr(ih, "write_to_sheet", writer)
    data = {"type": "expense", "category": "food", "amount": 5.0, "item": "Coffee", "person": "Hannah"}

    await ih.handle_intent("log_expense", data, message)

    writer.assert_awaited_once_with(data, message)


@pytest.mark.asyncio
async def test_log_income_calls_writer(monkeypatch, message):
    writer = AsyncMock()
    monkeypatch.setattr(ih, "write_to_sheet", writer)
    data = {"type": "income", "amount": 1000.0, "source": "Paycheck"}

    await ih.handle_intent("log_income", data, message)

    writer.assert_awaited_once_with(data, message)


@pytest.mark.asyncio
async def test_log_income_adds_missing_transaction_type(monkeypatch, message):
    writer = AsyncMock()
    monkeypatch.setattr(ih, "write_to_sheet", writer)
    data = {"amount": 21.88, "date": "2026-05-09", "source": "Amazon", "label": "Return"}

    await ih.handle_intent("log_income", data, message)

    writer.assert_awaited_once()
    written_data, written_message = writer.await_args.args
    assert written_message is message
    assert written_data["type"] == "income"
    assert written_data["amount"] == 21.88
    assert written_data["source"] == "Amazon"
    assert written_data["label"] == "Return"


@pytest.mark.asyncio
async def test_sheet_routing_errors_are_sent_to_user(monkeypatch, message):
    writer = AsyncMock(side_effect=SpreadsheetAccessError("Could not open spreadsheet 'abc'."))
    monkeypatch.setattr(ih, "write_to_sheet", writer)

    await ih.handle_intent("log_income", {"type": "income", "amount": 1000.0}, message)

    assert message.channel.sent == [("Could not open spreadsheet 'abc'.", {})]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("intent", "func_name", "amount", "expected"),
    [
        ("log_rent_paid", "log_rent_paid", 1200.0, "rent"),
        ("log_pge_paid", "log_pge_paid", 85.0, "PG&E"),
        ("log_recology_paid", "log_recology_paid", 85.0, "Recology"),
        ("log_water_paid", "log_water_paid", 85.0, "water"),
        ("log_student_loan_paid", "log_student_loan_paid", 250.0, "student loan"),
        ("log_1st_savings", "log_1st_savings", 100.0, "1st savings"),
        ("log_2nd_savings", "log_2nd_savings", 200.0, "2nd savings"),
    ],
)
async def test_logging_helpers_success(monkeypatch, message, intent, func_name, amount, expected):
    monkeypatch.setattr(ih.su, func_name, lambda amt: True)

    await ih.handle_intent(intent, {"amount": amount}, message)

    assert any(expected in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_log_need_expense(monkeypatch, message):
    monkeypatch.setattr(ih.su, "log_need_expense", lambda desc, amt: True)

    await ih.handle_intent("log_need_expense", {"description": "Groceries", "amount": 42.0}, message)

    assert any("Need expense" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_undo_last_transaction_clears_logged_expense(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "food", "amount": 5.0, "item": "Coffee", "location": "Cafe"},
            message,
        )

        assert repo.expense.cell(3, 16).value == "5.0"

        await ih.handle_intent("undo_last_transaction", {}, message)

        assert repo.expense.cell(3, 16).value == ""
        assert any("Undid:" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_recent_actions_lists_logged_expense(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "food", "amount": 12.5, "item": "Burrito", "location": "Chipotle"},
            message,
        )

        await ih.handle_intent("query_recent_actions", {"n": 5}, message)

    assert any("Amount: $12.5" in (msg or "") for msg, _ in message.channel.sent)
    assert any("Location: Chipotle" in (msg or "") for msg, _ in message.channel.sent)
    assert any("Food Expense" in (msg or "") for msg, _ in message.channel.sent)
    assert any("Type `show more` to see older transactions." in (msg or "") for msg, _ in message.channel.sent)
    assert not any("Type the number of the transaction, followed by what should happen to it" in (msg or "") for msg, _ in message.channel.sent)
    assert any(kwargs.get("view") is not None for _msg, kwargs in message.channel.sent)


@pytest.mark.asyncio
async def test_update_recent_action_changes_logged_expense_amount(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "food", "amount": 12.5, "item": "Burrito", "location": "Chipotle"},
            message,
        )

        await ih.handle_intent("update_recent_action", {"index": 1, "updates": {"amount": 14.75}}, message)

        assert repo.expense.cell(3, 16).value == "14.75"

        await ih.handle_intent("undo_last_transaction", {}, message)

        assert repo.expense.cell(3, 16).value == "12.5"

    assert any("Before:\n```" in (msg or "") for msg, _ in message.channel.sent)
    assert any("Amount: $12.5" in (msg or "") and "Amount: $14.75" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_update_recent_action_can_match_logged_expense_text(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "food", "amount": 12.5, "item": "Burrito", "location": "Chipotle"},
            message,
        )

        await ih.handle_intent("update_recent_action", {"match_text": "Chipotle", "updates": {"location": "Chipotle downtown"}}, message)

        assert repo.expense.cell(3, 17).value == "Chipotle downtown"


@pytest.mark.asyncio
async def test_recent_actions_display_updated_action_with_full_fields(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "food", "amount": 12.5, "item": "Burrito", "location": "Chipotle"},
            message,
        )
        await ih.handle_intent("update_recent_action", {"index": 1, "updates": {"amount": 14.75}}, message)
        await ih.handle_intent("query_recent_actions", {"n": 5}, message)

    recent_reply = message.channel.sent[-1][0] or ""
    assert "Updated: Food Expense" in recent_reply
    assert "Item: Burrito" in recent_reply
    assert "Location: Chipotle" in recent_reply
    assert "Amount: $14.75" in recent_reply
    assert "Person: Hannah" in recent_reply


@pytest.mark.asyncio
async def test_recent_actions_hide_original_after_update(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "food", "amount": 10.0, "item": "Burger", "location": "Wendy's"},
            message,
        )
        await ih.handle_intent("update_recent_action", {"index": 1, "updates": {"item": "Cookie"}}, message)
        await ih.handle_intent("query_recent_actions", {"n": 5}, message)

    recent_reply = message.channel.sent[-1][0] or ""
    assert "1. Updated: Food Expense" in recent_reply
    assert "2. Food Expense" not in recent_reply
    assert recent_reply.count("Location: Wendy's") == 1


@pytest.mark.asyncio
async def test_recent_actions_hide_moved_action_after_update(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "grocery", "amount": 5.0, "item": "Groceries", "location": "Costco"},
            message,
        )
        await ih.handle_intent("move_recent_action", {"index": 1, "category": "food", "updates": {"item": "Cookie"}}, message)
        await ih.handle_intent("update_recent_action", {"index": 1, "updates": {"amount": 6.0}}, message)
        await ih.handle_intent("query_recent_actions", {"n": 5}, message)

    recent_reply = message.channel.sent[-1][0] or ""
    assert "1. Updated: Food Expense" in recent_reply
    assert "2. Moved Expense" not in recent_reply
    assert recent_reply.count("Location: Costco") == 1
    assert "Amount: $6.0" in recent_reply


@pytest.mark.asyncio
async def test_update_recent_action_lists_candidates_when_value_missing(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "food", "amount": 12.5, "item": "Burrito", "location": "Chipotle"},
            message,
        )

        await ih.handle_intent("update_recent_action", {"match_text": "Chipotle", "updates": {}}, message)

        assert repo.expense.cell(3, 16).value == "12.5"

    assert any("Type the number of the transaction you want to update" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_update_recent_action_asks_for_value_after_candidate_selected(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "food", "amount": 12.5, "item": "Burrito", "location": "Chipotle"},
            message,
        )

        await ih.handle_intent("update_recent_action", {"match_text": "Chipotle", "updates": {}}, message)
        await ih.handle_intent("update_recent_action", {"index": 1, "updates": {}}, message)

    assert any("Please specify the new value" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_delete_recent_action_lists_matching_candidates_before_delete(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "food", "amount": 12.5, "item": "Burrito", "location": "Chipotle"},
            message,
        )

        await ih.handle_intent("delete_recent_action", {"match_text": "Chipotle"}, message)

        assert repo.expense.cell(3, 16).value == "12.5"

    assert any("Type the number of the transaction you want to delete" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_delete_recent_action_deletes_pending_candidate_by_index(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "food", "amount": 12.5, "item": "Burrito", "location": "Chipotle"},
            message,
        )
        await ih.handle_intent("delete_recent_action", {"match_text": "Chipotle"}, message)
        await ih.handle_intent("delete_recent_action", {"index": 1}, message)

        assert repo.expense.cell(3, 14).value == ""
        assert repo.expense.cell(3, 16).value == ""
        assert repo.expense.cell(3, 17).value == ""

    assert any("Deleted: food expense $12.5 for Hannah" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_move_recent_action_moves_grocery_to_food_and_can_undo(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "grocery", "amount": 12.5, "item": "Burrito", "location": "Chipotle"},
            message,
        )

        assert repo.expense.cell(3, 2).value == "12.5"

        await ih.handle_intent("move_recent_action", {"index": 1, "category": "food", "updates": {"item": "Burrito"}}, message)

        assert repo.expense.cell(3, 2).value == ""
        assert repo.expense.cell(3, 15).value == "Burrito"
        assert repo.expense.cell(3, 16).value == "12.5"
        assert repo.expense.cell(3, 17).value == "Chipotle"
        assert repo.expense.cell(3, 18).value == "Hannah"

        await ih.handle_intent("undo_last_transaction", {}, message)

        assert repo.expense.cell(3, 2).value == "12.5"
        assert repo.expense.cell(3, 15).value == ""
        assert repo.expense.cell(3, 16).value == ""
        assert repo.expense.cell(3, 17).value == ""
        assert repo.expense.cell(3, 18).value == ""
        assert repo.expense.cell(3, 15).value != "None"
        assert repo.expense.cell(3, 16).value != "None"
        assert repo.expense.cell(3, 17).value != "None"
        assert repo.expense.cell(3, 18).value != "None"

    assert any("Moved logged expense" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_move_recent_action_asks_for_item_when_destination_requires_it(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "grocery", "amount": 12.5, "item": "Groceries", "location": "Chipotle"},
            message,
        )

        await ih.handle_intent("move_recent_action", {"index": 1, "category": "food"}, message)

        assert repo.expense.cell(3, 2).value == "12.5"
        assert repo.expense.cell(3, 15).value == ""
        assert repo.expense.cell(3, 16).value == ""

        await ih.handle_intent("move_recent_action", {"index": 1, "category": "food", "updates": {"item": "Burrito"}}, message)

        assert repo.expense.cell(3, 2).value == ""
        assert repo.expense.cell(3, 15).value == "Burrito"
        assert repo.expense.cell(3, 16).value == "12.5"
        assert repo.expense.cell(3, 17).value == "Chipotle"

    assert any((msg or "") == "What is the name of the item?" for msg, _ in message.channel.sent)
    assert any("Moved logged expense" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_move_recent_action_lists_candidates_before_category(monkeypatch, message):
    import bookiebot.sheets.writer as writer

    monkeypatch.setattr(writer, "resolve_query_persons", lambda user, person=None, user_id=None: ["Hannah"])
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        await ih.handle_intent(
            "log_expense",
            {"type": "expense", "category": "grocery", "amount": 12.5, "item": "Burrito", "location": "Chipotle"},
            message,
        )

        await ih.handle_intent("move_recent_action", {"match_text": "Chipotle", "category": "food"}, message)

    assert any("Type the number of the transaction you want to move" in (msg or "") for msg, _ in message.channel.sent)
    assert any(kwargs.get("view") is not None for _msg, kwargs in message.channel.sent)


def test_expense_undo_can_be_recorded_after_context_exits():
    from bookiebot.sheets.undo import undo_last_action
    import bookiebot.sheets.writer as writer

    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        row = writer.log_category_row(
            {"date": "5/5/2026", "amount": 50.0, "person": "Brian (AL)"},
            repo.expense,
            "gas",
        )
        writer.record_expense_undo("gas", row, 50.0, "Brian (AL)", "676638528590970917")

        success, detail = undo_last_action("676638528590970917")

        assert success is True
        assert "gas expense" in detail
        assert repo.expense.cell(row, 8).value == ""
        assert repo.expense.cell(row, 9).value == ""
        assert repo.expense.cell(row, 10).value == ""


# Query intents (happy paths via mocked helpers)
@pytest.mark.asyncio
async def test_query_burn_rate(monkeypatch, message):
    monkeypatch.setattr(ih.su, "calculate_burn_rate", AsyncMock(return_value=("$1/day", "desc")))

    await ih.handle_intent("query_burn_rate", {}, message)

    assert any("burn rate" in (msg or "").lower() for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_rent_paid(monkeypatch, message):
    monkeypatch.setattr(ih.su, "check_rent_paid", AsyncMock(return_value=(True, 1200.0)))

    await ih.handle_intent("query_rent_paid", {}, message)

    assert any("$1200.00" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("intent", "su_attr", "return_value", "expected_sub"),
    [
        ("query_pge_paid", "check_pge_paid", (True, 80.0), "PG&E"),
        ("query_recology_paid", "check_recology_paid", (True, 80.0), "Recology"),
        ("query_water_paid", "check_water_paid", (True, 80.0), "water"),
        ("query_student_loans_paid", "check_student_loan_paid", (False, 0.0), "NOT"),
        ("query_total_income", "total_income", 1500.0, "1500.00"),
        ("query_remaining_budget", "remaining_budget", 200.0, "Remaining spending budget"),
        ("query_average_daily_spend", "average_daily_spend", 5.5, "5.50"),
        ("query_total_for_category", "total_for_category", 42.0, "42.00"),
        ("query_spent_this_week", "spent_this_week", 77.0, "77.00"),
        ("query_projected_spending", "projected_spending", 300.0, "300.00"),
        ("query_weekend_vs_weekday", "weekend_vs_weekday", (10.0, 20.0), "10.00"),
        ("query_no_spend_days", "no_spend_days", (3, [1, 2, 3]), "3"),
        ("query_total_for_item", "total_spent_on_item", (15.0, []), "15.00"),
        ("query_daily_spending_calendar", "daily_spending_calendar", ("summary", MagicMock(filename="x.png")), "summary"),
        ("query_best_worst_day_of_week", "best_worst_day_of_week", {"best": ("Mon", 1.0), "worst": ("Fri", 5.0)}, "Mon"),
        ("query_longest_no_spend_streak", "longest_no_spend_streak", (2, 1, 2), "longest"),
        ("query_days_budget_lasts", "days_budget_lasts", 5.0, "5.0"),
    ],
)
async def test_simple_queries(monkeypatch, message, intent, su_attr, return_value, expected_sub):
    if isinstance(return_value, tuple) and not isinstance(return_value, MagicMock):
        monkeypatch.setattr(ih.su, su_attr, AsyncMock(return_value=return_value))
    else:
        monkeypatch.setattr(ih.su, su_attr, AsyncMock(return_value=return_value))

    entities: dict[str, object] = {"category": "food", "store": "Costco"}
    if intent == "query_total_for_item":
        entities["item"] = "Coffee"
    if intent == "query_daily_spending_calendar":
        entities["persons"] = ["Hannah"]
    await ih.handle_intent(intent, entities, message)

    assert any(expected_sub.lower() in (msg or "").lower() for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_total_for_store(monkeypatch, message):
    monkeypatch.setattr(ih.su, "total_spent_at_store", AsyncMock(return_value=(12.0, [])))

    await ih.handle_intent("query_total_for_store", {"store": "Costco"}, message)

    assert any("Costco" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_highest_expense_category(monkeypatch, message):
    monkeypatch.setattr(ih.su, "highest_expense_category", AsyncMock(return_value=("food", 50.0)))

    await ih.handle_intent("query_highest_expense_category", {"person": None}, message)

    assert any("food" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_expense_breakdown(monkeypatch, message):
    monkeypatch.setattr(ih.su, "expense_breakdown_percentages", AsyncMock(return_value={}))

    await ih.handle_intent("query_expense_breakdown_percentages", {}, message)

    assert any("could not calculate expense breakdown".lower() in (msg or "").lower() for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_total_for_category(monkeypatch, message):
    monkeypatch.setattr(ih.su, "total_for_category", AsyncMock(return_value=25.0))

    await ih.handle_intent("query_total_for_category", {"category": "food"}, message)

    assert any("food" in (msg or "").lower() for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_largest_single_expense(monkeypatch, message):
    monkeypatch.setattr(
        ih.su,
        "largest_single_expense",
        AsyncMock(
            return_value={"amount": 10.0, "item": "Coffee", "location": "Cafe", "date": "05/01", "category": "food"}
        ),
    )

    await ih.handle_intent("query_largest_single_expense", {}, message)

    assert any("largest single expense" in (msg or "").lower() for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_top_n_expenses(monkeypatch, message):
    monkeypatch.setattr(
        ih.su,
        "top_n_expenses_all_categories",
        AsyncMock(return_value=[{"amount": 20.0, "item": "Shoes", "location": "Store", "date": "05/01", "category": "shopping"}]),
    )

    await ih.handle_intent("query_top_n_expenses", {"n": 2}, message)

    assert any("Top 2" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_most_frequent_purchases(monkeypatch, message):
    monkeypatch.setattr(
        ih.su,
        "most_frequent_purchases",
        AsyncMock(return_value=[{"item": "coffee", "count": 2, "total": 5.0}]),
    )

    await ih.handle_intent("query_most_frequent_purchases", {}, message)

    assert any("coffee" in (msg or "").lower() for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_expenses_on_day(monkeypatch, message):
    monkeypatch.setattr(
        ih.su,
        "expenses_on_day",
        AsyncMock(return_value=([{"category": "food", "item": "Coffee", "location": "Cafe", "amount": 5.0}], 5.0)),
    )

    await ih.handle_intent("query_expenses_on_day", {"date": "05/10/2025"}, message)

    assert any("coffee" in (msg or "").lower() for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_subscriptions(monkeypatch, message):
    monkeypatch.setattr(ih.su, "list_subscriptions", AsyncMock(return_value=([("A", 10.0)], 10.0, [("B", 5.0)], 5.0)))

    await ih.handle_intent("query_subscriptions", {}, message)

    assert any("Subscriptions" in (msg or "") or "Need" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_query_savings_checks(monkeypatch, message):
    monkeypatch.setattr(
        ih.su,
        "check_1st_savings_deposited",
        AsyncMock(return_value={"deposited": True, "actual": 10.0, "ideal": 20.0, "minimum": 5.0}),
    )
    await ih.handle_intent("query_1st_savings", {}, message)
    assert any("1st savings" in (msg or "") for msg, _ in message.channel.sent)

    message.channel.sent.clear()
    monkeypatch.setattr(
        ih.su,
        "check_2nd_savings_deposited",
        AsyncMock(return_value={"deposited": False, "actual": 0.0, "ideal": 15.0, "minimum": 5.0}),
    )
    await ih.handle_intent("query_2nd_savings", {}, message)
    assert any("2nd savings" in (msg or "") for msg, _ in message.channel.sent)


@pytest.mark.asyncio
async def test_fallback(monkeypatch, message):
    class _Choice:
        def __init__(self, content):
            self.message = SimpleNamespace(content=content)

    class _Response:
        def __init__(self, content):
            self.choices = [_Choice(content)]

    monkeypatch.setattr(ih.openai.ChatCompletion, "create", lambda *a, **k: _Response("fallback reply"))

    await ih.handle_intent("unknown_intent", {}, message)

    assert any("fallback" in (msg or "").lower() or "sorry" in (msg or "").lower() for msg, _ in message.channel.sent)
