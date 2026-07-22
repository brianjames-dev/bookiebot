# Finance Operations Workstream

Last updated: 2026-07-22

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

Status: Complete in code and automated/local browser verification; deployment checks remain in `.agent/STATUS.md`.

- Reconciliation digest and inbox component actions now use an explicit private thinking defer before sending follow-ups, fixing the silent `View Inbox` interaction and keeping the response actor-scoped.
- Callback regression coverage invokes the real `View Inbox` button and confirms it defers privately before dispatching the inbox workflow.
- Savings commands now support numbered first, second, and third paycheck rows through shared row-discovery, check, and logging helpers with standard undo metadata.
- Modern savings rows expose their own Ideal and Minimum values; the reader retains the legacy two-row fallback where Ideal and Minimum were split across the first and second rows.
- Expense reports emit current/projected savings amounts, Ideal/Minimum totals, and paycheck counts. Projected mode derives one monthly Ideal/Minimum rate from the reached sheet targets, applies it once to projected income, and divides the resulting monthly Ideal evenly across projected paycheck slots before filling empty contributions.
- The report's Saved card, Left amount, outflow total, and Savings Category Mix all consume the active current/projected savings value instead of a fixed current amount.
- Read-only inspection confirmed three savings rows on both live July sheets and Templates. A follow-up corrected the initial per-row scaling error: Brian July's `$11,472.33` projected income now produces a `$2,294.47` monthly Ideal and `$1,147.23` Minimum, not a three-row `$3,441.69` Ideal.
- Local browser verification confirmed the Brian July Saved card changes from the current `$2,294.47` / `$1,539.64` Ideal to a `$3,059.29` projected contribution / `$2,294.47` Ideal and produces no console warnings or errors.
- Verification: `410 passed, 1 skipped`; Pyright clean; frontend typecheck/build passed; `git diff --check` passed.

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
