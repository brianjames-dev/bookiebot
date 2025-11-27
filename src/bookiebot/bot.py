import discord
import logging
import os
from discord import app_commands
from dotenv import load_dotenv
from bookiebot.intent_parser import parse_message_llm
from bookiebot.intent_handlers import handle_intent
from bookiebot import intent_explorer
from bookiebot.logging_config import get_recent_logs, init_logging, uptime_seconds

init_logging()
logger = logging.getLogger(__name__)

logger.info("🚀 Starting bot...")

# Load environment variables
load_dotenv()
TOKEN = os.getenv("DISCORD_TOKEN")
if not TOKEN:
    raise RuntimeError("❌ DISCORD_TOKEN is not set in the environment!")

CHANNEL_NAME = os.getenv("CHANNEL_NAME", "babys-books")
CHANNEL_ID = int(os.getenv("CHANNEL_ID", "0")) or None

# Discord intents
intents = discord.Intents.default()
intents.messages = True
intents.message_content = True

client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)
DEBUG_ALLOWLIST = {u.strip() for u in os.getenv("DEBUG_ADMINS", "").split(",") if u.strip()}


def _is_debug_allowed(user: discord.abc.User) -> bool:
    if not DEBUG_ALLOWLIST:
        return False
    return str(user.id) in DEBUG_ALLOWLIST


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
    # Ignore the bot’s own messages
    if message.author == client.user:
        return

    # Only respond in the configured channel
    if CHANNEL_ID:
        if message.channel.id != CHANNEL_ID:
            return
    else:
        if message.channel.name != CHANNEL_NAME:
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

    # === INTENT LIST COMMANDS ===
    if content.lower() == "list":
        output = intent_explorer.list_intents()
        await message.channel.send(output)
        return

    if content.isdigit():
        idx = int(content)
        output = intent_explorer.describe_intent(idx)
        await message.channel.send(output)
        return

    # === REGULAR BOT FLOW ===
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

    # Add default `person` if not explicitly specified
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


@tree.command(name="debug_logs", description="(Admin) Show recent logs")
@app_commands.describe(lines="Number of lines to return (default 200, max 2000)", level="Optional level filter (INFO/WARN/ERROR)", contains="Optional substring filter")
async def debug_logs(interaction: discord.Interaction, lines: int = 200, level: str | None = None, contains: str | None = None):
    if not _is_debug_allowed(interaction.user):
        await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
        return

    lines = max(1, min(lines, 2000))
    logs = get_recent_logs(limit=lines, level=level, contains=contains)
    if not logs:
        await interaction.response.send_message("No logs available for the given filters.", ephemeral=True)
        return

    content = "\n".join(logs)
    if len(content) > 1800:
        import io

        buf = io.BytesIO(content.encode("utf-8"))
        await interaction.response.send_message(
            content=f"Last {len(logs)} log lines:",
            file=discord.File(buf, filename="logs.txt"),
            ephemeral=True,
        )
    else:
        await interaction.response.send_message(f"```\n{content}\n```", ephemeral=True)


@tree.command(name="debug_status", description="(Admin) Show bot status/health")
async def debug_status(interaction: discord.Interaction):
    if not _is_debug_allowed(interaction.user):
        await interaction.response.send_message("❌ Not authorized.", ephemeral=True)
        return

    uptime = uptime_seconds()
    git_sha = os.getenv("GIT_SHA", "unknown")
    env_name = os.getenv("ENV", "unknown")
    llm_ready = bool(os.getenv("OPENAI_API_KEY"))
    sheet_ready = bool(os.getenv("EXPENSE_SHEET_KEY") or os.getenv("INCOME_SHEET_KEY"))

    msg = (
        f"⏱️ Uptime: {uptime/3600:.2f}h\n"
        f"🔖 Build: {git_sha}\n"
        f"🌎 Env: {env_name}\n"
        f"🤖 LLM ready: {'yes' if llm_ready else 'no'}\n"
        f"📄 Sheets configured: {'yes' if sheet_ready else 'no'}"
    )
    await interaction.response.send_message(msg, ephemeral=True)


try:
    client.run(TOKEN)
except Exception as e:
    logger.exception("Bot failed to start", extra={"exception": str(e)})
