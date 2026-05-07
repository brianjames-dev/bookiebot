import logging
import re
import os

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
from bookiebot.intents.parser import parse_message_llm
from bookiebot.intents.handlers import handle_intent
from bookiebot.intents import explorer as intent_explorer
from bookiebot.sheets.routing import resolve_actor_key
from bookiebot.sheets.undo import pending_action_selection_kind

logger = logging.getLogger(__name__)

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
        "recent actions",
        "recent logged actions",
        "show recent actions",
        "show last actions",
        "undo history",
    }:
        return "query_recent_actions", {"n": 5}
    match = re.search(r"\b(?:show|list)\b.*\b(?:last|recent)\s+(\d{1,2})\b.*\b(?:actions|expenses|transactions)\b", text)
    if match:
        return "query_recent_actions", {"n": min(int(match.group(1)), 25)}
    return None


def register_events(client: discord.Client, tree: discord.app_commands.CommandTree):
    @client.event
    async def on_ready():
        logger.info("✅ Logged in as bot", extra={"user": str(client.user)})
        try:
            await tree.sync()
            logger.info("✅ Synced application commands")
        except Exception as e:
            logger.exception("Failed to sync commands", extra={"exception": str(e)})

    @client.event
    async def on_message(message):
        if message.author == client.user:
            return

        if config.CHANNEL_ID:
            if message.channel.id != config.CHANNEL_ID:
                return
        else:
            if message.channel.name != config.CHANNEL_NAME:
                return

        content = message.content.strip()
        logger.info(
            "📩 New message",
            extra={
                "text": content,
                "user": str(message.author),
                "user_id": str(message.author.id),
                "channel": message.channel.name,
            },
        )

        if content.lower() == "list":
            output = intent_explorer.list_intents()
            await message.channel.send(output)
            return

        if content.isdigit():
            idx = int(content)
            actor_key = resolve_actor_key(
                getattr(message.author, "id", None),
                getattr(message.author, "name", None) or getattr(message.author, "display_name", None),
            )
            pending_kind = pending_action_selection_kind(actor_key)
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
            actor_key = resolve_actor_key(
                getattr(message.author, "id", None),
                getattr(message.author, "name", None) or getattr(message.author, "display_name", None),
            )
            if pending_action_selection_kind(actor_key) == "move" and intent == "move_recent_action":
                entities.setdefault("index", 1)
            await handle_intent(intent, entities, message)
            return

        try:
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
            logger.exception("Failed to handle intent", extra={"exception": str(e)})
            await message.channel.send("❌ Something went wrong while processing your request.")
