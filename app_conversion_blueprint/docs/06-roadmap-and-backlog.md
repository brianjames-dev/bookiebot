# Roadmap And Backlog

## Phase 0: New Repo Bootstrap

Goal: create an empty but well-shaped project.

Deliverables:

- Xcode project under `ios/`.
- Plaid bridge project under `server/plaid-bridge/`.
- Shared JSON schemas under `shared/contracts/`.
- ADR folder.
- CI that builds iOS tests and bridge tests.

Exit criteria:

- App launches to an empty shell.
- Bridge health endpoint works locally.
- Tests run in CI.

## Phase 1: Local Ledger MVP

Goal: a useful finance app without Plaid.

Deliverables:

- Local database schema and migrations.
- Household, member, account, category, budget period setup.
- Manual expense and income logging.
- Transaction list.
- Monthly dashboard totals.
- Action event log and undo.
- Settings UI.

Tests:

- Create/update/delete/undo ledger transactions.
- Budget totals by period/category.
- Settings persistence.
- Migration smoke tests.

## Phase 2: Assistant Runtime MVP

Goal: replace command parsing with an assistant tool framework.

Deliverables:

- Assistant conversation store.
- Local model provider protocol.
- Downloadable Qwen 4B-class local model provider spike.
- Apple Foundation Models fallback provider where available.
- Local AI model onboarding flow that explains download size, privacy, and why the model is not prebundled.
- Tool registry and policy validator.
- Manual logging tools.
- Clarifying question flow.
- Confirmation cards.
- Eval harness seeded from BookieBot cassettes.

Tests:

- Plan validation rejects unsafe mutations.
- Ambiguous expense asks a question.
- Clear expense logs through the tool.
- Settings changes create proposals.
- Full local assistant mode can be enabled only after the model pack is installed.
- Lightweight/fallback mode still supports simple logging and search.

## Phase 3: Plaid Baseline

Goal: link accounts and sync transactions into the app.

Deliverables:

- Plaid bridge link-token endpoint.
- Plaid LinkKit iOS flow.
- Public-token exchange.
- Encrypted access token storage in bridge.
- `/transactions/sync` cursor handling.
- Local bank transaction cache.
- Account watch controls.
- Disconnect/delete-data flow.

Tests:

- Sandbox Link flow.
- Sync handles added/modified/removed transactions.
- Pending transactions do not enter normal review.
- Watched account filter works.

## Phase 4: Reconciliation Inbox

Goal: preserve BookieBot's review-first bank workflow.

Deliverables:

- Classification and matching engine.
- Reconciliation item lifecycle.
- Inbox UI.
- Confirm existing ledger match.
- Import as new expense/income after confirmation.
- Ignore transaction.
- Reopen linked reconciliation item after ledger mutation.
- Stale/historical review policy.

Tests:

- Exact amount/date match auto-suggests.
- Amount mismatch is surfaced.
- Imported transaction creates ledger row and audit event.
- Old unresolved item is hidden from normal inbox.
- Ledger update reopens linked reconciliation item.

## Phase 5: Recurring Bills, Subscriptions, And Cash Pulls

Goal: support expected upcoming money movement.

Deliverables:

- Recurring schedule editor.
- Pull-date calculations.
- Local notifications.
- Subscription and bill matching.
- Missing expected pull warnings.
- Amount changed warnings.

Tests:

- Monthly/yearly/quarterly pull dates.
- Grace window behavior.
- Matched schedule does not repeat alert.

## Phase 6: Google Sheets Export

Goal: make data portable and transparent.

Deliverables:

- Google OAuth.
- Spreadsheet creation/binding.
- Export preview.
- Monthly ledger export.
- Audit export.
- Dashboard snapshot export.
- Idempotent repeated exports using stable IDs.

Tests:

- Export preview matches local data.
- Re-running export updates rows without duplicates.
- OAuth disconnect clears tokens.

## Phase 7: Proactive Assistant

Goal: make the assistant useful without spam.

Deliverables:

- Daily/weekly briefing.
- Budget anomaly detection.
- Merchant rule suggestions.
- Subscription price change detection.
- Month-end closeout.

Tests:

- No notification when no actionable item exists.
- Anomaly thresholds are configurable.
- Suggested merchant rule requires confirmation.

## Backlog By Theme

Assistant:

- Tool call streaming.
- Assistant memory inspector.
- Natural-language settings search.
- On-device eval runner.
- Model pack update, delete, and re-download controls.
- Device capability scoring for Qwen/Gemma/Phi-class local models.

Finance:

- Refund handling.
- Split transactions.
- Household member sharing.
- Cash transactions.
- Savings goals.

Banking:

- Balance snapshots.
- Estimated balance from transaction deltas.
- Plaid update-mode flow.
- Webhook retry and dead-letter handling.

Export:

- CSV export.
- Sheets import preview.
- Backup/restore.

Polish:

- Widgets.
- App Intents.
- Voice input.
- Receipt/screenshot intake.
