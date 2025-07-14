import discord
import os
import json
from dotenv import load_dotenv
from intent_parser import parse_message_llm
from intent_handlers import handle_intent

print("Starting bot...")

load_dotenv()
TOKEN = os.getenv("DISCORD_TOKEN")
print("Loaded token:", TOKEN)

CHANNEL_NAME = "babys-books"

intents = discord.Intents.default()
intents.messages = True
intents.message_content = True

client = discord.Client(intents=intents)

@client.event
async def on_ready():
    print(f"Logged in as {client.user}")

@client.event
async def on_message(message):
    if message.author == client.user:
        return

    if message.channel.name == CHANNEL_NAME:
        print(f"New message: {message.content}")
        intent, entities = await parse_message_llm(message.content.strip())
        print(f"Detected intent: {intent}, Entities: {entities}")

        if not intent:
            await message.channel.send("Sorry, I couldn’t understand your request.")
            return

        await handle_intent(intent, entities, message)

try:
    client.run(TOKEN)
except Exception as e:
    print("Bot failed to start:", e)
