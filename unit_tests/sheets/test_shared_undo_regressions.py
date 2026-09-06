import pytest

from bookiebot.sheets import undo, writer
from bookiebot.sheets.routing import sheet_user_context
from unit_tests.support.sheets_repo_stub import SheetsRepoStub

B = "676638528590970917"
H = "830984827904851969"


@pytest.fixture
def repo(monkeypatch):
    monkeypatch.setattr(undo, "_sync_reconciliation_after_action_mutation", lambda *a, **k: None)
    value = SheetsRepoStub(expense_rows=[[], []])
    with value.patched():
        yield value


def log(repo, actor, item, amount, category="food"):
    values = {"date": "9/6/2026", "item": item, "amount": amount,
              "location": "Shop", "person": "Brian (BofA)" if actor == B else "Hannah"}
    with sheet_user_context(actor):
        row = writer.log_category_row(values, repo.expense, category)
        return writer.record_expense_undo(category, row, values, values["person"], actor)


def remove(actor, action, operation):
    with sheet_user_context(actor):
        if operation == "delete":
            result = undo.delete_recent_action(actor, action_id=action)
        else:
            result = undo.move_recent_action(actor, action_id=action, destination_category="shopping")
        assert result[0], result[1]


def food(repo):
    return {row[14]: row[15] for row in repo.expense.get_all_values()[2:]
            if len(row) > 15 and row[14]}


@pytest.mark.parametrize("operation", ["delete", "move"])
def test_undo_preserves_other_user_correction_and_new_expense(repo, operation):
    burger = log(repo, B, "Burger", 10)
    coffee = log(repo, H, "Coffee", 5)
    remove(B, burger, operation)
    with sheet_user_context(H):
        assert undo.update_recent_action(H, action_id=coffee, updates={"amount": 6})[0]
    log(repo, H, "Tea", 7)
    with sheet_user_context(B):
        assert undo.undo_last_action(B)[0]
    assert food(repo) == {"Burger": "$10.00", "Coffee": "$6.00", "Tea": "$7.00"}
    with sheet_user_context(H):
        assert undo.update_recent_action(H, action_id=coffee, updates={"amount": 8})[0]
    assert food(repo)["Coffee"] == "$8.00"
    assert food(repo)["Tea"] == "$7.00"


@pytest.mark.parametrize("operation", ["delete", "move"])
def test_undo_tracks_restore_position_after_another_user_deletes_preceding_row(repo, operation):
    first = log(repo, H, "First", 1)
    middle = log(repo, B, "Middle", 2)
    last = log(repo, H, "Last", 3)
    remove(B, middle, operation)
    remove(H, first, "delete")
    with sheet_user_context(B):
        assert undo.undo_last_action(B)[0]
        assert undo.update_recent_action(B, action_id=middle, updates={"amount": 20})[0]
    assert food(repo) == {"Middle": "$20.00", "Last": "$3.00"}
    with sheet_user_context(H):
        assert undo.update_recent_action(H, action_id=last, updates={"amount": 30})[0]
    assert food(repo)["Last"] == "$30.00"


def test_undo_move_refuses_a_changed_destination_without_restoring_source(repo):
    action = log(repo, B, "Burger", 10)
    remove(B, action, "move")
    repo.expense.update_cell(3, 24, "$99.00")
    before = repo.expense.get_all_values()
    with sheet_user_context(B):
        success, message = undo.undo_last_action(B)
    assert not success
    assert "changed" in message
    assert repo.expense.get_all_values() == before


def test_undo_preserves_an_intervening_manual_draft_row(repo):
    action = log(repo, B, "Burger", 10)
    remove(B, action, "delete")
    repo.expense.update_cell(3, 15, "Draft coffee")
    with sheet_user_context(B):
        assert undo.undo_last_action(B)[0]
    assert repo.expense.cell(3, 15).value == "Burger"
    assert repo.expense.cell(4, 15).value == "Draft coffee"
