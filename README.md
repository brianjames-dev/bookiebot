# 📒 BookieBot
<img src="assets/bookiebot-icon.png" alt="BookieBot Icon" width="300"/>

BookieBot is an intelligent Discord bot designed to help you track personal expenses and income directly from Discord.\
It leverages agentic AI to understand natural language commands, update a Google Sheet, and provide insightful budget analytics in real time.

## 🚀 Features

- Log expenses, income, rent, utilities, savings, and more via natural language (e.g., *"I spent \$25 on groceries today"*).
- Query financial data easily (e.g., *"What did I spend last week?"*, *"Show me my largest single expense"*).
- Supports dozens of intents including burn rate calculation, category breakdowns, and daily/weekly insights.
- Sends proactive subscription pull-date reminders 7, 3, and 1 day before expected charges.
- Fully integrated with Google Sheets for persistent, transparent data storage.
- Asynchronous and scalable, with clear error handling and feedback messages.

## 🛠️ Tech Stack

- **Python** — main language
- **Discord.py** — Discord bot framework
- **Google Sheets API** — data storage and retrieval
- **OpenAI API** — natural language understanding
- **Plotly + Kaleido** — chart rendering for Discord image attachments (Kaleido 0.2.x for self-contained PNG export on Railway)
- **AsyncIO** — asynchronous event loop and I/O
- **Railway** — deployment platform

## 📄 Example Commands

> 💬 *"Log \$15 for lunch today"*\
> 📋 Bot adds an expense to the Google Sheet.

> 💬 *"What’s my burn rate?"*\
> 📊 Bot calculates and returns your average daily spending.

> 💬 *"Show me my top 3 expenses this month"*\
> 📝 Bot fetches and lists your largest expenses.

## 🎭 Daily Avatar Rotation

BookieBot can rotate its Discord profile picture once per day. Add square avatar images to:

```text
assets/avatars/
```

Supported formats are `.png`, `.jpg`, `.jpeg`, and `.webp`. Rotation is enabled by default when images are present. Set `BOOKIEBOT_AVATAR_ROTATION_ENABLED=false` to disable it, or set `BOOKIEBOT_AVATAR_DIR` to use a different folder.

## Subscription Reminders

BookieBot keeps the visible `Subscriptions` worksheet as the editable source of truth, then syncs it into a hidden per-user worksheet named `_BookieBot Subscription Schedule`. Reminders fire once per user per day after the configured Pacific send hour and include every subscription expected to pull in the next 7 days.

```text
<@user> `$177.90` will be pulled by subscriptions in the next 7 days.

Today:
`None`

Tomorrow:
`Railway - $5.00 - May 15`

Upcoming:
`ChatGPT - $20.00 - May 17`
`Amazon Prime - $152.90 - May 21`
```

The current block layout is supported. The hidden sheet uses one normalized row per subscription with columns for owner, kind, cadence, amount, pull day/month, reminder offsets, source range, and sync timestamp. BookieBot refreshes this hidden sheet in the background even before the daily notification window, so sheet changes can be normalized automatically before reminders are due. If BookieBot finds malformed visible subscription rows it cannot safely normalize, it sends a concise parse-warning digest and skips those rows until fixed.

For scheduled rows that look like manually tracked bills, such as Rent, PG&E, Recology, or Water, BookieBot checks the existing payment fields and annotates the reminder if no payment has been logged yet. Student Loan is tracked only as subscription autopay, without dedicated log-payment or paid-status commands:

```text
Tomorrow:
`PG&E - $140.00 - May 15 (no logged payment yet for this expected tomorrow pull)`
```

Admin/debug support:

```text
/debug_subscriptions
```

This command forces a sync, lists parsed subscriptions, and reports skipped rows. Set `BOOKIEBOT_SUBSCRIPTION_REMINDERS_ENABLED=false` to disable the background checker, or set `BOOKIEBOT_SUBSCRIPTION_REMINDER_SEND_HOUR=9` to change the first eligible send hour.

Per-user send-hour overrides are also supported:

```env
BRIAN_SUBSCRIPTION_REMINDER_SEND_HOUR=10
HANNAH_SUBSCRIPTION_REMINDER_SEND_HOUR=8
```

## Read-Only Bank Integration

The Plaid-backed bank integration is in its first Sandbox-only implementation phase. It does not write bank transactions into budget sheets yet. The current slice can link a Plaid Sandbox Item, store the access token encrypted outside Google Sheets, fetch accounts, and sync transactions with Plaid's `/transactions/sync` cursor flow.

Required environment variables:

```env
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox
BANK_TOKEN_ENCRYPTION_KEY=
BANK_LINK_SIGNING_SECRET=
BANK_DATABASE_URL=
BANK_SQLITE_PATH=data/banking.sqlite3
PLAID_WEBHOOK_SECRET=
PLAID_WEBHOOK_URL=https://your-public-bot-url.example/bank/plaid-webhook
```

Send `PLAID_WEBHOOK_SECRET` with the `X-BookieBot-Webhook-Secret` request header. The webhook endpoint returns HTTP 503 when the secret is unset and HTTP 401 when the header is missing or invalid. Do not put the secret in the webhook URL query string.

On Railway, `data/banking.sqlite3` is not durable across redeploys unless a persistent volume is mounted. For Sandbox testing, use `/debug_bank_seed_sandbox` after each redeploy. Before linking real bank accounts, use Railway Postgres and set `BANK_DATABASE_URL`; SQLite should remain local/Sandbox-only unless it is backed by a mounted volume.

Admin/debug commands:

```text
/debug_bank_status
/debug_bank_seed_sandbox
/debug_bank_sandbox_link
/debug_bank_sync
/debug_bank_transactions
/debug_bank_reconcile
```

The first production-facing goal is reconciliation: matching bank transactions against manually logged expenses, income, subscriptions, and bills before anything is imported into the sheet.

## 📷 Screenshots

### Intent Recognition – Page 1
**Displays the first half of BookieBot’s supported natural language intents, including logging income, tracking rent, utilities, spending breakdowns, and more.**

<img src="assets/intent-list-1.png" alt="Intent List 1/2" width="600"/>

---

### Intent Recognition – Page 2
**Here are the rest of the LLM intent possibilities.**

<img src="assets/intent-list-2.png" alt="Intent List 2/2" width="600"/>

---

### Intent Description + Sample Query
**An example of how BookieBot interprets a user message and maps it to a structured command with parameters for downstream processing.**

<img src="assets/intent-desc+example.png" alt="Intent Desc+Example" width="600"/>

---

### Expense Breakdown
**BookieBot responding with a categorical breakdown of expenses, grouped by user-defined tags such as food, gas, groceries, and shopping.**

<img src="assets/expense-breakdown.png" alt="Expense Breakdown" width="600"/>

---

### Spending Calendar View
**BookieBot visualizes daily spending across a calendar, highlighting spikes or gaps to help users spot trends or missed logs.**

<img src="assets/spending-calendar.png" alt="Spending Calendar" width="600"/>

---

### Expenses on a Specific Day
**Shows how BookieBot retrieves all expenses logged for a specific day, including vendor, category, and total spent.**

<img src="assets/specific-day-expenses.png" alt="Specific Day Expenses" width="600"/>

---

### Food Log Snapshot
**A sample of a bot-logged food-related expense, showcasing detailed tracking by location and participant as well as payment selection.**

<img src="assets/logged-food-expense.png" alt="Logged Food" width="600"/>

---

### Autonomous Logging
**An annotated Google Sheet pointing to a row logged automatically by BookieBot, confirming autonomous expense tracking throughout the month.**

<img src="assets/expense-sheet-proof.png" alt="Autonomous Logging" width="600"/>

## 📄 License

MIT License
