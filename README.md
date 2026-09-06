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

## Conversational LangGraph Agent

Messages that do not match a BookieBot command enter a LangGraph conversational agent instead of a stateless generic fallback. Recognized read questions covered by the agent's tools also use this path, so the model interprets live tool data and answers in its own words instead of returning the legacy intent handler's preformatted string. The agent can answer normal questions directly and can combine these read-only tools when a response depends on the requesting user's live BookieBot data:

- Current budget snapshot, income, remaining budget, daily pace, and burn rate
- Category and merchant spending
- Largest expenses and expenses on a requested date
- Subscriptions and current bill-payment status
- The canonical Expense Breakdown dataset, including exact Current and Projected views for income, outflows, savings targets, category budgets/cascade balances, burn rate, scheduled cash flow, commitments, activity, utility history, and reimbursements

For planning questions, the agent uses `get_financial_report` with one focused section (`overview`, `categories`, `cash_flow`, `commitments`, `burn_rate`, `activity`, or `reimbursements`) and a `current`, `projected`, or `comparison` mode. These mode views are calculated on the server and are also consumed by the web report, so an agent answer about Projected income or money left uses the same values as the page's Projected button. Historical months can be requested explicitly.

Existing command routing remains authoritative for every mutation. The conversational agent cannot log, update, move, split, delete, reconcile, or pay anything. Tool identity comes from the trusted Discord message context rather than model-generated owner arguments, and conversation threads are isolated by guild, channel, and Discord user.

Imperative bank-transfer requests are rejected before intent parsing so wording such as `Transfer $50 from checking to savings` cannot be misread as setting the monthly savings contribution. A completed transfer can still be recorded when the user explicitly asks BookieBot to log it.

The agent uses process-local LangGraph memory by default. Set `BOOKIEBOT_AGENT_DATABASE_URL` for durable Postgres checkpoints; when it is omitted, an existing `BANK_DATABASE_URL` is reused. If neither URL is configured, conversational memory resets when the bot process restarts.

```env
BOOKIEBOT_INTENT_MODEL=gpt-4.1-mini
BOOKIEBOT_AGENT_MODEL=gpt-4.1-mini
BOOKIEBOT_AGENT_DATABASE_URL=
BOOKIEBOT_AGENT_TIMEOUT_SECONDS=45
BOOKIEBOT_AGENT_MAX_MODEL_CALLS=6
BOOKIEBOT_AGENT_MAX_TOOL_CALLS=8
```

## Income Projection Settings

Brian Budget 2026 and Hannah Budget 2026 use one settings grid at **E1:F5** in their **Template** and **September** tabs:

| Cell | Label | Value |
| --- | --- | --- |
| F2 | Main Income Source | Employer/source, e.g. `xAI` or `Sonic` |
| F3 | Income Projection Mode | Dropdown: `biweekly`, `fixed monthly`, `off` |
| F4 | Fixed Monthly Income | Monthly net/take-home salary; blank until configured |
| F5 | Paycheck Anchor Date | One known payday, e.g. `7/2/2026` |

Select the mode in **F3**. For fixed monthly salary, enter your monthly take-home amount in **F4**, not gross annual salary. For biweekly pay, enter one payday in **F5**: scheduled paydays repeat every fourteen days from that date indefinitely, across months and years. Actual early/late deposits keep their real dates and fill the nearest scheduled slot without shifting the schedule. F4 is used only in fixed monthly mode, and F5 schedules only biweekly mode. `off` keeps projected income at actual income.

The Apps Script in `scripts/google-apps-script/budget-system-automation.gs` copies the latest effective monthly settings into each new month, including the dropdown and date/currency validation. January inherits the prior annual workbook's last effective plan. Existing monthly choices are not overwritten by daily rollover. The internal Template provides defaults when there is no earlier month; make ongoing changes in the current month. `upgradeCurrentIncomeSettings()` migrates only the current month and internal Template in each annual budget, preserving the existing source/date. The grid stays above inserted income rows, with its anchor protected during first-income-row deletion and undo.

Only the configured source contributes to the paycheck estimate. Matching normalizes case, punctuation, and spacing and accepts the complete employer label with an optional standard suffix: `income`, `paycheck`, `payroll`, `salary`, or `wages`. Thus `xAI`, `xAI paycheck`, and `xAI income` match; `xAI bonus` and credit card rewards do not. Give bonuses or other one-time employer payments a distinct Source label.

Biweekly amounts use the average matching paycheck logged in the selected month, or the latest dated matching paycheck from the immediately prior month when none has been logged yet. The date schedule persists indefinitely; observed paycheck amounts retain this separate freshness limit. Without a usable amount, the report explains what is missing and leaves income at its logged total.

Fixed monthly projected income is actual income plus any unreceived portion of the configured salary. A $6,000 target with $3,000 salary and $50 rewards received projects to $6,050. Actual salary above the target is never reduced, and two/three-paycheck months use the same monthly target. The Calendar shows any remaining fixed salary as one **Projected salary remainder** at month-end, a planning estimate rather than a promised deposit date. Current and completed-month income stay actual-only, and both the Income card and Discord report tools expose the resolved basis. Settings do not log transactions or change Budget formulas.

Legacy month tabs remain readable: `Biweekly Income Source` aliases the main source; `Biweekly Income Start` retains its older bootstrap/reanchor behavior until migrated to `Paycheck Anchor Date`. Blank settings inherit earlier values; a new employer resets its inherited amount/mode/date. Invalid mode/amount does not restore an old salary estimate. Exact Monthly Income label matching keeps the fixed-salary setting separate from actual-income reads and writes.

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
BANK_DATABASE_URL=
BANK_SQLITE_PATH=data/banking.sqlite3
```

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
