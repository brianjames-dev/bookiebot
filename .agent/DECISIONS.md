# Agent Decisions

Record durable technical decisions here. Keep entries short and dated.

## 2026-06-14 - Use Agent Tracking Files

Decision: Add a root `.Agents` protocol file and a `.agent/` folder for current status, workstream backlog, and architecture decisions.

Rationale: Reconciliation and recent-action work spans bank storage, Discord workflows, Google Sheets mutation, and audit behavior. A small protocol keeps future agent work aligned without forcing a heavy project-management system.

## 2026-06-14 - Centralize Finance Operations Backlog

Decision: Use `.agent/WORKSTREAM_FINANCE_OPS.md` as the centralized workstream for bank reconciliation, transaction inbox behavior, and recent-action update/move/delete stabilization. Keep `.agent/STATUS.md` as the short on-deck view for the next implementation focus.

Rationale: Reconciliation and recent transactions share action-log lineage, sheet mutation, audit events, and user confirmation semantics. A single backlog prevents related work from drifting across separate documents.

## 2026-06-18 - Treat Recent Expense Mutations As Lineages

Decision: Recent expense move/delete behavior should operate on the active action lineage rather than only the latest raw action record. Deletes record all active action IDs in the deleted lineage so undo can restore the expected visible state.

Rationale: Updates and moves create new action records while preserving the same underlying sheet transaction. Operating on only the latest record caused updated or moved expenses to become hard to move/delete safely and could let stale source actions reappear after deletion.

## 2026-06-18 - Use Status As The Priority Queue

Decision: Use `.agent/STATUS.md` as the active priority queue, `.agent/WORKSTREAM_FINANCE_OPS.md` as the centralized backlog and context sheet, `.agent/DECISIONS.md` for durable decisions, and `.Agents` as the required task completion loop.

Rationale: The workstream document is intentionally broad, while active implementation needs a smaller on-deck surface. This keeps day-to-day task selection simple without losing the larger reconciliation and recent-transactions roadmap.

## 2026-06-18 - Centralize Recent Action Capabilities

Decision: Recent-action UI and handlers should use one capability helper for supported operations, editable fields, and user-facing unsupported-operation reasons.

Rationale: Update, move, delete, and undo support differs by action type. Centralized capabilities prevent the UI from presenting invalid controls and keep direct command failures consistent with selected-transaction workflows.

## 2026-06-18 - Expire Pending Recent-Action State With Component Views

Decision: In-process pending recent-action selections, update-field prompts, and move-item prompts expire after 300 seconds.

Rationale: Five minutes gives users a more practical reply window while still preventing old numeric replies or free-text values from mutating a transaction the user no longer has visible context for.

## 2026-06-18 - Keep Recent-Action Workflows Private To The Actor

Decision: Recent-action lists, follow-up prompts, and mutation results should be private to the user who triggered the workflow. Text-command recent lists are sent by DM when possible, component responses are ephemeral, and controls reject interactions from other users.

Rationale: Recent transactions can expose personal financial details. Keeping the workflow actor-scoped prevents other Discord users in the channel from seeing transaction details or mutating someone else's pending recent-action state.

## 2026-06-18 - Use Generic Public Reconciliation Digest Prompts

Decision: Scheduled reconciliation digest messages in the shared channel should show only a short unresolved-item count and route the detailed review into ephemeral interaction responses.

Rationale: Discord cannot provide a persistent channel message whose body is visible only to one user. A generic persistent prompt preserves the channel reminder and buttons while keeping bank transaction details private.

## 2026-06-18 - Bound Daily Reconciliation Digest To Morning Window

Decision: The normal daily reconciliation digest is eligible only inside the configured morning send window, defaulting to 60 minutes from `BOOKIEBOT_BANK_RECONCILIATION_SEND_HOUR`.

Rationale: The previous `current.hour >= send_hour` gate allowed newly synced Plaid transactions to cause a digest later in the day if no digest had been sent during the morning. A bounded window keeps daily digest behavior predictable.

## 2026-06-18 - Remove Reconciliation Digest Snooze

Decision: Reconciliation digest snooze/reminder functionality should be removed rather than hardened. The persistent public digest prompt now offers only `Reconcile Now`, and private review sessions provide `Ignore All` for dismissing the current review batch.

Rationale: Snooze created a second digest delivery path that could make reconciliation prompts appear later in the day. Removing it simplifies the lifecycle to daily scheduled sends plus explicit review actions.

## 2026-06-19 - Send Finance Digests By DM

Decision: Reconciliation and bills/subscriptions digests should send detailed finance content to the target user's DM. Reconciliation digest controls should offer `Reconcile Now` and `View Inbox`; list-level `Ignore All` belongs only on the inbox view.

Rationale: DM delivery avoids exposing finance details in shared channels. Keeping `Ignore All` on the inbox list makes the destructive bulk action apply only to the displayed batch, while one-at-a-time reconciliation stays focused on the current transaction.

## 2026-06-20 - Do Not Expose User-Entered Date Updates

Decision: Recent transaction update flows should not ask users for dates or accept parsed user-entered `date` updates. Date mutation is only allowed for reconciliation-origin automation that can use the bank transaction's reported date.

Rationale: Users should not have to reason about sheet dates manually during update/move/delete workflows. Reconciliation has the authoritative bank transaction date, so any automatic date correction should happen there.

## 2026-06-20 - Reopen Reconciliation Links After Recent-Action Mutation

Decision: When a recent action linked to reconciliation is updated, moved, deleted, or undone, reopen matching reconciliation items by action-log ID rather than leaving them confirmed/matched.

Rationale: A sheet mutation can invalidate the prior reconciliation decision. Reopening keeps the system conservative and visible until a later state-machine pass decides which unchanged mutations can safely stay confirmed.

## 2026-06-20 - Use 60 Days For Normal Reconciliation Freshness

Decision: Normal unresolved reconciliation digest, inbox, and session views should exclude posted bank transactions older than 60 days by default through `BOOKIEBOT_RECONCILIATION_MAX_AGE_DAYS`.

Rationale: Old Plaid or cached transactions were resurfacing as if they were current work. Hiding older items from normal review keeps the inbox actionable without deleting historical records.

## 2026-06-20 - Use Bank Amount After User Confirms A Match

Decision: Confirming an existing sheet/action row during reconciliation is the user's approval that the row represents the bank transaction. If that row's amount differs, BookieBot should update the sheet/action amount to the bank transaction amount and then confirm the reconciliation item.

Rationale: The human-in-the-loop step is selecting the matching row. After that selection, the bank transaction is the source of truth for the amount, and the user should not have to manually edit the price before reconciliation can complete.

## 2026-06-20 - Require Explicit Row Choice For Grouped Amount Adjustments

Decision: Grouped reconciliation matches should still reject mismatched totals by default. If the user chooses one row in the group to absorb the difference, BookieBot may update that row amount to make the grouped total match the bank transaction and then confirm the group.

Rationale: Grouped matches involve multiple sheet rows, so BookieBot should not guess which row should change. The human confirmation is selecting both the group and the specific row to adjust.

## 2026-07-05 - Snapshot Closed-Month Formula Outputs

Decision: Monthly Google Apps Script rollover should freeze previous-month personal budget formula outputs for Burn Rate and subscription totals as static values before creating or relinking the new month.

Rationale: Closed-month review cells should remain auditable snapshots. Live formulas such as burn rate and subscription totals can recalculate after the calendar rolls forward, making historical months misleading.

## 2026-07-05 - Scope Expense Report Burn Rate To Variable Wants

Decision: The expense breakdown web report burn rate tracks food plus shopping spend against the selected month's wants target, computed as current food/shopping spend plus the Budget sheet's remaining wants budget.

Rationale: Subscriptions are wants in the category rollup, but they are fixed commitments rather than day-to-day discretionary burn. Keeping the web report burn rate scoped to variable wants makes the pace signal match how the budget is used.

## 2026-07-05 - Use Budget Totals For Burn-Rate Amounts

Decision: The expense breakdown burn-rate line uses itemized food/shopping entries for daily pacing shape, but scales the series to the Budget sheet's food/shopping total when itemized rows and Budget totals differ.

Rationale: The Budget sheet is the authoritative aggregate for the report, while the shared expense rows provide the best available daily timing. Scaling keeps the line chart consistent with the headline burn-rate totals without hiding daily spending patterns.

## 2026-07-07 - Serve Expense Report Snapshots By Default

Decision: Signed expense report links should serve the saved HTML snapshot first, and only perform a live Google Sheets rerender when no snapshot exists or the URL includes `live=1`.

Rationale: Reports generated from Discord should remain openable even if Google Sheets permissions or service-account access drift later. Live dashboard behavior belongs behind an explicit request until the report becomes a true app API surface with caching and refresh controls.

## 2026-07-08 - Preserve Signed Report URLs Behind Short Link Text

Decision: Expense breakdown Discord responses should keep signed report URLs but render them behind a short `Open full report` markdown label.

Rationale: The token protects report access and snapshot selection. A short display label removes Discord message clutter without weakening the signed report route.

## 2026-07-08 - Forced Inbox Shows Recent Automatic Matches

Decision: The reconciliation `View Inbox` forced refresh may include recent persisted `matched` reconciliation items in addition to the fresh unresolved preview.

Rationale: Automatic matches can be persisted by the original digest run and then disappear from later fresh previews. Reading recent persisted matches lets users inspect what the digest reported instead of seeing a misleading "all caught up" response.

## 2026-07-08 - Use Hit-So-Far Subscription Totals For Open Months

Decision: Expense breakdown reports use scheduled subscription pull dates from the Subscriptions sheet for current and future month subscription category totals, while completed months continue to use the Budget sheet totals.

Rationale: Open-month reports should reflect which subscriptions should have hit so far and show the full-month subscription amount as projection context. Completed months should preserve Budget sheet snapshot totals for historical review.

## 2026-07-16 - Treat Needs As A Shared Expense Category

Decision: New Need transactions are normal shared-expense rows in the monthly `Shared Expenses` Needs section (`AD:AH`) with date, item, amount, location, and person fields. Personal Brian/Hannah budget sheets receive only their aggregated Needs total through the existing sheet formula/import flow; BookieBot no longer inserts individual Need rows there.

Rationale: Using the normal expense writer and action lineage gives Needs the same update, move, delete, undo, reconciliation-reopen, and query behavior as other shared categories while keeping personal budget sheets as aggregate views.

## 2026-07-16 - Discover Personal Income Columns From Headers

Decision: Personal-budget income mutations discover Date, Source (or legacy Employer), and Amount from the visible Income header row. Existing undated month tabs remain supported, while new tabs copied from the Brian Budget 2026 Template use the shifted `B:D` Date/Source/Amount layout. BookieBot and bank reconciliation stamp dates on API writes, and the global Apps Script stamps dates for manual amount edits.

Rationale: Header discovery permits a safe mixed-layout rollout without breaking current month tabs, fixed-column assumptions, recent-action updates, undo metadata, or reconciliation matching. Explicit API-side dates are required because Google Sheets API writes do not trigger spreadsheet `onEdit` handlers.

## 2026-07-16 - Do Not Guess Historical Income Dates During Layout Migration

Decision: Migrate existing Income rows to the canonical `B:D` Date/Source/Amount layout without changing their source or amount. Backfill a historical date only when the BookieBot action log provides a reliable matching timestamp; otherwise leave the new Date cell blank. Migrate action-log Income column metadata and reliable row references with the sheet layout.

Rationale: Invented dates would corrupt financial history. Keeping values intact and moving action metadata with the rows preserves report accuracy and update/delete/undo targeting while allowing unmatched manually entered income to remain honestly undated.

## 2026-07-16 - Maintain One Trailing Income Placeholder Row

Decision: Personal budget Income tables keep exactly one trailing placeholder row. A completed manual or BookieBot entry replaces that row in place, then creates one new placeholder immediately beneath it by inheriting the completed row's format and validation. The Monthly Income formula is reset to cover the full header-to-placeholder range after each append.

Rationale: A single reusable seed keeps Templates compact, preserves sequential entry order, gives manual users an obvious next input row, and removes the need for multiple preformatted blanks while keeping Bot and Apps Script behavior identical.

## 2026-07-16 - Preserve Anchored Income Configuration During Row Compaction

Decision: Income deletion may compact a whole sheet row, but it must snapshot and restore the biweekly configuration anchored beside the first Income row, preserve the deleted row's explicit cell properties, and rebuild the Monthly Income formula from stored header and summary coordinates. Undo clears the temporary anchor copy before reinserting the original row.

Rationale: Dynamic Income entries in `B:D` share physical rows with fixed configuration in `E:F`, and Google Sheets row insertion/deletion does not reliably preserve formula ranges, borders, notes, validation, or row height. Treating the transaction cells and anchored configuration as separate logical regions keeps edit/delete/undo behavior safe without abandoning compact sequential rows.

## 2026-07-16 - Standardize Personal Subscription Sheets On Four Blocks

Decision: Personal budget `Subscriptions` tabs use the Brian four-block layout: Needs Monthly, Needs Yearly, Wants Monthly, and Wants Yearly, with schedule, name, amount, and subtotal fields. Budget tabs sum both cadence subtotals for each category. Migrations preserve unknown pull dates as blanks rather than assigning guessed dates.

Rationale: One visible structure keeps subscription parsing, reminders, reports, and future annual subscriptions consistent across both budget owners. Leaving unsourced dates blank preserves financial accuracy while making the missing schedule inputs explicit.

## 2026-07-16 - Persist Undated Subscription Drafts Without Scheduling Them

Decision: `_BookieBot Subscription Schedule` stores structurally complete visible subscription rows even when their pull date is missing, leaving `pull_day` and `pull_month` blank. Reminder and normalized schedule readers continue to return only entries with a valid pull day.

Rationale: Persisting drafts gives users a stable normalized scaffold while they research dates and prevents background sync from erasing known cadence/name/amount/source metadata. Excluding undated drafts from reminder reads prevents BookieBot from inventing or sending notifications for unknown dates.

## 2026-07-17 - Track Student Loan Only As Subscription Autopay

Decision: Remove BookieBot's dedicated student-loan payment logging and paid-status query intents, stop seeding Student Loan into the manual bill schedule, and ignore pre-existing legacy student-loan bill-schedule rows. Keep the subscription schedule as the active source and retain historical report labels for old budget data.

Rationale: The student loan is an automatic subscription pull and no longer has a standalone personal-budget payment row. Removing the manual payment workflow prevents failed writes, misleading paid-status checks, and duplicate bill/subscription reminders without erasing historical reporting.

## Pending Decisions

- Where should durable system events live: banking database only, Google Sheets only, or dual-write during transition?
- What exact reconciliation states should replace or extend the current status set?
- What should the canonical model be for recent-action lineages after update, move, delete, and undo?
