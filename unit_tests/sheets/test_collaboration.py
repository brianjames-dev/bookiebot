from __future__ import annotations

from bookiebot.sheets.collaboration import (
    append_allocation,
    list_allocations,
    mark_reimbursed,
    new_allocation,
    split_amounts,
)
from bookiebot.sheets.undo import read_active_logged_actions, recent_actions, split_recent_action, undo_last_action
from bookiebot.sheets.writer import log_category_row, record_expense_undo
from bookiebot.sheets.routing import sheet_user_context
import bookiebot.sheets.utils as sheet_utils
from unit_tests.support.sheets_repo_stub import SheetsRepoStub


def test_income_split_uses_exact_household_income_ratio_and_penny_safe_remainder():
    brian_share, hannah_share = split_amounts(200, "income", "brian")

    assert brian_share == 129.46
    assert hannah_share == 70.54
    assert brian_share + hannah_share == 200


def test_equal_split_assigns_rounding_remainder_to_payer():
    payer_share, partner_share = split_amounts(10.01, "equal", "brian")

    assert payer_share == 5.01
    assert partner_share == 5.0


def test_shared_allocation_round_trips_and_reimbursement_only_changes_settlement_state():
    repo = SheetsRepoStub()
    allocation = new_allocation(
        actor_key="676638528590970917",
        payer="Brian (BofA)",
        source_action_id="expense1",
        source_worksheet="expense",
        source_category="grocery",
        source_row=12,
        expense_date="8/3/2026",
        item="Groceries",
        location="Safeway",
        gross_amount=200,
        split_method="income",
        payer_share=129.46,
        partner_share=70.54,
    )

    with repo.patched():
        append_allocation(allocation)
        stored = list_allocations("676638528590970917")
        reimbursed = mark_reimbursed(allocation.allocation_id)

    assert stored == [allocation]
    assert reimbursed is not None
    assert reimbursed.status == "reimbursed"
    assert reimbursed.gross_amount == 200
    assert reimbursed.payer_share == 129.46
    assert reimbursed.received_amount == 70.54
    assert reimbursed.outstanding_amount == 0


def test_split_recent_expense_nets_visible_amount_but_preserves_gross_action_for_reconciliation():
    actor_key = "676638528590970917"
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched():
        values = {
            "date": "8/3/2026",
            "amount": 200,
            "location": "Safeway",
            "person": "Brian (BofA)",
        }
        row = log_category_row(values, repo.expense, "grocery")
        source_action_id = record_expense_undo("grocery", row, values, values["person"], actor_key)

        success, detail = split_recent_action(
            actor_key,
            split_method="income",
            action_id=source_action_id,
        )

        assert success is True
        assert "Brian's expense: $129.46" in detail
        assert repo.expense.cell(row, 2).value == "$129.46"
        allocation = list_allocations(actor_key)[0]
        assert allocation.gross_amount == 200
        assert allocation.payer_share == 129.46
        assert allocation.partner_share == 70.54

        active = read_active_logged_actions(actor_key)
        source = next(logged for logged in active if logged.id == source_action_id)
        assert source.action.new_values[1] == "200"
        assert recent_actions(actor_key, 1)[0].action.metadata["type"] == "split"

        undone, undo_detail = undo_last_action(actor_key)

        assert undone is True
        assert "split grocery expense" in undo_detail
        assert repo.expense.cell(row, 2).value == "$200.00"
        assert list_allocations(actor_key) == []


def test_budget_payment_cells_can_be_split_without_changing_the_gross_action_amount():
    actor_key = "676638528590970917"
    repo = SheetsRepoStub(income_rows=[["", "PG&E", ""]])

    with repo.patched(), sheet_user_context(actor_key):
        logged, action_id = sheet_utils.log_pge_paid(100, return_action_id=True)
        success, _detail = split_recent_action(actor_key, split_method="income", action_id=action_id)

        assert logged is True
        assert success is True
        assert repo.income.cell(1, 3).value == "$64.73"
        allocation = list_allocations(actor_key)[0]
        assert allocation.gross_amount == 100
        assert allocation.payer_share == 64.73
        source = next(logged for logged in read_active_logged_actions(actor_key) if logged.id == action_id)
        assert source.action.new_values == ["100"]
