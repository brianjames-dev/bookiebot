from datetime import date, datetime

from bookiebot.core import subscription_reminders
from bookiebot.sheets.subscriptions import Subscription, SubscriptionReminder


def test_reminder_is_not_eligible_before_configured_hour(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10")

    assert subscription_reminders._reminder_is_eligible(datetime(2026, 5, 14, 9, 59)) is False


def test_reminder_is_eligible_at_configured_hour(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10")

    assert subscription_reminders._reminder_is_eligible(datetime(2026, 5, 14, 10, 0)) is True


def test_reminder_is_eligible_after_configured_hour(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10")

    assert subscription_reminders._reminder_is_eligible(datetime(2026, 5, 14, 15, 30)) is True


def test_format_subscription_reminder_digest_groups_by_window():
    reminders = [
        SubscriptionReminder(
            subscription=Subscription(name="ChatGPT", amount=20, cadence="monthly", pull_day=17),
            pull_date=date(2026, 5, 17),
            days_until=3,
        ),
        SubscriptionReminder(
            subscription=Subscription(name="Railway", amount=5, cadence="monthly", pull_day=15, account="BofA"),
            pull_date=date(2026, 5, 15),
            days_until=1,
        ),
        SubscriptionReminder(
            subscription=Subscription(name="Amazon Prime", amount=152.9, cadence="yearly", pull_day=21, pull_month=5),
            pull_date=date(2026, 5, 21),
            days_until=7,
        ),
    ]

    assert subscription_reminders.format_subscription_reminder_digest("<@123>", reminders) == (
        "<@123> Upcoming subscription pulls:\n"
        "\n"
        "Tomorrow\n"
        "- Railway: $5.00 from BofA on May 15\n"
        "\n"
        "In 3 days\n"
        "- ChatGPT: $20.00 on May 17\n"
        "\n"
        "In 7 days\n"
        "- Amazon Prime: $152.90 on May 21"
    )
