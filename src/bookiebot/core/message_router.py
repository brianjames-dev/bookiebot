import logging
import discord

from bookiebot.core import config
from bookiebot.intents.parser import parse_message_llm
from bookiebot.intents.handlers import handle_intent
from bookiebot.intents import explorer as intent_explorer

logger = logging.getLogger(__name__)


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
            output = intent_explorer.describe_intent(idx)
            await message.channel.send(output)
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
