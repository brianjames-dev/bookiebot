from bookiebot.core.message_router import _action_management_intent


def test_delete_unspecified_expense_routes_to_recent_actions():
    assert _action_management_intent("I need to delete an expense") == (
        "query_recent_actions",
        {"n": 10},
    )


def test_delete_specific_expense_routes_to_targeted_delete():
    assert _action_management_intent("I need to delete the Chipotle expense") == (
        "delete_recent_action",
        {"match_text": "chipotle"},
    )


def test_change_unspecified_expense_routes_to_recent_actions():
    assert _action_management_intent("I need to change a transaction") == (
        "query_recent_actions",
        {"n": 10},
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
