from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from datetime import datetime
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from bookiebot.banking import imports
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.store import BankStore


@pytest.fixture
def store(tmp_path):
    result = BankStore(tmp_path / 'bank.sqlite3', TokenCipher('test-secret'))
    result.initialize()
    return result


def seed(store, *, amount=20.0, bank_date='2026-09-05', pending=False):
    store.upsert_transactions([{
        'transaction_id': 'txn-1', 'date': bank_date, 'name': 'Example merchant',
        'amount': amount, 'pending': pending,
    }], 'brian')
    return store.upsert_reconciliation_item(
        owner_key='brian', transaction=store.recent_transactions('brian')[0],
        classification='expense', status='needs_review', confidence=0,
    )


@pytest.fixture
def writers(monkeypatch):
    actions = []
    monkeypatch.setattr(imports, 'get_user_config', lambda _: SimpleNamespace(budget_owner_key='brian'))
    monkeypatch.setattr(imports, 'sheet_user_context', lambda _: nullcontext())
    monkeypatch.setattr(imports, 'now_pacific', lambda: datetime(2026, 9, 6, 10))
    monkeypatch.setattr(imports, 'read_active_logged_actions', lambda _: actions)
    repo = SimpleNamespace(
        expense_sheet=Mock(return_value=SimpleNamespace(title='September')),
        income_sheet=Mock(return_value=SimpleNamespace(title='September')),
    )
    monkeypatch.setattr(imports, 'get_sheets_repo', lambda: repo)
    expense = Mock(return_value=12)
    record = Mock(return_value='expense-action')
    income = Mock(return_value=(9, 'income', 20, 'income-action'))
    monkeypatch.setattr(imports, 'log_category_row', expense)
    monkeypatch.setattr(imports, 'record_expense_undo', record)
    monkeypatch.setattr(imports, 'log_income_row', income)
    return SimpleNamespace(expense=expense, income=income, record=record, repo=repo, actions=actions)


def submit(store, item, kind='expense'):
    return imports.import_reconciliation_item(
        store, 'brian', item.id, actor_key='actor', kind=kind,
        fields={'category': 'food', 'person': 'Brian (BofA)', 'item': 'Example',
                'location': 'Example merchant', 'source': 'Payroll', 'label': 'paycheck'},
        expected_amount=item.transaction.amount,
        expected_date=item.transaction.date or item.transaction.authorized_date,
    )


def action_for(operation_id, reconciliation_id, *, kind='expense', action_id='recovered-action'):
    return SimpleNamespace(id=action_id, action=SimpleNamespace(
        worksheet=kind, row=12, metadata={
            'type': kind, 'bank_import_operation_id': operation_id,
            'bank_reconciliation_id': str(reconciliation_id),
            'bank_import_target_year': '2026', 'bank_import_target_month': '9',
        },
    ))


@pytest.mark.parametrize('kind', ['expense', 'income'])
@pytest.mark.parametrize('bank_date', ['2026-08-31', '2025-09-05', '2026-10-01', None, 'bad-date'])
def test_historical_future_and_missing_dates_reject_before_any_mutation(store, writers, kind, bank_date):
    item = seed(store, bank_date=bank_date)
    result = submit(store, item, kind)
    assert result.status == 'rejected'
    assert store.get_import_operation('brian', item.id) is None
    assert store.get_reconciliation_item('brian', item.id).status == 'needs_review'
    writers.repo.expense_sheet.assert_not_called()
    writers.repo.income_sheet.assert_not_called()
    writers.expense.assert_not_called()
    writers.income.assert_not_called()


@pytest.mark.parametrize('kind', ['expense', 'income'])
def test_same_bank_item_imports_once_across_sequential_forms_and_restart(store, writers, kind):
    item = seed(store)
    first = submit(store, item, kind)
    restarted = BankStore(store.path, TokenCipher('test-secret'))
    second = submit(restarted, item, kind)
    assert first.status == second.status == 'completed'
    assert first.operation_id == second.operation_id
    assert first.action_id == second.action_id
    assert writers.expense.call_count + writers.income.call_count == 1
    operation = store.get_import_operation('brian', item.id)
    assert operation.status == 'completed'
    assert store.get_reconciliation_item('brian', item.id).matched_action_log_id == first.action_id
    metadata = writers.record.call_args.args[5] if kind == 'expense' else writers.income.call_args.kwargs['metadata_extra']
    assert metadata['bank_import_operation_id'] == first.operation_id
    assert metadata['bank_reconciliation_id'] == str(item.id)


@pytest.mark.parametrize('status', ['confirmed', 'ignored', 'matched'])
def test_resolved_item_rejects_stale_modal_before_write(store, writers, status):
    item = seed(store)
    with store.connect() as conn:
        conn.execute('UPDATE bank_reconciliation_items SET status = ? WHERE id = ?', (status, item.id))
    assert submit(store, item).status == 'rejected'
    writers.expense.assert_not_called()
    assert store.get_import_operation('brian', item.id) is None


def test_changed_amount_and_removed_item_reject_stale_modal(store, writers):
    item = seed(store)
    seed(store, amount=27)
    assert submit(store, item).status == 'rejected'
    store.mark_transactions_removed(['txn-1'])
    assert submit(store, item).status == 'rejected'
    writers.expense.assert_not_called()


def test_pending_item_rejects_import(store, writers):
    item = seed(store, pending=True)
    assert submit(store, item).status == 'rejected'
    writers.expense.assert_not_called()


def test_wrong_actor_cannot_claim_or_recover(store, writers, monkeypatch):
    item = seed(store)
    monkeypatch.setattr(imports, 'get_user_config', lambda _: SimpleNamespace(budget_owner_key='hannah'))
    assert submit(store, item).status == 'rejected'
    assert store.get_import_operation('brian', item.id) is None
    writers.expense.assert_not_called()


def test_concurrent_forms_have_only_one_writer(store, writers):
    item = seed(store)
    entered, release = Event(), Event()
    def write(*args):
        entered.set()
        assert release.wait(5)
        return 12
    writers.expense.side_effect = write
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(submit, store, item)
        assert entered.wait(5)
        try:
            second = pool.submit(submit, store, item).result(timeout=5)
            assert second.status == 'needs_recovery'
        finally:
            release.set()
        assert first.result(timeout=5).status == 'completed'
    assert writers.expense.call_count == 1
    assert submit(store, item).status == 'completed'


@pytest.mark.parametrize('kind', ['expense', 'income'])
def test_uncertain_write_keeps_durable_guard_without_retry(store, writers, kind):
    item = seed(store)
    writer = writers.expense if kind == 'expense' else writers.income
    writer.side_effect = TimeoutError('write may have reached Sheets')
    first = submit(store, item, kind)
    assert first.status == 'needs_recovery'
    operation = store.get_import_operation('brian', item.id)
    assert operation.status == 'needs_recovery'
    writer.side_effect = None
    restarted = BankStore(store.path, TokenCipher('test-secret'))
    second = submit(restarted, item, kind)
    assert second.status == 'needs_recovery'
    assert writer.call_count == 1
    assert first.operation_id == second.operation_id


def test_missing_action_id_never_marks_import_confirmed(store, writers):
    item = seed(store)
    writers.record.return_value = None
    result = submit(store, item)
    assert result.status == 'needs_recovery'
    assert store.get_reconciliation_item('brian', item.id).status == 'import_requested'
    assert submit(store, item).status == 'needs_recovery'
    assert writers.expense.call_count == 1


def test_persisted_action_recovers_after_confirmation_failure(store, writers, monkeypatch):
    item = seed(store)
    original = store.complete_reconciliation_import
    def record(*args):
        metadata = args[5]
        writers.actions.append(action_for(metadata['bank_import_operation_id'], item.id, action_id='expense-action'))
        return 'expense-action'
    writers.record.side_effect = record
    monkeypatch.setattr(store, 'complete_reconciliation_import', Mock(side_effect=RuntimeError('database unavailable')))
    first = submit(store, item)
    assert first.status == 'needs_recovery'
    monkeypatch.setattr(store, 'complete_reconciliation_import', original)
    second = submit(store, item)
    assert second.status == 'completed'
    assert second.action_id == 'expense-action'
    assert writers.expense.call_count == 1


def test_logging_that_succeeded_despite_lost_response_recovers_without_second_write(store, writers):
    item = seed(store)
    def lost_response(*args):
        writers.actions.append(action_for(args[5]['bank_import_operation_id'], item.id))
        return None
    writers.record.side_effect = lost_response
    result = submit(store, item)
    assert result.status == 'completed'
    assert result.action_id == 'recovered-action'
    assert writers.expense.call_count == 1


def test_ambiguous_recovery_does_not_guess_or_write(store, writers):
    item = seed(store)
    writers.expense.side_effect = TimeoutError()
    first = submit(store, item)
    writers.actions.extend([
        action_for(first.operation_id, item.id, action_id='one'),
        action_for(first.operation_id, item.id, action_id='two'),
    ])
    assert submit(store, item).status == 'needs_recovery'
    assert writers.expense.call_count == 1


def test_ignored_during_write_is_not_overwritten_by_confirmation(store, writers):
    item = seed(store)
    def write(*args):
        store.ignore_reconciliation_item('brian', item.id)
        return 12
    writers.expense.side_effect = write
    result = submit(store, item)
    assert result.status == 'needs_recovery'
    assert store.get_reconciliation_item('brian', item.id).status == 'ignored'
    assert store.get_import_operation('brian', item.id).matched_action_log_id == 'expense-action'


def test_month_rollover_during_worksheet_lookup_blocks_writer(store, writers, monkeypatch):
    item = seed(store)
    def worksheet():
        monkeypatch.setattr(imports, 'now_pacific', lambda: datetime(2026, 10, 1))
        return SimpleNamespace(title='October')
    writers.repo.expense_sheet.side_effect = worksheet
    assert submit(store, item).status == 'needs_recovery'
    writers.expense.assert_not_called()


def test_completed_import_cannot_recreate_row_after_intentional_reopen(store, writers):
    item = seed(store)
    assert submit(store, item).status == 'completed'
    store.reopen_reconciliation_item('brian', item.id)
    assert submit(store, item).status == 'needs_recovery'
    assert writers.expense.call_count == 1


def test_claim_rechecks_bank_transaction_inside_atomic_update(store, writers, monkeypatch):
    item = seed(store)
    original = store.claim_reconciliation_import
    def claim(*args, **kwargs):
        store.mark_transactions_removed(['txn-1'])
        return original(*args, **kwargs)
    monkeypatch.setattr(store, 'claim_reconciliation_import', claim)
    assert submit(store, item).status == 'rejected'
    assert store.get_import_operation('brian', item.id) is None
    writers.expense.assert_not_called()


def test_uncertain_import_stays_visible_in_review_and_is_not_counted_confirmed(store, writers):
    item = seed(store)
    writers.expense.side_effect = TimeoutError()
    result = submit(store, item)
    assert result.status == 'needs_recovery'
    assert [pending.id for pending in store.unresolved_reconciliation_items('brian')] == [item.id]
    buckets = store.reconciliation_cache_buckets('brian')
    assert buckets.needs_review == 1
    assert buckets.confirmed == 0
    assert store.resolved_reconciliation_items('brian') == []


def test_recovery_does_not_search_a_different_month_or_year_action_log(store, writers, monkeypatch):
    item = seed(store)
    writers.expense.side_effect = TimeoutError()
    assert submit(store, item).status == 'needs_recovery'
    monkeypatch.setattr(imports, 'now_pacific', lambda: datetime(2027, 9, 6))
    reader = Mock(side_effect=AssertionError('must not search another year'))
    monkeypatch.setattr(imports, 'read_active_logged_actions', reader)
    assert submit(store, item).status == 'needs_recovery'
    reader.assert_not_called()
    assert writers.expense.call_count == 1


def test_recovery_requires_matching_action_target_period(store, writers):
    item = seed(store)
    writers.expense.side_effect = TimeoutError()
    first = submit(store, item)
    wrong_period = action_for(first.operation_id, item.id)
    wrong_period.action.metadata['bank_import_target_month'] = '8'
    writers.actions.append(wrong_period)
    assert submit(store, item).status == 'needs_recovery'
    assert writers.expense.call_count == 1


def test_concurrent_operation_completion_is_idempotent(store, writers):
    item = seed(store)
    operation, claimed = store.claim_reconciliation_import(
        'brian', item.id, operation_id='test-operation', actor_key='actor', kind='expense',
        request={'bank_amount':20, 'bank_date':'2026-09-05'},
    )
    assert claimed
    def complete(_):
        return store.complete_reconciliation_import(operation, action_id='one-action', sheet_ref='expense!row 12')
    with ThreadPoolExecutor(max_workers=2) as pool:
        completed = list(pool.map(complete, range(2)))
    assert [operation.status for operation in completed] == ['completed', 'completed']
    assert store.get_reconciliation_item('brian', item.id).matched_action_log_id == 'one-action'
