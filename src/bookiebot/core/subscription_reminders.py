from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
import logging
import os
from typing import Any

from bookiebot.sheets.routing import (
    APPLE_SHORTCUT_RELAY_USER_ID,
    get_discord_user_config,
    get_user_config,
    now_pacific,
    sheet_user_context,
)
from bookiebot.sheets.subscriptions import (
    SubscriptionParseWarning,
    SubscriptionReminder,
    debug_subscription_sync,
    due_subscription_reminders,
    due_subscription_reminders_for_subscriptions,
)
from bookiebot.sheets.bills import (
    BillReminder,
    BillScheduleWarning,
    due_bill_reminders,
)
from bookiebot.sheets.undo import has_system_event, record_system_event

logger = logging.getLogger(__name__)

_REMINDER_TASK: asyncio.Task | None = None


@dataclass(frozen=True)
class CashPullReminder:
    name: str
    pull_date: date
    days_until: int
    key: str
    source: str
    amount: float | None = None
    amount_missing: bool = False
    overdue: bool = False


@dataclass(frozen=True)
class PendingSystemEvent:
    actor_key: str
    event_type: str
    metadata: dict[str, str]
    description: str


@dataclass(frozen=True)
class PreparedReminderMessages:
    messages: list[str]
    sent_count: int
    post_send_events: list[PendingSystemEvent] | None = None


def _prepared(
    *,
    messages: list[str],
    sent_count: int,
    events: list[PendingSystemEvent] | None = None,
) -> PreparedReminderMessages:
    return PreparedReminderMessages(messages=messages, sent_count=sent_count, post_send_events=events or [])


def _pending_event(actor_key: str, event_type: str, metadata: dict[str, str], description: str) -> PendingSystemEvent:
    return PendingSystemEvent(actor_key=actor_key, event_type=event_type, metadata=metadata, description=description)


def _reminders_enabled() -> bool:
    return os.getenv("BOOKIEBOT_SUBSCRIPTION_REMINDERS_ENABLED", "true").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _check_interval_seconds() -> int:
    raw = os.getenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_INTERVAL_SECONDS", "3600").strip()
    try:
        return max(int(raw), 60)
    except ValueError:
        return 3600


def _coerce_hour(raw: str, fallback: int = 10) -> int:
    try:
        return min(max(int(raw), 0), 23)
    except ValueError:
        return fallback


def _send_hour(actor_key: str | None = None) -> int:
    raw = ""
    if actor_key:
        try:
            owner_key = get_user_config(actor_key).budget_owner_key.upper()
            raw = os.getenv(f"{owner_key}_SUBSCRIPTION_REMINDER_SEND_HOUR", "").strip()
        except Exception:
            raw = ""
    raw = raw or os.getenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10").strip()
    return _coerce_hour(raw, 10)


def _reminder_is_eligible(now: datetime | None = None, actor_key: str | None = None) -> bool:
    current = now or now_pacific()
    return current.hour >= _send_hour(actor_key)


def _notification_users() -> list[tuple[str, str]]:
    seen_owner_keys: set[str] = set()
    users: list[tuple[str, str]] = []
    for actor_key, user_config in get_discord_user_config().items():
        if actor_key == APPLE_SHORTCUT_RELAY_USER_ID or actor_key.startswith("shortcut:"):
            continue
        if not actor_key.isdigit():
            continue
        if user_config.budget_owner_key in seen_owner_keys:
            continue
        seen_owner_keys.add(user_config.budget_owner_key)
        users.append((actor_key, f"<@{actor_key}>"))
    return users


def _target_channel(client: Any) -> Any | None:
    channel_id = os.getenv("CHANNEL_ID", "").strip()
    if channel_id:
        try:
            channel = client.get_channel(int(channel_id))
        except ValueError:
            channel = None
        if channel is not None:
            return channel

    channel_name = os.getenv("CHANNEL_NAME", "babys-books").strip()
    for guild in getattr(client, "guilds", []) or []:
        for channel in getattr(guild, "text_channels", []) or []:
            if getattr(channel, "name", None) == channel_name:
                return channel
    return None


def _reminder_metadata(reminder: SubscriptionReminder) -> dict[str, str]:
    return {
        "reminder_key": reminder.key,
        "pull_date": reminder.pull_date.isoformat(),
        "days_until": str(reminder.days_until),
    }


def _bill_reminder_metadata(reminder: BillReminder) -> dict[str, str]:
    return {
        "reminder_key": reminder.key,
        "bill_key": reminder.bill.bill_key,
        "pull_date": reminder.pull_date.isoformat(),
        "days_until": str(reminder.days_until),
        "amount_entered": "yes" if reminder.amount_entered else "no",
        "overdue": "yes" if reminder.overdue else "no",
    }


def _parse_warning_metadata(warning: SubscriptionParseWarning, current: date) -> dict[str, str]:
    warning_key = "|".join((warning.source_range, warning.reason, *warning.values))
    return {
        "warning_key": warning_key,
        "source_range": warning.source_range,
        "warning_date": current.isoformat(),
    }


def _bill_warning_metadata(warning: BillScheduleWarning, current: date) -> dict[str, str]:
    warning_key = "|".join((warning.source_range, warning.reason, *warning.values))
    return {
        "warning_key": warning_key,
        "source_range": warning.source_range,
        "warning_date": current.isoformat(),
    }


def _digest_metadata(current: date) -> dict[str, str]:
    return {"digest_date": current.isoformat()}


def _format_pull_date(reminder: CashPullReminder) -> str:
    return f"{reminder.pull_date:%b} {reminder.pull_date.day}"


def _format_reminder_amount(reminder: CashPullReminder) -> str:
    if reminder.amount_missing:
        return "amount missing"
    amount = reminder.amount
    return f"${amount:.2f}" if amount else "amount unknown"


def _format_digest_heading(days_until: int) -> str:
    if days_until == 0:
        return "Today:"
    if days_until == 1:
        return "Tomorrow:"
    return "Upcoming:"


def _cash_pull_total(reminders: list[CashPullReminder]) -> float:
    return round(sum(reminder.amount or 0 for reminder in reminders if not reminder.amount_missing), 2)


def _missing_amount_count(reminders: list[CashPullReminder]) -> int:
    return sum(1 for reminder in reminders if reminder.amount_missing)


def _subscription_cash_pull(reminder: SubscriptionReminder) -> CashPullReminder:
    return CashPullReminder(
        name=reminder.subscription.name,
        pull_date=reminder.pull_date,
        days_until=reminder.days_until,
        key=reminder.key,
        source="subscription",
        amount=reminder.subscription.amount,
    )


def _bill_cash_pull(reminder: BillReminder) -> CashPullReminder:
    return CashPullReminder(
        name=reminder.bill.display_name,
        pull_date=reminder.pull_date,
        days_until=reminder.days_until,
        key=reminder.key,
        source="bill",
        amount=reminder.amount,
        amount_missing=not reminder.amount_entered,
        overdue=reminder.overdue,
    )


def _cash_pull_sort_key(reminder: CashPullReminder) -> tuple[int, date, str]:
    source_order = 0 if reminder.source == "bill" else 1
    return source_order, reminder.pull_date, reminder.name.lower()


def format_cash_pull_digest(
    mention: str,
    reminders: list[CashPullReminder],
) -> str:
    grouped: dict[str, list[CashPullReminder]] = defaultdict(list)
    overdue: list[CashPullReminder] = []
    for reminder in sorted(reminders, key=_cash_pull_sort_key):
        if reminder.overdue:
            overdue.append(reminder)
            continue
        if reminder.days_until == 0:
            grouped["today"].append(reminder)
        elif reminder.days_until == 1:
            grouped["tomorrow"].append(reminder)
        else:
            grouped["upcoming"].append(reminder)

    total = _cash_pull_total(reminders)
    missing_count = _missing_amount_count(reminders)
    if missing_count:
        missing_label = "missing amount" if missing_count == 1 else "missing amounts"
        headline = (
            f"{mention} `${total:.2f}` known + `{missing_count} {missing_label}` "
            "will be pulled by bills and subscriptions in the next 7 days."
        )
    else:
        headline = f"{mention} `${total:.2f}` will be pulled by bills and subscriptions in the next 7 days."
    lines = [headline, ""]
    for section_key, heading in (
        ("today", "Today:"),
        ("tomorrow", "Tomorrow:"),
        ("upcoming", "Upcoming:"),
    ):
        section_reminders = grouped.get(section_key, [])
        if not section_reminders:
            continue
        if lines[-1] != "":
            lines.append("")
        lines.append(heading)
        for reminder in section_reminders:
            lines.append(
                f"`{reminder.name} - {_format_reminder_amount(reminder)} - {_format_pull_date(reminder)}`"
            )
    if overdue:
        if lines[-1] != "":
            lines.append("")
        lines.append("Missing overdue:")
        for reminder in overdue:
            lines.append(f"`{reminder.name} - amount missing - {_format_pull_date(reminder)}`")
    return "\n".join(lines)


def format_subscription_reminder_digest(
    mention: str,
    reminders: list[SubscriptionReminder],
    reconciliation_notes: dict[str, str] | None = None,
) -> str:
    return format_cash_pull_digest(mention, [_subscription_cash_pull(reminder) for reminder in reminders])


def format_subscription_parse_warning_digest(mention: str, warnings: list[SubscriptionParseWarning]) -> str:
    noun = "issue" if len(warnings) == 1 else "issues"
    verb = "needs" if len(warnings) == 1 else "need"
    lines = [
        f"{mention} I found {len(warnings)} subscription sheet {noun} that {verb} attention.",
        "These rows were not added to the reminder schedule:",
    ]
    for warning in warnings[:10]:
        lines.append(f"- {warning.format()}")
    if len(warnings) > 10:
        lines.append(f"- ...and {len(warnings) - 10} more")
    return "\n".join(lines)


def format_bill_schedule_warning_digest(mention: str, warnings: list[BillScheduleWarning]) -> str:
    noun = "issue" if len(warnings) == 1 else "issues"
    verb = "needs" if len(warnings) == 1 else "need"
    lines = [
        f"{mention} I found {len(warnings)} bill schedule {noun} that {verb} attention.",
        "These rows were not added to cash pull reminders:",
    ]
    for warning in warnings[:10]:
        lines.append(f"- {warning.format()}")
    if len(warnings) > 10:
        lines.append(f"- ...and {len(warnings) - 10} more")
    return "\n".join(lines)


def sync_subscription_schedules_for_users() -> dict[str, tuple[int, int]]:
    results: dict[str, tuple[int, int]] = {}
    for actor_key, _mention in _notification_users():
        try:
            with sheet_user_context(actor_key):
                subscriptions, warnings = debug_subscription_sync()
            results[actor_key] = (len(subscriptions), len(warnings))
            logger.info(
                "Subscription schedule synced",
                extra={
                    "actor_key": actor_key,
                    "subscriptions": len(subscriptions),
                    "warnings": len(warnings),
                },
            )
        except Exception:
            logger.exception("Failed to sync subscription schedule", extra={"actor_key": actor_key})
    return results


async def send_due_subscription_reminders(client: Any, today: date | None = None) -> int:
    if not _reminders_enabled():
        return 0
    current_time = now_pacific()

    channel = _target_channel(client)
    if channel is None:
        logger.warning("Subscription reminders skipped because no target Discord channel was found")
        return 0

    sent = 0
    current = today or current_time.date()
    for actor_key, mention in _notification_users():
        if today is None and not _reminder_is_eligible(current_time, actor_key):
            continue
        prepared = await asyncio.to_thread(_prepare_due_reminder_messages, actor_key, mention, current)
        for message in prepared.messages:
            await channel.send(message)
        for event in prepared.post_send_events or []:
            if not await asyncio.to_thread(
                record_system_event,
                event.actor_key,
                event.event_type,
                event.metadata,
                event.description,
            ):
                logger.warning(
                    "Reminder digest was sent but system event was not recorded",
                    extra={"actor_key": event.actor_key, "event_type": event.event_type},
                )
        sent += prepared.sent_count
    return sent


def _prepare_due_reminder_messages(actor_key: str, mention: str, current: date) -> PreparedReminderMessages:
    messages: list[str] = []
    post_send_events: list[PendingSystemEvent] = []
    sent = 0
    try:
        with sheet_user_context(actor_key):
            subscriptions, warnings = debug_subscription_sync()
            reminders = due_subscription_reminders_for_subscriptions(subscriptions, current)
            bill_reminders, bill_warnings = due_bill_reminders(current)
    except Exception:
        logger.exception("Failed to evaluate subscription reminders", extra={"actor_key": actor_key})
        try:
            with sheet_user_context(actor_key):
                reminders = due_subscription_reminders(current)
                warnings = []
                bill_reminders, bill_warnings = due_bill_reminders(current)
        except Exception:
            logger.exception("Failed fallback subscription reminder evaluation", extra={"actor_key": actor_key})
            return _prepared(messages=[], sent_count=0)

    unsent_warnings: list[SubscriptionParseWarning] = []
    for warning in warnings:
        metadata = _parse_warning_metadata(warning, current)
        if not has_system_event(actor_key, "subscription_parse_warning_sent", metadata):
            unsent_warnings.append(warning)

    if unsent_warnings:
        messages.append(format_subscription_parse_warning_digest(mention, unsent_warnings))
        post_send_events.append(
            _pending_event(
                actor_key,
                "subscription_parse_warning_digest_sent",
                {**_digest_metadata(current), "warning_count": str(len(unsent_warnings))},
                f"Subscription parse warning digest sent for {current.isoformat()}",
            )
        )
        for warning in unsent_warnings:
            post_send_events.append(_pending_event(
                actor_key,
                "subscription_parse_warning_sent",
                _parse_warning_metadata(warning, current),
                f"Subscription parse warning sent for {warning.source_range}",
            ))
            sent += 1

    unsent_bill_warnings: list[BillScheduleWarning] = []
    for warning in bill_warnings:
        metadata = _bill_warning_metadata(warning, current)
        if not has_system_event(actor_key, "bill_schedule_warning_sent", metadata):
            unsent_bill_warnings.append(warning)

    if unsent_bill_warnings:
        messages.append(format_bill_schedule_warning_digest(mention, unsent_bill_warnings))
        post_send_events.append(
            _pending_event(
                actor_key,
                "bill_schedule_warning_digest_sent",
                {**_digest_metadata(current), "warning_count": str(len(unsent_bill_warnings))},
                f"Bill schedule warning digest sent for {current.isoformat()}",
            )
        )
        for warning in unsent_bill_warnings:
            post_send_events.append(_pending_event(
                actor_key,
                "bill_schedule_warning_sent",
                _bill_warning_metadata(warning, current),
                f"Bill schedule warning sent for {warning.source_range}",
            ))
            sent += 1

    cash_pulls = [_subscription_cash_pull(reminder) for reminder in reminders]
    cash_pulls.extend(_bill_cash_pull(reminder) for reminder in bill_reminders)
    if not cash_pulls:
        return _prepared(messages=messages, sent_count=sent, events=post_send_events)

    digest_metadata = _digest_metadata(current)
    if has_system_event(actor_key, "cash_pull_digest_sent", digest_metadata):
        return _prepared(messages=messages, sent_count=sent, events=post_send_events)

    messages.append(format_cash_pull_digest(mention, cash_pulls))
    post_send_events.append(
        _pending_event(
            actor_key,
            "cash_pull_digest_sent",
            digest_metadata,
            f"Cash pull digest sent for {current.isoformat()}",
        )
    )
    for reminder in reminders:
        metadata = _reminder_metadata(reminder)
        if not has_system_event(actor_key, "subscription_reminder_sent", metadata):
            post_send_events.append(_pending_event(
                actor_key,
                "subscription_reminder_sent",
                metadata,
                f"Subscription reminder sent for {reminder.subscription.name}",
            ))
            sent += 1
    for reminder in bill_reminders:
        metadata = _bill_reminder_metadata(reminder)
        if not has_system_event(actor_key, "bill_reminder_sent", metadata):
            post_send_events.append(_pending_event(
                actor_key,
                "bill_reminder_sent",
                metadata,
                f"Bill reminder sent for {reminder.bill.display_name}",
            ))
            sent += 1
    sent += 1
    return _prepared(messages=messages, sent_count=sent, events=post_send_events)


async def run_subscription_reminder_loop(client: Any) -> None:
    while True:
        try:
            await asyncio.to_thread(sync_subscription_schedules_for_users)
            await send_due_subscription_reminders(client)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Subscription reminder loop failed")
        await asyncio.sleep(_check_interval_seconds())


def ensure_subscription_reminder_loop(client: Any) -> asyncio.Task | None:
    global _REMINDER_TASK
    if not _reminders_enabled():
        return None
    if _REMINDER_TASK is None or _REMINDER_TASK.done():
        _REMINDER_TASK = asyncio.create_task(run_subscription_reminder_loop(client))
    return _REMINDER_TASK
