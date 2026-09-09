import json

import pytest

from bookiebot.sheets import collaboration, undo, writer
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


def shared_split(repo, operation):
    source = log(repo, B, "Shared groceries", 200)
    with sheet_user_context(B):
        assert undo.split_recent_action(B, split_method="equal", action_id=source)[0]
        if operation == "change":
            first_split = undo.recent_actions(B, 1)[0]
            assert undo.change_split_recent_action(B, split_method="income", action_id=first_split.id)[0]
        return undo.recent_actions(B, 1)[0], collaboration.list_allocations(B)[0]


def split_state(repo):
    sheets = (repo.expense, repo.shared_reimbursements, repo.action_log)
    return ([sheet.get_all_values() for sheet in sheets],
            [(sheet.update_calls, sheet.update_cell_calls) for sheet in sheets])


def undo_split(logged, trigger):
    with sheet_user_context(B):
        return undo.undo_last_action(B) if trigger == "last" else undo.undo_logged_action(B, logged.id)


@pytest.mark.parametrize("operation", ["apply", "change"])
@pytest.mark.parametrize("payment", ["partial", "full"])
@pytest.mark.parametrize("trigger", ["last", "selected"])
def test_paid_split_undo_does_not_change_expense_allocation_or_history(repo, operation, payment, trigger):
    logged, allocation = shared_split(repo, operation)
    collaboration.update_allocation(allocation.allocation_id,
                                    status="reimbursed" if payment == "full" else "outstanding",
                                    received_amount=allocation.partner_share if payment == "full" else 20)
    before = split_state(repo)

    success, message = undo_split(logged, trigger)

    assert not success
    assert "reimbursed" in message
    assert split_state(repo) == before


@pytest.mark.parametrize("operation", ["apply", "change"])
@pytest.mark.parametrize("payment", ["unpaid", "partial", "full"])
def test_split_undo_fails_closed_on_one_ledger_read_timeout(repo, monkeypatch, operation, payment):
    logged, allocation = shared_split(repo, operation)
    if payment != "unpaid":
        collaboration.update_allocation(allocation.allocation_id,
                                        status="reimbursed" if payment == "full" else "outstanding",
                                        received_amount=allocation.partner_share if payment == "full" else 20)
    before = split_state(repo)
    read = repo.shared_reimbursements.get_all_values
    failed = False

    def fail_once():
        nonlocal failed
        if not failed:
            failed = True
            raise TimeoutError("Temporary ledger read failure")
        return read()

    monkeypatch.setattr(repo.shared_reimbursements, "get_all_values", fail_once)
    success, message = undo_split(logged, "last")

    assert failed
    assert not success
    assert "reimbursement record" in message
    assert split_state(repo) == before, "No mutation or compensating write is safe before settlement state is verified"
    if payment == "unpaid":
        assert undo_split(logged, "last")[0], "An unchanged unpaid split can be retried after the read recovers"


@pytest.mark.parametrize("operation", ["apply", "change"])
@pytest.mark.parametrize("missing", ["allocation", "allocation_id", "void"])
def test_split_undo_requires_a_verified_active_linked_allocation(repo, operation, missing):
    logged, allocation = shared_split(repo, operation)
    if missing == "allocation":
        assert collaboration.remove_allocation(allocation.allocation_id)
    elif missing == "void":
        collaboration.update_allocation(allocation.allocation_id, status="void")
    else:
        for row_number, row in enumerate(repo.action_log.get_all_values(), start=1):
            if row[0] == logged.id:
                payload = json.loads(row[5])
                payload["metadata"].pop("allocation_id")
                repo.action_log.update_cell(row_number, 6, json.dumps(payload))
                break
    before = split_state(repo)

    success, message = undo_split(logged, "selected")

    assert not success
    assert "reimbursement record" in message
    assert split_state(repo) == before
