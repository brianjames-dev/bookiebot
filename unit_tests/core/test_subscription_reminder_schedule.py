from datetime import datetime

from bookiebot.core import subscription_reminders


def test_reminder_is_not_eligible_before_configured_hour(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10")

    assert subscription_reminders._reminder_is_eligible(datetime(2026, 5, 14, 9, 59)) is False


def test_reminder_is_eligible_at_configured_hour(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10")

    assert subscription_reminders._reminder_is_eligible(datetime(2026, 5, 14, 10, 0)) is True


def test_reminder_is_eligible_after_configured_hour(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10")

    assert subscription_reminders._reminder_is_eligible(datetime(2026, 5, 14, 15, 30)) is True
