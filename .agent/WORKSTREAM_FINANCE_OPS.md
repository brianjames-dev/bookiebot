# Finance Operations Workstream

Last updated: 2026-07-16

## Goal

Make BookieBot's finance operations reliable, auditable, and easy to reason about. This includes bank reconciliation, transaction inbox behavior, event logging, and the recent transactions flow for update, move, delete, and undo.

## Priority Source

Current task priority lives in `.agent/STATUS.md`. This file is the centralized backlog and reference for the full finance operations workstream.

Task execution and documentation update rules live in `.Agents`.

## Recent Transactions - Likely Problems To Fix

1. Updated expenses may no longer be movable because `move_recent_action` currently only allows metadata type `expense`, while an updated visible action has type `update`.
2. Moved expenses may not be movable again because the latest visible action has type `move`, not `expense`.
3. Deleting an updated action is risky because delete accepts `update` actions and compacts the current row, but the original source action may remain active or stale.
4. Deleting a moved action can leave source/destination lineage difficult to reason about unless the canonical sheet row is resolved first.
5. The UI does not expose date updates, and user-entered date updates are now rejected. Fixed 2026-06-20; reconciliation-origin automation may still set dates from bank transaction dates.
6. Pending selections live only in process memory, so deploys, restarts, or long pauses lose context.
7. Component views time out after 120 seconds while pending text state may still exist. Fixed 2026-06-18.
8. Income, Need expenses, payments, and savings appear in recent actions but have inconsistent edit/move/delete capabilities. Fixed for new shared-sheet Need expenses as of 2026-07-16; historical personal-budget Need action records remain legacy-only.
9. Match-text search only checks the latest 10 recent actions, so targeted commands can miss older actions.
10. Reconciled actions can be updated, moved, deleted, or undone without updating/reopening reconciliation state. Fixed first pass 2026-06-20 by reopening linked reconciliation items.

## Recent Transactions - What Currently Works

- Listing recent actions and paging with `show more`.
- Selecting actions by index, match text, or action ID.
- Updating configured fields for normal expense rows.
- Deleting normal expense rows with category compaction.
- Moving normal expense rows between configured categories.
- Undoing update, delete, and move in covered happy paths.
- Updating payments and savings amount-only through existing field capability logic.

## Recent Transactions - Target Invariants

- Every user-visible recent action should expose explicit capabilities: `can_update`, `can_move`, `can_delete`, `can_undo`, and `editable_fields`.
- Update/move/delete should operate on a canonical action lineage, not only the latest raw action type.
- A lineage should have one current sheet location when it represents a sheet row.
- Deleting should resolve the canonical current row before compacting.
- Moving should work for an expense lineage even after prior updates or moves.
- Updating should work for an expense lineage even after prior moves.
- Unsupported operations should return a clear reason.
- Pending selections should expire predictably and should not survive as misleading stale state.
- Reconciled action mutation should update or reopen the related reconciliation item.

## Recent Transactions - Implementation Slices

### Slice A - Capabilities And Canonical Lineage

- Add helper functions to resolve a `LoggedAction` to canonical lineage state.
- Add operation capability helpers for update, move, delete, and undo.
- Update recent-action UI to show only valid controls or return clear reasons.
- Add tests for capabilities across expense, update, move, income, Need expense, payment, and savings actions.

Status: Partially complete. Active lineage IDs are now used for delete/undo, and move uses full current category rows instead of only the latest action's changed columns. Explicit user-facing capability helpers still need to be added.

Update 2026-06-18: Explicit capability helpers now exist for update, move, delete, undo, and editable fields. The recent-action decision UI only shows supported controls for the selected transaction, and unsupported direct commands return clearer reasons. Canonical lineage helpers still need to be expanded beyond the targeted move/delete fixes already completed.

### Slice B - Move Updated And Moved Expenses

- Allow moving an expense lineage whose latest visible action is `update` or `move`.
- Resolve source category, current row, current values, and current category from lineage state.
- Add tests for moving an updated expense and moving an already moved expense.

Status: Complete for normal expense lineages as of 2026-06-18.

### Slice C - Safe Delete For Updated And Moved Expenses

- Make delete resolve canonical current row before compaction.
- Ensure original/source actions do not remain active in a misleading way after deleting an updated/moved lineage.
- Add tests for deleting updated expense and deleting moved expense.

Status: Complete for active recent-action lineages as of 2026-06-18.

## Recent Transactions - Completed Work Log

### 2026-06-18

- `move_recent_action` now accepts current expense lineages represented by `expense`, `update`, or `move` action records.
- Moving uses the full current sheet row for the source category, which fixes updated actions whose `action.columns` only contain the edited fields.
- Delete compaction now marks every active action in the selected lineage as undone, preventing deleted updated expenses from reappearing through their original action.
- Delete undo now reactivates all action IDs recorded for that deleted lineage.
- Added regression tests for moving updated expenses, moving already moved expenses, deleting updated expenses, and deleting moved expenses.
- Added explicit recent-action capabilities and wired the selected-transaction controls to hide unsupported operations.
- Added clearer unsupported-operation reasons for Need expenses, payments, savings, and other unsupported cases.
- Income rows can now be updated for source/amount and deleted from recent transactions.
- Added regression tests for expense capabilities, unsupported action capabilities, button visibility, income update, and income deletion.
- Added TTL-backed pending state for recent-action selections, update-field prompts, and move-item prompts.
- Expired pending replies now clear state and return a clear expired-selection message instead of falling through to intent routing or current recent-action indexes.
- Added regression tests for expired delete selections, update-field prompts, move-item prompts, and router numeric replies.
- Recent-action lists, candidate prompts, mutation prompts, and mutation results now send privately to the requesting user when Discord DMs are available.
- Recent-action component responses are ephemeral, and controls reject users other than the original actor.
- Added regression tests for private recent-action delivery and non-owner interaction rejection.
- DM replies to recent-action update prompts now route through pending update-field handling even when the bot is restricted to the configured public channel.
- Recent-action component view timeouts now match the 300-second pending-state TTL.
- Added regression tests for DM update-field replies and five-minute component view timeouts.
- Reconciliation digest channel messages now show a generic unresolved-item count instead of transaction details; detailed review remains ephemeral after `Reconcile Now`.
- Daily reconciliation digest eligibility is now bounded to the configured morning send window, preventing newly synced Plaid items from causing a normal daily digest later in the day.
- Added regression tests for the public digest prompt, morning send window, and after-window Plaid/new-item no-send behavior.
- Reconciliation digests now send by DM with `Reconcile Now` and `View Inbox` controls.
- `Ignore All` moved from individual reconciliation transaction cards to the inbox list view only.
- Bills and subscriptions digests now send by DM instead of posting cash-pull details in the shared channel.

Manual verification steps are tracked in `.agent/STATUS.md`.

### 2026-06-20

- User-entered date updates are hidden/rejected in recent-action update handling; date mutation is reserved for reconciliation-origin automation that can use the bank transaction's reported date.
- Recent-action update, move, delete, and undo now attempt to reopen linked reconciliation items by action-log ID.
- Store-level reconciliation reopening can find grouped matched action IDs such as `action-a+action-b`.
- Normal unresolved reconciliation views now apply a default 60-day transaction age cutoff through `BOOKIEBOT_RECONCILIATION_MAX_AGE_DAYS`.
- Added regression coverage for user date rejection, recent-action reconciliation sync hooks, grouped matched-action reopening, and max-age filtering.

Manual verification steps are tracked in `.agent/STATUS.md`.

### 2026-07-08

- Forced reconciliation inbox views now include recent persisted `matched` reconciliation items when the fresh preview no longer contains the automatic matches from the original digest.
- Auto-match-only inbox reports send the confirmed-match detail without unresolved action buttons, while unresolved inboxes still include `Reconcile Now` and `Ignore All`.
- Added regression coverage for the forced inbox auto-match report path.

### 2026-07-16

- Routed `log_need_expense` through the normal shared-expense writer into the monthly Needs section instead of inserting individual rows into a personal budget sheet.
- Need rows now record date, item, amount, location, and person and use normal expense action metadata/lineage.
- Added Needs to text and button move destinations plus the bank reconciliation expense-category selector.
- Verified shared Needs rows can be updated, moved out, moved back, deleted with category compaction, and restored with undo.
- Extended category totals, highest-category, largest-expense, and top-expense queries so Needs participates like the other shared categories.
- Preserved support for legacy `description` entities by translating them to the new item field at the intent boundary.

Manual verification steps are tracked in `.agent/STATUS.md`.

### Slice D - Pending State Hardening

- Add TTLs for pending update/delete/move selections.
- Clear stale pending state before routing numeric replies.
- Return a clear "selection expired" message.
- Add tests for stale pending selection behavior.

Status: Complete for in-process pending state as of 2026-06-18. Pending selections, update-field prompts, and move-item prompts now expire after 300 seconds and produce a clear expired-selection response.

### Slice E - UI And Field Coverage

- Decide whether date should be editable through UI.
- If date stays supported, add a date button and validation.
- If date is not supported, remove it from parser guidance and handler copy.
- Make category-specific missing fields clear, especially grocery/gas versus food/shopping.

Status: Date decision complete as of 2026-06-20. User-entered date updates are not exposed and are rejected if parsed. Reconciliation-origin code can still provide a date automatically from the bank transaction. Category-specific move prompts now explain when a destination category requires an item name.

### Slice F - Reconciliation Link Synchronization

- When a reconciled action lineage is updated, moved, deleted, or undone, update or reopen the reconciliation item.
- Prefer stable action IDs over sheet row refs where possible.
- Add tests for reconciled row update, move, delete, and undo.

Status: Complete first pass as of 2026-06-20. Recent-action update, move, delete, and undo reopen linked reconciliation items by matched action-log ID, including grouped IDs. Future refinement can decide whether some unchanged moves should stay confirmed instead of reopening.

## Bank Reconciliation - Known Problems

1. Reconciliation reminders do not always send at the expected time.
2. Snoozed reminders and daily digests use different lifecycle behavior.
3. The transaction inbox can surface very old unresolved bank transactions.
4. Event logging exists only as sheet-backed system-state entries, which is weak for debugging and auditing.
5. Reconciliation item statuses do not clearly separate new, presented, auto-matched, confirmed, ignored, stale, and failed states.
6. Confirming a reconciliation candidate updates the sheet amount to the bank amount when the user intentionally selects that row as the match. This is intended behavior.
7. Updating, moving, or deleting a recent action can leave reconciliation references stale unless explicitly coordinated.
8. Reconciliation behavior is spread across several modules, which makes lifecycle guarantees harder to reason about.

## Bank Reconciliation - Target Invariants

- Normal reconciliation inbox only shows eligible, fresh, posted, watched transactions.
- Historical transactions require an explicit debug/admin/historical review mode.
- A digest is sent once per actor per day unless explicitly forced by an admin/debug path.
- Normal daily digest sends only during the configured morning send window.
- Every meaningful reconciliation state transition is event logged.
- Matching a bank transaction to a sheet row does not silently rewrite the sheet unless the user selected that action.
- If a matched sheet action is updated, moved, deleted, or undone, the reconciliation linkage is updated or reopened.
- Reconciliation UI should present one clear next action at a time.

## Bank Reconciliation - Implementation Slices

### Slice 1 - Inbox Freshness And Stale Handling

- Add owner-level default freshness policy, likely `BOOKIEBOT_RECONCILIATION_MAX_AGE_DAYS`.
- Add query filters so normal unresolved inbox excludes transactions before the cutoff.
- Add a `stale` or `hidden_stale` reconciliation state, or a computed exclusion with explicit debug visibility.
- Add tests proving old transactions do not appear in normal digest/session flows.

Status: Complete first pass as of 2026-06-20. Normal unresolved views use a 60-day max age cutoff by default. Old records are hidden from normal review but are not yet marked with an explicit stale status.

### Slice 2 - Digest Lifecycle

- Introduce an explicit digest lifecycle: `claimed`, `sent`, `failed`.
- Ensure daily sends use consistent event semantics.
- Keep public digest prompts generic and route transaction detail into actor-scoped ephemeral review.
- Add tests for duplicate prevention, send failure, and morning-window enforcement.

### Slice 3 - Structured Event Logging

- Add durable event APIs with typed event names and JSON payloads.
- Log sync, preview, inbox item creation, digest, prompt start, skip, ignore, confirm, reopen, amount mismatch, sheet update, move, delete, and undo events.
- Keep `record_system_event` only for legacy dedupe until replaced.
- Add debug command support to inspect recent reconciliation events.

### Slice 4 - Reconciliation State Machine

- Define allowed statuses and transitions in one place.
- Make store methods enforce transitions instead of ad hoc status updates.
- Add timestamps for `presented_at`, `last_prompted_at`, `resolved_at`, `ignored_at`, and `stale_at`.
- Add tests for invalid transitions and idempotent confirmations.

### Slice 5 - Safer Match Confirmation

- Treat the user's match selection as explicit confirmation that the selected sheet row represents the bank transaction.
- If the selected row amount differs, update the sheet/action amount to the bank transaction amount after that confirmation.
- Keep grouped matches strict by default, but allow an explicit selected-row adjustment to make the grouped total match the bank transaction.
- Log whichever path the user chooses if structured event logging is added later.
- Add tests for mismatch flows.

Status: Complete first pass as of 2026-06-20. Existing-row match confirmation updates the sheet/action amount to the bank amount after the user selects the row as the match. Grouped matches still reject total mismatches by default, and now provide a button-based row adjustment path plus an internal `adjust_action_id` tool path to update one selected row and confirm the group.

### 2026-06-20 Reliability Follow-Up

- One-word `recent` now routes directly to recent actions before LLM parsing, preventing misclassification into unrelated logging flows.
- Expense sheet access during logging now retries once before returning a user-facing sheet access failure.
- Large recent-action DM lists now split on complete transaction blocks, keep Markdown code fences balanced, attach controls to the final DM, and acknowledge successful private delivery in the public channel.

### Slice 6 - Simplify Module Boundaries

- Keep matching/scoring in a reconciliation engine module.
- Keep lifecycle persistence and events in a store/service layer.
- Keep Discord UI/session flow in core workflow modules.
- Avoid sheet mutation logic inside reconciliation matching code.

### 2026-07-16 Shifted Dated Income Layout Follow-Up

Status: Complete. Live May-July migration and report verification finished; Discord/Google Sheets mutation flows are ready for final manual verification.

- Shifted the Brian Budget 2026 Template Income table to `B:D` with Date, Source, and Amount while preserving the biweekly-income configuration in `E:F`.
- Repaired the Template monthly-income total and budget-banner formula lineage for the shifted Amount column.
- Income writes now discover visible headers and support both the legacy Employer/Amount layout and the new Date/Source/Amount layout.
- BookieBot/API writes stamp a Pacific date directly because Google Sheets API writes do not fire `onEdit`; bank-origin income uses the bank transaction date when available.
- The global Apps Script now installs personal-budget edit triggers and stamps an empty Income date when a user manually enters an amount.
- Migrated Brian and Hannah May, June, and July plus Hannah's Template to the canonical `B:D` layout while preserving existing Income source/amount rows and month totals.
- Backfilled dates only from reliable BookieBot action-log timestamps, preserved Brian July's xAI configuration, and migrated Income action-log column metadata and matching row references.
- Expense report parsing now anchors to the visible Date/Source/Amount headers rather than row contents, so adjacent biweekly configuration labels cannot hide valid income rows.
- Updated Income actions remain deletable; deletion compacts the sheet and related action-row references, while undo reinserts the row and restores the affected lineage.
- Live report check: Brian July returned xAI `$3,774.59` on `7/2/2026` and internet stipend `$150.00` on `7/15/2026`; Hannah July returned Sonic paycheck `$1,619.47` on `7/10/2026`.
- Manual test: deploy the script and run `setupBudgetSystemAutomation()`, enter a manual Income amount, then log, update, delete, and undo a BookieBot income entry on a month tab copied from Template.

## Open Questions

- What should the canonical recent-action lineage model look like?
- Should updated/moved actions replace the source action or remain separate visible events?
- Should date updates be supported in the UI? Decided 2026-06-20: no user-entered date updates; reconciliation-origin automation only.
- How long should pending selections remain valid?
- Should old unresolved bank items be automatically ignored, marked stale, or hidden until manually reviewed?
- What is the right default freshness window: 30, 45, 60, or 90 days? Decided first pass 2026-06-20: 60 days.
- Should amount mismatches default to asking every time? Decided 2026-06-20: selecting the matching row is the confirmation; after that, use the bank amount as source of truth for single-row matches.
- Should a moved reconciled expense stay confirmed automatically if amount/date/person are unchanged?
- How much event state should live in Google Sheets versus the banking database?

## Candidate Commands To Add Or Improve

- `/debug_bank_events`
- `/debug_bank_reconciliation_inbox`
- `/debug_bank_mark_stale_before`
- `/debug_bank_review_history`
- `/debug_bank_reopen`
- `/debug_bank_reconciliation_policy`
- `/debug_recent_actions`
- `/debug_recent_action_lineage`

## Files To Inspect Before Editing

- `src/bookiebot/sheets/undo.py`
- `src/bookiebot/intents/handlers.py`
- `src/bookiebot/core/message_router.py`
- `src/bookiebot/ui/recent_actions.py`
- `src/bookiebot/banking/service.py`
- `src/bookiebot/banking/store.py`
- `src/bookiebot/banking/postgres_store.py`
- `src/bookiebot/banking/reconciliation.py`
- `src/bookiebot/core/bank_reconciliation.py`
- `src/bookiebot/core/bank_reconciliation_flow.py`
- `unit_tests/intents/test_handlers.py`
- `unit_tests/core/test_message_router.py`
- `unit_tests/banking/test_reconciliation.py`
- `unit_tests/banking/test_store.py`
- `unit_tests/core/test_bank_reconciliation.py`
