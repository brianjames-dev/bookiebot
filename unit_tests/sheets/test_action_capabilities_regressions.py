import copy
import json

import pytest

from bookiebot.sheets import undo, utils
from bookiebot.sheets.routing import sheet_user_context
from bookiebot.sheets.writer import log_income_row
from unit_tests.support.sheets_repo_stub import SheetsRepoStub


ACTOR = "830984827904851969"


@pytest.fixture
def budget(monkeypatch):
    repo = SheetsRepoStub(income_rows=[
        [], ["", "September"], [],
        ["", "Main Income Source:", "Income Projection Mode:", "Expected Income Amount:", "Paycheck Anchor Date:"],
        ["", "Sonic", "biweekly", "1700", "8/21/2026"],
        [], ["", "Date:", "Source:", "Amount:"],
        ["", "", "<Enter Source>", "0"],
        ["", "Monthly Income:", "", "=SUM(D8:D8)"],
        [], ["", "Rent", ""], ["", "PG&E", ""],
        ["", "Water", ""], ["", "Recology", ""],
        ["", "Enter Monthly Savings Contribution", "", "", "0"],
    ])
    monkeypatch.setattr(undo, "_sync_reconciliation_after_action_mutation", lambda *args, **kwargs: None)
    with repo.patched(), sheet_user_context(ACTOR):
        yield repo


@pytest.mark.parametrize("logger,source_type,row,column", [
    (utils.log_rent_paid, "payment", 11, 3),
    (utils.log_pge_paid, "payment", 12, 3),
    (utils.log_water_paid, "payment", 13, 3),
    (utils.log_recology_paid, "payment", 14, 3),
    (utils.log_savings, "savings", 15, 5),
])
def test_bill_and_savings_updates_keep_amount_only_capabilities_and_cannot_delete(
    budget, logger, source_type, row, column,
):
    assert logger(100)
    for amount in (110, 120, 130):
        success, detail = undo.update_recent_action(ACTOR, index=1, updates={"amount": amount})
        assert success, detail
        action = undo.recent_actions(ACTOR)[0].action
        assert action.metadata["source_type"] == source_type
        capabilities = undo.action_capabilities(action)
        assert capabilities.editable_fields == ["amount"]
        assert capabilities.can_update
        assert not capabilities.can_move
        assert not capabilities.can_delete
        assert capabilities.can_split is (source_type == "payment")
        assert "Income" not in undo.action_title(action)
        assert "Income:" not in undo.format_action_detail_block(action)
        assert budget.income.cell(row, column).value == f"${amount:.2f}"

        before = budget.income.get_all_values()
        before_log = budget.action_log.get_all_values()
        success, detail = undo.delete_recent_action(ACTOR, index=1)
        assert not success
        assert "payments or savings" in detail
        assert budget.income.get_all_values() == before
        assert budget.action_log.get_all_values() == before_log

    success, detail = undo.undo_last_action(ACTOR)
    assert success, detail
    assert budget.income.cell(row, column).value == "$120.00"


def test_repeated_income_updates_remain_deletable_and_undo_preserves_horizontal_grid(budget):
    settings = copy.deepcopy(budget.income.get_all_values()[3:7])
    log_income_row({"source": "Sonic", "amount": 1700, "date": "2026-09-04"}, budget.income)
    for amount in (1800, 1900, 2000):
        success, detail = undo.update_recent_action(ACTOR, index=1, updates={"amount": amount})
        assert success, detail
        action = undo.recent_actions(ACTOR)[0].action
        assert action.metadata["source_type"] == "income"
        capabilities = undo.action_capabilities(action)
        assert capabilities.can_delete
        assert capabilities.editable_fields == ["source", "amount"]
        assert not capabilities.can_split
        assert undo.action_title(action) == "Updated: Income"

    success, detail = undo.delete_recent_action(ACTOR, index=1)
    assert success, detail
    assert budget.income.cell(8, 2).value == "Monthly Income:"
    assert budget.income.get_all_values()[3:7] == settings
    assert undo.recent_actions(ACTOR) == []

    success, detail = undo.undo_last_action(ACTOR)
    assert success, detail
    assert budget.income.cell(8, 3).value == "Sonic"
    assert budget.income.cell(8, 4).value == "$2000.00"
    assert budget.income.cell(9, 4).value == "=SUM(D8:D8)"
    assert budget.income.get_all_values()[3:7] == settings
    assert undo.action_capabilities(undo.recent_actions(ACTOR)[0].action).can_delete


@pytest.mark.parametrize("source_type", ["income", "payment", "savings"])
def test_legacy_repeated_updates_resolve_original_type_from_saved_lineage(budget, source_type):
    if source_type == "income":
        log_income_row({"source": "Sonic", "amount": 100}, budget.income)
    else:
        assert (utils.log_rent_paid if source_type == "payment" else utils.log_savings)(100)
    for amount in (110, 120):
        assert undo.update_recent_action(ACTOR, index=1, updates={"amount": amount})[0]

    # Older versions saved the previous event type, losing transaction type on update #2.
    rows = budget.action_log.get_all_values()
    payload = json.loads(rows[-1][5])
    payload["metadata"]["source_type"] = "update"
    budget.action_log.update_cell(len(rows), 6, json.dumps(payload))
    assert undo.update_recent_action(ACTOR, index=1, updates={"amount": 130})[0]
    action = undo.recent_actions(ACTOR)[0].action
    assert action.metadata["source_type"] == source_type
    assert undo.action_capabilities(action).can_delete is (source_type == "income")


@pytest.mark.parametrize("row", [5, 7, 9, 11])
def test_income_deletion_rejects_saved_target_outside_transaction_table(budget, row):
    undo.record_undo_action(ACTOR, undo.UndoAction(
        worksheet="income", kind="delete_row", row=row, columns=[],
        previous_values=[], new_values=["", "9/4/2026", "Sonic", "1700"],
        description="stale income", metadata={"type": "income"},
    ))
    before = budget.income.get_all_values()
    before_log = budget.action_log.get_all_values()
    success, _detail = undo.delete_recent_action(ACTOR, index=1)
    assert not success
    assert budget.income.get_all_values() == before
    assert budget.action_log.get_all_values() == before_log


def test_undo_income_insertion_rejects_stale_target_at_summary(budget):
    undo.record_undo_action(ACTOR, undo.UndoAction(
        worksheet="income", kind="delete_row", row=9, columns=[],
        previous_values=[], description="stale income", metadata={"type": "income"},
    ))
    before = budget.income.get_all_values()
    assert not undo.undo_last_action(ACTOR)[0]
    assert budget.income.get_all_values() == before
