import discord
import os
from dotenv import load_dotenv
from intent_parser import parse_message_llm
from intent_handlers import handle_intent

print("🚀 Starting bot...")

# Load environment variables
load_dotenv()
TOKEN = os.getenv("DISCORD_TOKEN")
if not TOKEN:
    raise RuntimeError("❌ DISCORD_TOKEN is not set in the environment!")

CHANNEL_NAME = "babys-books"

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

    print(f"📩 New message: {message.content}")

    # Parse message with LLM
    try:
        intent_data = parse_message_llm(message.content.strip())
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

    # Handle intent
    try:
        await handle_intent(intent, entities, message)
    except Exception as e:
        print(f"[ERROR] Failed to handle intent: {e}")
        await message.channel.send("❌ Something went wrong while processing your request.")

try:
    client.run(TOKEN)
except Exception as e:
    print("❌ Bot failed to start:", e)
