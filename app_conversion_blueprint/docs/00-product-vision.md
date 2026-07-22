# Product Vision

## One-Sentence Product

BookieBot App is a private, AI-forward personal finance assistant for iOS that combines Rocket Money-style visibility with BookieBot's active logging and reconciliation workflow.

## What Should Feel Different

Most finance apps passively ingest transactions and then show charts. BookieBot should ask, remember, reconcile, and help the user keep an intentional budget model.

The core loop:

1. The user logs spending naturally: "I spent 18 at Chipotle on food."
2. The app records a structured ledger entry, stores an audit event, and updates the dashboard.
3. Plaid later sees the posted transaction.
4. The app matches it to the logged entry or asks the user what to do.
5. The user confirms, fixes, ignores, or imports it.
6. The assistant learns durable preferences only through explicit settings and merchant rules.

## Target User Experience

The first screen should be the working finance app, not a landing page.

Primary surfaces:

- Assistant thread for logging, questions, reviews, and settings edits.
- Today / Month dashboard with spending, budget left, savings progress, and upcoming pulls.
- Reconciliation inbox for Plaid transactions that need review.
- Ledger for manual and imported transactions.
- Recurring bills/subscriptions.
- Settings that are both form-editable and assistant-editable.
- Export center for Google Sheets.

## Product Pillars

### 1. AI Forward, Not AI Reckless

The assistant should use local inference to understand user intent, plan tool calls, ask clarifying questions, and explain results. It should not directly write arbitrary database changes. Every important mutation goes through typed tools and policy checks.

### 2. Active Finance Hygiene

Plaid creates a strong baseline, but the app should still encourage active logging and review. Manual logs are not obsolete; they are the user's budget model. Bank data is reality-checking and reconciliation data.

### 3. Local-First Privacy

The app should store the ledger locally and run the assistant locally by default. The preferred assistant experience should use a downloadable Qwen 4B-class local AI model pack, while Apple Foundation Models provide lightweight/fallback mode on supported devices. Plaid and Google are explicit integrations, not hidden processing paths. Remote frontier LLM APIs are out of scope for the default product.

During onboarding, the app should explain that the stronger model is not prebundled because it is large. Downloading it is the user's choice, keeps the first install smaller, and preserves the goal that personal finance chat runs on the user's device.

### 4. Exportable, Not Sheet-Captive

Google Sheets remains valuable for transparency and analysis, but it should be generated from the local ledger. The database owns state; Sheets reflects state.

### 5. Auditable By Design

Every user-facing finance mutation should create an event. The system should be able to answer, "Why did this amount change?" and "Which bank transaction confirmed this row?"

## MVP Scope

MVP should include:

- Local household/member/category/account settings.
- Manual expense and income logging.
- Basic budgets and monthly dashboard.
- Assistant thread with typed tool execution and local model provider selection.
- Action log and undo for manual ledger mutations.
- Reconciliation-ready data model, even before Plaid is connected.

Next slice:

- Plaid Link and transaction sync.
- Reconciliation inbox.
- Confirm/import/ignore flows.
- Merchant memory and user-editable rules.

After that:

- Google Sheets export.
- Subscription and bill pull-date reminders.
- Proactive anomaly detection.
- Receipt/screenshot intake.

## Behavioral Invariants To Preserve From BookieBot

- Do not write imported bank transactions into the ledger without explicit user confirmation.
- Do not hide amount mismatches during reconciliation.
- Keep bank transaction state, reconciliation item state, and ledger action lineage synchronized.
- Keep recent-action update, move, delete, and undo behavior auditable.
- Avoid surfacing old bank transactions as normal inbox work unless the user asks for historical review.
- Favor clarifying questions over confident wrong guesses.
