"""Private Discord reviews share live persisted state with phone decisions."""
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from bookiebot.banking.models import BankTransaction, ReconciliationItem
from bookiebot.core import bank_reconciliation_flow as flow
from bookiebot.banking.reconciliation import ActionLogCandidate
from datetime import date


def item(identity):
    transaction = BankTransaction(identity, f'txn-{identity}', 'brian', 'Checking', '1234',
        'depository', 'checking', '2026-10-07', None, f'Purchase {identity}', None,
        20, False, 'online', 'bank-v1')
    return ReconciliationItem(identity, 'brian', identity, transaction.provider_transaction_id,
        'expense', 'needs_review', .5, None, None, 'first', 'review-v1', None, None, None, transaction)


def interaction():
    return SimpleNamespace(response=SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
                           followup=SimpleNamespace(send=AsyncMock()))


class Service:
    def __init__(self, count=4):
        self.items = {identity: item(identity) for identity in range(1, count + 1)}
        self.ignored = []

    def unresolved_reconciliation_items(self, owner, limit, *, reconciliation_ids=None):
        return [entry for entry in self.items.values() if entry.status == 'needs_review'
                and (reconciliation_ids is None or entry.id in reconciliation_ids)]

    def get_reconciliation_item(self, owner, identity):
        return self.items.get(identity)

    def reconciliation_match_candidates(self, owner, identity, **kwargs):
        return self.get_reconciliation_item(owner, identity), [], []

    def ignore_reconciliation_item(self, owner, identity, *, expected_item):
        assert expected_item == self.items[identity]
        self.ignored.append(identity)
        self.items[identity] = replace(self.items[identity], status='ignored', last_seen_at='ignored')
        return self.items[identity]


def view(reply):
    return next(call.kwargs['view'] for call in reversed(reply.followup.send.call_args_list) if 'view' in call.kwargs)


def button(reply, action):
    return next(child for child in view(reply).children if getattr(child, 'action', None) == action)


async def start(monkeypatch, service):
    monkeypatch.setattr(flow, 'build_banking_service', lambda: service)
    reply = interaction()
    await flow.send_next_bank_reconciliation_item(reply, owner_key='brian', owner_name='Brian', actor_key='actor')
    return reply


@pytest.mark.asyncio
async def test_fixed_session_progress_codes_both_numbers_and_excludes_new_arrivals(monkeypatch):
    service = Service()
    reply = await start(monkeypatch, service)
    assert 'item `1` of `4`' in reply.followup.send.call_args.kwargs['content']
    service.items[5] = item(5)
    for ordinal in range(2, 5):
        clicked = interaction()
        await button(reply, 'ignore').callback(clicked)
        clicked.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
        assert f'item `{ordinal}` of `4`' in clicked.followup.send.call_args.kwargs['content']
        reply = clicked
    final = interaction()
    await button(reply, 'ignore').callback(final)
    assert 'session is complete' in final.followup.send.call_args.kwargs['content']
    assert service.ignored == [1, 2, 3, 4]
    assert service.items[5].status == 'needs_review'


@pytest.mark.asyncio
@pytest.mark.parametrize('status', ['confirmed', 'matched', 'ignored', 'removed'])
@pytest.mark.parametrize('action', ['ignore', 'log', 'fallback', 'skip'])
async def test_old_control_after_phone_resolution_explains_and_advances(monkeypatch, status, action):
    service = Service()
    reply = await start(monkeypatch, service)
    if status == 'removed':
        service.items.pop(1)
    else:
        service.items[1] = replace(service.items[1], status=status, last_seen_at='web-v2')
    clicked = interaction()
    await button(reply, action).callback(clicked)
    messages = [call.kwargs.get('content', call.args[0] if call.args else '')
                for call in clicked.followup.send.call_args_list]
    assert any('already' in message or 'no longer available' in message for message in messages)
    assert all('was found' not in message for message in messages)
    assert 'item `2` of `4`' in messages[-1]
    assert service.ignored == []


@pytest.mark.asyncio
async def test_stale_view_after_reopen_requires_fresh_review(monkeypatch):
    service = Service(1)
    reply = await start(monkeypatch, service)
    service.items[1] = replace(service.items[1], last_seen_at='web-reopened')
    clicked = interaction()
    await button(reply, 'ignore').callback(clicked)
    assert 'changed since' in clicked.followup.send.call_args_list[0].kwargs['content']
    assert 'item `1` of `1`' in clicked.followup.send.call_args.kwargs['content']
    assert service.ignored == []


@pytest.mark.asyncio
async def test_skipped_item_resolved_in_phone_does_not_leave_phantom_pause(monkeypatch):
    service = Service(2)
    reply = await start(monkeypatch, service)
    skipped = interaction()
    await button(reply, 'skip').callback(skipped)
    assert 'item `2` of `2`' in skipped.followup.send.call_args.kwargs['content']
    service.items[1] = replace(service.items[1], status='confirmed')
    final = interaction()
    await button(skipped, 'ignore').callback(final)
    assert 'session is complete' in final.followup.send.call_args.kwargs['content']


@pytest.mark.asyncio
async def test_direct_detail_of_completed_review_has_no_mutation_controls(monkeypatch):
    service = Service(1)
    service.items[1] = replace(service.items[1], status='confirmed')
    monkeypatch.setattr(flow, 'build_banking_service', lambda: service)
    reply = interaction()
    await flow.send_bank_reconciliation_detail(reply, owner_key='brian', owner_name='Brian',
                                               reconciliation_id=1, actor_key='actor')
    assert 'already reconciled' in reply.followup.send.call_args.kwargs['content']
    assert 'view' not in reply.followup.send.call_args.kwargs


@pytest.mark.asyncio
async def test_review_owner_checked_before_work_and_response_defer(monkeypatch):
    service = Service(1)
    reply = await start(monkeypatch, service)
    clicked = interaction()
    clicked.user = SimpleNamespace(id='another-actor')
    await button(reply, 'ignore').callback(clicked)
    clicked.response.send_message.assert_awaited_once()
    clicked.response.defer.assert_not_awaited()
    clicked.followup.send.assert_not_awaited()
    assert service.ignored == []


@pytest.mark.asyncio
async def test_unavailable_match_explains_conflict_without_repeating_unchanged_card(monkeypatch):
    service = Service(1)
    candidate = ActionLogCandidate('action', 'expense!row 4#cols=1,2,3,4#month=2026-10',
        'expense', date(2026, 10, 7), 20, 'grocery', .98, 'exact')
    service.reconciliation_match_candidates = lambda *args, **kwargs: (service.items[1], [candidate], [])
    service.confirm_reconciliation_action_match = lambda *args, **kwargs: (service.items[1], candidate, 'match_unavailable')
    reply = await start(monkeypatch, service)
    clicked = interaction()
    await button(reply, 'candidate:0').callback(clicked)
    clicked.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
    clicked.followup.send.assert_awaited_once()
    message = clicked.followup.send.call_args.kwargs['content']
    assert 'already linked' in message and 'changed since' not in message
    assert 'view' not in clicked.followup.send.call_args.kwargs
