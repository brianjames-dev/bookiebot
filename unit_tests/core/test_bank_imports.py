from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from bookiebot.banking.models import BankImportResult
from bookiebot.core import bank_reconciliation_flow as flow


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['expense', 'income'])
@pytest.mark.parametrize('status', ['completed', 'rejected', 'needs_recovery'])
async def test_both_modals_defer_before_service_and_complete_private_response(monkeypatch, kind, status):
    item = SimpleNamespace(id=7, transaction=SimpleNamespace(
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
    service = SimpleNamespace(import_reconciliation_item=Mock(side_effect=service_import))
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
