# Finance Operations Workstream

Last updated: 2026-08-16

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
- Made the optional Discord typing indicator fail open: transient `send_typing` entry or cleanup failures are logged as warnings and no longer abort intent parsing or a completed request.
- Added message-router regression tests proving typing-entry failures do not block processing and genuine request exceptions still propagate through the wrapper.

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

## Shared Expense Responsibility And Reimbursements

### Target Invariants

- The original bank-clearing amount remains immutable in the source action lineage and available for reconciliation.
- The visible expense amount/person represent the budget owner responsible for that spending: the payer's share for ordinary splits, or the partner's full amount for a fronted 0/100 allocation.
- Partner responsibility is a reimbursement receivable, not income and not negative spending.
- Settlement changes the reimbursement state only; it does not change the personal expense after the split is applied.
- Every split links the source action, current sheet row, gross amount, method, both shares, and settlement state in the visible `Shared Reimbursements` worksheet.
- `No split` cancels only the split workflow and leaves the already logged full expense intact.

### Slice G - Initial Split And Settlement Workflow

Status: Complete in code and automated/browser verification as of 2026-08-03; production confirmation remains in `.agent/STATUS.md` checklist item 74.

- Added income-weighted splitting from Brian `$156,000` and Hannah `$85,000` annual incomes, plus 50/50 splitting with penny-safe allocation.
- Added the post-log split prompt and explicit command directives. Grocery, Rent, PG&E, Water, Recology, and Gameday prompt automatically; internet is deliberately excluded.
- Added `Split` to applicable expense/payment recent-action workflows and kept already-split actions from being split again.
- Net the visible expense row to the payer's share while retaining the original gross in source action metadata for bank matching.
- Store reimbursement receivables in `Shared Reimbursements`, support outstanding-balance queries and received-state updates, and audit settlement without logging income.
- Added a responsive Shared Reimbursements web-report card and itemization. Primary expense charts continue to consume only the visible personal share.

### Slice H - Split Lifecycle Completion

Status: Partial as of 2026-08-03. Method changes and outstanding split cancellation are complete; the remaining settlement and mutation lifecycle work stays pending.

1. Complete 2026-08-03: change the split method and recalculate both shares without losing the original gross or settlement history.
2. Complete 2026-08-03: remove an outstanding split by restoring the gross visible expense and voiding the receivable.
3. Correct the actual gross amount after splitting and recalculate the active responsibility and reimbursement amounts.
4. Record partial reimbursements and maintain accurate received/outstanding balances.
5. Add an explicit confirmation/refund workflow before undoing or removing a split that has already been paid.
6. Make update, move, delete, and undo fully split-aware, including ledger row references and reconciliation lineage synchronization.
7. Harden pending split selections across restarts/deploys and add any lifecycle audit events required by production use.

### Slice I - Fronted Shared Expenses

Status: Complete in code and automated verification as of 2026-08-11; production confirmation remains in `.agent/STATUS.md` checklist item 78.

- Added canonical `fronted` allocation state and the `Fronted` control as a 0/100 allocation for shared expense rows only.
- Preserve the payer and gross source action for reconciliation while moving the visible full expense to the partner's Person bucket.
- Extend the reimbursement ledger with responsible owner, original person, and responsible person fields through an append-only migration of existing ledgers.
- Support fronted-at-log-time language, Recent Transactions application, method changes, undo/cancel restoration, and reimbursement queries in both owed-to-me and owed-by-me directions.
- Keep personal budget payment cells out of fronted mode until cross-workbook Rent/utility attribution has an explicit design.

### 2026-08-11 Work Log

- Implemented Slice I with ledger migration, Discord UI/parser/router support, person-aware split lineage, report payload detail, and focused regression coverage.
- Confirmed Brian-side fronted spending becomes Hannah-side shared expense activity without changing the source action's bank-clearing gross.
- Confirmed fronted method changes, undo, and cancellation keep the current row and reimbursement ledger synchronized; paid allocations retain the existing protected lifecycle.
- Migrated the sole live pre-cleanup `$11.99` allocation from the discarded development value `covered` to canonical `fronted`; verified its linked Hannah expense, Brian owed-to-me lookup, and August Expense Breakdown entry. This was a one-time data correction, not a compatibility alias.

### 2026-08-03 Work Log

- Added split-specific Recent Transactions controls for method changes and cancellation across normal expenses and bill/payment cells.
- Recorded method changes as reversible split-lineage children, retained gross source actions for bank matching, and kept ledger/current-sheet changes synchronized with rollback on persistence failures.
- Added confirmed outstanding-split cancellation with gross restoration, reimbursement voiding, a system audit event, and safe re-splitting. Received reimbursements remain protected pending the explicit paid-settlement workflow.
- Implemented Slice G with focused calculation, ledger, recent-action, router, handler, report, and undo regression coverage.
- Confirmed source action amounts remain gross while split leaf actions and the reimbursement ledger carry the personal allocation state.
- Verified the report at desktop and mobile widths and recorded the remaining lifecycle work in Slice H.

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

Status: Complete. Live May-July migration and report verification finished; Income mutation lifecycle coverage now includes anchored configuration and formula preservation.

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
- Reduced the live Brian Template to one Income seed row and preserved its visible style, validation, notes, Monthly Income formula, and budget formula lineage.
- Reduced the live Hannah Template to the same one-seed layout, standardized the seed label to `<Enter Source>`, and preserved the biweekly configuration plus shifted formula lineage.
- BookieBot now replaces the Template seed row instead of inserting ahead of it, then inserts later rows only when another Income event is logged and repairs the summary range without retaining a trailing placeholder.
- BookieBot explicitly reapplies the seed row's cell format, validation, notes, borders, and row height because the Sheets API's inherited-row insertion omits some of those properties.
- Whole-row Income deletion now snapshots the affected `B:F` properties and preserves the first Income row's anchored biweekly configuration instead of shifting or deleting it with the transaction.
- Income delete undo clears the temporarily preserved anchor before reinsertion, restores the deleted row's explicit formatting/validation/notes/height, and rebuilds Monthly Income from the discovered header and summary coordinates.
- Manual Source/Amount edits use Apps Script for date stamping and summary-formula repair without appending a placeholder, regardless of whether Source or Amount is entered first.
- Live Hannah verification: a temporary Template copy accepted two sequential dated BookieBot Income entries with matching row properties, totaled `$191.34`, and was deleted after the check.
- Live Brian July verification: temporary-copy first-row delete/undo, later-row delete/undo, and immediate undo all preserved the `E:F` biweekly configuration, kept summary totals/formulas correct, restored baseline values/formulas, and left no QA tabs behind.
- Manual test: deploy the script and run `setupBudgetSystemAutomation()`, enter a manual Income amount, then log, update, delete, and undo a BookieBot income entry on month tabs copied from both Templates.

### 2026-07-17 Income Source And Just-In-Time Row Follow-Up

Status: Complete. The duplicate Source and extra trailing placeholder reported from Brian July are fixed in code and on the live sheet.

- Income Source and label values are whitespace-normalized and overlapping values are collapsed, so `source=xAI` plus `label=xAI` writes `xAI` once while distinct details remain available.
- A Template retains one initial seed row; the first Income event restores that row's undo state, and subsequent events insert copied/formatted rows immediately above Monthly Income only when needed.
- Apps Script keeps automatic date stamping and summary repair but no longer appends a blank placeholder after a completed manual entry.
- Brian July's live Source was corrected from `xAI xAI` to `xAI`, the extra placeholder was removed, and PDF/API verification confirmed `$7,698.22` Monthly Income plus intact Budget and biweekly configuration formulas.
- Manual test: after deploying the Apps Script and bot revision, log another Income event whose parser repeats Source and label; confirm a single Source value, one newly inserted formatted transaction row, no trailing placeholder, and a correct Monthly Income total.

### 2026-07-17 Actual-Date Biweekly Projection Follow-Up

Status: Complete. Current-month report projections now account for paychecks that arrive slightly early or late.

- The configured Biweekly Income Start remains the bootstrap schedule before a dated paycheck is available.
- Once the configured Income source has a dated paycheck, future calendar projections advance in 14-day increments from the latest actual date instead of leaving an obsolete configured occurrence in the past.
- Projected Income now adds only the remaining future occurrences to the current logged total, avoiding both stale projection days and dropped month-end paychecks.
- Live Brian July verification produced actual xAI events on July 2 and July 17 plus a projected `$3,774.11` paycheck on July 31; the projected monthly total is `$11,472.33`.
- Manual test: log a configured paycheck one to two days early or late, open the current expense breakdown, and confirm the next projected paycheck is exactly fourteen days after the actual event with no stale projection left behind.

### 2026-07-17 Chart Tooltip Anchor Follow-Up

Status: Complete after lifecycle correction. Report tooltips no longer animate from the chart origin after briefly losing hover, and their five-second hold/fade behavior remains intact.

- The shared chart tooltip content caches the last active payload and overrides Recharts' immediate inactive visibility only until the five-second hold plus 180 ms fade completes.
- The wrapper records its last non-empty Recharts transform and restores it whenever the inactive render clears that transform.
- Transform transitions are disabled for the unpositioned wrapper and enabled only after the first real anchor is painted, eliminating the initial `(0, 0)` flight.
- Point-to-point transitions remain enabled after that first anchor, so sequential hover and non-sequential re-entry both move smoothly from the prior position.
- Rebuilt the embedded JavaScript asset and added a report regression assertion for the transform-retention hook.
- Local browser verification covered initial hover, adjacent movement, empty-space re-entry, the five-second visible hold, fade phase, and final hide.
- Manual test: move between non-adjacent bars, slices, and line points while briefly crossing empty chart space; confirm no top-left fly-in, no janky re-entry, and a smooth fade after about five seconds.

### 2026-07-17 Carousel Tooltip Dismissal Follow-Up

Status: Complete. Changing the top-chart carousel or any chart data-view toggle now dismisses the previous tooltip without leaking cached data into the next view.

- Every chart or data-view switch publishes a shared dismissal revision before changing its visible dataset and cancels the active tooltip's normal five-second hold timer.
- A visible tooltip uses the existing 180 ms fade-out instead of being hidden abruptly by the carousel cooldown.
- Cached payloads stay suppressed after the transition until a deliberate mouse move or pointer press occurs inside the selected chart, preventing arbitrary new-graph data from occupying the old tooltip position.
- The regular five-second tooltip lifecycle and fresh-hover behavior remain unchanged after that interaction gate is released.
- The dismissal provider now spans the full report, covering Projected mode, Category Mix, Calendar, Daily Spending, and Expense Highlights selectors in addition to carousel navigation.
- Regression markers cover every toggle trigger plus the switch/fade hooks in generated report HTML; focused and full report tests, Pyright, frontend typecheck/build, and local browser switching checks pass.
- Manual test: show a tooltip, change the current chart with either a carousel control or an in-card data toggle, confirm the old tooltip fades away with no replacement, then hover or tap the new view and confirm its correct tooltip appears.

### 2026-07-17 Selective Calendar Filter Transition Follow-Up

Status: Complete. Switching the report Calendar between All and Subs no longer remounts or reanimates the full calendar panel.

- Removed the filter-keyed panel boundary so the month heading, Current/Projected label, weekday header, day cells, and calendar container retain stable DOM identity across filter changes.
- Each potentially visible event marker now remains stably keyed and changes an explicit visibility state; markers leaving or entering the selected view fade and collapse individually on desktop and mobile.
- Per-day rendering retains only markers that can occupy the three visible slots in at least one filter, while separate stable overflow controls represent each filter's remaining events.
- The outflow amount and event count crossfade independently when their values change; the month and mode labels do not receive change animations.
- Regression markers cover the stable calendar shell, static labels, changing values, and marker transitions. Full unit tests, Pyright, frontend typecheck/build, and a local All-to-Subs browser fixture pass with no console warnings or errors.
- Manual test: open Calendar on All, switch to Subs, and confirm only non-subscription event pills fade/collapse, the amount/count crossfade to subscription values, and the calendar/month/mode labels remain visually stationary; switch back and confirm the removed events return smoothly.

### 2026-07-17 Concise Expense Breakdown Reply Follow-Up

Status: Complete. Discord now sends a compact expense-breakdown summary while the web report remains the detailed view.

- Removed the category-by-category amounts and percentages from the Discord message body.
- Retained the report heading, Total Spent, signed `Open full report` link, and attached pie chart.
- Continued passing every non-zero category to the pie-chart renderer, so only the duplicated text payload changed.
- Manual test: request an expense breakdown and confirm the Discord reply has only the compact summary and chart; open the signed link and confirm the full category detail remains available.

### 2026-07-17 Category Mix Envelope Follow-Up

Status: Complete. The donut, connector stems, and metric labels now remain inside the chart border as its available height changes.

- Category Mix observes its actual chart-host size and solves for the largest radius whose complete visual envelope fits with responsive edge padding.
- Envelope bounds include the donut radius, stem endpoints, text gap, measured label width/height, and the same per-category x/y deltas applied during rendering.
- Sector midpoint calculations mirror Recharts' `0°` to `360°` distribution and one-degree slice padding so later categories do not accumulate angular drift.
- The full envelope is re-centered after ResizeObserver updates, including when expanding Categories reduces the chart host height.
- Regression coverage confirms the fitted-host hooks are embedded in generated reports; frontend type-check/build and browser geometry checks cover the ten-slice Brian example.
- Manual test: open Brian's July report at desktop width, expand and collapse Categories, and confirm all labels and stems keep a small gap from every chart border.

### 2026-07-17 Category Mix Layout Motion Follow-Up

Status: Complete after animation-pipeline correction. Category Mix retains the envelope solver's per-view fit while smoothly moving and reshaping the pie between the All, Needs, Wants, and Savings centers without a delayed or interrupted sector morph.

- Each filter change records the previous fitted center and initially offsets the newly rendered stable Recharts pie group back to that visual origin.
- The offset returns to zero over 520 ms while Recharts performs its existing slice morph, so the donut, stems, and labels float together into the new fitted position instead of snapping.
- Wrapper phase state now lives outside a memoized Recharts pie surface, preventing the primed, active, and idle updates from reconciling the sector-animation subtree mid-morph.
- The Recharts pie animation starts at zero delay so sector interpolation and center travel share the same 520 ms window; the wrapper keeps its compositor state for an additional 80 ms before settling idle.
- The fit solver remains authoritative for every destination; no fixed center or radius is introduced, and endpoint label/stem padding remains unchanged.
- Tooltip interaction is temporarily suppressed during the layout transition and restored after completion; interrupted or near-zero transitions settle explicitly to idle so rapid toggles cannot leave the chart inert.
- Reduced-motion users receive the final fitted position without the translation animation.
- Regression hooks expose motion phase, revision, travel, offsets, render isolation, and synchronized animation in generated reports. Full unit tests, Pyright, frontend typecheck/build, and browser frame sampling pass; the sampled sector changed continuously until its stable tail and never resumed after becoming stable.
- Manual test: switch Category Mix through All, Needs, Wants, and Savings, confirm the complete pie/label group glides and reshapes continuously into each fitted location without a pause, then toggle two tabs quickly and confirm the chart settles and tooltips remain interactive.

### 2026-07-17 Category Rollover And Overspend Follow-Up

Status: Complete. Needs and Wants Category Mix views now show their category-specific available income and overspend pressure.

- Report parsing prefers the Budget sheet's Rollover column aligned with the Needs and Wants subtotal rows, while retaining the older Margins-row fallback for legacy sheets.
- Dedicated Needs/Wants rollover payload fields preserve the existing margin metrics and Burn Rate target instead of silently changing those established calculations.
- Positive rollover is added to the selected pie as `Income left`; negative rollover is excluded from the pie and shown in a compact single-bar overspend indicator.
- Wants uses its cascaded rollover value, so Needs overspend is already deducted; the Wants view explicitly identifies that carried impact.
- Projected mode mirrors the sheet sequence by calculating Needs at 50% of projected income and Wants at 30%, then carrying Needs rollover into Wants.
- Regression coverage preserves negative rollover values and the cross-category payload; browser checks cover current positive rollovers, Needs overspend, Wants impact, projected mode, and chart containment.
- Manual test: open Category Mix for a month with positive rollovers, verify both `Income left` slices, then temporarily overspend Needs and confirm Needs shows the overspend bar while Wants drops by the same amount and explains the deduction.

### 2026-07-17 Daily Spending Grid Follow-Up

Status: Complete after contrast follow-up. Every Daily Spending filter now separates foreground boundaries/X labels from the muted-grey interior scale/Y labels.

- Recharts' first generated horizontal line (`$0`) and final unlabeled top boundary are solid and use the report's theme-aware foreground color.
- X-axis labels use that same foreground tone; Y-axis dollar labels retain the muted-grey color.
- Interior lines explicitly use the muted-grey color, `1px` width, `3 3` dash spacing, and butt caps so no segment differs in hue or dot size.
- Stable grid and X-label classes are embedded in generated report assets for regression coverage.
- Browser SVG checks verified computed colors, widths, caps, and dash patterns for All, Needs, and Wants with no console warnings or errors.
- Manual test: switch Daily Spending through All, Needs, and Wants in light and dark mode, confirm the top/bottom boundaries and X labels use the foreground tone, and confirm the Y labels plus uniformly dotted interior lines remain grey.

### 2026-07-17 Daily Spending Bar Radius Follow-Up

Status: Complete. Needs and Wants bars now share the blue bar's subtle four-corner radius in every Daily Spending filter.

- One typed `[2, 2, 2, 2]` radius constant drives both stacked bars and the single filtered bar, preventing color-specific radius drift.
- Focused regression coverage asserts all three Daily Spending bar definitions consume the shared constant and rejects the former purple `6px` top corners.
- Browser SVG checks confirmed identical `A 2,2` corner arcs for blue and purple bars across All, Needs, and Wants with no console warnings or errors.
- Manual test: compare blue and purple bars in All, then switch to Needs and Wants and confirm every bar retains the same subtle rounding.
- Verification: `405 passed, 1 skipped`, Pyright reported zero errors, frontend typecheck/build passed, focused report tests passed, and `git diff --check` passed.

### 2026-07-17 Three-Bucket Category Cascade Follow-Up

Status: Complete. Category Mix now preserves separate Needs, Wants, and Savings balances and exhausts donor buckets in the requested source-specific order.

- Current reports parse all three raw values from the Budget sheet Margins row, including zero balances, while retaining the older Rollover payload fields for compatibility and unchanged Burn Rate behavior.
- Needs overspend borrows from Wants then Savings; Wants overspend borrows from Savings then Needs; over-saving borrows from Wants then Needs.
- The backend emits the raw balances, adjusted balances, transfer ledger, source deficits, and final total overspend so current-mode behavior is regression tested and auditable.
- Category Mix adds a Savings tab, uses Amount Saved as its activity slice, and shows its adjusted positive balance as `Income left`.
- Red alerts describe the overspent source and how donors covered it; amber alerts identify deductions from a selected donor; All shows a budget-overspend alert only after all category funds are depleted.
- Projected mode recomputes the same three-bucket cascade from projected 50/30/20 allocations and projected category totals.
- Manual test: create a temporary overage in each source category, confirm donor impacts follow its priority, then exceed all three available balances and confirm the All-tab budget-overspend amount equals the uncovered remainder.
- Verification: `404 passed, 1 skipped`, Pyright reported zero errors, frontend typecheck/build passed, and local browser checks covered live balances, all donor orders, projected mode, total overspend, and chart containment.

### 2026-07-22 Digest Inbox And Three-Paycheck Savings Follow-Up

Status: Complete. The three-paycheck workflow remains active; its projected-savings-amount behavior was superseded by the 2026-07-26 actual-only savings decision below.

- Reconciliation digest and inbox component actions now use an explicit private thinking defer before sending follow-ups, fixing the silent `View Inbox` interaction and keeping the response actor-scoped.
- Callback regression coverage invokes the real `View Inbox` button and confirms it defers privately before dispatching the inbox workflow.
- Savings commands now support numbered first, second, and third paycheck rows through shared row-discovery, check, and logging helpers with standard undo metadata.
- Modern savings rows expose their own Ideal and Minimum values; the reader retains the legacy two-row fallback where Ideal and Minimum were split across the first and second rows.
- Expense reports emit current/projected savings target metadata and paycheck counts. Projected mode derives one monthly Ideal/Minimum rate from the reached sheet targets and applies it once to projected income.
- Historical behavior estimated unentered future contributions and fed that amount into Saved, Left, and Savings Category Mix. The 2026-07-26 follow-up keeps Saved actual in both modes instead.
- Read-only inspection confirmed three savings rows on both live July sheets and Templates. A follow-up corrected the initial per-row scaling error: Brian July's `$11,472.33` projected income now produces a `$2,294.47` monthly Ideal and `$1,147.23` Minimum, not a three-row `$3,441.69` Ideal.
- Historical browser verification covered the prior contribution projection; current expected behavior is recorded in the 2026-07-26 follow-up.
- Verification: `410 passed, 1 skipped`; Pyright clean; frontend typecheck/build passed; `git diff --check` passed.

### 2026-07-26 Expense Report Financial Semantics Follow-Up

Status: Complete in code, automated verification, and live browser verification; deployment confirmation remains in `.agent/STATUS.md`.

- Spent uses detailed elapsed Needs/Wants expense itemization without savings. Left uses the Budget sheet's Net Total after its category margins and cross-category coverage; it is not derived by subtracting elapsed outflow and savings from income.
- Category Mix All remains the elapsed-outflow view. Needs and Wants use their source Budget-sheet subtotals and allocations so percentages match the workbook even when full subscription budgets differ from subscriptions elapsed so far. The Savings tab remains separate and uses only the actual saved amount read from the sheet.
- Projected mode keeps Saved and current category usage unchanged. It applies a penny-safe 50/30/20 split to projected income, cascades the resulting category balances, and updates the monthly Ideal/Minimum targets without inventing future savings deposits.
- Calendar keeps the month name as its heading, restores the original visible non-income outflow total as the subtitle beneath it, and renders its current/projected event count as one spaced value. Both animated values continue to respond to All/Subs and Projected state.
- Largest includes every non-Rent actual shared expense, entered bill/utility, and elapsed subscription in descending order. The graph shows the top ten while the expandable table retains all non-Rent rows.
- Burn Rate derives effective Wants availability after the category cascade, places the daily pace beside its summary, and names both donor and covered category in the impact callout.
- The Saved metric is a color-coded zero-to-Ideal progress bar with a Minimum marker; mode/paycheck prose was removed. Daily Spending details start open only on desktop, and the header places the timestamp beside the title with Projected immediately left of the rightmost theme control.
- Live Brian July verification showed Current Income `$7,698.22`, Spent `$5,133.70`, Left `$794.00`, Needs `$4,098.47 / $3,849.11 (106.48%)`, Wants `$1,266.11 / $2,309.47 (54.82%)`, and Saved `$1,539.64 / $1,539.64`. Projected showed `$11,472.33` Income, `$4,568.11` Left, unchanged Saved `$1,539.64`, and `$2,294.47` Ideal.
- Live Hannah July source verification showed `$618.53` Left with `$688.12 / $809.74` Needs, `$312.82 / $485.84` Wants, and `$0.00 / $323.89` Savings.
- Verification: focused report suite, full suite, Pyright, frontend typecheck/build, `git diff --check`, and live desktop/mobile browser checks are recorded in `.agent/STATUS.md`.

### 2026-07-24 Persisted Reconciliation Inbox Follow-Up

Status: Complete in code and focused verification; production deployment confirmation remains in `.agent/STATUS.md`.

- Replaced the digest button's forced reconciliation rebuild with a persisted-state inbox read. `View Inbox` no longer starts a Plaid sync, rescoring preview, action-log read, or schedule-sheet hydration after deferring the Discord interaction.
- The persisted report includes current-month unresolved and automatic-match items and retains `Reconcile Now`, `Ignore All`, and `Unmatch` controls where applicable.
- Match reports infer schedule, spreadsheet-row, and spreadsheet-group source types from persisted lineage when source hydration is intentionally skipped.
- Inbox loading is bounded by `BOOKIEBOT_RECONCILIATION_INBOX_TIMEOUT_SECONDS` (15 seconds by default); timeouts and exceptions return a private no-mutation retry message instead of leaving Discord's thinking state unresolved.
- Regression coverage proves the fast path never calls sync/rescoring, returns persisted automatic matches, retains batch-ignore behavior, and closes the deferred interaction on preparation failure.
- Verification: focused core/reconciliation suite `66 passed`; full suite `412 passed, 1 skipped`; Pyright clean; `git diff --check` passed.

### 2026-07-25 Deferred Discord Response Lifecycle Follow-Up

Status: Complete in code and focused verification; production deployment confirmation remains in `.agent/STATUS.md`.

- Corrected the remaining Discord lifecycle issue: after `thinking=True`, the first inbox result now edits the original deferred interaction response instead of creating a separate follow-up that leaves the thinking placeholder unresolved.
- Empty, timeout, exception, Ignore All, and Unmatch outcomes also complete their original deferred responses in place.
- Multi-chunk reports edit the original response with the first chunk and reserve follow-ups for later chunks. `Reconcile Now` uses a non-thinking defer because its established review flow sends follow-up cards.
- Regression coverage verifies successful reports, empty state, timeout/failure, and batch-ignore response completion.
- Verification: focused core/reconciliation suite `68 passed`; full suite `414 passed, 1 skipped`; Pyright clean; `git diff --check` passed.

### 2026-07-25 Persisted Inbox Data Accuracy Follow-Up

Status: Complete in code and focused verification; production deployment confirmation remains in `.agent/STATUS.md`.

- Persisted inbox previews now load current-month cache buckets from the banking store, so Stored, Needs review, Matched, Confirmed, Ignored, and Pending counts no longer fall back to zeros.
- Unresolved review rows are formatted before automatic-match history and their action controls are attached to the first Discord response. Long match reports continue in later messages without hiding the actionable inbox.
- Regression coverage reproduces unresolved items alongside multi-message match history and verifies accurate cache totals, visible review rows, and immediate controls.
- Verification: focused finance-ops suite `92 passed`; full suite `414 passed, 1 skipped`; Pyright clean; `git diff --check` passed.

### 2026-07-25 Interaction Typing And Recent Privacy Follow-Up

Status: Complete in code and automated verification; production confirmation remains in `.agent/STATUS.md`.

- `View Inbox`, digest `Reconcile Now`, and inbox `Reconcile Now` now use silent component defers while a resilient channel typing context displays Discord's normal `BookieBot is typing...` UI.
- Inbox success, empty, timeout, failure, Ignore All, and Unmatch results are private follow-ups rather than edits to a temporary thinking response.
- Recent-action button/select prompts, ownership errors, and action outcomes remain ephemeral, with new callback-level regression coverage.
- Discord does not support `ephemeral=True` on ordinary `User.send` or DM channel messages. Typed recent-action requests now receive a short-lived launcher with no financial data; opening it deletes the launcher and sends the list through an ephemeral interaction.
- The active follow-up webhook is retained for the ten-minute workflow window, keeping typed pagination, update/move replies, cancellations, expiry notices, and results in the same ephemeral session.
- DM-originated requests no longer receive the redundant `I sent your recent transactions list to your DMs.` acknowledgement; requests from a shared channel still do.
- Verification: focused recent/message-router suite `135 passed`; full suite `418 passed, 1 skipped`; Pyright clean; `git diff --check` passed.

### 2026-07-31 Recent Ephemeral Launcher Restoration

Status: Complete in code and automated verification; production confirmation remains in `.agent/STATUS.md`.

- Restored the short-lived launcher after production testing confirmed that direct bot-authored DM lists are persistent and do not carry Discord's native ephemeral footer.
- Tapping `Open Recent Transactions` silently creates the interaction context, returns the list and selector ephemerally, and deletes the launcher immediately.
- The active interaction follow-up remains available for the ten-minute workflow window so pagination, typed update/move replies, cancellations, expiry notices, and outcomes stay ephemeral where Discord permits.
- Verification: focused recent/message-router suite `134 passed`; full suite `422 passed, 1 skipped`; Pyright clean; `git diff --check` passed.

### 2026-08-02 Prior-Month Paycheck Projection Follow-Up

Status: Complete in code and automated/read-only verification; production browser confirmation remains in `.agent/STATUS.md` checklist item 73.

- New-month expense reports use the immediately prior month's latest dated paycheck matching the configured biweekly source as projection-only amount and cadence context.
- A missing current-month source/start configuration inherits from the immediately prior month, covering Brian's live August tab without changing either sheet.
- The prior paycheck never enters Current income or the selected month's actual calendar. A matching current-month paycheck supersedes it; unrelated, mismatched, undated, or older income does not become the projection basis.
- January optionally loads the previous annual workbook's December tab, while access/configuration failures retain the existing safe fallback behavior.
- Current-month signed report links rebuild from Sheets by default so a pre-fix saved HTML snapshot cannot keep returning a `$0.00` projection. The saved file remains the route's failure fallback; completed months remain snapshot-first, and `snapshot=1` explicitly requests the current-month file.
- Read-only Brian August verification found the July 31 `xAI` paycheck at `$3,137.49` and produced `$6,274.98` Projected income with August 14 and 28 projected events while Current remained `$0.00`.
- Browser verification opened a normal signed current-month URL backed by a deliberately stale snapshot and confirmed the live Projected cards show Income `$6,274.98`, Left `$2,339.42`, Minimum `$627.50`, and Ideal `$1,255.00` with no console errors.
- Verification: report suite `44 passed`; full suite `432 passed, 1 skipped`; Pyright clean; frontend typecheck/build passed; `git diff --check` passed.

### 2026-08-02 Daily Spending Compression-Pill Follow-Up

Status: Complete in code and focused/browser verification; production confirmation remains in `.agent/STATUS.md` checklist item 70.

- Removed the visible `Axis compressed above ...` pill and its dedicated CSS from Daily Spending.
- Preserved the conditional outlier-compression calculation, transformed chart values, raw-value axis labels/tooltips, totals, and itemized details.
- Regression coverage rejects the removed markup and styling while continuing to assert the compression trigger and chart data paths.
- Live Brian August browser verification confirmed the chart still compresses the rent outlier, the pill and copy are absent, the page has no horizontal overflow, and browser logs are clean.
- Verification: focused report suite `44 passed`; full suite `432 passed, 1 skipped`; Pyright clean; frontend typecheck/build passed; `git diff --check` passed.

### 2026-08-07 Intent And Bill-Payment Reliability Follow-Up

Status: Complete in code and automated verification; production confirmation remains in `.agent/STATUS.md` checklist item 76.

- Unambiguous Rent, PG&E, Recology/trash, and Water logs/checks route locally before the LLM. This keeps critical bill mutation available during a transient OpenAI incident and preserves LLM parsing for genuinely ambiguous purchases.
- The OpenAI client retries transient server/rate/connection failures with bounded backoff. Parser infrastructure failures and invalid/unknown structured responses now raise through the parser boundary instead of becoming a legitimate `fallback` and triggering generic advice.
- Google Sheets `429` read-quota errors are distinct from permissions and missing worksheets. Bill-payment reads retry asynchronously and report a no-mutation outcome after exhaustion.
- Current-month worksheet handles are cached per spreadsheet/month. Bill-payment logging reuses the loaded row's previous value and removes two redundant `acell` reads, reducing the mutation path from three income-sheet reads to one after worksheet resolution.
- Verification: focused reliability suite `221 passed`; full suite `488 passed`; Pyright clean; `git diff --check` passed.
- Manual test: deploy, send `Water bill 148.82` and a bill-status query, then confirm local routing, the normal success/split flow, and the bounded no-generic-response behavior under simulated OpenAI `500` and Sheets read-quota `429` failures.

### 2026-08-07 Quarterly Utility History Follow-Up

Status: Complete in code and automated/browser verification; production confirmation remains in `.agent/STATUS.md` checklist item 77.

- Utility history now resolves quarterly cadence and configured pull months from the normalized bill schedule before producing chart points.
- Off-cycle months are absent from a quarterly series instead of being represented as `$0`. Monthly bills remain month-by-month, and a configured quarterly pull month can still show `$0` when an expected bill has not been entered.
- Regression coverage uses May/August Recology hits, rejects June/July points, and requires Recharts to connect valid hits across the off-cycle gaps. Local browser verification confirmed one quarterly line with nodes only at May/August alongside continuous monthly series, with no browser warnings or errors.
- Verification: report suite `47 passed`; full suite `490 passed`; Pyright clean; frontend typecheck/build passed; `git diff --check` passed.
- Manual test: open a report spanning quarterly billing and off-cycle months and confirm configured pull months remain connected while only those months receive nodes for that quarterly bill.

### 2026-08-16 Fixed Expense-Report Carousel Stage Follow-Up

Status: Complete in code and automated/responsive browser verification; production confirmation remains in `.agent/STATUS.md` checklist item 79.

- Replaced the per-slide top-chart cards with one edge-to-edge shaded band that acts as the shared carousel viewport for Category Mix, Burn Rate, Calendar, and Bills & Utilities. The band itself is borderless and square, while each graph/calendar surface is transparent and borderless rather than appearing as another container.
- Kept the existing swipe, desktop previous/next, tooltip dismissal, and active-indicator behavior; navigation remains outside the shared viewport.
- Established one fixed responsive stage height for all four pages. Burn Rate and Bills & Utilities use the full available chart row when details are closed and surrender space to bounded, scrollable inline details when opened without changing the stage height.
- Moved the larger Category Mix and Calendar detail datasets into bounded native dialogs so opening them never changes carousel geometry. Category Mix All now reports the summed category budget and its percentage used.
- Changed Calendar rows to equal fractional tracks and consolidated every multi-event date into one marker whose tooltip lists all events. Event count can no longer enlarge a date cell or the shared stage.
- Kept the carousel and its slides flush with both viewport edges, then added a separate responsive `16px`-to-`56px` gutter inside each chart page. The shaded swipe surface remains visibly full bleed while text, graphs, and controls stay safely inset. All four pages use a common header/body/footer grid; graphs fill the variable middle row while the details-control row stays aligned at the bottom.
- Removed redundant Category Mix/Calendar outer titles and the duplicate Bills & Utilities title. Category Mix retains only its Spent/Saved summary and Calendar retains its month/outflow summary.
- Locked the underlying document while Category/Calendar dialogs are open, bounded scrolling to the dialog body, restored the prior Y position on close, and made Calendar details render the complete subscription list without a nested `View all` step.
- Added effective donor usage to filtered Category Mix views: coverage transferred out of Wants or Savings becomes a visible chart slice and participates in the filtered Spent/% used headline, while the recipient retains its actual overspend and the All view avoids transfer double-counting.
- Added focused source regressions and rebuilt the embedded report assets. Desktop and `390x844` checks confirmed stable `640px`/`540px` stage heights, exact viewport-width slides at `x=0`, responsive inner content alignment at `x=56`/`x=16`, aligned lower regions, cleaned headings, complete subscription details, page-scroll isolation, one marker per date, aggregate tooltips, accurate transfer-adjusted usage, no horizontal overflow, and clean browser diagnostics.
- Verification: report suite `52 passed`; full suite `509 passed, 1 skipped`; Pyright clean with the project Python 3.12 environment; frontend typecheck/build passed; `git diff --check` passed.
- Manual test: open a report at desktop and phone widths; switch/swipe across all four panels and confirm the shaded shell enters from both viewport edges while every page's text, graph, and footer controls retain the same inner gutter. Confirm the stage and lower control row never move and each graph fills its available middle row. Confirm Category shows only Spent/Saved, Calendar shows only month/outflow, and Bills & Utilities appears once. Open Category and Calendar details after scrolling the page, attempt to scroll outside the dialog, scroll a long dialog internally, close it, and confirm the page remains at its prior Y position. Confirm Calendar details lists every Needs/Wants subscription. In a report where Needs overspend is covered by Wants, compare both filtered charts and subtitles with the coverage callout and confirm All does not double-count the transfer. Confirm multi-event calendar dates retain one marker whose tooltip lists every event and the indicator remains outside below the band.

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
