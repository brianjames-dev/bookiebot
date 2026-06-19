from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import date, datetime, timedelta
import logging
import os
from collections.abc import Callable
from typing import Any, Awaitable, cast

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
    BankReconciliationDigestView,
)

logger = logging.getLogger(__name__)

_BANK_RECONCILIATION_TASK: asyncio.Task | None = None
_PERSISTENT_DIGEST_VIEW_REGISTERED = False


@dataclass(frozen=True)
class PreparedBankReconciliationDigest:
    public_message: str
    detail_message: str


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


def _send_window_minutes() -> int:
    raw = os.getenv("BOOKIEBOT_BANK_RECONCILIATION_SEND_WINDOW_MINUTES", "60").strip()
    try:
        return max(int(raw), 1)
    except ValueError:
        return 60


def _is_eligible(now: datetime | None = None) -> bool:
    current = now or now_pacific()
    window_start = current.replace(hour=_send_hour(), minute=0, second=0, microsecond=0)
    window_end = window_start + timedelta(minutes=_send_window_minutes())
    return window_start <= current < window_end


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

    if today is None and not _is_eligible(current_time):
        return 0

    current = today or current_time.date()
    sent = 0
    for actor_key, mention in _notification_users():
        digest = await asyncio.to_thread(
            prepare_bank_reconciliation_digest_messages,
            actor_key,
            mention,
            current,
            mark_sent=False,
        )
        if not digest:
            continue
        await channel.send(f"{digest.public_message}\n\u200b", view=bank_reconciliation_digest_view(actor_key))
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
    async_edit = cast(Callable[..., Awaitable[Any]], edit)
    try:
        await async_edit(view=None)
    except discord.NotFound:
        logger.info("Bank reconciliation digest message was already deleted before buttons could be cleared")
    except Exception:
        logger.exception("Failed to clear bank reconciliation digest buttons")


def prepare_bank_reconciliation_digest(
    actor_key: str,
    mention: str,
    current: date,
    *,
    mark_sent: bool,
    force: bool = False,
) -> str | None:
    digest = prepare_bank_reconciliation_digest_messages(
        actor_key,
        mention,
        current,
        mark_sent=mark_sent,
        force=force,
    )
    return digest.detail_message if digest else None


def prepare_bank_reconciliation_digest_messages(
    actor_key: str,
    mention: str,
    current: date,
    *,
    mark_sent: bool,
    force: bool = False,
) -> PreparedBankReconciliationDigest | None:
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

    unresolved_count = len(unresolved)
    if not unresolved_count:
        return None

    if mark_sent:
        if not record_system_event(
            actor_key,
            "bank_reconciliation_digest_sent",
            {**metadata, "unresolved_count": str(len(unresolved))},
            f"Bank reconciliation digest sent for {current.isoformat()}",
        ):
            return None

    return PreparedBankReconciliationDigest(
        public_message=format_bank_reconciliation_public_prompt(
            mention,
            unresolved_count,
            sync_error=sync_error,
        ),
        detail_message=format_bank_reconciliation_digest(mention, preview, unresolved, sync_error=sync_error),
    )


def format_bank_reconciliation_public_prompt(
    mention: str,
    unresolved_count: int,
    *,
    sync_error: str | None = None,
) -> str:
    noun = "item" if unresolved_count == 1 else "items"
    verb = "needs" if unresolved_count == 1 else "need"
    lines = [
        f"{mention} bank reconciliation has `{unresolved_count}` {noun} that {verb} review.",
        "Use the button below to review privately.",
        "No transaction details are shown in this channel.",
    ]
    if sync_error:
        lines.append("Bank sync warning: using cached bank data.")
    return "\n".join(lines)


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
