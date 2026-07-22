# Porting Map From Current BookieBot

This map identifies what should be ported, rewritten, or retired when creating the iOS app.

## Current Assets Worth Preserving

### Intent Examples And Test Cassettes

Current files:

- `src/bookiebot/intents/explorer.py`
- `src/bookiebot/intents/parser.py`
- `unit_tests/cassettes/`
- `unit_tests/intents/`

Use them as:

- Assistant evaluation fixtures.
- Tool catalog seed data.
- Examples of real user phrasing.

Do not port the raw prompt as-is. It is command-router oriented and tied to JSON intent names.

### Reconciliation Logic

Current files:

- `src/bookiebot/banking/reconciliation.py`
- `src/bookiebot/banking/models.py`
- `unit_tests/banking/test_reconciliation.py`

Port concepts:

- Transaction classification buckets.
- Conservative action-log matching.
- Scheduled pull matching.
- Candidate/grouped match flows.
- Confidence scoring.

Rewrite in Swift as domain services over the new database model.

### Plaid Integration Concepts

Current files:

- `src/bookiebot/banking/plaid_client.py`
- `src/bookiebot/banking/service.py`
- `src/bookiebot/banking/store.py`
- `src/bookiebot/banking/postgres_store.py`
- `unit_tests/banking/test_plaid_client.py`
- `unit_tests/banking/test_store.py`

Port concepts:

- `/transactions/sync` cursor flow.
- Added/modified/removed transaction handling.
- Watched account selection.
- Token encryption requirement.
- Sandbox seeding/debug ergonomics.

Do not port the storage layer directly into iOS. The app needs a local database; the bridge needs a small server store.

### Action Log And Undo

Current files:

- `src/bookiebot/sheets/undo.py`
- `unit_tests/intents/test_handlers.py`
- `unit_tests/core/test_message_router.py`

Port concepts:

- Logged action IDs.
- Active/undone lifecycle.
- Undo for update/delete/move.
- Operation capabilities.
- Expiring pending interactions.
- Reopening reconciliation links after mutations.

Rewrite as typed audit/action events, not JSON in a Google Sheet.

### Subscription And Bill Schedules

Current files:

- `src/bookiebot/sheets/subscriptions.py`
- `src/bookiebot/sheets/bills.py`
- `src/bookiebot/core/subscription_reminders.py`
- `unit_tests/sheets/test_subscription_reminders.py`
- `unit_tests/sheets/test_bills.py`

Port concepts:

- Cadence parsing.
- Pull-date calculation.
- Reminder offsets.
- Warning on malformed schedules.
- Bill/subscription reconciliation candidate generation.

Rewrite schedules as database rows with app-native editing.

### Reports And Dashboard Calculations

Current files:

- `src/bookiebot/reports/expense_breakdown.py`
- `web/expense-report/`
- `unit_tests/reports/test_expense_breakdown.py`

Port concepts:

- Monthly spending totals.
- Burn rate.
- Category mix.
- Subscription hit-so-far versus projected totals.
- Largest/frequent merchant highlights.
- Daily spending calendar.

Do not port the generated HTML report as the primary app UI. Use SwiftUI charts and local queries.

## Current Assets To Retire Or Isolate

### Discord UI

Current files:

- `src/bookiebot/core/discord_client.py`
- `src/bookiebot/ui/`
- Discord-specific handlers in `src/bookiebot/core/`

Retire for iOS. Keep only behavior examples.

### Google Sheets Row Mutation

Current files:

- `src/bookiebot/sheets/writer.py`
- `src/bookiebot/sheets/repo.py`
- `src/bookiebot/sheets/routing.py`

Do not preserve row-based mutation as internal state. Translate this into database repository operations and a separate Sheets export adapter.

### OpenAI Client

Current files:

- `src/bookiebot/llm/client.py`

Retire as default. Keep fixture/cassette testing ideas.

## Suggested Migration Sequence

1. Define shared domain contracts in the new repo.
2. Port existing intent cassettes into assistant eval fixtures.
3. Implement local ledger models and action events.
4. Implement manual logging tools and tests.
5. Port reconciliation classifier/matcher into Swift.
6. Add Plaid bridge and sync.
7. Implement reconciliation inbox and confirmations.
8. Add recurring schedule models and reminder logic.
9. Add dashboard calculations.
10. Add Google Sheets export.

## Compatibility Notes

The future app does not need to preserve the exact current Google Sheet layout internally. It should preserve user-visible meaning:

- Expense categories.
- Income rows.
- Need/want distinction.
- Subscriptions and bills.
- Recent action lineage.
- Reconciliation decisions.
- Manual confirmation before import.
