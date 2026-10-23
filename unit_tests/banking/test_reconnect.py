"""Repair an existing Item without exchanging tokens or replacing its history."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from bookiebot.banking.config import BankingConfig
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import BankAccount
from bookiebot.banking.plaid_client import PlaidClient
from bookiebot.banking.service import BankingService
from bookiebot.banking.store import BankStore


@pytest.fixture
def service(tmp_path):
    config = BankingConfig('client', 'secret', 'sandbox', 'key', tmp_path / 'bank.sqlite3')
    store = BankStore(config.sqlite_path, TokenCipher('key'))
    store.initialize()
    item = store.upsert_item(owner_key='brian', provider='plaid', item_id='existing-item',
                             access_token='existing-private-token', institution_name='Example Bank')
    store.upsert_accounts([BankAccount(item.id, 'account', 'brian', 'Checking', '1234',
                                       'depository', 'checking', None, 100, 100)])
    store.mark_sync_success(item.id, 'saved-cursor')
    store.mark_sync_error(item.id, 'PlaidApiError: ITEM_LOGIN_REQUIRED')
    plaid = SimpleNamespace(create_update_link=AsyncMock(return_value='https://secure.plaid.com/hl/test'),
                            exchange_public_token=AsyncMock(side_effect=AssertionError('Never exchange in update mode')),
                            get_accounts=AsyncMock(return_value=[{'account_id': 'account', 'name': 'Checking',
                                'type': 'depository', 'subtype': 'checking', 'balances': {}}]),
                            sync_transactions=AsyncMock(return_value={'added': [], 'modified': [], 'removed': [],
                                'next_cursor': 'fresh-cursor', 'has_more': False}))
    return BankingService(config, store, plaid)


@pytest.mark.asyncio
async def test_update_link_uses_existing_token_without_products_or_new_item(tmp_path, monkeypatch):
    client = PlaidClient(BankingConfig('client', 'secret', 'sandbox', 'key', tmp_path / 'bank'))
    post = AsyncMock(return_value={'hosted_link_url': 'https://secure.plaid.com/hl/test'})
    monkeypatch.setattr(client, '_post', post)
    assert await client.create_update_link(owner_key='brian', access_token='private-token',
        completion_redirect_uri='https://bookie.test/bank/link?token=signed&complete=1') == 'https://secure.plaid.com/hl/test'
    path, payload = post.call_args.args
    assert path == '/link/token/create'
    assert payload['access_token'] == 'private-token'
    assert payload['user'] == {'client_user_id': 'brian'}
    assert payload['hosted_link']['completion_redirect_uri'].endswith('&complete=1')
    assert 'products' not in payload and 'transactions' not in payload
    assert 'phone_number' not in payload['user']


@pytest.mark.asyncio
async def test_reconnect_preserves_item_accounts_watch_cursor_and_review_history(service):
    item = service.linked_items('brian')[0]
    account = service.accounts('brian')[0]
    service.store.upsert_transactions([{'transaction_id': 'old', 'account_id': 'account',
        'date': '2026-10-14', 'name': 'Old purchase', 'amount': 12, 'pending': False}], 'brian')
    transaction = service.recent_transactions('brian')[0]
    review = service.store.upsert_reconciliation_item(owner_key='brian', transaction=transaction,
        classification='expense', status='ignored', confidence=0)
    assert service.connection_issues('brian')[0]['needsReconnect'] is True
    assert await service.create_reconnect_link('brian', item.id, 'https://bookie.test/complete')
    service.plaid.create_update_link.assert_awaited_once_with(owner_key='brian',
        access_token='existing-private-token', completion_redirect_uri='https://bookie.test/complete')
    assert service.store.get_cursor(item.id) == 'saved-cursor'
    result = await service.complete_reconnect('brian', item.id)
    assert result.item_id == item.id
    assert service.linked_items('brian') == [item]
    assert service.accounts('brian')[0].id == account.id
    assert service.accounts('brian')[0].watched == account.watched
    assert service.store.get_cursor(item.id) == 'fresh-cursor'
    assert service.store.get_reconciliation_item('brian', review.id).status == 'ignored'
    assert service.connection_issues('brian') == []
    service.plaid.exchange_public_token.assert_not_awaited()
    service.plaid.sync_transactions.assert_awaited_once_with('existing-private-token', cursor='saved-cursor')


@pytest.mark.asyncio
@pytest.mark.parametrize('owner,disconnected', [('hannah', False), ('brian', True)])
async def test_reconnect_rejects_other_owner_and_disconnected_before_provider_call(service, owner, disconnected):
    item = service.linked_items('brian')[0]
    if disconnected:
        service.disconnect_item('brian', item.id)
    for operation in [lambda: service.create_reconnect_link(owner, item.id, 'https://bookie.test/complete'),
                      lambda: service.complete_reconnect(owner, item.id)]:
        with pytest.raises(ValueError):
            await operation()
    service.plaid.create_update_link.assert_not_awaited()
    service.plaid.get_accounts.assert_not_awaited()


@pytest.mark.asyncio
async def test_failed_reconnect_does_not_clear_warning_or_cursor(service):
    item = service.linked_items('brian')[0]
    service.plaid.get_accounts.side_effect = RuntimeError('ITEM_LOGIN_REQUIRED')
    with pytest.raises(RuntimeError):
        await service.complete_reconnect('brian', item.id)
    assert service.connection_issues('brian')[0]['needsReconnect']
    assert service.store.get_cursor(item.id) == 'saved-cursor'


@pytest.mark.asyncio
async def test_reconnect_sync_replaces_pending_using_original_cursor_and_preserves_hidden_account(service):
    item = service.linked_items('brian')[0]
    service.store.upsert_accounts([BankAccount(item.id, 'hidden', 'brian', 'Savings', '9999',
        'depository', 'savings', None, 100, 100, watched=False)])
    service.store.upsert_transactions([{'transaction_id': 'authorization', 'account_id': 'account',
        'date': '2026-10-14', 'name': 'Coffee', 'amount': 12, 'pending': True}], 'brian')
    service.plaid.get_accounts.return_value.append({'account_id': 'hidden', 'name': 'Savings',
        'type': 'depository', 'subtype': 'savings', 'balances': {}})
    service.plaid.sync_transactions.return_value = {'added': [{'transaction_id': 'posted',
        'pending_transaction_id': 'authorization', 'account_id': 'account', 'date': '2026-10-15',
        'name': 'Coffee', 'amount': 12, 'pending': False}], 'modified': [],
        'removed': [{'transaction_id': 'authorization'}], 'next_cursor': 'repaired-cursor', 'has_more': False}
    result = await service.complete_reconnect('brian', item.id)
    assert (result.added, result.removed) == (1, 1)
    rows = service.store.review_transactions('brian', start_date='2026-10-01')
    assert len(rows) == 1 and not rows[0].pending
    assert rows[0].provider_transaction_id == 'posted'
    assert not next(account for account in service.accounts('brian') if account.provider_account_id == 'hidden').watched
    assert service.store.get_cursor(item.id) == 'repaired-cursor'


@pytest.mark.asyncio
async def test_repaired_webhook_retains_error_until_provider_sync_succeeds(service):
    item = service.linked_items('brian')[0]
    service.plaid.get_accounts.side_effect = RuntimeError('ITEM_LOGIN_REQUIRED')
    service.receive_plaid_webhook({'item_id': item.item_id, 'webhook_type': 'ITEM', 'webhook_code': 'LOGIN_REPAIRED'})
    assert (await service.process_plaid_webhook_inbox())['failed'] == 1
    assert service.connection_issues('brian')[0]['needsReconnect']
    assert service.store.get_cursor(item.id) == 'saved-cursor'


@pytest.mark.asyncio
async def test_item_error_webhook_exposes_owner_warning_and_login_repaired_verifies_sync(service):
    item = service.linked_items('brian')[0]
    service.store.mark_sync_success(item.id, 'saved-cursor')
    service.receive_plaid_webhook({'item_id': item.item_id, 'webhook_type': 'ITEM',
        'webhook_code': 'ERROR', 'error': {'error_code': 'ITEM_LOGIN_REQUIRED'}})
    assert (await service.process_plaid_webhook_inbox())['processed'] == 1
    assert service.connection_issues('brian')[0]['needsReconnect']
    assert service.connection_issues('hannah') == []
    service.plaid.get_accounts.assert_not_awaited()
    service.receive_plaid_webhook({'item_id': item.item_id, 'webhook_type': 'ITEM', 'webhook_code': 'LOGIN_REPAIRED'})
    assert (await service.process_plaid_webhook_inbox())['processed'] == 1
    assert service.connection_issues('brian') == []


@pytest.mark.asyncio
async def test_delayed_item_error_cannot_replace_a_newer_successful_reconnect(service):
    item = service.linked_items('brian')[0]
    service.receive_plaid_webhook({'item_id': item.item_id, 'webhook_type': 'ITEM',
        'webhook_code': 'ERROR', 'error': {'error_code': 'ITEM_LOGIN_REQUIRED'}})
    await service.complete_reconnect('brian', item.id)
    assert (await service.process_plaid_webhook_inbox())['processed'] == 1
    assert service.connection_issues('brian') == []

