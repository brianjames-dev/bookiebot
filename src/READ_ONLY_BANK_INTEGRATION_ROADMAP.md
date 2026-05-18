# Read-Only Bank Integration Roadmap

This roadmap covers BookieBot's read-only bank account integration effort. The goal is to let BookieBot compare real posted bank activity against the current Google Sheets budget model without ever moving money or storing raw bank credentials.

## Recommendation

Use Plaid first.

Why:

- Plaid is the most practical aggregator for a US-based personal finance workflow.
- Plaid Sandbox is free, supports Plaid Link and API testing, and allows unlimited test Items.
- Plaid Trial plans support limited real production data for up to 10 Production Items, which is enough for BookieBot's initial household rollout but not enough for broad/commercial use.
- Plaid provides Transactions, Balance, accounts, transaction webhooks, and update-mode flows that map directly to BookieBot's needs.

Keep the implementation adapter-shaped so another provider can be added later, but do not over-abstract v1. The first version should be Plaid-backed end to end.

## Current Implementation Status

Status: Phase 1 implemented; Phase 3 transaction/income review inbox is in progress.

Implemented first slice:

- Plaid Sandbox HTTP client using the existing `aiohttp` dependency.
- Local SQLite bank store for Sandbox/local development.
- Env-backed access-token encryption before tokens are written to disk.
- Owner-scoped linked Items and accounts.
- `/transactions/sync` cursor storage.
- Transaction upsert handling for `added`, `modified`, and `removed`.
- Recent cached bank transaction inspection.
- Durable SQLite reconciliation item storage.
- Rule-based cached transaction classification.
- Conservative action-log matching for `expense`, `income`, and utility/bill `payment` actions.
- Once-daily reconciliation digest loop, defaulting to 7:00 AM Pacific.
- Daily digest duplicate suppression through the BookieBot action log.
- Review inbox and manual resolution commands for unresolved bank transactions.
- Expense and income import commands that create normal sheet rows and action-log entries.
- Optional Postgres bank store selected by `BANK_DATABASE_URL`, with SQLite retained as local fallback.
- Hosted Plaid Link page with signed setup tokens.
- `/debug_bank_link` command that creates a private browser Link URL.
- Link-token creation and public-token exchange into encrypted bank storage.
- Admin-only debug commands:
  - `/debug_bank_status`
  - `/debug_bank_link`
  - `/debug_bank_items`
  - `/debug_bank_disconnect_item`
  - `/debug_bank_purge_item`
  - `/debug_bank_seed_sandbox`
  - `/debug_bank_sandbox_link`
  - `/debug_bank_sync`
  - `/debug_bank_transactions`
  - `/debug_bank_seed_action_log`
  - `/debug_bank_seed_unmatched`
  - `/debug_bank_reconcile`
  - `/debug_bank_review`
  - `/debug_bank_ignore`
  - `/debug_bank_log_expense`
  - `/debug_bank_log_income`

Not implemented yet:

- Production/Trial account linking.
- Non-debug/user-friendly reconciliation commands.
- Bill, subscription, and income reconciliation.
- Low-cost balance snapshots and estimated balance tracking.
- Balance-based cash-flow warnings.

## Product Goals

The bank integration should answer questions BookieBot currently cannot answer reliably:

- Did this expected bill or subscription actually pull?
- Did the pulled amount match the expected amount?
- Did expected income or paycheck deposits actually arrive?
- Did a received income transaction get missed in the budget sheet?
- Are there bank transactions that were never manually logged?
- Did we manually log something twice?
- What is the real checking or credit-card balance before upcoming pulls?
- What is the estimated current balance after posted and pending activity?
- Are there pending transactions that should not be treated as final yet?

The integration should enhance the existing Google Sheets workflow. It should not replace the sheet as the human-readable budget source of truth.

## Non-Negotiable Constraints

- Read-only access only.
- Never initiate payments or transfers.
- Never store bank usernames, passwords, or MFA secrets.
- Store Plaid access tokens securely, not in Google Sheets.
- Store only the minimum transaction metadata needed for matching, reconciliation, and audit.
- Require user confirmation before writing imported transactions into the budget sheet.
- Treat pending and posted transactions differently.
- Provide a clear disconnect/delete-data path.

## Plaid Products and APIs

### v1 Products

Use:

- `Transactions`: source of posted and pending bank transactions.
- `Balance`: current account balances for cash-flow risk checks.
- `Link`: user connection flow.

Plaid transaction amount convention:

- Positive amounts are money leaving the account.
- Negative amounts are money entering the account, such as paychecks or deposits.

Avoid for v1:

- Auth, Transfer, Signal, Identity, Assets, Investments, Liabilities, Income.

Reasoning:

- BookieBot does not need account/routing details or payment movement.
- BookieBot only needs balances and transactions for reconciliation.
- Paycheck/deposit reconciliation should use the `Transactions` product. The separate Plaid `Income` product is for income/payroll verification workflows and is unnecessary for v1.
- Minimizing requested products reduces privacy exposure and product complexity.

### Transaction Sync

Use `/transactions/sync`, not legacy `/transactions/get`.

Expected model:

- Store one cursor per Plaid Item.
- On first sync, pull historical transactions and store them in a local/import staging store.
- On later syncs, apply `added`, `modified`, and `removed` changes.
- Listen for `SYNC_UPDATES_AVAILABLE` webhooks and run sync when new data is available.
- Support manual refresh/debug commands for development and recovery.

### Balances

Use `/accounts/balance/get` sparingly:

- Once when an account is first linked.
- Once per watched account at the beginning of each month.
- On demand when the user explicitly asks for a fresh balance.
- Before a high-risk warning only when the estimated balance is stale or close to a threshold.

Do not poll balances aggressively. The low-cost target is to rely on the monthly account fee for `Transactions`, then use infrequent Balance calls as anchor snapshots.

Recommended first real setup:

- Link the primary checking account that funds bills/subscriptions.
- Link the primary credit card used for everyday spending.
- Skip savings unless transfers or autopays from savings matter for reconciliation.

Cost model at the current pay-as-you-go rates:

```text
Transactions:
2 connected accounts x $0.30/month = $0.60/month

Balance snapshots:
2 accounts x 1 monthly snapshot x $0.10 = $0.20/month

Baseline:
~$0.80/month before occasional manual refreshes
```

If the user manually asks for exact balances, each extra Balance call adds cost. Use a cached daily/monthly snapshot by default and label estimates clearly.

## Proposed Architecture

### New Modules

Recommended modules:

```text
bookiebot/banking/provider.py
bookiebot/banking/plaid_client.py
bookiebot/banking/store.py
bookiebot/banking/reconciliation.py
bookiebot/core/bank_sync.py
```

Responsibilities:

- `provider.py`: provider-neutral interfaces and dataclasses.
- `plaid_client.py`: Plaid-specific Link, token exchange, sync, balance, and webhook handling.
- `store.py`: secure token storage plus transaction/account cache.
- `reconciliation.py`: matching logic between bank transactions and BookieBot sheet/action-log records.
- `bank_sync.py`: scheduled sync jobs, Discord summaries, and operational glue.

### Storage

Do not store bank tokens in Google Sheets.

Recommended v1 storage:

- Local encrypted SQLite for local development and Sandbox testing.
- Railway Postgres for real Plaid Trial/Production data.
- Environment-backed encryption key.

Storage rule:

```text
Sandbox testing: SQLite is acceptable.
Real bank data: Postgres first.
```

Reasoning:

- Railway's app filesystem is ephemeral unless a volume is mounted.
- Ephemeral SQLite loses linked Items, encrypted access tokens, transactions, cursors, and reconciliation state on redeploy.
- A mounted SQLite volume can work, but Postgres is better for migrations, backups, operational visibility, and future multi-instance safety.
- Railway Postgres may add storage/database cost, but BookieBot's expected data volume is very small.

Configuration model:

```text
BANK_DATABASE_URL=postgres://...
BANK_SQLITE_PATH=data/banking.sqlite3
```

If `BANK_DATABASE_URL` is set, use Postgres. Otherwise, fall back to SQLite for local/Sandbox development.

Minimum tables:

```text
bank_items
bank_accounts
bank_transactions
bank_balance_snapshots
bank_sync_state
bank_reconciliation_matches
```

The current implementation has started with `bank_reconciliation_items`; the final schema should keep either `bank_reconciliation_items` or `bank_reconciliation_matches` as the canonical name, not both.

`bank_items`:

```text
id | owner_key | provider | item_id | encrypted_access_token | institution_name | status | created_at | updated_at | disconnected_at
```

`bank_accounts`:

```text
id | item_id | provider_account_id | owner_key | name | mask | type | subtype | official_name | current_balance | available_balance | updated_at
```

`bank_transactions`:

```text
id | provider_transaction_id | account_id | owner_key | date | authorized_date | name | merchant_name | amount | pending | category | payment_channel | raw_json_hash | created_at | updated_at | removed_at
```

`bank_balance_snapshots`:

```text
id | account_id | owner_key | snapshot_date | current_balance | available_balance | source | created_at
```

`bank_sync_state`:

```text
item_id | transactions_cursor | last_sync_at | last_success_at | last_error | webhook_pending
```

`bank_reconciliation_matches`:

```text
id | bank_transaction_id | action_log_id | match_type | confidence | status | created_at | confirmed_at | ignored_at
```

## Security Model

### Secrets

Environment variables:

```text
PLAID_CLIENT_ID
PLAID_SECRET
PLAID_ENV=sandbox|production
PLAID_WEBHOOK_SECRET
BANK_TOKEN_ENCRYPTION_KEY
BANK_DATABASE_URL
BANK_SQLITE_PATH
PUBLIC_BASE_URL
```

Rules:

- Never log Plaid access tokens.
- Never put Plaid access tokens into Discord messages.
- Never write tokens to Google Sheets.
- Redact tokens and account ids in logs.
- Log institution/account names only when helpful for debugging.

### Access Control

- Only configured budget owners can link accounts.
- An account connection belongs to one `owner_key`.
- Brian and Hannah account data must remain scoped to their own budget owner unless explicitly shared later.
- Admin/debug commands should not dump raw transaction data by default.

## User Flows

### Link Account

Possible command:

```text
/bank_link
```

Flow:

1. BookieBot creates a signed setup URL for the requesting owner. Implemented as `/debug_bank_link`.
2. User opens BookieBot's hosted Link page. Implemented.
3. Browser asks BookieBot for a Plaid Link token. Implemented.
4. User connects one institution through Plaid Link. Implemented.
5. Client receives `public_token`. Implemented.
6. Backend exchanges `public_token` for an access token. Implemented.
7. Access token is encrypted and stored. Implemented.
8. BookieBot fetches accounts and starts an initial transaction sync. Account fetch is implemented; explicit `/debug_bank_sync` runs transaction sync after linking.
9. BookieBot confirms the linked institution and account names. Implemented in the web response and debug status.

### Sync Accounts

Possible commands:

```text
/bank_sync
/bank_status
```

Flow:

- Sync transactions for linked Items.
- Update balances when explicitly requested.
- Report counts of added, modified, removed, and pending transactions.
- Report connection errors such as login required.

### Balance Snapshot and Estimate

Possible commands:

```text
/bank_balance
/bank_balance_refresh
```

Flow:

- Show estimated balances from the latest real snapshot plus synced transactions.
- Include pending impact separately.
- Show the date of the last real Balance snapshot.
- Only call Plaid Balance when the command explicitly asks for a refresh or when monthly snapshot automation runs.

### Review Imported Transactions

BookieBot should not automatically write every bank transaction into the budget sheet.

Suggested flow:

```text
BookieBot found 3 unlogged posted transactions.

1. $18.50 - Blue Bottle - May 15 - likely Food
2. $58.15 - Target - May 15 - likely Shopping
3. $1,639.90 - Sonic - May 15 - likely Income

Reply `import all`, `ignore 2`, `1 food`, or `3 income Sonic`.
```

Rules:

- Start with review-only.
- Require confirmation before writing.
- Prefer posted transactions over pending transactions.
- Use merchant memory later for better categorization.

### Reconciliation Notification Cadence

BookieBot should sync transaction data regularly, but it should not send a reconciliation digest every day unless there is something actionable.

Daily lightweight behavior:

- Sync transactions for linked accounts.
- Update estimated balances.
- Re-run matching logic against recent action-log and sheet entries.
- Stay quiet when nothing needs user attention.

User-facing reconciliation should trigger when:

- A new posted purchase has no matching BookieBot expense.
- A new posted deposit has no matching BookieBot income log.
- An expected bill/subscription posts with a different amount.
- An expected bill/subscription remains missing after the grace window.
- Pending activity creates a clear cash-flow risk against upcoming pulls.

If everything reconciles cleanly, BookieBot may send a concise success summary when useful, but it should not spam the user every day just to say nothing changed.

## Reconciliation Design

### In Progress: Once-Daily Cached Reconciliation

Status: in progress.

BookieBot should treat reconciliation as a durable workflow, not as a one-off transaction list.

Current implementation:

- `/debug_bank_reconcile` reads cached Plaid transactions and active BookieBot action-log rows.
- It attempts read-only matches against real logged `expense`, `income`, and utility/bill `payment` actions.
- Matching is conservative: amount must match within one cent and dates must be within a small window.
- Successful action-log matches are stored on `bank_reconciliation_items` with the matched action-log id and sheet row reference.
- The Discord preview separates matched items from items that still need review.
- `/debug_bank_review` lists unresolved reconciliation items with stable ids.
- `/debug_bank_ignore` resolves an item without writing to the sheet.
- `/debug_bank_log_expense` imports an unresolved posted outflow into the existing expense sheet flow.
- `/debug_bank_log_income` imports an unresolved posted inflow into the existing income sheet flow.
- A scheduled bank reconciliation loop runs after the configured send hour and sends one digest per user/date only when unresolved items need review.

Core operating model:

- Run reconciliation once per user per day.
- Sync Plaid transactions once during that job.
- Reconcile from locally cached transactions and BookieBot sheet/action-log data.
- Cache reconciliation results locally.
- Do not make more Plaid calls while the user is answering review questions.
- Keep asking about unresolved items on future runs until they are resolved, ignored, imported, or otherwise classified.

Recommended timing:

```text
7:00 AM Pacific: bank sync + reconciliation scan
10:00 AM Pacific: existing cash-pull reminder digest
```

The daily reconciliation job should:

1. Sync new/changed Plaid transactions for linked Items. Implemented for configured Plaid Items.
2. Look at new/changed posted transactions since the last reconciliation run. Implemented through unreconciled cached transaction selection.
3. Compare them against BookieBot action-log entries and current sheet rows. Action-log comparison is implemented; direct sheet-row fallback remains future work.
4. Classify each transaction using simple BookieBot-shaped buckets. Implemented with conservative rules.
5. Store a reconciliation item for each relevant bank transaction. Implemented.
6. Send one Discord digest only when there is something useful to report. Implemented for unresolved review items.

Simple classification buckets:

```text
expense
income
subscription_or_bill
transfer_or_payment
refund_or_credit
ignore
needs_review
```

User-facing labels:

```text
Expense
Income
Subscription/Bill
Transfer/Payment
Refund/Credit
Ignored
Needs review
```

Initial conservative rules:

- Positive amount with merchant-like text -> `expense`.
- Negative amount with payroll-like text -> `income`.
- Negative amount from a merchant-like source -> `refund_or_credit`.
- Card payments, ACH transfers, CDs, savings transfers, and account movement -> `transfer_or_payment`.
- Matches known subscription/bill schedule by merchant/date/amount -> `subscription_or_bill`.
- Anything ambiguous -> `needs_review`.

Durable reconciliation state should be stored locally.

Suggested table:

```text
bank_reconciliation_items
id | owner_key | bank_transaction_id | classification | status | matched_action_log_id | matched_sheet_ref | confidence | first_seen_at | last_seen_at | resolved_at | ignored_at | notes
```

Statuses:

```text
matched
needs_review
pending_user
confirmed
import_requested
ignored
conflict
```

Daily digest examples:

```text
@Deebers bank reconciliation is clear.

Matched:
`Starbucks - $4.33 - May 11 - Expense`
`McDonald's - $12.00 - May 11 - Expense`
`Sonic - $1,639.90 - May 15 - Income`
```

```text
@Deebers bank reconciliation found 2 items that need review.

Matched:
`Starbucks - $4.33 - May 11 - Expense`

Needs review:
`United Airlines - $500.00 inflow - May 12`
Is this a refund/credit, income, or should I ignore it?

Unlogged:
`Uber - $5.40 - May 14`
Should I create a new Expense?
```

Product rules:

- Do not auto-create sheet rows from bank data in the first version.
- Ask before creating a missing expense or income entry.
- Treat subscription/bill matches as confirmation unless amount/date differs enough to need review.
- Treat transfers/payments as non-budget events unless a future workflow needs them.
- Treat refunds/credits separately from paycheck income.
- Prefer quiet success when nothing needs attention.

### Low-Cost Balance Estimation

BookieBot should avoid daily Balance calls. Instead, it should use real Balance calls as sparse anchor snapshots and then estimate current balances from synced transactions.

For each watched account, store:

```text
last_real_balance_snapshot
snapshot_date
posted_transaction_delta_since_snapshot
pending_transaction_delta_since_snapshot
estimated_posted_balance
estimated_available_balance
```

Plaid transaction amount convention:

- Positive amount means money leaving the account.
- Negative amount means money entering the account.

Balance math:

```text
estimated_posted_balance =
  snapshot_balance - sum(posted plaid transaction amounts after snapshot_date)

estimated_available_balance =
  estimated_posted_balance - sum(pending plaid transaction amounts after snapshot_date)
```

Checking and credit-card accounts should be presented separately:

- Checking balance means cash available.
- Credit-card balance usually means amount owed or utilization context.
- Do not combine them into one net number unless the user explicitly asks for net worth-style reporting later.

User-facing wording should distinguish estimates from real balance checks:

```text
Checking estimated balance: $1,240.15
Pending impact: -$86.42
Conservative available estimate: $1,153.73
Last real balance check: May 1
```

Refresh rules:

- Take a real Balance snapshot when an account is linked.
- Take one real Balance snapshot per watched account at the beginning of each month.
- Allow a manual fresh-balance command for intentional checks.
- Force a fresh Balance call only before serious cash-flow warnings when the estimate is stale or close to the risk threshold.
- If transaction sync has errors, connection issues, or a large removed/modified transaction set, mark the estimated balance as potentially stale.

### Matching Manual Logs to Bank Transactions

BookieBot should match bank transactions against existing action-log entries and sheet rows.

Signals:

- Amount.
- Date or authorized date.
- Merchant/location text.
- Person/account owner.
- Category.
- Pending-to-posted relationship.

Match statuses:

```text
matched
needs_review
ignored
confirmed
conflict
```

Confidence examples:

- High: same amount, same date, merchant text match.
- Medium: same amount within 1-2 days, merchant/category partial match.
- Low: same amount only.

### Bill and Subscription Reconciliation

Use the existing schedules:

- `_BookieBot Subscription Schedule`
- `_BookieBot Bill Schedule`

Future digest additions:

```text
Matched:
`PG&E - $132.36 - posted May 22`

Needs review:
`Water expected $117.36 on May 18, no matching posted transaction yet`
```

Rules:

- Do not warn on same-day expected pulls too early.
- Prefer posted transactions over pending transactions.
- Handle weekend/holiday posting delays with a grace window.
- Track confirmed matches so alerts do not repeat.

### Income Reconciliation

Use Plaid transaction inflows to reconcile against BookieBot's existing income sheet and income action-log entries.

Useful behavior:

```text
Matched income:
`Sonic - $1,639.90 - posted May 15`

Needs review:
`Insurity deposit $1,341.43 posted May 15, but no matching income log was found`
```

Rules:

- Treat income as posted only after the bank transaction is no longer pending.
- Match against existing `log_income` action-log entries and income sheet rows.
- Use amount, posted date, source/payor text, and owner/account as matching signals.
- Do not automatically write new income rows without user confirmation.
- Keep separate matching logic for inflows and outflows so refunds do not get mistaken for paychecks.

## Implementation Phases

### Phase 1: Plaid Sandbox Spike

Goal: prove the integration without touching real bank data.

Build:

- Add Plaid SDK/client dependency.
- Add Plaid environment config.
- Implement Sandbox public-token creation or Link token flow. Implemented.
- Exchange public token for access token. Implemented.
- Fetch accounts. Implemented.
- Run `/transactions/sync`. Implemented.
- Store fake accounts and transactions. Implemented.
- Add a developer-only debug command to show sync counts.

Exit criteria:

- Sandbox account can be linked.
- Transactions can be synced repeatedly with cursor state.
- Added/modified/removed transaction handling is covered by tests.

### Phase 2: Secure Storage and Owner Scoping

Goal: make the integration safe enough for real data.

Build:

- Add Postgres-backed bank storage via `BANK_DATABASE_URL`. Implemented.
- Keep SQLite fallback for local/Sandbox development. Implemented.
- Add schema initialization/migration path for Postgres. Initial schema creation is implemented.
- Add encrypted token storage in Postgres. Implemented.
- Add owner-scoped bank Item/account tables. Implemented.
- Add disconnect/delete-data flow.
- Redact secrets in logs.
- Add tests for owner isolation. Implemented for SQLite; Postgres integration coverage is still needed.

Exit criteria:

- Real Plaid Trial/Production access tokens are stored in Postgres, not ephemeral SQLite.
- Access tokens are encrypted at rest before database write.
- Tokens are never written to sheets or Discord.
- Each owner only sees their own accounts.
- Railway redeploys do not lose linked Items, sync cursors, cached transactions, or reconciliation state.

### Phase 3: Transaction and Income Review Inbox

Status: in progress.

Goal: let BookieBot identify unlogged expenses and income without auto-writing them.

Build:

- Add durable reconciliation item storage. Implemented for SQLite.
- Add simple rule-based transaction classification. Implemented.
- Add once-daily reconciliation scan. Implemented for cached transactions and configured Plaid Items.
- Add `/debug_bank_reconcile` preview command before proactive notifications. Implemented.
- Import inbox for unmatched posted outflows and inflows. Implemented through `/debug_bank_review`.
- Matching against action log/manual sheet rows. Initial action-log matching is implemented for `expense`, `income`, and `payment` actions; direct sheet matching remains future work.
- Discord review command. Implemented.
- Confirm/ignore/import actions. Implemented for ignore, expense import, and income import.
- Add non-debug aliases once the workflow is stable.
- Add clearer resolution prompts/buttons after Discord UI shape is settled.

Exit criteria:

- Reconciliation results are cached and do not require repeated Plaid calls.
- Resolved/ignored items are not repeatedly surfaced.
- Unresolved items continue to be shown until handled.
- BookieBot can show likely unlogged transactions.
- User can import selected expenses into existing expense categories. Implemented.
- User can import selected income into the existing income sheet flow. Implemented.
- Imported transactions create normal action-log entries. Implemented.

### Phase 4: Bill, Subscription, and Income Reconciliation

Goal: close the loop on expected pulls and expected deposits.

Build:

- Match scheduled bills/subscriptions to posted bank transactions.
- Match manually logged income against posted deposit transactions.
- Detect amount differences.
- Detect missing posted pulls after a grace window.
- Detect unlogged income deposits after they post.
- Add reconciliation notes to the daily cash-pull digest or a separate follow-up digest.

Exit criteria:

- Expected pulls can be marked posted, missing, or mismatched.
- Income deposits can be marked matched, missing from the sheet, or needs review.
- Alerts are deduped.
- User can confirm or ignore a mismatch.

### Phase 5: Low-Cost Balances and Cash-Flow Risk

Goal: make upcoming pull reminders more useful.

Build:

- Let the user mark which linked accounts are watched for balance estimation.
- Take initial and monthly real Balance snapshots for watched accounts.
- Estimate current balances from posted transactions since the latest snapshot.
- Track pending transaction impact separately for conservative available estimates.
- Compare known upcoming pulls against estimated checking balance.
- Warn only when risk is clear and actionable.
- Avoid daily Balance calls by default.

Exit criteria:

- BookieBot can answer estimated balance questions.
- BookieBot clearly shows the last real balance-check date.
- BookieBot can refresh exact balances on explicit command.
- BookieBot can warn when upcoming pulls appear larger than estimated available cash.
- Normal monthly Balance usage for checking plus credit card remains around two Balance calls/month.

### Phase 6: Production Trial Rollout

Goal: safely test with real data.

Build:

- Confirm Postgres storage is enabled and persistent.
- Move from Sandbox to Plaid Trial/Production config.
- Link one real institution first.
- Validate transaction date, merchant, amount, pending, and posting behavior.
- Monitor rate limits and sync reliability.

Exit criteria:

- `BANK_DATABASE_URL` is configured in Railway.
- One real Item syncs reliably.
- No secrets leak into logs, sheets, or Discord.
- Disconnect/delete-data has been tested.
- The 10-Item Trial cap still covers the household accounts being tested.

## Testing Plan

Unit tests:

- Token encryption/decryption.
- Owner scoping.
- Storage backend selection: Postgres when `BANK_DATABASE_URL` is set, SQLite otherwise.
- Transaction sync cursor application.
- Added/modified/removed transaction changes.
- Pending vs posted handling.
- Rule-based transaction classification.
- Reconciliation item status transitions.
- Once-daily reconciliation duplicate suppression.
- Cached reconciliation result reuse without Plaid calls.
- Balance snapshot estimation math.
- Checking vs credit-card balance presentation.
- Monthly Balance snapshot scheduling.
- Matching confidence.
- Duplicate detection.
- Bill/subscription reconciliation windows.
- Income/deposit reconciliation.

Integration tests:

- Postgres schema initialization.
- Plaid Sandbox link/token exchange.
- `/transactions/sync` cursor flow.
- Webhook handling for `SYNC_UPDATES_AVAILABLE`.
- `/accounts/balance/get` response parsing.
- Balance snapshot persistence.
- Reconciliation scan against cached bank transactions and action-log fixtures.

Manual tests:

- Confirm Railway Postgres persists bank status after redeploy.
- Link Sandbox institution.
- Inspect cached transactions with `/debug_bank_transactions`.
- Preview reconciliation with `/debug_bank_reconcile`.
- Confirm successful matches appear in the reconciliation summary.
- Confirm real action-log matches appear under matched sections such as `Matched Expense`.
- Confirm transfer/payment rows are not suggested as expenses.
- Confirm unmatched spending can become a proposed Expense.
- Confirm unmatched deposits can become proposed Income or Refund/Credit.
- Mark checking and credit-card accounts as watched.
- Take an initial Balance snapshot.
- Verify estimated balances change after synced posted transactions.
- Verify pending transactions affect conservative available estimates without being treated as posted.
- Simulate transactions webhook.
- Simulate login required/update mode.
- Disconnect Item.
- Confirm no token appears in logs or sheets.

## Open Product Questions

- What exact Railway Postgres cost/usage should we expect on the current plan?
- Should we keep SQLite fallback indefinitely for local development, or move local development to Docker/Postgres later?
- Which migration tool should we use for Postgres schema changes, if any?
- Should pending transactions appear in user-facing review lists, or only in balance/risk context?
- Should a fully successful reconciliation send a digest every day, or only when new matched items exist?
- How long should unresolved reconciliation items be repeated before escalation or quieter reminders?
- What exact user replies should resolve a pending item: `create expense`, `ignore`, `transfer`, `refund`, `income`, or slash-command buttons later?
- What grace window should bill/subscription reconciliation use after an expected pull date?
- Should BookieBot import transactions directly into the monthly sheet or keep a separate staging tab first?
- Should estimated balances be included in daily cash-pull digests or only shown when risk exists?
- Which accounts should be watched for cash-flow risk?
- How stale can a balance snapshot be before BookieBot forces or recommends a fresh Balance call?

## External References

- Plaid free/Sandbox/Trial overview: https://support.plaid.com/hc/en-us/articles/16194695660311-Can-I-use-Plaid-for-free
- Plaid pricing models: https://support.plaid.com/hc/en-us/articles/16194632655895-How-much-does-Plaid-cost-and-what-are-the-pricing-models
- Plaid Sandbox docs: https://plaid.com/docs/sandbox/
- Plaid token glossary: https://plaid.com/docs/quickstart/glossary/
- Plaid Transactions docs: https://plaid.com/docs/transactions/
- Plaid Balance docs: https://plaid.com/docs/balance/
