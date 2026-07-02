import logging
import re
import os
import asyncio
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from typing import Any, AsyncContextManager, cast

# Disable discord voice/audio stack to avoid loading audioop (deprecated in Python 3.13)
os.environ.setdefault("DISCORD_AUDIO_DISABLE", "1")

try:
    import discord
except ModuleNotFoundError:
    class _Discord:
        class Client:
            pass

        class app_commands:
            class CommandTree:
                pass

    discord = _Discord()

from bookiebot.core import config
from bookiebot.core.avatar_rotation import run_avatar_rotation_loop
from bookiebot.core.bank_reconciliation import ensure_bank_reconciliation_loop, register_persistent_bank_reconciliation_views
from bookiebot.core.subscription_reminders import ensure_subscription_reminder_loop
from bookiebot.core.web_server import ensure_web_server
from bookiebot.intents.parser import parse_message_llm
from bookiebot.intents.handlers import handle_intent
from bookiebot.intents import explorer as intent_explorer
from bookiebot.sheets.routing import UnknownDiscordUserError, get_user_config, resolve_actor_key, resolve_message_actor_key
from bookiebot.sheets.undo import (
    clear_pending_action_selection,
    pending_action_selection_count,
    pending_action_selection_kind,
    pending_move_item,
    pop_pending_action_expiration_notice,
    pending_update_field,
)

logger = logging.getLogger(__name__)
_AVATAR_ROTATION_TASK: asyncio.Task | None = None

_ACTION_NOUNS = {
    "action",
    "entry",
    "expense",
    "log",
    "logged",
    "payment",
    "purchase",
    "transaction",
}
_DELETE_VERBS = {"clear", "delete", "remove", "erase"}
_UPDATE_VERBS = {"change", "correct", "edit", "fix", "redo", "update"}
_MOVE_VERBS = {"categorize", "move", "reclassify", "recategorize"}
_CATEGORIES = {"grocery", "groceries", "gas", "food", "shopping"}
_CANCEL_WORDS = {"cancel", "nevermind", "never mind", "stop"}


@asynccontextmanager
async def _maybe_typing(message: Any) -> AsyncIterator[None]:
    channel = getattr(message, "channel", None)
    typing = getattr(channel, "typing", None)
    if not callable(typing):
        yield
        return
    typing_context = cast(AsyncContextManager[Any], typing())
    async with typing_context:
        yield


def _short_value(value: object, *, limit: int = 80) -> str:
    text = str(value).strip()
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3]}..."


def _intent_action_label(intent: str | None) -> str:
    labels = {
        "log_income": "logging income",
        "log_expense": "logging an expense",
        "log_need_expense": "logging a Need expense",
        "log_rent_paid": "logging rent paid",
        "log_pge_paid": "logging PG&E paid",
        "log_recology_paid": "logging Recology paid",
        "log_water_paid": "logging water paid",
        "log_student_loan_paid": "logging a student loan payment",
        "query_recent_actions": "showing recent actions",
        "update_recent_action": "updating a logged action",
        "delete_recent_action": "deleting a logged action",
        "move_recent_action": "moving a logged action",
    }
    return labels.get(intent or "", f"handling `{intent}`" if intent else "handling your request")


def _format_intent_summary(intent: str | None, entities: dict) -> str:
    parts = [intent or "unknown"]
    amount = entities.get("amount")
    if amount not in (None, ""):
        parts.append(f"${amount}")

    if intent == "log_income":
        source = entities.get("source")
        label = entities.get("label")
        if source:
            parts.append(f"from {_short_value(source)}")
        if label:
            parts.append(f"({_short_value(label)})")
    elif intent == "log_expense":
        category = entities.get("category")
        item = entities.get("item")
        location = entities.get("location")
        if category:
            parts.append(f"in {_short_value(category)}")
        if item:
            parts.append(f"for {_short_value(item)}")
        if location:
            parts.append(f"at {_short_value(location)}")

    return " ".join(parts)


def _format_processing_error(intent: str | None, entities: dict, error: Exception) -> str:
    error_name = type(error).__name__
    error_detail = _short_value(error or error_name, limit=120)
    action = _intent_action_label(intent)
    summary = _format_intent_summary(intent, entities)

    lines = [
        f"❌ I hit an error while {action}.",
        f"Request: {summary}",
        f"Error: {error_name}: {error_detail}",
    ]
    if (intent or "").startswith("log_"):
        lines.append("If you also see a success message, the sheet may already have been updated. Check `recent actions` before retrying.")
    return "\n".join(lines)


def _extract_action_match_text(content: str) -> str | None:
    text = content.lower()
    text = re.sub(r"\$?\d+(?:\.\d{1,2})?", " ", text)
    words = re.findall(r"[a-z&']+", text)
    stop_words = {
        "a",
        "an",
        "and",
        "can",
        "could",
        "for",
        "from",
        "i",
        "it",
        "last",
        "me",
        "most",
        "my",
        "need",
        "one",
        "please",
        "recent",
        "that",
        "the",
        "this",
        "to",
        "want",
        "would",
        "be",
        "category",
        "in",
        "into",
        "name",
        "of",
        "should",
    } | _ACTION_NOUNS | _DELETE_VERBS | _UPDATE_VERBS | _MOVE_VERBS
    field_words = {"amount", "card", "date", "item", "location", "name", "person"}
    candidates = [word for word in words if word not in stop_words and word not in field_words]
    candidates = [word for word in candidates if word not in _CATEGORIES]
    return " ".join(candidates) or None


def _extract_destination_category(content: str) -> str | None:
    words = set(re.findall(r"[a-z&']+", content.lower()))
    if "groceries" in words:
        return "grocery"
    for category in ("grocery", "gas", "food", "shopping"):
        if category in words:
            return category
    return None


def _action_management_intent(content: str) -> tuple[str, dict] | None:
    text = content.lower()
    words = set(re.findall(r"[a-z&']+", text))
    has_action_noun = bool(words & _ACTION_NOUNS)
    has_update_field = bool(words & {"amount", "card", "date", "item", "location", "name", "person"})

    destination_category = _extract_destination_category(text)
    if destination_category and (has_action_noun or "it" in words or "that" in words) and "to" in words and not (words & _DELETE_VERBS):
        match_text = _extract_action_match_text(text)
        entities = {"category": destination_category}
        if match_text:
            entities["match_text"] = match_text
        return "move_recent_action", entities

    if not has_action_noun:
        if words & _UPDATE_VERBS and has_update_field:
            return "query_recent_actions", {"n": 5}
        return None

    if words & _MOVE_VERBS or ("category" in words and words & _UPDATE_VERBS):
        match_text = _extract_action_match_text(text)
        entities = {"category": destination_category} if destination_category else {}
        if match_text:
            entities["match_text"] = match_text
        return "move_recent_action", entities

    if words & _DELETE_VERBS:
        match_text = _extract_action_match_text(text)
        if match_text:
            return "delete_recent_action", {"match_text": match_text}
        return "query_recent_actions", {"n": 5}

    if words & _UPDATE_VERBS:
        match_text = _extract_action_match_text(text)
        if match_text:
            return "update_recent_action", {"match_text": match_text, "updates": {}}
        return "query_recent_actions", {"n": 5}

    return None


def _indexed_action_intent(content: str) -> tuple[str, dict] | None:
    match = re.match(r"^\s*(\d{1,2})\b(.+)$", content.strip(), flags=re.IGNORECASE)
    if not match:
        return None
    index = int(match.group(1))
    rest = match.group(2).lower()
    words = set(re.findall(r"[a-z&']+", rest))
    destination_category = _extract_destination_category(rest)
    if destination_category and (words & _MOVE_VERBS or "to" in words):
        return "move_recent_action", {"index": index, "category": destination_category}
    if words & _DELETE_VERBS:
        return "delete_recent_action", {"index": index}
    if words & _UPDATE_VERBS:
        return "update_recent_action", {"index": index, "updates": {}}
    return None


def _recent_query_intent(content: str) -> tuple[str, dict] | None:
    text = content.lower().strip()
    if text == "show more":
        return "query_recent_actions", {"more": True}
    if text in {
        "recent",
        "recent actions",
        "recent logged actions",
        "show recent actions",
        "show last actions",
        "undo history",
    }:
        return "query_recent_actions", {"n": 5}
    match = re.search(r"\b(?:show|list)\b.*\b(?:last|recent)\s+(\d{1,2})\b.*\b(?:actions|expenses|transactions)\b", text)
    if match:
        return "query_recent_actions", {"n": min(int(match.group(1)), 25), "explicit_n": True}
    return None


def register_events(client, tree):
    @client.event
    async def on_ready():
        global _AVATAR_ROTATION_TASK
        logger.info("✅ Logged in as bot", extra={"user": str(client.user)})
        register_persistent_bank_reconciliation_views(client)
        ensure_web_server(client)
        if _AVATAR_ROTATION_TASK is None or _AVATAR_ROTATION_TASK.done():
            _AVATAR_ROTATION_TASK = asyncio.create_task(run_avatar_rotation_loop(client))
        ensure_bank_reconciliation_loop(client)
        ensure_subscription_reminder_loop(client)
        try:
            await tree.sync()
            logger.info("✅ Synced application commands")
        except Exception as e:
            logger.exception("Failed to sync commands", extra={"exception": str(e)})

    @client.event
    async def on_message(message):
        if message.author == client.user:
            return

        channel = getattr(message, "channel", None)
        is_dm = getattr(channel, "guild", None) is None
        if config.CHANNEL_ID:
            if not is_dm and message.channel.id != config.CHANNEL_ID:
                return
        else:
            if not is_dm and getattr(message.channel, "name", None) != config.CHANNEL_NAME:
                return

        actor_key = resolve_message_actor_key(message)
        try:
            get_user_config(actor_key)
        except UnknownDiscordUserError as exc:
            if is_dm:
                logger.info(
                    "Ignoring DM from unmapped Discord user",
                    extra={"user_id": str(getattr(message.author, "id", None))},
                )
                return
            await message.channel.send(str(exc))
            return

        content = message.content.strip()
        logger.info(
            "📩 New message",
            extra={
                "text": content,
                "user": str(message.author),
                "user_id": str(message.author.id),
                "channel": getattr(message.channel, "name", "dm"),
            },
        )

        if content.lower() == "list":
            output = intent_explorer.list_intents()
            await message.channel.send(output)
            return

        pending_item_move = pending_move_item(actor_key)
        if pending_item_move:
            if content.lower() in _CANCEL_WORDS:
                clear_pending_action_selection(actor_key)
                await message.channel.send("Canceled.")
                return
            action_id, category = pending_item_move
            await handle_intent(
                "move_recent_action",
                {"action_id": action_id, "category": category, "updates": {"item": content.strip()}},
                message,
            )
            return
        expired_notice = pop_pending_action_expiration_notice(actor_key)
        if expired_notice:
            await message.channel.send(f"❌ {expired_notice}")
            return

        pending_field = pending_update_field(actor_key)
        if pending_field:
            action_id, field = pending_field
            value = content.strip()
            if field == "amount":
                amount_match = re.search(r"\$?\s*(\d+(?:\.\d{1,2})?)", value)
                if amount_match:
                    value = amount_match.group(1)
            await handle_intent("update_recent_action", {"action_id": action_id, "updates": {field: value}}, message)
            return
        expired_notice = pop_pending_action_expiration_notice(actor_key)
        if expired_notice:
            await message.channel.send(f"❌ {expired_notice}")
            return

        if content.isdigit():
            idx = int(content)
            pending_kind = pending_action_selection_kind(actor_key)
            expired_notice = pop_pending_action_expiration_notice(actor_key)
            if expired_notice:
                await message.channel.send(f"❌ {expired_notice}")
                return
            if pending_kind == "update":
                await handle_intent("update_recent_action", {"index": idx}, message)
                return
            if pending_kind == "delete":
                await handle_intent("delete_recent_action", {"index": idx}, message)
                return
            if pending_kind == "move":
                await handle_intent("move_recent_action", {"index": idx}, message)
                return
            output = intent_explorer.describe_intent(idx)
            await message.channel.send(output)
            return

        if content.lower() in {"undo", "undo last", "undo last transaction", "remove last entry"}:
            await handle_intent("undo_last_transaction", {}, message)
            return

        if content.lower().startswith(("delete #", "remove #", "clear #")):
            idx_text = content.split("#", 1)[1].strip()
            if idx_text.isdigit():
                await handle_intent("delete_recent_action", {"index": int(idx_text)}, message)
                return

        if (
            pending_action_selection_kind(actor_key) == "delete"
            and pending_action_selection_count(actor_key, "delete") == 1
            and set(re.findall(r"[a-z']+", content.lower())) & _DELETE_VERBS
        ):
            await handle_intent("delete_recent_action", {"index": 1}, message)
            return
        expired_notice = pop_pending_action_expiration_notice(actor_key)
        if expired_notice:
            await message.channel.send(f"❌ {expired_notice}")
            return

        recent_query = _recent_query_intent(content)
        if recent_query:
            intent, entities = recent_query
            await handle_intent(intent, entities, message)
            return

        indexed_action = _indexed_action_intent(content)
        if indexed_action:
            intent, entities = indexed_action
            await handle_intent(intent, entities, message)
            return

        action_management = _action_management_intent(content)
        if action_management:
            intent, entities = action_management
            pending_kind = pending_action_selection_kind(actor_key)
            expired_notice = pop_pending_action_expiration_notice(actor_key)
            if expired_notice:
                await message.channel.send(f"❌ {expired_notice}")
                return
            if pending_kind == "move" and intent == "move_recent_action":
                entities.setdefault("index", 1)
            await handle_intent(intent, entities, message)
            return

        try:
            async with _maybe_typing(message):
                intent_data = await parse_message_llm(content)
            intent = intent_data.get("intent")
            entities = intent_data.get("entities", {})
            logger.info(
                "🤖 Detected intent",
                extra={
                    "intent": intent,
                    "entities": entities,
                    "user": str(message.author),
                    "user_id": str(message.author.id),
                },
            )
        except Exception as e:
            logger.exception("Failed to parse intent", extra={"exception": str(e)})
            await message.channel.send("❌ Sorry, I couldn’t understand your request.")
            return

        if not intent:
            await message.channel.send("❌ Sorry, I couldn’t understand your request.")
            return

        if "person" not in entities or not entities["person"]:
            entities["person"] = None
            logger.info(
                "No person specified; resolver will handle user",
                extra={"user": message.author.name, "user_id": str(message.author.id)},
            )

        try:
            await handle_intent(intent, entities, message)
        except Exception as e:
            logger.exception(
                "Failed to handle intent",
                extra={
                    "exception": str(e),
                    "intent": intent,
                    "entities": entities,
                    "user": str(message.author),
                    "user_id": str(message.author.id),
                },
            )
            await message.channel.send(_format_processing_error(intent, entities, e))
