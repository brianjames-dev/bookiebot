# BookieBot Agent Roadmap

BookieBot is already strong as a single-turn financial operator: it can parse natural language, log and query Google Sheets, and manage recent transactions through update, delete, move, and undo flows.

The next best direction is to make it more proactive, context-aware, and capable of handling multi-step financial tasks without needing explicit commands for every action.

## Highest-Value BookieBot Upgrades

### 1. Daily and Weekly Financial Briefings

Add scheduled Discord summaries that proactively report:

- Total spent today or this week
- Remaining monthly budget
- Burn rate and projected month-end spend
- Biggest recent transaction
- Bills or savings deposits still unpaid
- Whether spending is ahead of or behind expected pace

This should reuse the existing analytics helpers and query handlers where possible.

### 2. Anomaly Detection

Have BookieBot notice unusual financial events before anyone asks:

- Large transaction compared with normal behavior
- Category spike, such as food or shopping suddenly running high
- Duplicate-looking entries
- Subscription price increases
- Missing expected bills
- No logged spending for several days when that is abnormal

The bot could send a short alert and offer actions like confirm, delete, update, or ignore.

### 3. Bill and Subscription Pull-Date Reminders

Track the dates that bills and subscriptions usually pull money from the bank, then send proactive Discord reminders.

Examples:

- Rent pulls on the 1st
- PG&E pulls around the 8th
- Recology pulls quarterly
- Spotify pulls on the 14th
- Credit card autopay pulls on the 22nd

Useful notifications:

- Bill due tomorrow
- Subscription pulling today
- Large autopay expected this week
- Bank balance may need to cover upcoming withdrawals
- A usual bill has not appeared yet

This could use the existing subscriptions sheet plus a new schedule field for expected pull day, reminder window, amount estimate, and account/card.

### 4. Read-Only Bank Account Integration

Optionally connect bank accounts with read-only access so BookieBot can understand what actually happened instead of relying only on manually logged entries.

Useful capabilities:

- Show real account balances
- Compare bank transactions against BookieBot logs
- Detect missed manual entries
- Detect duplicates
- Confirm whether bills and subscriptions actually pulled
- Categorize imported transactions for review
- Show cash-flow risk before large upcoming bills
- Give a clearer picture across checking, savings, and credit cards

Important design constraints:

- Read-only access only
- Never move money
- Never store raw banking credentials
- Use a trusted aggregator such as Plaid, MX, Teller, or a bank-provided API
- Store only the minimum transaction metadata needed
- Require user confirmation before writing imported transactions to the budget sheet

This would make BookieBot much more agentic because it could reconcile reality against the user's budget model.

### 5. Goal Tracking

Add support for explicit financial goals:

- Emergency fund target
- Debt payoff target
- Monthly savings target
- Vacation or large-purchase fund
- Discretionary spending ceiling

Useful questions this unlocks:

- Can I spend $80 on dinner?
- Am I on track for savings this month?
- What do I need to cut to hit my goal?
- How much can I safely spend this weekend?

### 6. Clarifying Questions Before Logging

When the parser is uncertain, BookieBot should ask a follow-up instead of guessing.

Examples:

- Was this food or grocery?
- Which card did you use?
- Was this a Need expense?
- Should Target be shopping or grocery this time?
- Is this a new transaction or an update to a recent one?

The existing pending interaction state in the message router makes this a natural extension.

### 7. Merchant Memory and Preferences

Add a lightweight memory layer for recurring merchants and user preferences.

Examples:

- Starbucks usually means food
- Shell usually means gas
- Costco should ask grocery vs shopping
- Apple Shortcut logs from Brian should use Brian's default card flow
- Certain vendors should always be marked as Need expenses

This could live in a new Google Sheet tab or a small local database.

### 8. Multi-Action Agent Planning

Allow one message to produce several steps instead of exactly one intent.

Examples:

- Log $20 at Chipotle and show my food total.
- Move the Costco one to grocery and tell me remaining budget.
- Delete the duplicate Starbucks and show recent actions.
- Log my paycheck, pay rent, and show my budget margin.

This would require a planner layer above the current intent handler. The planner should output ordered tool calls that reuse existing handlers.

### 9. Receipt and Screenshot Intake

Let users upload receipt images or screenshots and have BookieBot extract:

- Merchant
- Total amount
- Date
- Category
- Card or person, if visible
- Optional line items

The bot should show a confirmation before writing to the sheet.

### 10. Month-End Closeout

Add a monthly review flow:

- Summarize the month
- Compare spending to previous months
- Identify the largest surprises
- Report recurring subscriptions
- Suggest budget adjustments
- Prepare or validate the next month's sheet

This could run automatically near the end of the month or on demand.

### 11. Confidence and Audit Metadata

Expand the action log with richer metadata:

- Source Discord message id
- Parsed intent
- Parser confidence
- Fields inferred by the bot
- Fields confirmed by the user
- Original raw user message

This would make BookieBot easier to debug and allow questions like, "Why did you log this as grocery?"

### 12. Modern LLM Interface

Upgrade the LLM client and parser to use structured outputs with a current model instead of relying on free-form JSON from an older chat completion interface.

Benefits:

- More reliable intent parsing
- Better validation for required fields
- Cleaner support for multi-action plans
- Easier testing of parser failures and confidence states

### 13. Portable Containerized App and Self-Serve Setup

Turn BookieBot from a personal bot into a portable app that another household could install, configure, and run with minimal manual setup.

Target experience:

- User creates or connects a Google account
- App creates the required Google Sheets structure
- User invites the Discord bot to their own server
- User enters household member names, cards, categories, bills, and subscriptions
- App automatically writes that configuration into Google Sheets
- App runs in Docker or another containerized deployment target
- Google Sheets remains the human-readable source of truth for viewing and editing budget data

Important pieces:

- Dockerfile and docker-compose setup
- Environment variable template and validation
- First-run setup wizard
- Google OAuth or service-account setup flow
- Discord bot invite instructions or generated invite URL
- Automatic spreadsheet and worksheet creation
- Configurable users, cards, categories, subscriptions, and bill schedules
- Data migration/versioning for future sheet schema changes
- Admin commands for health checks, setup validation, and re-syncing config

This is a larger productization effort, but it would make BookieBot dramatically easier to share with other people.

## Companion Agents Worth Building

### 1. HomeOps Agent

Tracks household tasks, maintenance, warranties, bill due dates, recurring chores, and overdue reminders.

Potential features:

- Appliance and warranty tracker
- Home maintenance schedule
- Utility and bill reminders
- Shared household task queue

### 2. Meal and Grocery Agent

Uses budget, preferences, pantry inventory, and calendar context to suggest meals and grocery lists.

Potential features:

- Weekly meal planning
- Grocery list generation
- Cost-aware recipes
- Pantry tracking
- Compare planned grocery spend with actual BookieBot logs

### 3. Inbox and Admin Agent

Watches email or forwarded messages for receipts, bills, renewals, appointments, refunds, and subscription changes.

Potential features:

- Extract receipts and pass them to BookieBot
- Detect new subscriptions
- Alert on renewal dates
- Track refunds and credits
- Summarize admin tasks from email

### 4. Health Routine Agent

Tracks routines, appointments, workouts, medication reminders, sleep notes, and habit streaks.

This should stay focused on personal organization and reminders rather than medical advice.

### 5. Life Chief-of-Staff Agent

Creates a weekly planning brief that pulls together finances, calendar, tasks, goals, and loose ends.

Potential weekly output:

- What matters this week
- Bills and deadlines
- Budget posture
- Top unfinished tasks
- Decisions to make
- Suggested focus areas

### 6. Codex Maintenance Agent

Expand the existing debug and GitHub autofix workflow into a more complete maintenance agent.

Potential features:

- Watch production logs
- Detect recurring errors
- Open GitHub issues
- Suggest tests
- Prepare small fix PRs
- Summarize recent failures and deployments

## Recommended Build Order

1. Daily and weekly financial briefings
2. Bill and subscription pull-date reminders
3. Multi-action planner for compound requests
4. Merchant memory and low-confidence clarification
5. Anomaly detection
6. Receipt and screenshot logging
7. Month-end closeout
8. Goal tracking
9. Confidence and audit metadata
10. Modern structured-output LLM parser
11. Portable containerized app and self-serve setup
12. Read-only bank account integration
13. Companion agents, starting with Inbox/Admin or HomeOps

This order builds on the existing strengths of the codebase without requiring a rewrite. The best first milestone is a proactive briefing loop because most of the data and analytics already exist.
