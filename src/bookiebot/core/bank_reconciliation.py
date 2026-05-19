from __future__ import annotations

import asyncio
from datetime import date, datetime
import logging
import os
from typing import Any

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
from bookiebot.ui.bank_reconciliation import BankReconciliationDigestView

logger = logging.getLogger(__name__)

_BANK_RECONCILIATION_TASK: asyncio.Task | None = None


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
    if today is None and not _is_eligible(current_time):
        return 0

    channel = _target_channel(client)
    if channel is None:
        logger.warning("Bank reconciliation digest skipped because no target Discord channel was found")
        return 0

    sent = 0
    current = today or current_time.date()
    for actor_key, mention in _notification_users():
        message = await asyncio.to_thread(_prepare_bank_reconciliation_digest, actor_key, mention, current)
        if not message:
            continue
        await channel.send(message, view=_bank_reconciliation_digest_view(actor_key))
        sent += 1
    return sent


def _bank_reconciliation_digest_view(actor_key: str) -> BankReconciliationDigestView:
    async def handle_action(interaction: Any, action: str) -> None:
        if str(getattr(interaction.user, "id", "")) != str(actor_key):
            await interaction.response.send_message(
                "This reconciliation inbox belongs to another user.",
                ephemeral=True,
            )
            return
        await interaction.response.defer(ephemeral=True)
        if action == "later":
            await interaction.followup.send(
                "Okay. I will leave these bank reconciliation items unresolved for later.",
                ephemeral=True,
            )
            return
        if action == "start":
            owner = get_user_config(actor_key)
            await send_next_bank_reconciliation_item(
                interaction,
                owner_key=owner.budget_owner_key,
                owner_name=owner.name,
                actor_key=actor_key,
            )

    return BankReconciliationDigestView(handle_action)


def _prepare_bank_reconciliation_digest(actor_key: str, mention: str, current: date) -> str | None:
    metadata = _digest_metadata(current)
    if has_system_event(actor_key, "bank_reconciliation_digest_sent", metadata):
        return None

    try:
        owner = get_user_config(actor_key)
        service = build_banking_service()
        if service.config.configured:
            asyncio.run(service.sync_owner(owner.budget_owner_key))
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

    if not record_system_event(
        actor_key,
        "bank_reconciliation_digest_sent",
        {**metadata, "unresolved_count": str(len(unresolved))},
        f"Bank reconciliation digest sent for {current.isoformat()}",
    ):
        return None

    return format_bank_reconciliation_digest(mention, preview, unresolved)


def format_bank_reconciliation_digest(mention: str, preview: ReconciliationPreview, unresolved: list) -> str:
    noun = "item" if len(unresolved) == 1 else "items"
    verb = "needs" if len(unresolved) == 1 else "need"
    lines = [
        f"{mention} bank reconciliation found `{len(unresolved)}` {noun} that {verb} review.",
        "",
        f"Cached transactions: `{preview.cached_transaction_count}`",
        f"Checked this run: `{preview.candidate_transaction_count}`",
        "",
        format_reconciliation_review(unresolved),
    ]
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
