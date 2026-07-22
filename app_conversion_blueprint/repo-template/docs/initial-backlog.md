# Initial Backlog

## Milestone 1: Local Ledger

- Create iOS project.
- Choose persistence stack.
- Define local schema for household, member, account, category, budget period, ledger transaction, and action event.
- Implement migrations.
- Add manual expense logging.
- Add manual income logging.
- Add transaction list.
- Add monthly totals.
- Add undo.

## Milestone 2: Assistant Runtime

- Define assistant model provider protocol.
- Add Qwen 4B-class downloaded local model provider spike.
- Add Apple Foundation Models fallback/lightweight provider where available.
- Add onboarding copy and settings controls for installing/removing the local AI pack.
- Define tool registry.
- Implement plan validator.
- Add `logExpense`, `logIncome`, `searchTransactions`, and `proposeSettingsPatch`.
- Add confirmation UI.
- Port BookieBot intent cassettes into eval fixtures.

## Milestone 3: Plaid Baseline

- Create Plaid bridge.
- Add Link token endpoint.
- Add iOS LinkKit.
- Exchange public token.
- Store access token encrypted.
- Run Sandbox transaction sync.
- Store bank transactions locally.

## Milestone 4: Reconciliation

- Port transaction classifier.
- Create reconciliation item lifecycle.
- Add inbox.
- Confirm match.
- Import after confirmation.
- Ignore.
- Reopen linked items after ledger mutations.

## Milestone 5: Export

- Add Google OAuth.
- Create spreadsheet binding.
- Preview export.
- Export ledger and audit events.
- Make repeated exports idempotent.
