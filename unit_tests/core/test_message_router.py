import pytest

from bookiebot.core.message_router import _action_management_intent
from bookiebot.core.message_router import _format_processing_error
from bookiebot.core.message_router import _maybe_typing


class DummyTyping:
    def __init__(self, channel):
        self.channel = channel

    async def __aenter__(self):
        self.channel.typing_enters += 1

    async def __aexit__(self, exc_type, exc, tb):
        self.channel.typing_exits += 1


class TypingChannel:
    def __init__(self):
        self.typing_enters = 0
        self.typing_exits = 0

    def typing(self):
        return DummyTyping(self)


class TypingMessage:
    def __init__(self):
        self.channel = TypingChannel()


@pytest.mark.asyncio
async def test_message_router_maybe_typing_wraps_pre_intent_work():
    message = TypingMessage()

    async with _maybe_typing(message):
        pass

    assert message.channel.typing_enters == 1
    assert message.channel.typing_exits == 1


def test_delete_unspecified_expense_routes_to_recent_actions():
    assert _action_management_intent("I need to delete an expense") == (
        "query_recent_actions",
        {"n": 5},
    )


def test_delete_specific_expense_routes_to_targeted_delete():
    assert _action_management_intent("I need to delete the Chipotle expense") == (
        "delete_recent_action",
        {"match_text": "chipotle"},
    )


def test_change_unspecified_expense_routes_to_recent_actions():
    assert _action_management_intent("I need to change a transaction") == (
        "query_recent_actions",
        {"n": 5},
    )


def test_change_specific_expense_without_value_routes_to_update_candidates():
    assert _action_management_intent("I need to change the amount for the Chipotle expense") == (
        "update_recent_action",
        {"match_text": "chipotle", "updates": {}},
    )


def test_move_specific_expense_routes_to_move_action():
    assert _action_management_intent("move the Chipotle expense to food") == (
        "move_recent_action",
        {"category": "food", "match_text": "chipotle"},
    )


def test_change_category_routes_to_move_action():
    assert _action_management_intent("change the category for the Target expense to shopping") == (
        "move_recent_action",
        {"category": "shopping", "match_text": "target"},
    )


def test_selected_transaction_move_followup_routes_to_move_action():
    assert _action_management_intent("move it to food") == (
        "move_recent_action",
        {"category": "food"},
    )


def test_change_item_name_routes_to_recent_actions():
    assert _action_management_intent("change item name") == (
        "query_recent_actions",
        {"n": 5},
    )


def test_change_last_transaction_item_name_routes_to_recent_actions():
    assert _action_management_intent("change item name of last transaction") == (
        "query_recent_actions",
        {"n": 5},
    )


def test_indexed_move_routes_to_move_action():
    from bookiebot.core.message_router import _indexed_action_intent

    assert _indexed_action_intent("2 move to food") == (
        "move_recent_action",
        {"index": 2, "category": "food"},
    )


def test_recent_query_show_more():
    from bookiebot.core.message_router import _recent_query_intent

    assert _recent_query_intent("show more") == (
        "query_recent_actions",
        {"more": True},
    )


def test_recent_query_explicit_n_is_preserved():
    from bookiebot.core.message_router import _recent_query_intent

    assert _recent_query_intent("show last 10 transactions") == (
        "query_recent_actions",
        {"n": 10, "explicit_n": True},
    )


def test_recent_query_explicit_n_caps_at_25():
    from bookiebot.core.message_router import _recent_query_intent

    assert _recent_query_intent("show last 30 transactions") == (
        "query_recent_actions",
        {"n": 25, "explicit_n": True},
    )


def test_processing_error_reply_includes_context_for_income():
    reply = _format_processing_error(
        "log_income",
        {"amount": 21.88, "source": "Amazon", "label": "Return"},
        RuntimeError("post-write bookkeeping failed"),
    )

    assert "I hit an error while logging income" in reply
    assert "Request: log_income $21.88 from Amazon (Return)" in reply
    assert "Error: RuntimeError: post-write bookkeeping failed" in reply
    assert "sheet may already have been updated" in reply
