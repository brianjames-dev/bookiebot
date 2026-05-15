from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import date, datetime
import logging
import os
import re
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
import bookiebot.sheets.utils as sheet_utils
from bookiebot.sheets.undo import has_system_event, record_system_event

logger = logging.getLogger(__name__)

_REMINDER_TASK: asyncio.Task | None = None
_DIGEST_SENT_CACHE: set[tuple[str, str]] = set()


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


def _parse_warning_metadata(warning: SubscriptionParseWarning, current: date) -> dict[str, str]:
    warning_key = "|".join((warning.source_range, warning.reason, *warning.values))
    return {
        "warning_key": warning_key,
        "source_range": warning.source_range,
        "warning_date": current.isoformat(),
    }


def _digest_metadata(current: date) -> dict[str, str]:
    return {"digest_date": current.isoformat()}


def _digest_cache_key(actor_key: str, current: date) -> tuple[str, str]:
    return (str(actor_key), current.isoformat())


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


def _bill_key_for_name(name: str) -> str | None:
    normalized = re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()
    if not normalized:
        return None
    if "student loan" in normalized:
        return "student_loan"
    if "pg e" in normalized or "pge" in normalized or "gas electric" in normalized:
        return "pge"
    if "recology" in normalized or "trash" in normalized or "garbage" in normalized:
        return "recology"
    if "santa rosa water" in normalized or normalized == "water" or " water " in f" {normalized} ":
        return "water"
    if normalized == "rent" or normalized.endswith(" rent") or normalized.startswith("rent "):
        return "rent"
    return None


async def _bill_reconciliation_note(reminder: SubscriptionReminder) -> str | None:
    if reminder.days_until not in {0, 1}:
        return None
    bill_key = _bill_key_for_name(reminder.subscription.name)
    if bill_key is None:
        return None

    checkers = {
        "rent": sheet_utils.check_rent_paid,
        "pge": sheet_utils.check_pge_paid,
        "recology": sheet_utils.check_recology_paid,
        "water": sheet_utils.check_water_paid,
        "student_loan": sheet_utils.check_student_loan_paid,
    }
    paid, amount = await checkers[bill_key]()
    if paid:
        return None

    when = "today" if reminder.days_until == 0 else "tomorrow"
    return f"no logged payment yet for this expected {when} pull"


async def _bill_reconciliation_notes(reminders: list[SubscriptionReminder]) -> dict[str, str]:
    notes: dict[str, str] = {}
    for reminder in reminders:
        note = await _bill_reconciliation_note(reminder)
        if note:
            notes[reminder.key] = note
    return notes


def format_subscription_reminder_digest(
    mention: str,
    reminders: list[SubscriptionReminder],
    reconciliation_notes: dict[str, str] | None = None,
) -> str:
    reconciliation_notes = reconciliation_notes or {}
    grouped: dict[int, list[SubscriptionReminder]] = defaultdict(list)
    for reminder in sorted(reminders, key=lambda item: (item.days_until, item.pull_date, item.subscription.name.lower())):
        grouped[reminder.days_until].append(reminder)

    total = _reminder_total(reminders)
    lines = [
        f"{mention} `${total:.2f}` will be pulled by subscriptions in the next 7 days.",
        "",
    ]
    for days_until in sorted(grouped):
        if lines[-1] != "":
            lines.append("")
        lines.append(_format_digest_heading(days_until))
        for reminder in grouped[days_until]:
            note = f" ({reconciliation_notes[reminder.key]})" if reminder.key in reconciliation_notes else ""
            lines.append(
                f"`{reminder.subscription.name} - {_format_reminder_amount(reminder)} - "
                f"{_format_pull_date(reminder)}{note}`"
            )
    return "\n".join(lines)


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

        try:
            with sheet_user_context(actor_key):
                subscriptions, warnings = debug_subscription_sync()
                reminders = due_subscription_reminders_for_subscriptions(subscriptions, current)
        except Exception:
            logger.exception("Failed to evaluate subscription reminders", extra={"actor_key": actor_key})
            try:
                with sheet_user_context(actor_key):
                    reminders = due_subscription_reminders(current)
                    warnings = []
            except Exception:
                logger.exception("Failed fallback subscription reminder evaluation", extra={"actor_key": actor_key})
                continue

        unsent_warnings: list[SubscriptionParseWarning] = []
        for warning in warnings:
            metadata = _parse_warning_metadata(warning, current)
            if not has_system_event(actor_key, "subscription_parse_warning_sent", metadata):
                unsent_warnings.append(warning)

        if unsent_warnings:
            await channel.send(format_subscription_parse_warning_digest(mention, unsent_warnings))
            for warning in unsent_warnings:
                record_system_event(
                    actor_key,
                    "subscription_parse_warning_sent",
                    _parse_warning_metadata(warning, current),
                    f"Subscription parse warning sent for {warning.source_range}",
                )
                sent += 1

        if not reminders:
            continue

        digest_metadata = _digest_metadata(current)
        digest_cache_key = _digest_cache_key(actor_key, current)
        if digest_cache_key in _DIGEST_SENT_CACHE or has_system_event(actor_key, "subscription_digest_sent", digest_metadata):
            continue

        with sheet_user_context(actor_key):
            reconciliation_notes = await _bill_reconciliation_notes(reminders)
        persistent_digest_recorded = record_system_event(
            actor_key,
            "subscription_digest_sent",
            digest_metadata,
            f"Subscription digest sent for {current.isoformat()}",
        )
        if not persistent_digest_recorded:
            logger.error(
                "Subscription digest marker failed to persist; using in-memory suppression for this process",
                extra={"actor_key": actor_key, "digest_date": current.isoformat()},
            )
        _DIGEST_SENT_CACHE.add(digest_cache_key)
        await channel.send(format_subscription_reminder_digest(mention, reminders, reconciliation_notes))
        for reminder in reminders:
            metadata = _reminder_metadata(reminder)
            if not has_system_event(actor_key, "subscription_reminder_sent", metadata):
                record_system_event(
                    actor_key,
                    "subscription_reminder_sent",
                    metadata,
                    f"Subscription reminder sent for {reminder.subscription.name}",
                )
                sent += 1
        sent += 1
    return sent


async def run_subscription_reminder_loop(client: Any) -> None:
    while True:
        try:
            sync_subscription_schedules_for_users()
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
