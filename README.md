# 📒 BookieBot

BookieBot is an intelligent Discord bot designed to help you track personal expenses and income directly from Discord.\
It leverages an agentic AI to understand natural language commands, update a Google Sheet, and provide insightful budget analytics — all in real time.

---

## 🚀 Features

- Log expenses, income, rent, utilities, savings, and more via natural language (e.g., *"I spent \$25 on groceries today"*).
- Query financial data easily (e.g., *"What did I spend last week?"*, *"Show me my largest single expense"*).
- Supports dozens of intents including burn rate calculation, category breakdowns, and daily/weekly insights.
- Fully integrated with Google Sheets for persistent, transparent data storage.
- Asynchronous and scalable, with clear error handling and feedback messages.

---

## 🛠️ Tech Stack

- **Python** — main language
- **Discord.py** — Discord bot framework
- **Google Sheets API** — data storage and retrieval
- **OpenAI API** — natural language understanding
- **AsyncIO** — asynchronous event loop and I/O
- **Railway** — deployment platform

---

## 📄 Example Commands

> 💬 *"Log \$15 for lunch today"*\
> 📋 Bot adds an expense to the Google Sheet.

> 💬 *"What’s my burn rate?"*\
> 📊 Bot calculates and returns your average daily spending.

> 💬 *"Show me my top 3 expenses this month"*\
> 📝 Bot fetches and lists your largest expenses.

---

## 🔗 Getting Started

1. Clone the repository:

   ```bash
   git clone https://github.com/yourusername/bookiebot.git
   cd bookiebot
   ```

2. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Set up environment variables:

   - `DISCORD_BOT_TOKEN`
   - `GOOGLE_SHEET_ID`
   - `OPENAI_API_KEY`
   - (optional) `RAILWAY_API_KEY` if deploying on Railway

4. Run locally:

   ```bash
   python bot.py
   ```

5. Or deploy to [Railway](https://railway.app/).

---

## 📷 Screenshots

*(You can add a few screenshots of the bot in Discord responding to commands here.)*

---

## 📄 License

MIT License

