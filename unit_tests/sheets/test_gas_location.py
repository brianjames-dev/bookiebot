from copy import deepcopy

import pytest

from bookiebot.sheets.config import GAS_LOCATION_LAYOUT, category_layout, get_category_columns, layout_for_version


def sheet_rows(*, migrated=False, needs=True):
    layout = layout_for_version(GAS_LOCATION_LAYOUT if migrated else "")
    rows = [[""] * 41 for _ in range(5)]
    from openpyxl.utils import column_index_from_string
    for category, config in layout.items():
        first = column_index_from_string(config["columns"]["date"]) - 1
        rows[0][first] = "NEEDS" if category == "need_expenses" else category.upper()
        for field, col in config["columns"].items():
            rows[1][column_index_from_string(col) - 1] = field.title() + ":"
    if not needs:
        rows[0][column_index_from_string(layout["need_expenses"]["columns"]["date"]) - 1] = "TOTALS"
    return rows


def test_layout_follows_headers_and_does_not_mutate_legacy_map():
    before = deepcopy(get_category_columns)
    old = category_layout(sheet_rows())
    new = category_layout(sheet_rows(migrated=True))
    assert old == before
    assert new["gas"]["columns"] == {"date": "H", "amount": "I", "location": "J", "person": "K"}
    assert new["food"]["columns"] == {"date": "O", "item": "P", "amount": "Q", "location": "R", "person": "S"}
    assert new["shopping"]["columns"]["person"] == "AA"
    assert new["need_expenses"]["columns"]["person"] == "AI"
    assert new["grocery"] == old["grocery"]
    assert get_category_columns == before


@pytest.mark.parametrize("migrated", [False, True])
def test_early_sheet_totals_are_not_misread_as_needs(migrated):
    assert "need_expenses" not in category_layout(sheet_rows(migrated=migrated, needs=False))


def test_unknown_live_header_fails_closed():
    rows = sheet_rows(migrated=True)
    rows[1][10] = "Unknown"
    with pytest.raises(ValueError, match="Gas columns"):
        category_layout(rows)


@pytest.mark.parametrize("category", ["grocery", "gas", "food", "shopping", "need_expenses"])
def test_migrated_logging_edit_delete_undo_and_bank_identity(category, monkeypatch):
    from bookiebot.sheets import writer, undo
    from bookiebot.sheets.routing import sheet_user_context
    from bookiebot.banking.reconciliation import action_sheet_ref, _action_candidate
    from unit_tests.support.sheets_repo_stub import SheetsRepoStub
    actor = "676638528590970917"
    repo = SheetsRepoStub(expense_rows=sheet_rows(migrated=True)[:2])
    values = {"date": "11/3/2026", "item": "Fuel", "amount": "42.25", "location": "Chevron", "person": "Brian (BofA)"}
    monkeypatch.setattr(undo, "_sync_reconciliation_after_action_mutation", lambda *a, **kw: None)
    with repo.patched(), sheet_user_context(actor):
        row = writer.log_category_row(values, repo.expense, category)
        identity = writer.record_expense_undo(category, row, values, values["person"], actor, worksheet=repo.expense)
        logged = undo.active_logged_action_by_id(actor, identity)
        assert logged.action.metadata["expense_layout"] == GAS_LOCATION_LAYOUT
        assert undo._field_values_for_action(logged.action)["location"] == "Chevron"
        assert "location" in undo.editable_fields_for_action(logged.action)
        assert _action_candidate(logged)["amount"] == 42.25
        expected = undo._category_columns(category, values=repo.expense.get_all_values())
        assert "#cols=" + ",".join(map(str, expected.values())) in action_sheet_ref(logged)
        assert undo.update_recent_action(actor, updates={"location": "Shell"}, action_id=identity)[0]
        assert repo.expense.cell(row, expected["location"]).value == "Shell"
        assert undo.undo_last_action(actor)[0]
        assert repo.expense.cell(row, expected["location"]).value == "Chevron"
        assert undo.delete_recent_action(actor, action_id=identity)[0]
        assert repo.expense.cell(row, expected["amount"]).value == ""
        assert undo.undo_last_action(actor)[0]
        assert repo.expense.cell(row, expected["location"]).value == "Chevron"
        assert repo.expense.cell(row, expected["person"]).value == "Brian (BofA)"


def test_gas_move_keeps_merchant_and_undo_restores_new_columns(monkeypatch):
    from bookiebot.sheets import writer, undo
    from bookiebot.sheets.routing import sheet_user_context
    from unit_tests.support.sheets_repo_stub import SheetsRepoStub
    actor = "676638528590970917"
    repo = SheetsRepoStub(expense_rows=sheet_rows(migrated=True)[:2])
    values = {"date": "11/3/2026", "amount": "42.25", "location": "Chevron", "person": "Brian (BofA)"}
    monkeypatch.setattr(undo, "_sync_reconciliation_after_action_mutation", lambda *a, **kw: None)
    with repo.patched(), sheet_user_context(actor):
        row = writer.log_category_row(values, repo.expense, "gas")
        identity = writer.record_expense_undo("gas", row, values, values["person"], actor, worksheet=repo.expense)
        assert undo.move_recent_action(actor, destination_category="shopping", updates={"item": "Fuel"}, action_id=identity)[0]
        assert repo.expense.cell(3, 26).value == "Chevron"
        assert repo.expense.cell(3, 27).value == "Brian (BofA)"
        assert undo.undo_last_action(actor)[0]
        assert repo.expense.cell(3, 10).value == "Chevron"
        assert repo.expense.cell(3, 11).value == "Brian (BofA)"


def test_report_and_manual_transactions_expose_gas_merchant():
    from bookiebot.reports.expense_breakdown import _shared_expense_entries, BudgetMonth
    from bookiebot.reports.transactions import _manual_actions
    from bookiebot.sheets.undo import _field_values_for_action
    rows = sheet_rows(migrated=True)
    rows[2][7:11] = ["11/3/2026", "$42.25", "Chevron", "Brian (BofA)"]
    entries = _shared_expense_entries(rows, ["Brian (BofA)"], BudgetMonth(2026, 11))
    assert len(entries) == 1
    assert entries[0].location == "Chevron"
    actions = list(_manual_actions("676638528590970917", "2026-11", rows, []))
    assert _field_values_for_action(actions[0].action)["location"] == "Chevron"
