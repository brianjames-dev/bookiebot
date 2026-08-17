from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from bookiebot.sheets.routing import resolve_actor_key


@dataclass(frozen=True)
class ConversationContext:
    """Trusted Discord identity and scope injected into graph tools at runtime."""

    actor_key: str
    discord_user_id: str
    display_name: str
    channel_id: str
    guild_id: str | None
    thread_id: str


def conversation_context_from_message(message: Any) -> ConversationContext:
    author = getattr(message, "author", None)
    user_id = _identifier(getattr(author, "id", None), "unmapped-user")
    user_name = str(
        getattr(author, "name", None)
        or getattr(author, "display_name", None)
        or "BookieBot user"
    )
    display_name = str(getattr(author, "display_name", None) or user_name)
    actor_key = resolve_actor_key(user_id, user_name) or user_id
    channel_id = _identifier(getattr(getattr(message, "channel", None), "id", None), "unknown-channel")
    raw_guild_id = getattr(getattr(message, "guild", None), "id", None)
    guild_id = str(raw_guild_id) if raw_guild_id is not None else None
    scope = guild_id or "dm"
    thread_id = f"discord:{scope}:{channel_id}:{actor_key}"
    return ConversationContext(
        actor_key=actor_key,
        discord_user_id=user_id,
        display_name=display_name,
        channel_id=channel_id,
        guild_id=guild_id,
        thread_id=thread_id,
    )


def _identifier(value: Any, fallback: str) -> str:
    text = str(value).strip() if value is not None else ""
    return text or fallback
