"""Reset commands preserve sheet spending and integrate with source corrections."""
from copy import deepcopy
from dataclasses import replace

import pytest

from bookiebot.reimbursements import migration, service
from bookiebot.reimbursements.store import ReimbursementConflictError
from bookiebot.sheets import undo
from bookiebot.sheets.collaboration import SHARED_REIMBURSEMENT_HEADERS, allocations_from_rows
from unit_tests.reimbursements.test_service import BRIAN, selected, setup, split  # noqa: F401
from unit_tests.reimbursements.test_store import access, command, payment  # noqa: F401


def reset(setup):
    return service.command("brian", command("reset", expectedState=setup.store.snapshot("brian")["resetState"],
                                            note="Settled outside BookieBot"))


def source_rows(setup):
    return {name: deepcopy(sheet.rows) for name, sheet in setup.book.sheets.items() if name != "Shared Reimbursements"}


def test_partial_receipt_reset_undo_redo_keep_purchase_and_repayment_rows_exactly(setup, monkeypatch):
    assert split(setup)[0]
    initial = setup.store.snapshot("brian")["allocations"][0]
    service.command("brian", payment(initial, 5000))
    before_rows = source_rows(setup)
    before_events = setup.store.snapshot("brian")["events"]
    def frozen_budget(*_args, **_kwargs):
        raise AssertionError("A balance-only reset must not inspect or change frozen expense budgets")
    monkeypatch.setattr(migration, "verify_budget_links", frozen_budget)

    result = reset(setup)
    for operation, expected_outstanding in (("undo_reset", 11391), ("redo_reset", 0)):
        assert result["projectionPending"] is False
        assert source_rows(setup) == before_rows
        assert result["events"] == before_events
        record = result["resets"][0]
        result = service.command("hannah", command(operation, resetId=record["id"], version=record["version"]))
        assert result["allocations"][0]["outstandingCents"] == expected_outstanding

    assert source_rows(setup) == before_rows
    assert result["events"] == before_events and len(setup.history) == 1
    allocation = result["allocations"][0]
    assert allocation["settledCents"] == 5000 and allocation["clearedCents"] == 11391
    mirror = setup.book.worksheet("Shared Reimbursements")
    assert mirror.rows[0] == SHARED_REIMBURSEMENT_HEADERS
    mirrored = allocations_from_rows(mirror.rows)[0]
    assert mirrored.status == "cleared" and mirrored.received_amount == 50
    assert mirrored.outstanding_amount == 0 and mirrored.cleared_amount == 113.91


@pytest.mark.parametrize("operation,kwargs", [
    ("update", {"updates": {"amount": "500.00"}}),
    ("move", {"destination_category": "grocery"}),
    ("split", {"split_method": "equal"}),
    ("cancel", {}),
    ("delete", {}),
])
def test_reset_blocks_existing_source_actions_until_undo_then_allows_them(setup, operation, kwargs):
    assert split(setup)[0]
    result = reset(setup)
    before_rows = source_rows(setup)
    success, message = service.mutate_recent_action(BRIAN, selected(setup), operation, **kwargs)
    assert not success and "Undo the balance reset" in message
    assert source_rows(setup) == before_rows
    record = result["resets"][0]
    undone = service.command("brian", command("undo_reset", resetId=record["id"], version=record["version"]))
    success, message = service.mutate_recent_action(BRIAN, selected(setup), operation, **kwargs)
    assert success and "syncing" not in message
    record = undone["resets"][0]
    with pytest.raises(ReimbursementConflictError):
        service.command("brian", command("redo_reset", resetId=record["id"], version=record["version"]))


def test_direct_canonical_undo_explains_reset_guard_without_rewriting_source(setup):
    assert split(setup)[0]
    reset(setup)
    before_rows = source_rows(setup)
    success, message = undo._apply_undo_action(setup.history[0], user_key=BRIAN)
    assert not success and "balance reset from Shared" in message
    assert source_rows(setup) == before_rows


@pytest.mark.parametrize("operation,kwargs", [
    ("split", {"split_method": "income"}),
    ("update", {"updates": {"amount": "464.72"}}),
    ("move", {"destination_category": "need_expenses"}),
])
def test_unchanged_source_action_after_reset_cannot_claim_original_balance_is_owed(setup, operation, kwargs):
    assert split(setup)[0]
    reset(setup)
    before_rows = source_rows(setup)
    before = setup.store.snapshot("brian")
    success, message = service.mutate_recent_action(BRIAN, selected(setup), operation, **kwargs)
    assert not success and "Undo the balance reset" in message
    assert setup.store.snapshot("brian") == before
    assert before["allocations"][0]["outstandingCents"] == 0
    assert source_rows(setup) == before_rows


def test_reset_lost_mirror_response_recovers_same_request_without_any_expense_projection(setup):
    assert split(setup)[0]
    before_rows = source_rows(setup)
    body = command("reset", expectedState=setup.store.snapshot("brian")["resetState"])
    setup.book.timeout_after_values = True
    result = service.command("brian", body)
    assert result["projectionPending"] is True and result["resets"][0]["canUndo"] is False
    assert source_rows(setup) == before_rows
    recovered = service.command("brian", body)
    assert recovered["projectionPending"] is False and recovered["resets"][0]["canUndo"] is True
    assert recovered["allocations"][0]["outstandingCents"] == 0
    assert len(recovered["resets"]) == 1 and not recovered["events"]
    assert source_rows(setup) == before_rows


@pytest.mark.parametrize("operation", ["split", "cancel", "undo"])
@pytest.mark.parametrize("received", [0, 25])
def test_legacy_sheet_mutations_cannot_revive_a_cleared_allocation(monkeypatch, operation, received):
    from bookiebot.sheets.collaboration import _allocation_row, list_allocations
    from bookiebot.sheets.routing import sheet_user_context
    from bookiebot.sheets.writer import log_category_row, record_expense_undo
    from unit_tests.support.sheets_repo_stub import SheetsRepoStub
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false")
    repo = SheetsRepoStub(expense_rows=[[], []])
    with repo.patched(), sheet_user_context(BRIAN):
        values = {"date": "8/3/2026", "amount": 200, "location": "Safeway", "person": "Brian (BofA)"}
        row = log_category_row(values, repo.expense, "grocery")
        source_id = record_expense_undo("grocery", row, values, values["person"], BRIAN)
        assert undo.split_recent_action(BRIAN, split_method="equal", action_id=source_id)[0]
        split_id = undo.recent_actions(BRIAN, 1)[0].id
        allocation = replace(list_allocations(BRIAN)[0], status="cleared", received_amount=received)
        repo.shared_reimbursements.update([_allocation_row(allocation)], range_name="A2:Y2")
        before = repo.expense.get_all_values()
        if operation == "split":
            success, message = undo.change_split_recent_action(BRIAN, split_method="income", action_id=split_id)
        elif operation == "cancel":
            success, message = undo.cancel_split_recent_action(BRIAN, action_id=split_id)
        else:
            success, message = undo.undo_last_action(BRIAN)
        assert not success and "balance reset from Shared" in message
        assert repo.expense.get_all_values() == before
        assert list_allocations(BRIAN)[0] == allocation
