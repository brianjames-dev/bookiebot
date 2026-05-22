from datetime import date

from bookiebot.sheets.subscriptions import (
    NORMALIZED_SCHEDULE_HEADERS,
    Subscription,
    SubscriptionReminder,
    format_subscription_reminder,
    list_normalized_subscription_schedules,
    list_subscription_schedules,
    next_pull_date,
    due_subscription_reminders_for_subscriptions,
    sync_subscription_schedule_sheet,
    parse_visible_subscription_schedules_with_warnings,
)
from bookiebot.sheets.routing import sheet_user_context
from unit_tests.support.sheets_repo_stub import SheetsRepoStub


def test_parses_current_block_layout():
    rows = [
        [],
        ["", "SUBSCRIPTIONS"],
        [],
        ["Needs", "", "(Monthly)", "", "Needs", "", "(Yearly)", "", "", "Wants", "", "(Monthly)"],
        ["", "", "", "", "", "", "", "", "", "", "", ""],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:", "", "", "Date:", "Name:", "Amount:"],
        ["3rd", "Xfinity", "$61.50", "", "10/29", "Amazon Prime", "$152.90", "", "", "5th", "YouTube Premium", "$13.99"],
        ["21st", "ChatGPT", "$20.00", "", "2/4", "MacroFactor", "$71.99", "", "", "16th", "Apple iCloud Storage", "$2.99"],
    ]

    subscriptions = list_subscription_schedules(rows)

    assert [(sub.name, sub.cadence, sub.pull_month, sub.pull_day) for sub in subscriptions] == [
        ("Xfinity", "monthly", None, 3),
        ("ChatGPT", "monthly", None, 21),
        ("Amazon Prime", "yearly", 10, 29),
        ("MacroFactor", "yearly", 2, 4),
        ("YouTube Premium", "monthly", None, 5),
        ("Apple iCloud Storage", "monthly", None, 16),
    ]


def test_parses_current_hidden_normalized_layout():
    rows = [
        NORMALIZED_SCHEDULE_HEADERS,
        ["monthly", "Spotify", "$9.99", "14", "", "Subscriptions!A2:C2", "2026-05-16T13:11:02-07:00"],
        ["yearly", "Amazon Prime", "$152.90", "29", "10", "Subscriptions!A3:C3", "2026-05-16T13:11:02-07:00"],
    ]

    subscriptions = list_subscription_schedules(rows)

    assert [(sub.name, sub.cadence, sub.pull_day, sub.pull_month) for sub in subscriptions] == [
        ("Spotify", "monthly", 14, None),
        ("Amazon Prime", "yearly", 29, 10),
    ]


def test_hidden_normalized_layout_can_be_read_by_header_names():
    rows = [
        ["id", "active", "budget_owner_key", "owner_name", "kind", "cadence", "name", "amount", "pull_day", "pull_month"],
        ["old", "yes", "brian", "Brian", "needs", "monthly", "Spotify", "$9.99", "14", ""],
    ]

    subscriptions = list_subscription_schedules(rows)

    assert len(subscriptions) == 1
    assert subscriptions[0].name == "Spotify"
    assert subscriptions[0].amount == 9.99
    assert subscriptions[0].pull_day == 14


def test_due_subscription_reminders_include_every_day_in_next_7_days():
    subscriptions = [
        Subscription(name="Today", amount=1, cadence="monthly", pull_day=14),
        Subscription(name="Tomorrow", amount=2, cadence="monthly", pull_day=15),
        Subscription(name="Two Days", amount=3, cadence="monthly", pull_day=16),
        Subscription(name="Four Days", amount=4, cadence="monthly", pull_day=18),
        Subscription(name="Seven Days", amount=5, cadence="monthly", pull_day=21),
        Subscription(name="Eight Days", amount=6, cadence="monthly", pull_day=22),
    ]

    reminders = due_subscription_reminders_for_subscriptions(subscriptions, date(2026, 5, 14))

    assert [(reminder.subscription.name, reminder.days_until) for reminder in reminders] == [
        ("Today", 0),
        ("Tomorrow", 1),
        ("Two Days", 2),
        ("Four Days", 4),
        ("Seven Days", 7),
    ]


def test_next_pull_date_clamps_month_end_and_rolls_forward():
    subscription = Subscription(name="Month End", amount=10, cadence="monthly", pull_day=31)

    assert next_pull_date(subscription, date(2026, 2, 20)) == date(2026, 2, 28)
    assert next_pull_date(subscription, date(2026, 3, 31)) == date(2026, 3, 31)
    assert next_pull_date(subscription, date(2026, 4, 1)) == date(2026, 4, 30)


def test_format_subscription_reminder():
    subscription = Subscription(name="ChatGPT", amount=20, cadence="monthly", pull_day=21, account="BofA")

    text = format_subscription_reminder(
        reminder=SubscriptionReminder(subscription=subscription, days_until=1, pull_date=date(2026, 5, 21)),
        mention="<@123>",
    )

    assert text == "<@123> Reminder: ChatGPT is expected to pull $20.00 from BofA tomorrow (May 21)."


def test_sync_subscription_schedule_sheet_writes_hidden_normalized_rows():
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
        subscription_schedule_rows=[
            [
                "id",
                "active",
                "budget_owner_key",
                "owner_name",
                "kind",
                "cadence",
                "name",
                "amount",
                "pull_day",
                "pull_month",
                "account",
                "reminder_offsets",
                "source_range",
                "updated_at",
            ],
            [
                "old",
                "yes",
                "hannah",
                "Hannah",
                "needs",
                "monthly",
                "Old",
                "1.00",
                "1",
                "",
                "",
                "7,3,1,0",
                "Old!A1:C1",
                "old-time",
            ],
        ],
    )

    with repo.patched(), sheet_user_context("830984827904851969"):
        subscriptions = sync_subscription_schedule_sheet()

    rows = repo.subscription_schedule.get_all_values()
    assert [sub.name for sub in subscriptions] == ["ChatGPT"]
    assert rows[0][:7] == NORMALIZED_SCHEDULE_HEADERS
    assert rows[1][:6] == [
        "monthly",
        "ChatGPT",
        "20.00",
        "21",
        "",
        "Subscriptions!A7:C7",
    ]
    assert rows[1][6]
    assert len(rows[0]) == 14
    assert all(value == "" for value in rows[0][7:])
    assert all(value == "" for value in rows[1][7:])


def test_list_normalized_subscription_schedules_accepts_extra_hidden_columns():
    repo = SheetsRepoStub(
        subscription_schedule_rows=[
            [
                "cadence",
                "name",
                "amount",
                "pull_day",
                "pull_month",
                "account",
                "source_range",
                "updated_at",
            ],
            [
                "monthly",
                "iCloud Storage",
                "2.99",
                "16",
                "",
                "BofA",
                "Subscriptions!J8:L8",
                "2026-05-21T08:00:00-07:00",
            ],
        ],
    )

    with repo.patched(), sheet_user_context("676638528590970917"):
        subscriptions = list_normalized_subscription_schedules()

    assert len(subscriptions) == 1
    assert subscriptions[0].name == "iCloud Storage"
    assert subscriptions[0].amount == 2.99
    assert subscriptions[0].account == "BofA"
    assert subscriptions[0].source_range == "Subscriptions!J8:L8"


def test_parse_visible_subscription_schedules_reports_skipped_rows():
    rows = [
        [],
        ["", "SUBSCRIPTIONS"],
        [],
        ["Needs", "", "(Monthly)"],
        [],
        ["Recurring:", "Name:", "Amount:"],
        ["21st", "ChatGPT", "$20.00"],
        ["22nd", "Missing Amount", ""],
        ["bad day", "Bad Date", "$5.00"],
    ]

    subscriptions, warnings = parse_visible_subscription_schedules_with_warnings(rows)

    assert [sub.name for sub in subscriptions] == ["ChatGPT"]
    assert [warning.format() for warning in warnings] == [
        "Subscriptions!A8:C8: missing amount (22nd, Missing Amount)",
        'Subscriptions!A9:C9: invalid monthly day "bad day" (Bad Date, $5.00)',
    ]
