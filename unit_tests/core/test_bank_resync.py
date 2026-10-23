import asyncio
from contextlib import suppress
from dataclasses import replace
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from zoneinfo import ZoneInfo

import pytest

from bookiebot.banking import service as banking
from bookiebot.banking.models import ReconciliationPreview
from bookiebot.core import bank_reconciliation as digest
from bookiebot.core.bank_link import verify_bank_link_setup_token
from unit_tests.core.test_bank_reconciliation import _reconciliation_item


@pytest.fixture
def morning(monkeypatch):
    monkeypatch.setattr(digest, '_digest_events', lambda *a: set())
    monkeypatch.setenv('BOOKIEBOT_BANK_RECONCILIATION_ENABLED', 'true')
    monkeypatch.setenv('BOOKIEBOT_BANK_RECONCILIATION_SEND_HOUR', '10')
    monkeypatch.setenv('BOOKIEBOT_BANK_RECONCILIATION_SEND_WINDOW_MINUTES', '60')
    monkeypatch.setenv('BANK_LINK_SIGNING_SECRET', 'test-resync-key')
    monkeypatch.setattr(digest, 'now_pacific', lambda: datetime(2026, 10, 23, 10, 5, tzinfo=ZoneInfo('America/Los_Angeles')))


@pytest.mark.asyncio
@pytest.mark.parametrize('normal_already_sent', [False, True])
async def test_morning_failure_repair_and_delivery_retry_produce_one_fresh_digest(morning, monkeypatch, normal_already_sent):
    events = {'bank_reconciliation_digest_sent'} if normal_already_sent else set()
    def record(actor, event, metadata, description):
        assert actor == '123' and metadata['digest_date'] == '2026-10-23'
        events.add(event)
        return True
    monkeypatch.setattr(digest, '_digest_events', lambda *a: set(events))
    monkeypatch.setattr(digest, 'record_system_event', record)
    monkeypatch.setattr(digest, '_notification_users', lambda: [('123', '<@123>')])
    monkeypatch.setattr(digest, 'get_user_config', lambda actor: SimpleNamespace(budget_owner_key='brian'))
    failed = True
    matched = replace(_reconciliation_item(42, name='Recovered posted purchase'), status='matched')
    service = SimpleNamespace(config=SimpleNamespace(configured=True, public_base_url='https://bookie.test'),
        sync_owner=AsyncMock(),
        connection_issues=lambda owner: [{'id': 3, 'institution': 'Example Bank', 'needsReconnect': True, 'checkedAt': None}] if failed else [],
        reconciliation_preview=Mock(return_value=ReconciliationPreview(owner_key='brian', items=[],
            cached_transaction_count=1, candidate_transaction_count=0)),
        unresolved_reconciliation_items=lambda *a, **kw: [],
        matched_reconciliation_items=lambda *a, **kw: [matched],
        reconciliation_report_matches=lambda *a, **kw: [])
    monkeypatch.setattr(digest, 'build_banking_service', lambda: service)
    send = AsyncMock(return_value=True)
    monkeypatch.setattr(digest, '_send_user_dm', send)
    assert await digest.send_due_bank_reconciliation_digest(SimpleNamespace()) == 1
    assert 'bank_connection_alert_sent' in events, 'A prior normal digest cannot hide a later connection failure'
    failed = False
    await digest.notify_bank_reconciliation_refreshed('123')
    send.return_value = False
    assert await digest.send_due_bank_reconciliation_digest(SimpleNamespace()) == 0
    assert 'bank_reconciliation_recovery_digest_sent' not in events
    send.return_value = True
    assert await digest.send_due_bank_reconciliation_digest(SimpleNamespace()) == 1
    assert 'bank_reconciliation_recovery_digest_sent' in events
    assert 'automatic' in send.call_args.args[2], 'Already refreshed matches still appear in the recovery digest'
    assert await digest.send_due_bank_reconciliation_digest(SimpleNamespace()) == 0
    assert send.await_count == 3, 'One alert, one failed attempt and one delivered refreshed digest'
    assert all(call.args == ('brian',) for call in service.sync_owner.await_args_list)


@pytest.mark.asyncio
@pytest.mark.parametrize('hour,minute,eligible', [(9, 59, False), (10, 0, True), (10, 59, True), (11, 0, False)])
async def test_resync_notification_is_confined_to_morning_window(morning, monkeypatch, hour, minute, eligible):
    monkeypatch.setattr(digest, 'now_pacific', lambda: datetime(2026, 1, 23, hour, minute, tzinfo=ZoneInfo('America/Los_Angeles')))
    record = Mock(return_value=True)
    monkeypatch.setattr(digest, 'record_system_event', record)
    wake = asyncio.Event()
    monkeypatch.setattr(digest, '_BANK_RECONCILIATION_WAKE', wake)
    await digest.notify_bank_reconciliation_refreshed('123')
    assert wake.is_set() == eligible
    assert record.call_count == int(eligible)


@pytest.mark.asyncio
async def test_morning_resync_wakes_single_loop_without_waiting_poll_interval(morning, monkeypatch):
    first, second = asyncio.Event(), asyncio.Event()
    calls = 0
    async def send(client):
        nonlocal calls
        calls += 1
        (first if calls == 1 else second).set()
        return 0
    monkeypatch.setattr(digest, 'send_due_bank_reconciliation_digest', send)
    monkeypatch.setattr(digest, 'record_system_event', lambda *a: True)
    monkeypatch.setattr(digest, '_check_interval_seconds', lambda: 3600)
    task = asyncio.create_task(digest.run_bank_reconciliation_loop(SimpleNamespace()))
    try:
        await asyncio.wait_for(first.wait(), timeout=1)
        await digest.notify_bank_reconciliation_refreshed('123')
        await asyncio.wait_for(second.wait(), timeout=1)
        assert calls == 2
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    assert digest._BANK_RECONCILIATION_WAKE is None


@pytest.mark.asyncio
async def test_notification_audit_failure_does_not_turn_successful_sync_into_failure(morning, monkeypatch):
    def unavailable(*args):
        raise RuntimeError('Audit temporarily unavailable')
    monkeypatch.setattr(digest, 'record_system_event', unavailable)
    wake = asyncio.Event()
    monkeypatch.setattr(digest, '_BANK_RECONCILIATION_WAKE', wake)
    await digest.notify_bank_reconciliation_refreshed('123')
    assert wake.is_set()


def test_digest_event_flags_use_one_owner_scoped_read_and_ignore_old_or_undone_events(monkeypatch):
    def event(kind, day='2026-10-23', status='active', action_type='system_state'):
        return SimpleNamespace(status=status, action=SimpleNamespace(metadata={
            'type': action_type, 'event_type': kind, 'digest_date': day}))
    read = Mock(return_value=[event('bank_connection_alert_sent'), event('old', day='2026-10-22'),
        event('undone', status='undone'), event('expense', action_type='expense'),
        event('bank_reconciliation_resync_completed')])
    monkeypatch.setattr(digest, 'read_logged_action_history', read)
    assert digest._digest_events('123', date(2026, 10, 23)) == {
        'bank_connection_alert_sent', 'bank_reconciliation_resync_completed'}
    read.assert_called_once_with('123')


def test_recovery_digest_confirms_healthy_empty_inbox_while_normal_empty_inbox_stays_quiet(morning, monkeypatch):
    service = SimpleNamespace(config=SimpleNamespace(configured=True), sync_owner=AsyncMock(),
        connection_issues=lambda owner: [],
        reconciliation_preview=lambda *a, **kw: ReconciliationPreview(owner_key='brian', items=[],
            cached_transaction_count=0, candidate_transaction_count=0),
        unresolved_reconciliation_items=lambda *a, **kw: [],
        matched_reconciliation_items=lambda *a, **kw: [],
        reconciliation_report_matches=lambda *a, **kw: [])
    monkeypatch.setattr(digest, 'build_banking_service', lambda: service)
    monkeypatch.setattr(digest, 'get_user_config', lambda actor: SimpleNamespace(budget_owner_key='brian'))
    assert digest.prepare_bank_reconciliation_digest_messages('123', '<@123>', date(2026, 10, 23), mark_sent=False) is None
    monkeypatch.setattr(digest, '_digest_events', lambda *a: {'bank_reconciliation_resync_completed'})
    result = digest.prepare_bank_reconciliation_digest_messages('123', '<@123>', date(2026, 10, 23), mark_sent=False)
    assert result.event_type == 'bank_reconciliation_recovery_digest_sent'
    assert 'resynced; no posted transactions need review' in result.public_message


@pytest.mark.asyncio
@pytest.mark.parametrize('persistent', [False, True])
async def test_discord_resync_checks_owner_and_refreshes_shared_review(morning, monkeypatch, persistent):
    service = SimpleNamespace(sync_owner=AsyncMock())
    build = Mock(return_value=service)
    monkeypatch.setattr(digest, 'build_banking_service', build)
    monkeypatch.setattr(digest, 'get_user_config', lambda actor: SimpleNamespace(budget_owner_key='brian'))
    refresh, notify = AsyncMock(), AsyncMock()
    monkeypatch.setattr(digest, 'refresh_reconciliation_review', refresh)
    monkeypatch.setattr(digest, 'notify_bank_reconciliation_refreshed', notify)
    factory = digest.persistent_bank_reconciliation_digest_view if persistent else digest.bank_reconciliation_digest_view
    button = next(child for child in factory('123').children if child.action == 'resync')
    interaction = SimpleNamespace(user=SimpleNamespace(id='999'),
        response=SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
        followup=SimpleNamespace(send=AsyncMock()))
    await button.callback(interaction)
    build.assert_not_called()
    interaction.user.id = '123'
    await button.callback(interaction)
    service.sync_owner.assert_awaited_once_with('brian')
    refresh.assert_awaited_once_with(service, 'brian', '123')
    notify.assert_awaited_once_with('123')
    assert interaction.followup.send.call_args.kwargs['ephemeral']


@pytest.mark.asyncio
async def test_discord_login_failure_offers_fresh_scoped_reconnect_without_digest(morning, monkeypatch):
    service = SimpleNamespace(sync_owner=AsyncMock(side_effect=RuntimeError('ITEM_LOGIN_REQUIRED')),
        config=SimpleNamespace(public_base_url='https://bookie.test'),
        connection_issues=lambda owner: [{'id': 3, 'institution': 'Example Bank', 'needsReconnect': True}])
    monkeypatch.setattr(digest, 'build_banking_service', lambda: service)
    monkeypatch.setattr(digest, 'get_user_config', lambda actor: SimpleNamespace(budget_owner_key='brian'))
    notify = AsyncMock()
    monkeypatch.setattr(digest, 'notify_bank_reconciliation_refreshed', notify)
    interaction = SimpleNamespace(followup=SimpleNamespace(send=AsyncMock()))
    await digest._resync_bank_information(interaction, '123')
    notify.assert_not_awaited()
    view = interaction.followup.send.call_args.kwargs['view']
    link = next(child.url for child in view.children if getattr(child, 'url', None))
    assert verify_bank_link_setup_token(link.split('token=')[1]) == {'actor_key': '123', 'owner_key': 'brian', 'item_db_id': '3'}


@pytest.mark.asyncio
async def test_shared_refresh_forces_owner_scoped_recent_review_and_invalidates_schedule(monkeypatch):
    clear = Mock()
    monkeypatch.setattr(banking, 'clear_schedule_source_cache', clear)
    monkeypatch.setattr(banking, 'now_pacific', lambda: datetime(2026, 10, 23))
    monkeypatch.setattr(banking, '_reconciliation_max_age_days', lambda: 60)
    preview = Mock(return_value='refreshed')
    service = SimpleNamespace(reconciliation_preview=preview)
    assert await banking.refresh_reconciliation_review(service, 'brian', '123') == 'refreshed'
    clear.assert_called_once_with('123')
    preview.assert_called_once_with('brian', limit=200, force=True, actor_key='123', start_date='2026-08-24')
