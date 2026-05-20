from datetime import date, datetime

import pytest

from bookiebot.core import subscription_reminders
from bookiebot.sheets.bills import BillReminder, BillSchedule
from bookiebot.sheets.routing import sheet_user_context
from bookiebot.sheets.subscriptions import Subscription, SubscriptionParseWarning, SubscriptionReminder
from unit_tests.support.sheets_repo_stub import SheetsRepoStub


class FakeChannel:
    def __init__(self):
        self.messages = []

    async def send(self, content, **_kwargs):
        self.messages.append(content)


class FailingChannel:
    async def send(self, content, **_kwargs):
        raise RuntimeError("discord send failed")


class FakeClient:
    def __init__(self, channel):
        self.channel = channel

    def get_channel(self, _channel_id):
        return self.channel


def test_reminder_is_not_eligible_before_configured_hour(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10")

    assert subscription_reminders._reminder_is_eligible(datetime(2026, 5, 14, 9, 59)) is False


def test_reminder_is_eligible_at_configured_hour(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10")

    assert subscription_reminders._reminder_is_eligible(datetime(2026, 5, 14, 10, 0)) is True


def test_reminder_is_eligible_after_configured_hour(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10")

    assert subscription_reminders._reminder_is_eligible(datetime(2026, 5, 14, 15, 30)) is True


def test_reminder_eligibility_uses_per_owner_hour(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10")
    monkeypatch.setenv("BRIAN_SUBSCRIPTION_REMINDER_SEND_HOUR", "8")

    assert (
        subscription_reminders._reminder_is_eligible(
            datetime(2026, 5, 14, 8, 0),
            "676638528590970917",
        )
        is True
    )


def test_reminder_eligibility_falls_back_to_global_hour(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10")
    monkeypatch.delenv("HANNAH_SUBSCRIPTION_REMINDER_SEND_HOUR", raising=False)

    assert (
        subscription_reminders._reminder_is_eligible(
            datetime(2026, 5, 14, 9, 59),
            "830984827904851969",
        )
        is False
    )


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
        "<@123> `$177.90` will be pulled by bills and subscriptions in the next 7 days.\n"
        "\n"
        "Tomorrow:\n"
        "`Railway - $5.00 - May 15`\n"
        "\n"
        "Upcoming:\n"
        "`ChatGPT - $20.00 - May 17`\n"
        "`Amazon Prime - $152.90 - May 21`"
    )


def test_format_subscription_reminder_digest_supports_today_group():
    reminders = [
        SubscriptionReminder(
            subscription=Subscription(name="Railway", amount=5, cadence="monthly", pull_day=15),
            pull_date=date(2026, 5, 15),
            days_until=0,
        ),
    ]

    assert subscription_reminders.format_subscription_reminder_digest("<@123>", reminders) == (
        "<@123> `$5.00` will be pulled by bills and subscriptions in the next 7 days.\n"
        "\n"
        "Today:\n"
        "`Railway - $5.00 - May 15`"
    )


def test_format_subscription_reminder_digest_includes_reconciliation_note():
    reminder = SubscriptionReminder(
        subscription=Subscription(name="PG&E", amount=140, cadence="monthly", pull_day=15),
        pull_date=date(2026, 5, 15),
        days_until=1,
    )

    assert subscription_reminders.format_subscription_reminder_digest(
        "<@123>",
        [reminder],
        {reminder.key: "no logged payment yet for this expected tomorrow pull"},
    ) == (
        "<@123> `$140.00` will be pulled by bills and subscriptions in the next 7 days.\n"
        "\n"
        "Tomorrow:\n"
        "`PG&E - $140.00 - May 15`"
    )


def test_format_cash_pull_digest_includes_bills_and_missing_amounts():
    subscription = SubscriptionReminder(
        subscription=Subscription(name="ChatGPT", amount=20, cadence="monthly", pull_day=21),
        pull_date=date(2026, 5, 21),
        days_until=6,
    )
    pge = BillReminder(
        bill=BillSchedule("pge", "PG&E", "monthly", 16, source_label="PG&E"),
        pull_date=date(2026, 5, 16),
        days_until=1,
        amount=None,
        amount_entered=False,
    )
    rent = BillReminder(
        bill=BillSchedule("rent", "Rent", "monthly", 15, source_label="Rent"),
        pull_date=date(2026, 5, 15),
        days_until=0,
        amount=2000,
        amount_entered=True,
    )

    text = subscription_reminders.format_cash_pull_digest(
        "<@123>",
        [
            subscription_reminders._subscription_cash_pull(subscription),
            subscription_reminders._bill_cash_pull(pge),
            subscription_reminders._bill_cash_pull(rent),
        ],
    )

    assert text == (
        "<@123> `$2020.00` known + `1 missing amount` will be pulled by bills and subscriptions in the next 7 days.\n"
        "\n"
        "Today:\n"
        "`Rent - $2000.00 - May 15`\n"
        "\n"
        "Tomorrow:\n"
        "`PG&E - amount missing - May 16`\n"
        "\n"
        "Upcoming:\n"
        "`ChatGPT - $20.00 - May 21`"
    )


def test_format_cash_pull_digest_includes_overdue_missing_section():
    pge = BillReminder(
        bill=BillSchedule("pge", "PG&E", "monthly", 14, source_label="PG&E"),
        pull_date=date(2026, 5, 14),
        days_until=-1,
        amount=None,
        amount_entered=False,
        overdue=True,
    )

    text = subscription_reminders.format_cash_pull_digest(
        "<@123>",
        [subscription_reminders._bill_cash_pull(pge)],
    )

    assert text == (
        "<@123> `$0.00` known + `1 missing amount` will be pulled by bills and subscriptions in the next 7 days.\n"
        "\n"
        "Missing overdue:\n"
        "`PG&E - amount missing - May 14`"
    )


def test_format_subscription_parse_warning_digest():
    warnings = [
        SubscriptionParseWarning(
            source_range="Subscriptions!A8:C8",
            reason="missing amount",
            values=("22nd", "Missing Amount"),
        ),
        SubscriptionParseWarning(
            source_range="Subscriptions!A9:C9",
            reason='invalid monthly day "bad day"',
            values=("Bad Date", "$5.00"),
        ),
    ]

    assert subscription_reminders.format_subscription_parse_warning_digest("<@123>", warnings) == (
        "<@123> I found 2 subscription sheet issues that need attention.\n"
        "These rows were not added to the reminder schedule:\n"
        "- Subscriptions!A8:C8: missing amount (22nd, Missing Amount)\n"
        '- Subscriptions!A9:C9: invalid monthly day "bad day" (Bad Date, $5.00)'
    )


def test_parse_warning_metadata_is_scoped_to_day():
    warning = SubscriptionParseWarning(
        source_range="Subscriptions!A8:C8",
        reason="missing amount",
        values=("22nd", "Missing Amount"),
    )

    assert subscription_reminders._parse_warning_metadata(warning, date(2026, 5, 14)) == {
        "warning_key": "Subscriptions!A8:C8|missing amount|22nd|Missing Amount",
        "source_range": "Subscriptions!A8:C8",
        "warning_date": "2026-05-14",
    }


def test_digest_metadata_is_scoped_to_day():
    assert subscription_reminders._digest_metadata(date(2026, 5, 14)) == {
        "digest_date": "2026-05-14",
    }


def test_sync_subscription_schedules_for_users_refreshes_hidden_sheets(monkeypatch):
    repo = SheetsRepoStub(
        subscriptions_rows=[
            [],
            ["", "SUBSCRIPTIONS"],
            [],
            ["Needs", "", "(Monthly)"],
            [],
            ["Recurring:", "Name:", "Amount:"],
            ["21st", "ChatGPT", "$20.00"],
        ],
    )
    monkeypatch.setattr(
        subscription_reminders,
        "_notification_users",
        lambda: [("830984827904851969", "<@830984827904851969>")],
    )

    with repo.patched(), sheet_user_context("830984827904851969"):
        results = subscription_reminders.sync_subscription_schedules_for_users()

    rows = repo.subscription_schedule.get_all_values()
    assert results == {"830984827904851969": (1, 0)}
    assert rows[0][:7] == ["cadence", "name", "amount", "pull_day", "pull_month", "source_range", "updated_at"]
    assert rows[1][1] == "ChatGPT"


@pytest.mark.asyncio
async def test_digest_includes_items_with_existing_per_item_audit_rows(monkeypatch):
    repo = SheetsRepoStub(
        subscriptions_rows=[
            [],
            ["", "SUBSCRIPTIONS"],
            [],
            ["Needs", "", "(Monthly)"],
            [],
            ["Recurring:", "Name:", "Amount:"],
            ["15th", "Railway", "$5.00"],
            ["19th", "Raycast", "$10.00"],
            ["21st", "ChatGPT", "$20.00"],
        ],
        action_log_rows=[
            ["id", "created_at", "user_key", "status", "undone_at", "action_json"],
            [
                "oldrail",
                "2026-05-15T09:00:00",
                "676638528590970917",
                "active",
                "",
                '{"worksheet":"income","kind":"restore_cells","row":0,"columns":[],"previous_values":[],"description":"Subscription reminder sent for Railway","new_values":[],"metadata":{"type":"system_state","event_type":"subscription_reminder_sent","reminder_key":"railway|monthly|2026-05-15|0","pull_date":"2026-05-15","days_until":"0"}}',
            ],
        ],
    )
    channel = FakeChannel()
    client = FakeClient(channel)
    monkeypatch.setenv("CHANNEL_ID", "123")
    monkeypatch.setattr(
        subscription_reminders,
        "_notification_users",
        lambda: [("676638528590970917", "<@676638528590970917>")],
    )

    with repo.patched(), sheet_user_context("676638528590970917"):
        sent = await subscription_reminders.send_due_subscription_reminders(client, today=date(2026, 5, 15))

    assert sent == 3
    assert len(channel.messages) == 1
    assert "`Railway - $5.00 - May 15`" in channel.messages[0]
    assert "`Raycast - $10.00 - May 19`" in channel.messages[0]
    assert "`ChatGPT - $20.00 - May 21`" in channel.messages[0]


@pytest.mark.asyncio
async def test_subscription_digest_records_sent_events_only_after_discord_send(monkeypatch):
    recorded = []
    channel = FakeChannel()
    client = FakeClient(channel)
    event = subscription_reminders.PendingSystemEvent(
        actor_key="676638528590970917",
        event_type="cash_pull_digest_sent",
        metadata={"digest_date": "2026-05-15"},
        description="Cash pull digest sent for 2026-05-15",
    )
    monkeypatch.setenv("CHANNEL_ID", "123")
    monkeypatch.setattr(
        subscription_reminders,
        "_notification_users",
        lambda: [("676638528590970917", "<@676638528590970917>")],
    )
    monkeypatch.setattr(
        subscription_reminders,
        "_prepare_due_reminder_messages",
        lambda *_args: subscription_reminders.PreparedReminderMessages(["digest"], 1, [event]),
    )
    monkeypatch.setattr(
        subscription_reminders,
        "record_system_event",
        lambda user_key, event_type, metadata, description: recorded.append(
            (user_key, event_type, metadata, description)
        )
        or True,
    )

    sent = await subscription_reminders.send_due_subscription_reminders(client, today=date(2026, 5, 15))

    assert sent == 1
    assert channel.messages == ["digest"]
    assert recorded == [
        (
            "676638528590970917",
            "cash_pull_digest_sent",
            {"digest_date": "2026-05-15"},
            "Cash pull digest sent for 2026-05-15",
        )
    ]


@pytest.mark.asyncio
async def test_subscription_digest_does_not_record_sent_event_when_discord_send_fails(monkeypatch):
    recorded = []
    client = FakeClient(FailingChannel())
    event = subscription_reminders.PendingSystemEvent(
        actor_key="676638528590970917",
        event_type="cash_pull_digest_sent",
        metadata={"digest_date": "2026-05-15"},
        description="Cash pull digest sent for 2026-05-15",
    )
    monkeypatch.setenv("CHANNEL_ID", "123")
    monkeypatch.setattr(
        subscription_reminders,
        "_notification_users",
        lambda: [("676638528590970917", "<@676638528590970917>")],
    )
    monkeypatch.setattr(
        subscription_reminders,
        "_prepare_due_reminder_messages",
        lambda *_args: subscription_reminders.PreparedReminderMessages(["digest"], 1, [event]),
    )
    monkeypatch.setattr(
        subscription_reminders,
        "record_system_event",
        lambda *args: recorded.append(args) or True,
    )

    with pytest.raises(RuntimeError, match="discord send failed"):
        await subscription_reminders.send_due_subscription_reminders(client, today=date(2026, 5, 15))

    assert recorded == []
