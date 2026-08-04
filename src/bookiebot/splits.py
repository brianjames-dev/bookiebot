from __future__ import annotations

import re
from typing import Any, Literal

from bookiebot.sheets.collaboration import normalize_split_method
from bookiebot.sheets.routing import actor_key_aliases, resolve_actor_key, sheet_user_context
from bookiebot.sheets.undo import change_split_recent_action, split_recent_action
from bookiebot.ui.recent_actions import ChangeSplitMethodView, SplitMethodView


SplitDirective = Literal["income", "equal", "prompt", "none"]
SPLIT_PROMPT = "How do you want to split this expense?"


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
        try:
            await interaction.response.defer(ephemeral=True)
        except Exception:
            pass
        with sheet_user_context(actor_key):
            success, detail = split_recent_action(
                actor_key,
                split_method=method,
                action_id=action_id,
            )
        prefix = "✅" if success else "❌"
        await interaction.followup.send(f"{prefix} {detail}", ephemeral=True)

    return SplitMethodView(handle_split)


def change_split_method_view(actor_key: str | None, action_id: str) -> ChangeSplitMethodView:
    async def handle_change(interaction: Any, method: str) -> None:
        interaction_user = getattr(interaction, "user", None)
        interaction_actor = resolve_actor_key(
            getattr(interaction_user, "id", None),
            getattr(interaction_user, "name", None),
        )
        if actor_key and interaction_actor and interaction_actor not in actor_key_aliases(str(actor_key)):
            await interaction.response.send_message("This split workflow belongs to another user.", ephemeral=True)
            return
        if method == "cancel":
            await interaction.response.send_message(
                "Canceled. The existing split remains unchanged.",
                ephemeral=True,
            )
            return
        try:
            await interaction.response.defer(ephemeral=True)
        except Exception:
            pass
        with sheet_user_context(actor_key):
            success, detail = change_split_recent_action(
                actor_key,
                split_method=method,
                action_id=action_id,
            )
        prefix = "✅" if success else "❌"
        await interaction.followup.send(f"{prefix} {detail}", ephemeral=True)

    return ChangeSplitMethodView(handle_change)


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
    if directive in {"income", "equal"}:
        with sheet_user_context(actor_key):
            success, detail = split_recent_action(
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
