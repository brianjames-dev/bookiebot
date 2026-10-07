from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from collections.abc import Awaitable, Callable
from typing import Any, Literal

from bookiebot.sheets.collaboration import normalize_split_method
from bookiebot.sheets.routing import actor_key_aliases, resolve_actor_key, sheet_user_context
from bookiebot.sheets.undo import change_split_recent_action, split_recent_action
from bookiebot.ui.recent_actions import ChangeSplitMethodView, SplitMethodView


SplitDirective = Literal["income", "equal", "fronted", "prompt", "none"]
SPLIT_PROMPT = "How do you want to split this expense?"
logger = logging.getLogger(__name__)
_SPLIT_LOCKS_GUARD = threading.Lock()
_SPLIT_LOCKS: dict[tuple[str | None, str], tuple[Any, int]] = {}


def run_split_operation(operation: Callable[..., tuple[bool, str]], actor_key: str | None, *,
                        action_id: str, **kwargs: Any) -> tuple[bool, str]:
    # Worker callbacks can overlap. Serialize this expense's log/ledger writes
    # without holding a global mutation lock or retaining unused locks forever.
    key = (actor_key, action_id)
    with _SPLIT_LOCKS_GUARD:
        lock, users = _SPLIT_LOCKS.get(key, (threading.Lock(), 0))
        _SPLIT_LOCKS[key] = (lock, users + 1)
    try:
        with lock, sheet_user_context(actor_key):
            return operation(actor_key, action_id=action_id, **kwargs)
    finally:
        with _SPLIT_LOCKS_GUARD:
            lock, users = _SPLIT_LOCKS[key]
            if users == 1:
                del _SPLIT_LOCKS[key]
            else:
                _SPLIT_LOCKS[key] = (lock, users - 1)


async def _apply_split(interaction: Any, actor_key: str | None, action_id: str, method: str,
                       operation: Callable[..., tuple[bool, str]]) -> None:
    # A component's default defer is silent. Acknowledge before starting any
    # blocking I/O, and let Discord's event loop keep serving other callbacks.
    await interaction.response.defer(ephemeral=True, thinking=True)
    started = time.perf_counter()
    try:
        success, detail = await asyncio.to_thread(run_split_operation, operation, actor_key, split_method=method, action_id=action_id)
    except Exception:
        logger.exception("Split workflow failed", extra={"action_id": action_id})
        success, detail = False, "The split could not finish. Check Recent transactions and Shared before trying again."
    prefix = "✅" if success else "❌"
    logger.info("Split workflow finished in %.2fs (action=%s; success=%s)", time.perf_counter() - started, action_id, success)
    await interaction.followup.send(f"{prefix} {detail}", ephemeral=True)


def requested_split_directive(data: dict[str, Any], content: str = "") -> SplitDirective | None:
    raw_method = data.get("split_method") or data.get("split")
    normalized_method = normalize_split_method(raw_method)
    if normalized_method is not None:
        return normalized_method
    raw_method_text = str(raw_method or "").strip().lower()
    if raw_method_text in {"none", "no", "no split", "cancel"}:
        return "none"
    if raw_method_text in {"prompt", "ask", "split"}:
        return "prompt"

    text = " ".join(str(content or "").lower().split())
    if re.search(r"\b(?:no|don't|do not)\s+split\b", text):
        return "none"
    if ("split" in text and re.search(r"\bby\s+income\b", text)) or re.search(r"\bincome[- ]based\s+split\b", text):
        return "income"
    if re.search(r"\b50\s*/\s*50\b", text) or ("split" in text and re.search(r"\b(?:evenly|equally)\b", text)):
        return "equal"
    if re.search(r"\bcover(?:ed)?\b.*\bfor\s+(?:hannah|brian|them|her|him)\b", text):
        return "fronted"
    if re.search(r"\bfront(?:ed)?\b.*\bfor\s+(?:hannah|brian|them|her|him)\b", text):
        return "fronted"
    if re.search(r"\b(?:hannah|brian|they|she|he)\s+owes?\s+me\s+(?:all|the\s+full\s+amount|for\s+(?:this|that|the|my))\b", text):
        return "fronted"
    if re.search(r"\b(?:they|partner)\s+owe(?:s)?\s+(?:it\s+)?all\b", text):
        return "fronted"
    if re.search(r"\bsplit\b", text):
        return "prompt"
    return None


def should_auto_prompt_for_split(*, category: str = "", location: str = "", payment_label: str = "") -> bool:
    normalized_payment = payment_label.strip().lower()
    if normalized_payment == "internet":
        return False
    if normalized_payment in {"rent", "pg&e", "pge", "water", "recology"}:
        return True
    if category.strip().lower() == "grocery":
        return True
    return location.strip().casefold() == "gameday"


def split_method_view(actor_key: str | None, action_id: str) -> SplitMethodView:
    async def handle_split(interaction: Any, method: str) -> None:
        interaction_user = getattr(interaction, "user", None)
        interaction_actor = resolve_actor_key(
            getattr(interaction_user, "id", None),
            getattr(interaction_user, "name", None),
        )
        if actor_key and interaction_actor and interaction_actor not in actor_key_aliases(str(actor_key)):
            await interaction.response.send_message("This split workflow belongs to another user.", ephemeral=True)
            return
        if method == "no_split":
            await interaction.response.send_message(
                "No split applied. The full expense remains logged.",
                ephemeral=True,
            )
            return
        await _apply_split(interaction, actor_key, action_id, method, split_recent_action)

    return SplitMethodView(handle_split)


def change_split_method_view(
    actor_key: str | None,
    action_id: str,
    *,
    on_cancel_split: Callable[[Any], Awaitable[None]] | None = None,
) -> ChangeSplitMethodView:
    async def handle_change(interaction: Any, method: str) -> None:
        interaction_user = getattr(interaction, "user", None)
        interaction_actor = resolve_actor_key(
            getattr(interaction_user, "id", None),
            getattr(interaction_user, "name", None),
        )
        if actor_key and interaction_actor and interaction_actor not in actor_key_aliases(str(actor_key)):
            await interaction.response.send_message("This split workflow belongs to another user.", ephemeral=True)
            return
        if method == "cancel_split" and on_cancel_split is not None:
            await on_cancel_split(interaction)
            return
        if method == "cancel":
            await interaction.response.send_message(
                "Canceled. The existing split remains unchanged.",
                ephemeral=True,
            )
            return
        await _apply_split(interaction, actor_key, action_id, method, change_split_recent_action)

    return ChangeSplitMethodView(handle_change, can_cancel_split=on_cancel_split is not None)


async def continue_split_after_log(
    *,
    data: dict[str, Any],
    message: Any,
    actor_key: str | None,
    action_id: str | None,
    category: str = "",
    payment_label: str = "",
) -> None:
    if not action_id:
        return
    directive = requested_split_directive(data, getattr(message, "content", ""))
    if directive == "none":
        return
    if directive in {"income", "equal", "fronted"}:
        success, detail = await asyncio.to_thread(run_split_operation, split_recent_action,
            actor_key,
            split_method=directive,
            action_id=action_id,
        )
        prefix = "✅" if success else "❌"
        await message.channel.send(f"{prefix} {detail}")
        return
    if directive == "prompt" or should_auto_prompt_for_split(
        category=category,
        location=str(data.get("location") or ""),
        payment_label=payment_label,
    ):
        await message.channel.send(
            SPLIT_PROMPT,
            view=split_method_view(actor_key, action_id),
        )
