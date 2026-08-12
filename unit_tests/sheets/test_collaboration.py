from __future__ import annotations

from bookiebot.sheets.collaboration import (
    LEGACY_SHARED_REIMBURSEMENT_HEADERS,
    SHARED_REIMBURSEMENT_HEADERS,
    append_allocation,
    list_allocations,
    mark_reimbursed,
    matching_outstanding_obligations,
    new_allocation,
    normalize_split_method,
    split_amounts,
)
from bookiebot.sheets.undo import (
    cancel_split_recent_action,
    change_split_recent_action,
    has_system_event,
    read_active_logged_actions,
    recent_actions,
    split_recent_action,
    undo_last_action,
)
from bookiebot.sheets.writer import log_category_row, record_expense_undo
from bookiebot.sheets.routing import sheet_user_context
import bookiebot.sheets.utils as sheet_utils
from unit_tests.support.sheets_repo_stub import SheetsRepoStub


def test_income_split_uses_exact_household_income_ratio_and_penny_safe_remainder():
    brian_share, hannah_share = split_amounts(200, "income", "brian")
    hannah_payer_share, brian_partner_share = split_amounts(200, "income", "hannah")

    assert brian_share == 129.46
    assert hannah_share == 70.54
    assert brian_share + hannah_share == 200
    assert hannah_payer_share == 70.54
    assert brian_partner_share == 129.46


def test_equal_split_assigns_rounding_remainder_to_payer():
    payer_share, partner_share = split_amounts(10.01, "equal", "brian")

    assert payer_share == 5.01
    assert partner_share == 5.0


def test_fronted_split_assigns_full_responsibility_to_partner():
    payer_share, partner_share = split_amounts(200, "fronted", "brian")

    assert payer_share == 0
    assert partner_share == 200


def test_fronted_is_the_only_canonical_full_reimbursement_method_value():
    assert normalize_split_method("fronted") == "fronted"
    assert normalize_split_method("covered") is None


def test_legacy_reimbursement_header_is_extended_without_losing_existing_rows():
    actor_key = "676638528590970917"
    legacy_row = [
        "alloc-1", "2026-08-03T10:00:00-07:00", "2026-08-03T10:00:00-07:00",
        actor_key, "brian", "Brian (BofA)", "Hannah", "expense-1", "split-1",
        "expense", "grocery", "3", "8/3/2026", "Groceries", "Safeway",
        "200.00", "income", "129.46", "70.54", "outstanding", "0.00", "",
    ]
    repo = SheetsRepoStub(
        shared_reimbursements_rows=[LEGACY_SHARED_REIMBURSEMENT_HEADERS, legacy_row],
    )

    with repo.patched():
        allocations = list_allocations(actor_key)

    assert repo.shared_reimbursements.get_all_values()[0] == SHARED_REIMBURSEMENT_HEADERS
    assert allocations[0].gross_amount == 200
    assert allocations[0].responsible_owner_key == "brian"
    assert allocations[0].original_person == "Brian (BofA)"


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


def test_fronted_expense_moves_visible_responsibility_but_preserves_payer_gross_lineage():
    actor_key = "676638528590970917"
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched(), sheet_user_context(actor_key):
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
            split_method="fronted",
            action_id=source_action_id,
        )

        assert success is True
        assert "Fronted expense recorded" in detail
        assert "Brian paid $200.00" in detail
        assert "Hannah owns the full $200.00 expense" in detail
        assert repo.expense.cell(row, 2).value == "$200.00"
        assert repo.expense.cell(row, 4).value == "Hannah"
        allocation = list_allocations(actor_key)[0]
        assert allocation.payer_share == 0
        assert allocation.partner_share == 200
        assert allocation.responsible_owner_key == "hannah"
        assert allocation.original_person == "Brian (BofA)"
        assert allocation.responsible_person == "Hannah"

        source = next(logged for logged in read_active_logged_actions(actor_key) if logged.id == source_action_id)
        assert source.action.new_values[1] == "200"
        assert source.action.new_values[-1] == "Brian (BofA)"

        obligations = matching_outstanding_obligations("830984827904851969")
        assert [item.allocation_id for item in obligations] == [allocation.allocation_id]

        undone, undo_detail = undo_last_action(actor_key)

        assert undone is True
        assert "split grocery expense" in undo_detail
        assert repo.expense.cell(row, 2).value == "$200.00"
        assert repo.expense.cell(row, 4).value == "Brian (BofA)"
        assert list_allocations(actor_key) == []


def test_fronted_mode_is_rejected_for_personal_budget_payment_cells():
    actor_key = "676638528590970917"
    repo = SheetsRepoStub(income_rows=[["", "PG&E", ""]])

    with repo.patched(), sheet_user_context(actor_key):
        logged, action_id = sheet_utils.log_pge_paid(100, return_action_id=True)
        success, detail = split_recent_action(actor_key, split_method="fronted", action_id=action_id)

    assert logged is True
    assert success is False
    assert "only for shared expense rows" in detail
    assert repo.income.cell(1, 3).value == "100"
    assert repo.shared_reimbursements.get_all_values() == [SHARED_REIMBURSEMENT_HEADERS]


def test_fronted_split_can_be_changed_and_undone_with_person_attribution_restored():
    actor_key = "676638528590970917"
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched(), sheet_user_context(actor_key):
        values = {
            "date": "8/3/2026",
            "amount": 200,
            "location": "Safeway",
            "person": "Brian (BofA)",
        }
        row = log_category_row(values, repo.expense, "grocery")
        source_action_id = record_expense_undo("grocery", row, values, values["person"], actor_key)
        split_recent_action(actor_key, split_method="income", action_id=source_action_id)
        income_split_id = recent_actions(actor_key, 1)[0].id

        changed, _detail = change_split_recent_action(
            actor_key,
            split_method="fronted",
            action_id=income_split_id,
        )

        assert changed is True
        assert repo.expense.cell(row, 2).value == "$200.00"
        assert repo.expense.cell(row, 4).value == "Hannah"
        fronted = list_allocations(actor_key)[0]
        assert fronted.split_method == "fronted"
        assert fronted.responsible_owner_key == "hannah"

        undone, _undo_detail = undo_last_action(actor_key)

        assert undone is True
        assert repo.expense.cell(row, 2).value == "$129.46"
        assert repo.expense.cell(row, 4).value == "Brian (BofA)"
        restored = list_allocations(actor_key)[0]
        assert restored.split_method == "income"
        assert restored.responsible_owner_key == "brian"
        assert restored.responsible_person == "Brian (BofA)"


def test_cancel_fronted_split_restores_original_payer_attribution_and_voids_receivable():
    actor_key = "676638528590970917"
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched(), sheet_user_context(actor_key):
        values = {
            "date": "8/3/2026",
            "amount": 200,
            "location": "Safeway",
            "person": "Brian (BofA)",
        }
        row = log_category_row(values, repo.expense, "grocery")
        source_action_id = record_expense_undo("grocery", row, values, values["person"], actor_key)
        split_recent_action(actor_key, split_method="fronted", action_id=source_action_id)
        split_action_id = recent_actions(actor_key, 1)[0].id

        canceled, detail = cancel_split_recent_action(actor_key, action_id=split_action_id)

        assert canceled is True
        assert "Restored the original $200.00 expense" in detail
        assert repo.expense.cell(row, 2).value == "$200.00"
        assert repo.expense.cell(row, 4).value == "Brian (BofA)"
        assert list_allocations(actor_key) == []
        voided = list_allocations(actor_key, include_void=True)[0]
        assert voided.status == "void"
        assert recent_actions(actor_key, 1)[0].id == source_action_id


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


def test_change_grocery_split_method_recalculates_from_gross_and_can_be_undone():
    actor_key = "676638528590970917"
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched(), sheet_user_context(actor_key):
        values = {
            "date": "8/3/2026",
            "amount": 200,
            "item": "Groceries",
            "location": "Safeway",
            "person": "Brian (BofA)",
        }
        row = log_category_row(values, repo.expense, "grocery")
        source_action_id = record_expense_undo("grocery", row, values, values["person"], actor_key)
        split_recent_action(actor_key, split_method="income", action_id=source_action_id)
        split_action_id = recent_actions(actor_key, 1)[0].id

        changed, detail = change_split_recent_action(
            actor_key,
            split_method="equal",
            action_id=split_action_id,
        )

        assert changed is True
        assert "Split changed to 50/50" in detail
        assert repo.expense.cell(row, 2).value == "$100.00"
        allocation = list_allocations(actor_key)[0]
        assert allocation.gross_amount == 200
        assert allocation.split_method == "equal"
        assert allocation.payer_share == 100
        assert allocation.partner_share == 100
        changed_action = recent_actions(actor_key, 1)[0]
        assert changed_action.action.metadata["split_operation"] == "change"
        source = next(logged for logged in read_active_logged_actions(actor_key) if logged.id == source_action_id)
        assert source.action.new_values[1] == "200"

        undone, _undo_detail = undo_last_action(actor_key)

        assert undone is True
        assert repo.expense.cell(row, 2).value == "$129.46"
        restored = list_allocations(actor_key)[0]
        assert restored.split_method == "income"
        assert restored.payer_share == 129.46
        assert restored.partner_share == 70.54


def test_cancel_changed_bill_split_restores_gross_and_voids_reimbursement():
    actor_key = "676638528590970917"
    repo = SheetsRepoStub(income_rows=[["", "PG&E", ""]])

    with repo.patched(), sheet_user_context(actor_key):
        logged, source_action_id = sheet_utils.log_pge_paid(200, return_action_id=True)
        split_recent_action(actor_key, split_method="income", action_id=source_action_id)
        first_split_id = recent_actions(actor_key, 1)[0].id
        change_split_recent_action(actor_key, split_method="equal", action_id=first_split_id)
        changed_split_id = recent_actions(actor_key, 1)[0].id

        canceled, detail = cancel_split_recent_action(actor_key, action_id=changed_split_id)

        assert logged is True
        assert canceled is True
        assert "Restored the original $200.00 expense" in detail
        assert repo.income.cell(1, 3).value == "$200.00"
        assert list_allocations(actor_key) == []
        voided = list_allocations(actor_key, include_void=True)[0]
        assert voided.status == "void"
        assert voided.gross_amount == 200
        assert recent_actions(actor_key, 1)[0].id == source_action_id
        assert recent_actions(actor_key, 1)[0].action.metadata["type"] == "payment"
        assert has_system_event(
            actor_key,
            "shared_split_cancelled",
            {"allocation_id": voided.allocation_id},
        )

        resplit, _resplit_detail = split_recent_action(
            actor_key,
            split_method="equal",
            action_id=source_action_id,
        )
        assert resplit is True
        assert repo.income.cell(1, 3).value == "$100.00"
        outstanding = list_allocations(actor_key)
        assert len(outstanding) == 1
        assert outstanding[0].allocation_id != voided.allocation_id
        assert outstanding[0].status == "outstanding"


def test_reimbursed_split_cannot_be_changed_or_canceled():
    actor_key = "676638528590970917"
    repo = SheetsRepoStub(income_rows=[["", "Water", ""]])

    with repo.patched(), sheet_user_context(actor_key):
        _logged, source_action_id = sheet_utils.log_water_paid(200, return_action_id=True)
        split_recent_action(actor_key, split_method="income", action_id=source_action_id)
        split_action_id = recent_actions(actor_key, 1)[0].id
        allocation = list_allocations(actor_key)[0]
        mark_reimbursed(allocation.allocation_id)

        changed, change_detail = change_split_recent_action(
            actor_key,
            split_method="equal",
            action_id=split_action_id,
        )
        canceled, cancel_detail = cancel_split_recent_action(actor_key, action_id=split_action_id)

        assert changed is False
        assert canceled is False
        assert "already been reimbursed" in change_detail
        assert "already been reimbursed" in cancel_detail
        assert repo.income.cell(1, 3).value == "$129.46"
        reimbursed = list_allocations(actor_key)[0]
        assert reimbursed.status == "reimbursed"
        assert reimbursed.received_amount == 70.54
