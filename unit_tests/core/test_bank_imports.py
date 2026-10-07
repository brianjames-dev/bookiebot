from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from bookiebot.banking.models import BankImportResult
from bookiebot.core import bank_reconciliation_flow as flow


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['expense', 'income'])
@pytest.mark.parametrize('status', ['completed', 'rejected', 'needs_recovery'])
async def test_both_modals_defer_before_service_and_complete_private_response(monkeypatch, kind, status):
    item = SimpleNamespace(id=7, status='needs_review', transaction=SimpleNamespace(
        amount=20.0, date='2026-09-05', authorized_date=None,
        merchant_name='Test merchant', name='Test transaction',
    ))
    interaction = SimpleNamespace(
        response=SimpleNamespace(defer=AsyncMock()), edit_original_response=AsyncMock(),
    )
    def service_import(owner_key, reconciliation_id, **kwargs):
        interaction.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
        assert (owner_key, reconciliation_id) == ('brian', 7)
        assert kwargs['actor_key'] == 'actor'
        assert kwargs['kind'] == kind
        assert kwargs['expected_amount'] == 20.0
        assert kwargs['expected_date'] == '2026-09-05'
        return BankImportResult(status, 'Result for the user')
    service = SimpleNamespace(import_reconciliation_item=Mock(side_effect=service_import),
                              get_reconciliation_item=Mock(return_value=item))
    monkeypatch.setattr(flow, 'build_banking_service', lambda: service)
    continued = AsyncMock()
    if kind == 'expense':
        modal = flow._BankExpenseLogModal(item=item, owner_key='brian', actor_key='actor',
                                         continue_session=continued, category='food', person='Brian (BofA)')
    else:
        modal = flow._BankIncomeLogModal(item=item, owner_key='brian', actor_key='actor', continue_session=continued)
    await modal.on_submit(interaction)
    interaction.edit_original_response.assert_awaited_once_with(content='Result for the user')
    assert continued.await_count == (1 if status == 'completed' else 0)


@pytest.mark.asyncio
async def test_failed_import_closes_deferred_response_without_internal_error(monkeypatch):
    item = SimpleNamespace(id=7, transaction=SimpleNamespace(amount=20, date='2026-09-05', authorized_date=None))
    service = SimpleNamespace(import_reconciliation_item=Mock(side_effect=RuntimeError('private error')))
    monkeypatch.setattr(flow, 'build_banking_service', lambda: service)
    interaction = SimpleNamespace(response=SimpleNamespace(defer=AsyncMock()), edit_original_response=AsyncMock())
    continued = AsyncMock()
    await flow._submit_bank_import(interaction, item=item, owner_key='brian', actor_key='actor',
                                   kind='expense', fields={}, continue_session=continued)
    interaction.edit_original_response.assert_awaited_once()
    assert 'private error' not in interaction.edit_original_response.call_args.kwargs['content']
    continued.assert_not_awaited()


@pytest.mark.parametrize('kind', ['expense', 'income'])
@pytest.mark.parametrize('status', ['completed', 'rejected', 'needs_recovery'])
def test_admin_imports_use_same_durable_service_and_preserve_recovery_message(monkeypatch, kind, status):
    from bookiebot.core import commands
    item = SimpleNamespace(id=7, status='needs_review', transaction=SimpleNamespace(
        amount=20 if kind == 'expense' else -20, date='2026-10-07', authorized_date=None,
        merchant_name='Test merchant', name='Test transaction'))
    service = SimpleNamespace(get_reconciliation_item=Mock(return_value=item),
        import_reconciliation_item=Mock(return_value=BankImportResult(status, 'Check recovery status')))
    monkeypatch.setattr(commands, 'build_banking_service', lambda: service)
    # Any direct call to a sheet writer would require real configuration and fail;
    # the helper must forward the full reviewed snapshot to the durable service.
    if kind == 'expense':
        current, outcome = commands._log_bank_reconciliation_expense(actor_key='actor', owner_key='brian',
            reconciliation_id=7, category='needs', person='Brian (BofA)', item_name='T', location='Gameday')
    else:
        current, outcome = commands._log_bank_reconciliation_income(actor_key='actor', owner_key='brian',
            reconciliation_id=7, source='Paycheck', label='income')
    assert current is item
    kwargs = service.import_reconciliation_item.call_args.kwargs
    assert kwargs['expected_item'] is item and kwargs['kind'] == kind
    assert outcome == ('logged' if status == 'completed' else f'import_{status}: Check recovery status')


@pytest.mark.asyncio
@pytest.mark.parametrize('status', ['confirmed', 'ignored'])
async def test_import_form_resolved_in_phone_advances_discord_session(monkeypatch, status):
    item = SimpleNamespace(id=7, transaction=SimpleNamespace(amount=20, date='2026-10-07', authorized_date=None))
    service = SimpleNamespace(import_reconciliation_item=Mock(return_value=BankImportResult(
        'rejected', 'This item is already reviewed.')),
        get_reconciliation_item=Mock(return_value=SimpleNamespace(status=status)))
    monkeypatch.setattr(flow, 'build_banking_service', lambda: service)
    reply = SimpleNamespace(response=SimpleNamespace(defer=AsyncMock()), edit_original_response=AsyncMock())
    continued = AsyncMock()
    await flow._submit_bank_import(reply, item=item, owner_key='brian', actor_key='actor',
                                   kind='expense', fields={}, continue_session=continued)
    assert service.import_reconciliation_item.call_args.kwargs['expected_item'] is item
    continued.assert_awaited_once_with(reply)
