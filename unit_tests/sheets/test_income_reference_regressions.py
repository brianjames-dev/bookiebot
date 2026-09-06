import pytest

from bookiebot.sheets import collaboration, undo, utils
from bookiebot.sheets.routing import (
    BRIAN_SHORTCUT_ACTOR_KEY, get_current_discord_user_id, get_user_config, sheet_user_context,
)
from bookiebot.sheets.writer import log_income_row
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet, SheetsRepoStub


BRIAN = "676638528590970917"
HANNAH = "830984827904851969"


def _rows():
    return [
        [], [], [],
        ["", "Main Income Source", "Income Projection Mode", "Expected Income Amount", "Paycheck Anchor Date"],
        ["", "Salary", "biweekly", "3000", "9/1/2026"], [],
        ["", "Date", "Source", "Amount"],
        ["", "9/1/2026", "Salary", "100"], ["", "9/2/2026", "Bonus", "20"],
        ["", "Monthly Income:", "", "=SUM(D8:D9)"],
        ["", "Rent", "0"], ["", "PG&E", "0"], ["", "Water", "0"], ["", "Recology", "0"],
        ["", "Enter Monthly Savings Contribution", "", "", "0"],
    ]


class MultiOwnerRepo(SheetsRepoStub):
    def __init__(self):
        super().__init__()
        self.budgets = {owner: InMemoryWorksheet(_rows(), title="September") for owner in ("brian", "hannah")}

    def income_sheet(self):
        return self.budgets[get_user_config(get_current_discord_user_id()).budget_owner_key]


@pytest.fixture
def repo(monkeypatch):
    repository = MultiOwnerRepo()
    monkeypatch.setattr(undo, "_sync_reconciliation_after_action_mutation", lambda *args, **kwargs: None)
    with repository.patched():
        yield repository


def _income_action(repo, actor, row):
    with sheet_user_context(actor):
        values = repo.income_sheet().get_all_values()[row - 1]
        return undo.record_undo_action(actor, undo.UndoAction(
            worksheet="income", kind="delete_row", row=row, columns=[], previous_values=[],
            new_values=values, description="saved income",
            metadata={"type": "income", "income_date_column": "2", "income_source_column": "3", "income_amount_column": "4"},
        ))


def _reference(actor, action_id):
    return undo.active_logged_action_by_id(actor, action_id).action.row


def _log_rows_for(repo, actor):
    return [row for row in repo.action_log.get_all_values()[1:] if row[2] == actor]


def test_income_delete_restore_shifts_same_owner_aliases_only(repo):
    salary_id = _income_action(repo, BRIAN, 8)
    bonus_id = _income_action(repo, BRIAN_SHORTCUT_ACTOR_KEY, 9)
    hannah_id = _income_action(repo, HANNAH, 9)
    hannah_log = _log_rows_for(repo, HANNAH)
    settings = repo.budgets["brian"].get_all_values()[3:7]

    with sheet_user_context(BRIAN):
        assert undo.delete_recent_action(BRIAN, action_id=salary_id)[0]
        assert _reference(BRIAN_SHORTCUT_ACTOR_KEY, bonus_id) == 8
        assert _reference(HANNAH, hannah_id) == 9
        assert _log_rows_for(repo, HANNAH) == hannah_log
    with sheet_user_context(HANNAH):
        assert undo.update_recent_action(HANNAH, action_id=hannah_id, updates={"amount": 999})[0]
        assert repo.income_sheet().cell(8, 4).value == "100"
        assert repo.income_sheet().cell(9, 4).value == "$999.00"
        hannah_log = _log_rows_for(repo, HANNAH)
    with sheet_user_context(BRIAN):
        assert undo.undo_last_action(BRIAN)[0]
        assert _reference(BRIAN_SHORTCUT_ACTOR_KEY, bonus_id) == 9
        assert _log_rows_for(repo, HANNAH) == hannah_log
        assert repo.income_sheet().get_all_values()[3:7] == settings
    with sheet_user_context(BRIAN_SHORTCUT_ACTOR_KEY):
        assert undo.update_recent_action(BRIAN_SHORTCUT_ACTOR_KEY, action_id=bonus_id, updates={"amount": 77})[0]
        assert repo.income_sheet().cell(9, 4).value == "$77.00"
        assert repo.income_sheet().cell(8, 4).value == "100"


@pytest.mark.parametrize("logger,label,column", [
    (utils.log_rent_paid, "Rent", 3), (utils.log_pge_paid, "PG&E", 3),
    (utils.log_water_paid, "Water", 3), (utils.log_recology_paid, "Recology", 3),
    (utils.log_savings, "Enter Monthly Savings Contribution", 5),
])
def test_fixed_budget_actions_follow_income_insert_delete_restore_and_undo(repo, logger, label, column):
    with sheet_user_context(HANNAH):
        logger(50)
    other_sheet = repo.budgets["hannah"].get_all_values()
    other_log = _log_rows_for(repo, HANNAH)
    with sheet_user_context(BRIAN):
        assert logger(100)
        action_id = undo.recent_actions(BRIAN)[0].id
        original_row = repo.income_sheet().find(label).row
        settings = repo.income_sheet().get_all_values()[3:7]
        _row, _source, _amount, income_id = log_income_row(
            {"source": "Paycheck", "amount": 3000, "date": "2026-09-04"}, repo.income_sheet(), return_action_id=True,
        )
        assert _reference(BRIAN, action_id) == original_row + 1
        assert undo.update_recent_action(BRIAN, action_id=action_id, updates={"amount": 110})[0]
        updated_id = undo.recent_actions(BRIAN)[0].id
        assert repo.income_sheet().cell(original_row + 1, column).value == "$110.00"
        assert undo.delete_recent_action(BRIAN, action_id=income_id)[0]
        assert _reference(BRIAN, action_id) == original_row
        assert _reference(BRIAN, updated_id) == original_row
        assert undo.undo_last_action(BRIAN)[0]
        assert _reference(BRIAN, action_id) == original_row + 1
        assert _reference(BRIAN, updated_id) == original_row + 1
        assert undo.undo_logged_action(BRIAN, updated_id)[0]
        assert repo.income_sheet().cell(original_row + 1, column).value == "100"
        assert undo.undo_logged_action(BRIAN, income_id)[0]
        assert _reference(BRIAN, action_id) == original_row
        assert repo.income_sheet().cell(original_row, 2).value == label
        assert repo.income_sheet().cell(10, 4).value == "=SUM(D8:D9)"
        assert repo.income_sheet().get_all_values()[3:7] == settings
    assert repo.budgets["hannah"].get_all_values() == other_sheet
    assert _log_rows_for(repo, HANNAH) == other_log


@pytest.mark.parametrize("logger", [utils.log_rent_paid, utils.log_savings])
def test_stale_fixed_target_refuses_update_and_undo_without_overwriting_neighbor(repo, logger):
    with sheet_user_context(BRIAN):
        assert logger(100)
        saved = undo.recent_actions(BRIAN)[0]
        repo.income_sheet().insert_row(["", "Unexpected row", "900"], saved.action.row)
        before = repo.income_sheet().get_all_values()
        assert not undo.update_recent_action(BRIAN, action_id=saved.id, updates={"amount": 110})[0]
        assert not undo.undo_logged_action(BRIAN, saved.id)[0]
        assert repo.income_sheet().get_all_values() == before


def test_bill_split_ledger_and_all_lineage_rows_follow_owner_income_changes(repo):
    allocations = {}
    for actor in (BRIAN, HANNAH):
        with sheet_user_context(actor):
            assert utils.log_rent_paid(2000)
            assert undo.split_recent_action(actor, index=1, split_method="equal")[0]
            allocations[actor] = collaboration.list_allocations(actor)[0]
    with sheet_user_context(BRIAN):
        log_income_row({"source": "Paycheck", "amount": 3000}, repo.income_sheet())
        brian = collaboration.allocation_by_id(allocations[BRIAN].allocation_id)
        hannah = collaboration.allocation_by_id(allocations[HANNAH].allocation_id)
        assert brian.source_row == 12
        assert hannah.source_row == 11
        assert _reference(BRIAN, brian.source_action_id) == 12
        assert _reference(BRIAN, brian.split_action_id) == 12
        assert undo.undo_last_action(BRIAN)[0]
        assert collaboration.allocation_by_id(brian.allocation_id).source_row == 11
        assert collaboration.allocation_by_id(hannah.allocation_id).source_row == 11


def test_updated_bill_split_stays_editable_after_income_insertion(repo):
    with sheet_user_context(BRIAN):
        assert utils.log_rent_paid(2000)
        assert undo.update_recent_action(BRIAN, index=1, updates={"amount": 2100})[0]
        assert undo.split_recent_action(BRIAN, index=1, split_method="equal")[0]
        split = undo.recent_actions(BRIAN)[0]
        assert split.action.metadata["source_type"] == "payment"
        log_income_row({"source": "Salary", "amount": 3000}, repo.income_sheet())
        assert undo.change_split_recent_action(BRIAN, action_id=split.id, split_method="income")[0]
        allocation = collaboration.list_allocations(BRIAN)[0]
        assert allocation.source_row == 12
        assert float(repo.income_sheet().cell(12, 3).value.replace("$", "")) == allocation.payer_share


def test_legacy_update_does_not_inherit_another_owners_income_type(repo):
    parent_id = _income_action(repo, HANNAH, 8)
    with sheet_user_context(BRIAN):
        action_id = undo.record_undo_action(BRIAN, undo.UndoAction(
            worksheet="income", kind="restore_cells", row=11, columns=[3], previous_values=["0"],
            new_values=["100"], description="broken legacy update",
            metadata={"type": "update", "source_type": "update", "updated_action_id": parent_id},
        ))
        saved = undo.active_logged_action_by_id(BRIAN, action_id)
        assert not undo.action_capabilities(saved.action).can_delete
        before = repo.income_sheet().get_all_values()
        assert not undo.update_recent_action(BRIAN, action_id=action_id, updates={"amount": 200})[0]
        assert repo.income_sheet().get_all_values() == before


@pytest.mark.parametrize("operation", ["insert", "delete", "restore"])
def test_reference_write_failure_rolls_back_structural_edit_and_action_log(repo, monkeypatch, operation):
    salary_id = _income_action(repo, BRIAN, 8)
    _income_action(repo, BRIAN_SHORTCUT_ACTOR_KEY, 9)
    with sheet_user_context(BRIAN):
        assert utils.log_rent_paid(100)
        if operation == "restore":
            assert undo.delete_recent_action(BRIAN, action_id=salary_id)[0]
        before_sheet = repo.income_sheet().get_all_values()
        before_log = repo.action_log.get_all_values()
        write_logged_action = undo._write_logged_action
        failed = False

        def fail_once(*args, **kwargs):
            nonlocal failed
            if not failed:
                failed = True
                raise RuntimeError("temporary action-log write failure")
            return write_logged_action(*args, **kwargs)

        monkeypatch.setattr(undo, "_write_logged_action", fail_once)
        if operation == "insert":
            with pytest.raises(RuntimeError, match="action-log write failure"):
                log_income_row({"source": "Salary", "amount": 3000}, repo.income_sheet())
        elif operation == "delete":
            assert not undo.delete_recent_action(BRIAN, action_id=salary_id)[0]
        else:
            assert not undo.undo_last_action(BRIAN)[0]
        assert repo.income_sheet().get_all_values() == before_sheet
        assert repo.action_log.get_all_values() == before_log


def test_ledger_read_failure_prevents_income_insertion(repo, monkeypatch):
    with sheet_user_context(BRIAN):
        assert utils.log_rent_paid(100)
        before = repo.income_sheet().get_all_values()

        def fail_read():
            raise RuntimeError("ledger unavailable")

        monkeypatch.setattr(repo.shared_reimbursements, "get_all_values", fail_read)
        with pytest.raises(RuntimeError, match="ledger unavailable"):
            log_income_row({"source": "Salary", "amount": 3000}, repo.income_sheet())
        assert repo.income_sheet().get_all_values() == before


def test_legacy_placeholder_compaction_updates_fixed_budget_references(repo):
    with sheet_user_context(BRIAN):
        sheet = repo.income_sheet()
        sheet.update([["", "<Enter Source>", "0"], ["", "<Enter Source>", "0"]], range_name="B8:D9")
        assert utils.log_rent_paid(100)
        rent_id = undo.recent_actions(BRIAN)[0].id
        log_income_row({"source": "Salary", "amount": 3000}, sheet)
        assert _reference(BRIAN, rent_id) == 10
        assert undo.update_recent_action(BRIAN, action_id=rent_id, updates={"amount": 110})[0]
        assert sheet.cell(10, 2).value == "Rent"
        assert sheet.cell(10, 3).value == "$110.00"
        assert sheet.cell(9, 4).value == "=SUM(D8:D8)"
