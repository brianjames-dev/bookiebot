from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from bookiebot.core import bank_reconciliation as digest
from bookiebot.core.bank_link import verify_bank_link_setup_token


@pytest.fixture
def failed_bank(monkeypatch):
    monkeypatch.setenv('BANK_LINK_SIGNING_SECRET', 'test-reconnect-key')
    service = SimpleNamespace(config=SimpleNamespace(configured=True, public_base_url='https://bookie.test'),
        sync_owner=AsyncMock(side_effect=RuntimeError('ITEM_LOGIN_REQUIRED')),
        connection_issues=lambda owner: [{'id': 3, 'institution': 'Example Bank', 'needsReconnect': True,
                                         'checkedAt': '2026-10-15T14:00:45+00:00'}],
        reconciliation_preview=lambda *a, **kw: pytest.fail('Broken connection must not read Sheets or preview'))
    monkeypatch.setattr(digest, 'build_banking_service', lambda: service)
    monkeypatch.setattr(digest, 'get_user_config', lambda actor: SimpleNamespace(budget_owner_key='brian'))
    monkeypatch.setattr(digest, '_digest_events', lambda *a: set())
    return service


def test_empty_cached_inbox_still_produces_actionable_connection_alert(failed_bank):
    result = digest.prepare_bank_reconciliation_digest_messages('123', '<@123>', date(2026, 10, 23), mark_sent=False)
    assert result.event_type == 'bank_connection_alert_sent'
    assert 'Reconnect Example Bank' in result.public_message
    assert 'Oct 15, 07:00 AM Pacific' in result.public_message
    assert '/bank_reconnect' in result.public_message
    token = result.reconnect_links[0][1].split('token=')[1]
    assert verify_bank_link_setup_token(token) == {'actor_key': '123', 'owner_key': 'brian', 'item_db_id': '3'}


def test_alert_deduplication_does_not_consume_normal_digest(failed_bank, monkeypatch):
    events = []
    monkeypatch.setattr(digest, 'record_system_event', lambda actor, event, *a: events.append(event) or True)
    result = digest.prepare_bank_reconciliation_digest_messages('123', '<@123>', date(2026, 10, 23), mark_sent=True)
    assert result and events == ['bank_connection_alert_sent']
    monkeypatch.setattr(digest, '_digest_events', lambda *a: set(events))
    assert digest.prepare_bank_reconciliation_digest_messages('123', '<@123>', date(2026, 10, 23), mark_sent=False) is None

    from bookiebot.banking.models import ReconciliationPreview
    from unit_tests.core.test_bank_reconciliation import _reconciliation_item
    review = _reconciliation_item(42, name='Fresh purchase')
    failed_bank.sync_owner.side_effect = None
    failed_bank.connection_issues = lambda owner: []
    failed_bank.reconciliation_preview = lambda *a, **kw: ReconciliationPreview(owner_key='brian',
        items=[review], cached_transaction_count=1, candidate_transaction_count=1)
    failed_bank.unresolved_reconciliation_items = lambda *a, **kw: [review]
    failed_bank.matched_reconciliation_items = lambda *a, **kw: []
    failed_bank.reconciliation_report_matches = lambda *a, **kw: []
    result = digest.prepare_bank_reconciliation_digest_messages('123', '<@123>', date(2026, 10, 23), mark_sent=False)
    assert result and result.event_type == 'bank_reconciliation_recovery_digest_sent'
    assert 'Fresh purchase' in result.detail_message


@pytest.mark.asyncio
@pytest.mark.parametrize('delivered', [True, False])
async def test_alert_records_separate_event_only_after_successful_dm(failed_bank, monkeypatch, delivered):
    events = []
    monkeypatch.setattr(digest, '_notification_users', lambda: [('123', '<@123>')])
    monkeypatch.setattr(digest, '_send_user_dm', AsyncMock(return_value=delivered))
    monkeypatch.setattr(digest, 'record_system_event', lambda actor, event, *a: events.append(event) or True)
    assert await digest.send_due_bank_reconciliation_digest(SimpleNamespace(), today=date(2026, 10, 23)) == int(delivered)
    assert events == (['bank_connection_alert_sent'] if delivered else [])
    view = digest._send_user_dm.call_args.kwargs['view']
    assert len(view.children) == 2
    assert view.children[0].custom_id == 'bank_reconcile:resync:123'
    assert view.children[1].url.startswith('https://bookie.test/bank/link?token=')


def test_default_morning_window_is_ten_am_pacific_including_dst(monkeypatch):
    from zoneinfo import ZoneInfo
    monkeypatch.delenv('BOOKIEBOT_BANK_RECONCILIATION_SEND_HOUR', raising=False)
    monkeypatch.delenv('BOOKIEBOT_BANK_RECONCILIATION_SEND_WINDOW_MINUTES', raising=False)
    pacific = ZoneInfo('America/Los_Angeles')
    for month in [1, 7, 10, 11]:
        assert not digest._is_eligible(datetime(2026, month, 23, 9, 59, tzinfo=pacific))
        assert digest._is_eligible(datetime(2026, month, 23, 10, 0, tzinfo=pacific))
        assert digest._is_eligible(datetime(2026, month, 23, 10, 59, tzinfo=pacific))
        assert not digest._is_eligible(datetime(2026, month, 23, 11, 0, tzinfo=pacific))

