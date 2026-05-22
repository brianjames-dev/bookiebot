from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
import logging
import os
from typing import Any

import discord

from bookiebot.banking.formatting import format_reconciliation_review
from bookiebot.banking.models import ReconciliationPreview
from bookiebot.banking.service import build_banking_service
from bookiebot.core.bank_reconciliation_flow import send_next_bank_reconciliation_item
from bookiebot.sheets.routing import (
    APPLE_SHORTCUT_RELAY_USER_ID,
    get_discord_user_config,
    get_user_config,
    now_pacific,
)
from bookiebot.sheets.undo import has_system_event, record_system_event
from bookiebot.ui.bank_reconciliation import (
    BankReconciliationChangeDefaultView,
    BankReconciliationDigestView,
    BankReconciliationSnoozeView,
)

logger = logging.getLogger(__name__)

_BANK_RECONCILIATION_TASK: asyncio.Task | None = None
_PERSISTENT_DIGEST_VIEW_REGISTERED = False


def _bank_reconciliation_enabled() -> bool:
    return os.getenv("BOOKIEBOT_BANK_RECONCILIATION_ENABLED", "true").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _check_interval_seconds() -> int:
    raw = os.getenv("BOOKIEBOT_BANK_RECONCILIATION_INTERVAL_SECONDS", "3600").strip()
    try:
        return max(int(raw), 60)
    except ValueError:
        return 3600


def _send_hour() -> int:
    raw = os.getenv("BOOKIEBOT_BANK_RECONCILIATION_SEND_HOUR", "7").strip()
    try:
        return min(max(int(raw), 0), 23)
    except ValueError:
        return 7


def _is_eligible(now: datetime | None = None) -> bool:
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


def _digest_metadata(current: date) -> dict[str, str]:
    return {"digest_date": current.isoformat()}


async def send_due_bank_reconciliation_digest(client: Any, today: date | None = None) -> int:
    if not _bank_reconciliation_enabled():
        return 0
    current_time = now_pacific()

    channel = _target_channel(client)
    if channel is None:
        logger.warning("Bank reconciliation digest skipped because no target Discord channel was found")
        return 0

    sent = await _send_due_snoozed_bank_reconciliation_digests(channel, current_time)
    if today is None and not _is_eligible(current_time):
        return sent

    current = today or current_time.date()
    for actor_key, mention in _notification_users():
        message = await asyncio.to_thread(
            prepare_bank_reconciliation_digest,
            actor_key,
            mention,
            current,
            mark_sent=False,
        )
        if not message:
            continue
        await channel.send(f"{message}\n\u200b", view=bank_reconciliation_digest_view(actor_key))
        if not await asyncio.to_thread(
            record_system_event,
            actor_key,
            "bank_reconciliation_digest_sent",
            {**_digest_metadata(current), "sent_after": "discord_send"},
            f"Bank reconciliation digest sent for {current.isoformat()}",
        ):
            logger.warning(
                "Bank reconciliation digest sent but system event was not recorded",
                extra={"actor_key": actor_key, "digest_date": current.isoformat()},
            )
        sent += 1
    return sent


async def _send_due_snoozed_bank_reconciliation_digests(channel: Any, current_time: datetime) -> int:
    service = build_banking_service()
    due_actor_keys = [
        actor_key
        for actor_key, _remind_at in await asyncio.to_thread(
            service.due_reconciliation_snoozes,
            current_time.isoformat(),
        )
    ]
    sent = 0
    for actor_key in due_actor_keys:
        message = await asyncio.to_thread(
            prepare_bank_reconciliation_digest,
            actor_key,
            f"<@{actor_key}>",
            current_time.date(),
            mark_sent=False,
            force=True,
        )
        await asyncio.to_thread(service.clear_reconciliation_snooze_until, actor_key)
        if not message:
            continue
        await channel.send(f"{message}\n\u200b", view=bank_reconciliation_digest_view(actor_key))
        sent += 1
    return sent


def bank_reconciliation_digest_view(actor_key: str) -> BankReconciliationDigestView:
    async def handle_action(interaction: Any, action: str) -> None:
        interaction_actor_key = _interaction_actor_key(interaction)
        if interaction_actor_key != str(actor_key):
            await interaction.response.send_message(
                "This reconciliation inbox belongs to another user.",
                ephemeral=True,
            )
            return
        await interaction.response.defer(ephemeral=True)
        if action == "later":
            await _handle_bank_reconciliation_snooze(interaction, actor_key)
            return
        if action == "start":
            if not await _claim_bank_reconciliation_prompt(interaction, actor_key):
                await interaction.followup.send(
                    content="This reconciliation prompt has already been used. Run `/debug_bank_review` to inspect the current inbox.",
                    ephemeral=True,
                )
                return
            await _clear_digest_prompt_buttons(interaction)
            owner = get_user_config(actor_key)
            await send_next_bank_reconciliation_item(
                interaction,
                owner_key=owner.budget_owner_key,
                owner_name=owner.name,
                actor_key=actor_key,
            )

    return BankReconciliationDigestView(handle_action, actor_key=str(actor_key))


def persistent_bank_reconciliation_digest_view(actor_key: str) -> BankReconciliationDigestView:
    async def handle_action(interaction: Any, action: str) -> None:
        interaction_actor_key = _interaction_actor_key(interaction)
        if interaction_actor_key != str(actor_key):
            await interaction.response.send_message(
                "This reconciliation inbox belongs to another user.",
                ephemeral=True,
            )
            return
        await interaction.response.defer(ephemeral=True)
        if action == "later":
            await _handle_bank_reconciliation_snooze(interaction, actor_key)
            return
        if action == "start":
            if not await _claim_bank_reconciliation_prompt(interaction, actor_key):
                await interaction.followup.send(
                    content="This reconciliation prompt has already been used. Run `/debug_bank_review` to inspect the current inbox.",
                    ephemeral=True,
                )
                return
            await _clear_digest_prompt_buttons(interaction)
            owner = get_user_config(actor_key)
            await send_next_bank_reconciliation_item(
                interaction,
                owner_key=owner.budget_owner_key,
                owner_name=owner.name,
                actor_key=actor_key,
            )

    return BankReconciliationDigestView(handle_action, actor_key=str(actor_key))


def register_persistent_bank_reconciliation_views(client: Any) -> None:
    global _PERSISTENT_DIGEST_VIEW_REGISTERED
    if _PERSISTENT_DIGEST_VIEW_REGISTERED:
        return
    add_view = getattr(client, "add_view", None)
    if not callable(add_view):
        return
    for actor_key, _mention in _notification_users():
        add_view(persistent_bank_reconciliation_digest_view(actor_key))
    _PERSISTENT_DIGEST_VIEW_REGISTERED = True


def _interaction_actor_key(interaction: Any) -> str:
    return str(getattr(getattr(interaction, "user", None), "id", "") or "")


def _digest_prompt_metadata(interaction: Any) -> dict[str, str]:
    message_id = str(getattr(getattr(interaction, "message", None), "id", "") or "unknown")
    return {"prompt_message_id": message_id}


async def _claim_bank_reconciliation_prompt(interaction: Any, actor_key: str) -> bool:
    metadata = _digest_prompt_metadata(interaction)
    if await asyncio.to_thread(has_system_event, actor_key, "bank_reconciliation_prompt_started", metadata):
        return False
    return await asyncio.to_thread(
        record_system_event,
        actor_key,
        "bank_reconciliation_prompt_started",
        metadata,
        f"Bank reconciliation prompt started for message {metadata['prompt_message_id']}",
    )


async def _clear_digest_prompt_buttons(interaction: Any) -> None:
    message = getattr(interaction, "message", None)
    edit = getattr(message, "edit", None)
    if not callable(edit):
        return
    try:
        await edit(view=None)
    except discord.NotFound:
        logger.info("Bank reconciliation digest message was already deleted before buttons could be cleared")
    except Exception:
        logger.exception("Failed to clear bank reconciliation digest buttons")


async def _handle_bank_reconciliation_snooze(interaction: Any, actor_key: str) -> None:
    service = build_banking_service()
    default = await asyncio.to_thread(service.get_reconciliation_default_snooze, actor_key)
    if default:
        label, remind_at = _resolve_snooze(default, now_pacific())
        await asyncio.to_thread(service.set_reconciliation_snooze_until, actor_key, remind_at.isoformat())
        await interaction.followup.send(
            content=(
                f"I will remind you {label}.\n"
                "If you want to change the default reminder time, tap below."
            ),
            view=_change_default_view(actor_key),
            ephemeral=True,
        )
        return
    await interaction.followup.send(
        content="When should I remind you again?",
        view=_snooze_options_view(actor_key),
        ephemeral=True,
    )


def _snooze_options_view(actor_key: str) -> BankReconciliationSnoozeView:
    async def handle_snooze(interaction: Any, action: str) -> None:
        if str(getattr(interaction.user, "id", "")) != str(actor_key):
            await interaction.response.send_message("This reminder belongs to another user.", ephemeral=True)
            return
        if action == "snooze:specific":
            await _send_specific_time_modal(interaction, actor_key)
            return
        await interaction.response.defer(ephemeral=True)
        option = action.split(":", 1)[1]
        label, remind_at = _resolve_snooze(option, now_pacific())
        service = build_banking_service()
        await asyncio.to_thread(service.set_reconciliation_default_snooze, actor_key, option)
        await asyncio.to_thread(service.set_reconciliation_snooze_until, actor_key, remind_at.isoformat())
        await interaction.followup.send(
            f"I will remind you {label}. I saved that as your default reminder time.",
            ephemeral=True,
        )

    return BankReconciliationSnoozeView(handle_snooze)


def _change_default_view(actor_key: str) -> BankReconciliationChangeDefaultView:
    async def handle_change(interaction: Any, action: str) -> None:
        if str(getattr(interaction.user, "id", "")) != str(actor_key):
            await interaction.response.send_message("This reminder belongs to another user.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True)
        await interaction.followup.send(
            content="Choose a new default reminder time.",
            view=_snooze_options_view(actor_key),
            ephemeral=True,
        )

    return BankReconciliationChangeDefaultView(handle_change)


async def _send_specific_time_modal(interaction: Any, actor_key: str) -> None:
    class SpecificTimeModal(discord.ui.Modal, title="Bank reminder time"):
        reminder_time = discord.ui.TextInput(
            label="Time today or tomorrow",
            placeholder="Examples: 3:30 PM, 15:30, tomorrow 9 AM",
            max_length=40,
        )

        async def on_submit(self, modal_interaction: discord.Interaction) -> None:
            raw_value = str(self.reminder_time.value)
            parsed = _parse_specific_snooze_time(raw_value, now_pacific())
            if parsed is None:
                await modal_interaction.response.send_message(
                    "I could not understand that time. Try `3:30 PM`, `15:30`, or `tomorrow 9 AM`.",
                    ephemeral=True,
                )
                return
            service = build_banking_service()
            await asyncio.to_thread(service.set_reconciliation_default_snooze, actor_key, f"specific:{raw_value}")
            await asyncio.to_thread(service.set_reconciliation_snooze_until, actor_key, parsed.isoformat())
            await modal_interaction.response.send_message(
                f"I will remind you at {_format_reminder_time(parsed)}. I saved that as your default reminder time.",
                ephemeral=True,
            )

    await interaction.response.send_modal(SpecificTimeModal())


def _resolve_snooze(option: str, current: datetime) -> tuple[str, datetime]:
    if option == "1h":
        return "in 1 hour", current + timedelta(hours=1)
    if option == "2h":
        return "in 2 hours", current + timedelta(hours=2)
    if option == "tomorrow":
        return "tomorrow at the same time", current + timedelta(days=1)
    if option.startswith("specific:"):
        parsed = _parse_specific_snooze_time(option.split(":", 1)[1], current)
        if parsed is not None:
            return f"at {_format_reminder_time(parsed)}", parsed
    return "in 1 hour", current + timedelta(hours=1)


def _parse_specific_snooze_time(raw_value: str, current: datetime) -> datetime | None:
    text = raw_value.strip().lower()
    if not text:
        return None
    day_offset = 0
    if text.startswith("tomorrow"):
        day_offset = 1
        text = text.replace("tomorrow", "", 1).strip()
    formats = ("%I:%M %p", "%I %p", "%H:%M", "%H")
    for fmt in formats:
        try:
            parsed = datetime.strptime(text.upper(), fmt)
        except ValueError:
            continue
        candidate = current.replace(
            hour=parsed.hour,
            minute=parsed.minute,
            second=0,
            microsecond=0,
        ) + timedelta(days=day_offset)
        if candidate <= current:
            candidate += timedelta(days=1)
        return candidate
    return None


def _format_reminder_time(value: datetime) -> str:
    return value.strftime("%-I:%M %p on %-m/%-d")


def prepare_bank_reconciliation_digest(
    actor_key: str,
    mention: str,
    current: date,
    *,
    mark_sent: bool,
    force: bool = False,
) -> str | None:
    metadata = _digest_metadata(current)
    if not force and has_system_event(actor_key, "bank_reconciliation_digest_sent", metadata):
        return None

    owner = get_user_config(actor_key)
    service = build_banking_service()
    sync_error: str | None = None
    if service.config.configured:
        try:
            asyncio.run(service.sync_owner(owner.budget_owner_key))
        except Exception as exc:
            sync_error = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "Bank sync failed before reconciliation digest; using cached data",
                extra={"actor_key": actor_key, "error": sync_error},
            )

    try:
        preview = service.reconciliation_preview(
            owner.budget_owner_key,
            limit=50,
            actor_key=actor_key,
        )
        unresolved = service.unresolved_reconciliation_items(owner.budget_owner_key, limit=25)
    except Exception:
        logger.exception("Failed to prepare bank reconciliation digest", extra={"actor_key": actor_key})
        return None

    if not unresolved:
        return None

    if mark_sent:
        if not record_system_event(
            actor_key,
            "bank_reconciliation_digest_sent",
            {**metadata, "unresolved_count": str(len(unresolved))},
            f"Bank reconciliation digest sent for {current.isoformat()}",
        ):
            return None

    return format_bank_reconciliation_digest(mention, preview, unresolved, sync_error=sync_error)


def format_bank_reconciliation_digest(
    mention: str,
    preview: ReconciliationPreview,
    unresolved: list,
    *,
    sync_error: str | None = None,
) -> str:
    noun = "item" if len(unresolved) == 1 else "items"
    verb = "needs" if len(unresolved) == 1 else "need"
    lines = [
        f"{mention} bank reconciliation found `{len(unresolved)}` {noun} that {verb} review.",
    ]
    if sync_error:
        lines.extend(["", "Bank sync warning: using cached bank data for this digest."])
    buckets = preview.cache_buckets
    lines.extend(
        [
            "",
            "Bank cache:",
            f"- Stored bank transactions: `{buckets.stored}`",
            f"- Needs review: `{buckets.needs_review}`",
            f"- Matched automatically: `{buckets.matched}`",
            f"- Confirmed/logged: `{buckets.confirmed}`",
            f"- Ignored: `{buckets.ignored}`",
            f"- Pending: `{buckets.pending}`",
            f"- Not reviewed yet: `{buckets.not_reviewed}`",
            f"- Unwatched accounts: `{buckets.unwatched}`",
            f"- Other: `{buckets.other}`",
            f"- Checked this run: `{preview.candidate_transaction_count}`",
            "",
            format_reconciliation_review(unresolved),
        ]
    )
    return "\n".join(lines)[:1900]


async def run_bank_reconciliation_loop(client: Any) -> None:
    while True:
        try:
            await send_due_bank_reconciliation_digest(client)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Bank reconciliation loop failed")
        await asyncio.sleep(_check_interval_seconds())


def ensure_bank_reconciliation_loop(client: Any) -> asyncio.Task | None:
    global _BANK_RECONCILIATION_TASK
    if not _bank_reconciliation_enabled():
        return None
    if _BANK_RECONCILIATION_TASK is None or _BANK_RECONCILIATION_TASK.done():
        _BANK_RECONCILIATION_TASK = asyncio.create_task(run_bank_reconciliation_loop(client))
    return _BANK_RECONCILIATION_TASK
