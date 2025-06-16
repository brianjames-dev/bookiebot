import discord
import os
from dotenv import load_dotenv
from message_parser import parse_message_llm
from sheets_writer import write_to_sheet
import json

print("Starting bot...")

load_dotenv()
TOKEN = os.getenv("DISCORD_TOKEN")
print("Loaded token:", TOKEN)

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

    if message.channel.name == "babys-books":
        print(f"New message: {message.content}")
        parsed = parse_message_llm(message.content)

        if parsed:
            try:
                data = json.loads(parsed)
                print("Parsed:", data)
                write_to_sheet(data, message)
            except json.JSONDecodeError:
                print("JSON parsing failed.")
        else:
            print("Could not parse the message.")

try:
    client.run(TOKEN)
except Exception as e:
    print("Bot failed to start:", e)
