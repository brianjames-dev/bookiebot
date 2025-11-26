import discord
import os
from dotenv import load_dotenv
from bookiebot.intent_parser import parse_message_llm
from bookiebot.intent_handlers import handle_intent
import intent_explorer

print("🚀 Starting bot...")

# Load environment variables
load_dotenv()
TOKEN = os.getenv("DISCORD_TOKEN")
if not TOKEN:
    raise RuntimeError("❌ DISCORD_TOKEN is not set in the environment!")

CHANNEL_NAME = os.getenv("CHANNEL_NAME", "babys-books")

# Discord intents
intents = discord.Intents.default()
intents.messages = True
intents.message_content = True

client = discord.Client(intents=intents)


@client.event
async def on_ready():
    print(f"✅ Logged in as {client.user}")


@client.event
async def on_message(message):
    # Ignore the bot’s own messages
    if message.author == client.user:
        return

    # Only respond in the configured channel
    if message.channel.name != CHANNEL_NAME:
        return

    content = message.content.strip()
    print(f"📩 New message: {content}")

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
        print(f"🤖 Detected intent: {intent}, Entities: {entities}")
    except Exception as e:
        print(f"[ERROR] Failed to parse intent: {e}")
        await message.channel.send("❌ Sorry, I couldn’t understand your request.")
        return

    if not intent:
        await message.channel.send("❌ Sorry, I couldn’t understand your request.")
        return

    # Add default `person` if not explicitly specified
    if "person" not in entities or not entities["person"]:
        entities["person"] = None
        print(f"👤 No person specified, letting resolver handle Discord user: {message.author.name}")

    try:
        await handle_intent(intent, entities, message)
    except Exception as e:
        print(f"[ERROR] Failed to handle intent: {e}")
        await message.channel.send("❌ Something went wrong while processing your request.")


try:
    client.run(TOKEN)
except Exception as e:
    print("❌ Bot failed to start:", e)
