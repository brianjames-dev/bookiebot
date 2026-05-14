from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import date, datetime
import logging
import os
from typing import Any

from bookiebot.sheets.routing import (
    APPLE_SHORTCUT_RELAY_USER_ID,
    get_discord_user_config,
    now_pacific,
    sheet_user_context,
)
from bookiebot.sheets.subscriptions import SubscriptionReminder, due_subscription_reminders
from bookiebot.sheets.undo import has_system_event, record_system_event

logger = logging.getLogger(__name__)

_REMINDER_TASK: asyncio.Task | None = None


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


def _send_hour() -> int:
    raw = os.getenv("BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR", "10").strip()
    try:
        return min(max(int(raw), 0), 23)
    except ValueError:
        return 10


def _reminder_is_eligible(now: datetime | None = None) -> bool:
    current = now or now_pacific()
    return current.hour >= _send_hour()


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


def _format_pull_date(reminder: SubscriptionReminder) -> str:
    return f"{reminder.pull_date:%b} {reminder.pull_date.day}"


def _format_reminder_amount(reminder: SubscriptionReminder) -> str:
    amount = reminder.subscription.amount
    return f"${amount:.2f}" if amount else "amount unknown"


def _format_digest_heading(days_until: int) -> str:
    if days_until == 0:
        return "Today"
    if days_until == 1:
        return "Tomorrow"
    return f"In {days_until} days"


def _reminder_total(reminders: list[SubscriptionReminder]) -> float:
    return round(sum(reminder.subscription.amount for reminder in reminders), 2)


def format_subscription_reminder_digest(mention: str, reminders: list[SubscriptionReminder]) -> str:
    grouped: dict[int, list[SubscriptionReminder]] = defaultdict(list)
    for reminder in sorted(reminders, key=lambda item: (item.days_until, item.pull_date, item.subscription.name.lower())):
        grouped[reminder.days_until].append(reminder)

    total = _reminder_total(reminders)
    lines = [
        f"{mention} ${total:.2f} will be pulled in the next 7 days.",
        "Upcoming subscription pulls:",
    ]
    for days_until in sorted(grouped):
        lines.append("")
        lines.append(_format_digest_heading(days_until))
        for reminder in grouped[days_until]:
            account = f" from {reminder.subscription.account}" if reminder.subscription.account else ""
            lines.append(
                f"- {reminder.subscription.name}: {_format_reminder_amount(reminder)}{account} "
                f"on {_format_pull_date(reminder)}"
            )
    return "\n".join(lines)


async def send_due_subscription_reminders(client: Any, today: date | None = None) -> int:
    if not _reminders_enabled():
        return 0
    current_time = now_pacific()
    if today is None and not _reminder_is_eligible(current_time):
        return 0

    channel = _target_channel(client)
    if channel is None:
        logger.warning("Subscription reminders skipped because no target Discord channel was found")
        return 0

    sent = 0
    current = today or current_time.date()
    for actor_key, mention in _notification_users():
        try:
            with sheet_user_context(actor_key):
                reminders = due_subscription_reminders(current)
        except Exception:
            logger.exception("Failed to evaluate subscription reminders", extra={"actor_key": actor_key})
            continue

        unsent_reminders: list[SubscriptionReminder] = []
        for reminder in reminders:
            if not has_system_event(actor_key, "subscription_reminder_sent", _reminder_metadata(reminder)):
                unsent_reminders.append(reminder)

        if not unsent_reminders:
            continue

        await channel.send(format_subscription_reminder_digest(mention, unsent_reminders))
        for reminder in unsent_reminders:
            metadata = _reminder_metadata(reminder)
            record_system_event(
                actor_key,
                "subscription_reminder_sent",
                metadata,
                f"Subscription reminder sent for {reminder.subscription.name}",
            )
            sent += 1
    return sent


async def run_subscription_reminder_loop(client: Any) -> None:
    while True:
        try:
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
