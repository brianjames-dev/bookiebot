from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from bookiebot.core import subscription_reminders as reminders


@pytest.fixture
def scheduler(monkeypatch):
    monkeypatch.setattr(reminders, '_LAST_REMINDER_EVALUATION_DATE', {})
    monkeypatch.setattr(reminders, '_REMINDER_RETRY_AFTER', {})
    monkeypatch.setattr(reminders, '_REMINDER_FAILURES', {})
    monkeypatch.setattr(reminders, '_reminders_enabled', lambda: True)
    monkeypatch.setattr(reminders, '_notification_users', lambda: [('actor','<@actor>')])
    monkeypatch.setattr(reminders, '_target_channel', lambda _: None)
    monkeypatch.setattr(reminders, '_reminder_is_eligible', lambda *_: True)
    monkeypatch.setattr(reminders, 'now_pacific', lambda: datetime(2026,9,6,10))
    clock = [1000.0]
    monkeypatch.setattr(reminders.time, 'monotonic', lambda: clock[0])
    sender = AsyncMock(return_value=True)
    monkeypatch.setattr(reminders, '_send_user_dm', sender)
    return clock, sender


@pytest.mark.asyncio
async def test_failed_evaluation_retries_same_day_after_backoff_then_delivers_once(scheduler, monkeypatch):
    clock, sender = scheduler
    prepare = Mock(side_effect=[
        reminders._prepared(messages=[], sent_count=0, evaluation_succeeded=False),
        reminders._prepared(messages=['due subscriptions'], sent_count=1),
    ])
    monkeypatch.setattr(reminders, '_prepare_due_reminder_messages', prepare)
    client = SimpleNamespace()
    assert await reminders.send_due_subscription_reminders(client) == 0
    assert reminders._LAST_REMINDER_EVALUATION_DATE == {}
    assert reminders._next_reminder_check_seconds() == 60
    assert await reminders.send_due_subscription_reminders(client) == 0
    assert prepare.call_count == 1
    clock[0] += 60
    assert await reminders.send_due_subscription_reminders(client) == 1
    assert await reminders.send_due_subscription_reminders(client) == 0
    assert prepare.call_count == 2
    sender.assert_awaited_once()
    assert reminders._REMINDER_RETRY_AFTER == {}


@pytest.mark.asyncio
async def test_successful_empty_evaluation_is_complete_without_retry(scheduler, monkeypatch):
    prepare = Mock(return_value=reminders._prepared(messages=[], sent_count=0))
    monkeypatch.setattr(reminders, '_prepare_due_reminder_messages', prepare)
    await reminders.send_due_subscription_reminders(SimpleNamespace())
    await reminders.send_due_subscription_reminders(SimpleNamespace())
    assert prepare.call_count == 1
    assert reminders._REMINDER_RETRY_AFTER == {}


def test_backoff_is_capped_and_stale_actor_retry_cannot_create_busy_loop(scheduler, monkeypatch):
    clock, _ = scheduler
    monkeypatch.setattr(reminders, '_check_interval_seconds', lambda: 3600)
    for _ in range(20):
        reminders._schedule_reminder_retry('actor')
    assert reminders._REMINDER_RETRY_AFTER['actor'] - clock[0] == 3600
    clock[0] += 3601
    assert reminders._next_reminder_check_seconds() == 3600


def test_failed_primary_and_fallback_evaluation_is_retryable(monkeypatch):
    from contextlib import nullcontext
    monkeypatch.setattr(reminders, 'sheet_user_context', lambda _: nullcontext())
    monkeypatch.setattr(reminders, 'debug_subscription_sync', Mock(side_effect=RuntimeError('primary read failed')))
    monkeypatch.setattr(reminders, 'due_subscription_reminders', Mock(side_effect=RuntimeError('fallback read failed')))
    prepared = reminders._prepare_due_reminder_messages('actor', '<@actor>', datetime(2026,9,6).date())
    assert prepared.evaluation_succeeded is False
    assert prepared.messages == []
