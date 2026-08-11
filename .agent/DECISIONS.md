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

## 2026-07-09 - Keep iOS App Conversion Planning Separate

Decision: Add `app_conversion_blueprint/` as a standalone planning and new-repo handoff package. The blueprint recommends a future local-database-first iOS app with Google Sheets as export/sync output and a minimal Plaid bridge, but it does not change the current Discord bot runtime.

Rationale: The app conversion is a product and architecture direction that should be easy to copy into a fresh project without coupling early iOS planning to the existing Google Sheets and Discord implementation.

## 2026-07-09 - Use Downloadable Local AI Pack As Primary App Assistant

Decision: The iOS app blueprint should target a downloadable Qwen 4B-class local AI model pack as the primary assistant provider, with Apple Foundation Models kept as fallback/lightweight mode. The stronger model should be offered during onboarding rather than prebundled in the app.

Rationale: The desired app experience needs a smarter and larger-context chat agent than Apple's lightweight on-device model. A post-install model pack keeps the base app small, makes the privacy/storage tradeoff explicit to the user, and preserves local-only finance chat by default.

## 2026-07-16 - Treat Needs As A Shared Expense Category

Decision: New Need transactions are normal shared-expense rows in the monthly `Shared Expenses` Needs section (`AD:AH`) with date, item, amount, location, and person fields. Personal Brian/Hannah budget sheets receive only their aggregated Needs total through the existing sheet formula/import flow; BookieBot no longer inserts individual Need rows there.

Rationale: Using the normal expense writer and action lineage gives Needs the same update, move, delete, undo, reconciliation-reopen, and query behavior as other shared categories while keeping personal budget sheets as aggregate views.

## 2026-07-16 - Discover Personal Income Columns From Headers

Decision: Personal-budget income mutations discover Date, Source (or legacy Employer), and Amount from the visible Income header row. Existing undated month tabs remain supported, while new tabs copied from the Brian Budget 2026 Template use the shifted `B:D` Date/Source/Amount layout. BookieBot and bank reconciliation stamp dates on API writes, and the global Apps Script stamps dates for manual amount edits.

Rationale: Header discovery permits a safe mixed-layout rollout without breaking current month tabs, fixed-column assumptions, recent-action updates, undo metadata, or reconciliation matching. Explicit API-side dates are required because Google Sheets API writes do not trigger spreadsheet `onEdit` handlers.

## 2026-07-16 - Do Not Guess Historical Income Dates During Layout Migration

Decision: Migrate existing Income rows to the canonical `B:D` Date/Source/Amount layout without changing their source or amount. Backfill a historical date only when the BookieBot action log provides a reliable matching timestamp; otherwise leave the new Date cell blank. Migrate action-log Income column metadata and reliable row references with the sheet layout.

Rationale: Invented dates would corrupt financial history. Keeping values intact and moving action metadata with the rows preserves report accuracy and update/delete/undo targeting while allowing unmatched manually entered income to remain honestly undated.

## 2026-07-16 - Maintain One Trailing Income Placeholder Row (Superseded 2026-07-17)

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

## 2026-07-17 - Insert Income Rows Only When Transactions Are Logged

Decision: Personal budget Templates keep one initial Income seed row. The first Income event consumes that seed, while each later BookieBot event inserts a copied/formatted row immediately above Monthly Income. Completed tables retain no trailing placeholder. Apps Script stamps dates and repairs the summary formula but does not create blank rows. Source and label values are collapsed when they repeat or overlap.

Rationale: Just-in-time insertion preserves sequential formatting without displaying a false `$0.00` Income entry. Treating the seed replacement as a cell restoration for undo keeps a new month reusable, while later inserted transactions retain normal row-delete undo semantics. Source normalization prevents parser aliases from appearing twice in the single visible Source field.

## 2026-07-17 - Re-Anchor Biweekly Projections From Actual Paychecks

Decision: Expense breakdown Income projections use Biweekly Income Start only to bootstrap the schedule. After a dated Income entry matches the configured biweekly source, the latest actual paycheck becomes the anchor and remaining current-month projections advance every fourteen days from that date. Projected totals add those future occurrences to the amount already logged.

Rationale: Payroll deposits can arrive slightly early or late. Keeping the original static cadence after an actual shift can leave a projected paycheck in the past and consume the remaining projection before the real month-end payday. Actual dates provide the most accurate forward schedule while retaining explicit configuration for months with no observed paycheck yet.

## 2026-07-17 - Keep Discord Expense Breakdown Replies Concise

Decision: Expense-breakdown replies in Discord include only the person/month heading, Total Spent, signed full-report link, and pie-chart attachment. Category-by-category values remain in the linked web report and the chart rather than being repeated as message text.

Rationale: The Discord response should be quick to scan and avoid sending a large duplicate payload when the full interactive breakdown is already available behind the signed report link.

## 2026-07-17 - Use Cascaded Category Rollover For Category Mix Balances

Decision: Needs and Wants Category Mix views use dedicated payload fields sourced from the Budget sheet's category Rollover cells as their `Income left` values, leaving existing margin fields and Burn Rate semantics unchanged. Positive rollover is a pie slice; negative rollover is displayed separately as overspend. Wants uses the sheet's cascaded rollover, which includes any positive or negative Needs remainder, and the report calls out a negative Needs impact explicitly. Projected mode applies the same 50% Needs, 30% Wants, then Needs-to-Wants cascade.

Rationale: Rollover is the sheet's authoritative available-money value for each category. Keeping negative values out of a pie preserves valid chart geometry, while a separate bar makes overspending visible and explains why Needs overspend reduces the later Wants bucket.

## 2026-07-17 - Use A Source-Aware Three-Bucket Category Cascade

Decision: Supersede the fixed Needs-to-Wants Category Mix cascade with three separate raw Budget-sheet margin balances. Needs deficits draw from Wants then Savings; Wants deficits draw from Savings then Needs; Savings deficits (`Over saving`) draw from Wants then Needs. Each donor retains its positive balance until a source-specific rule uses it, and any uncovered remainder becomes total budget overspend.

Rationale: The sheet's cumulative Rollover formulas encode one fixed sequence and can consume Needs before Savings when Wants is overspent. An explicit transfer ledger preserves the same total money while honoring the requested priorities, supporting a Savings view, and explaining both source overspending and downstream donor impacts in current and projected reports.

## 2026-07-22 - Project Savings From Numbered Paycheck Targets (Superseded 2026-07-22)

Decision: Treat each discovered numbered paycheck savings row as a separate contribution slot with its own Actual, Ideal, and Minimum values. Current report mode includes slots reached by observed paychecks or entered deposits. Projected mode preserves entered deposits, adds remaining detected paycheck slots, scales their sheet targets with the existing income projection, and uses each empty slot's projected Ideal as its projected saved amount. Completed months remain actual-only. The report's Saved card, Left amount, outflow, and Savings Category Mix must all consume the same active-mode savings amount.

Rationale: The personal budget sheets now support three paycheck savings entries, and a fixed current savings value made the Projected toggle internally inconsistent. Basing both targets and projected contributions on the sheet's numbered rows keeps the budget sheet authoritative, supports two- and three-paycheck months, and makes every savings visualization describe the same current or projected scenario.

## 2026-07-22 - Apply The Savings Target Once Per Month

Decision: Use reached savings rows to determine the current month's aggregate Ideal and Minimum rates, rounded to the nearest basis point so sheet-cent rounding does not distort the percentage. Apply each rate once to projected monthly income, regardless of whether the month has two or three paycheck rows. Preserve entered contributions and estimate each unentered projected contribution from the monthly projected Ideal divided by the projected paycheck count.

Rationale: A savings row is a contribution slot, not an additional monthly allocation. Scaling every row by projected income made three rows produce a 30% Ideal even though the Budget model's aggregate target is 20%. Separating the one monthly target from its per-paycheck contribution schedule preserves the sheet's current values while keeping projected Ideal and Minimum mathematically consistent.

## 2026-07-24 - Render View Inbox From Persisted Reconciliation State

Decision: The reconciliation digest's `View Inbox` action reads current-month unresolved and matched items already persisted in the banking store. It does not run Plaid sync, reconciliation rescoring, action-log reads, or schedule-sheet hydration. Inbox preparation must have a bounded timeout and return a private failure message without mutating reconciliation state when it cannot complete.

Rationale: The scheduled digest has already synchronized and persisted the state the user is asking to inspect. Repeating external network and sheet work after Discord defers the component made a read-only button slow and capable of leaving an indefinite thinking response. Persisted reads make the interaction deterministic while `Reconcile Now` remains the explicit path for active review work.

## 2026-07-25 - Complete Deferred Discord Responses In Place

Decision: When a Discord component is deferred with `thinking=True`, its first success, empty, timeout, or error result must edit the original interaction response. Follow-up messages are reserved for additional chunks after that original response is complete. Component paths whose established workflow only sends follow-up cards use a non-thinking defer.

Rationale: A follow-up webhook message does not replace Discord's original private thinking placeholder. Editing the original response gives every deferred interaction one explicit terminal state and prevents a successful or failed reconciliation inbox load from appearing to run forever.

## 2026-07-25 - Prioritize Actionable Reconciliation Inbox State

Decision: A persisted reconciliation inbox reads its cache summary from the same banking store and date window as its unresolved and matched items. When unresolved items exist, their rows and controls appear before automatic-match history and are attached to the first Discord response; match history may continue in later chunks.

Rationale: Synthetic zero-valued cache metadata contradicts the persisted item count, while placing a long audit report before unresolved transactions can hide the work the user opened the inbox to perform. One consistent store snapshot and action-first ordering keep the summary truthful and the inbox immediately usable.

## 2026-07-25 - Use Channel Typing For Reconciliation Components

Decision: Reconciliation component callbacks acknowledge with `thinking=False`, run their work inside a resilient Discord channel typing context, and return results through private follow-ups. This applies to `View Inbox`, `Reconcile Now`, and inbox mutation controls.

Rationale: Discord's `thinking=True` defer creates a temporary response instead of the familiar channel-level `BookieBot is typing...` UI. A silent acknowledgement preserves the three-second component deadline, typing communicates progress consistently with message-driven workflows, and ephemeral follow-ups keep financial results private.

## 2026-07-25 - Bridge Typed Recent Requests Into Ephemeral Interactions

Decision: A message-triggered recent-action request sends a five-minute launcher DM containing no financial data. Opening the launcher silently acknowledges the component, deletes the launcher, and sends the prepared list ephemerally. BookieBot retains the latest authorized interaction follow-up for ten minutes so later typed replies and pagination remain ephemeral. DM-originated requests do not receive a sent-to-DMs acknowledgement.

Rationale: Discord cannot mark an ordinary bot-authored DM as ephemeral. A disposable launcher is the smallest bridge that preserves the natural-language `recent` entry while giving the transaction list and full workflow Discord's native `Only you can see this · Dismiss message` treatment.

## 2026-07-26 - Keep Savings Actual, Spending Savings-Free, And Reserve Savings From Left

Decision: Expense-report Saved values always come from actual numbered savings deposits read at report build time, even when Projected is active. Projected income may change monthly Ideal/Minimum targets and the remaining savings gap, but it does not estimate future deposits. Spent and Category Mix spending exclude savings; Left is Income minus Spent minus actual Saved. Detailed Needs/Wants itemization is the primary expense total and category subtotals are fallback data. Burn Rate uses Wants availability after the same three-bucket category cascade shown in Category Mix.

Rationale: Moving money to savings is not spending, but it is also no longer available cash. Keeping actual deposits separate from both expenses and projected targets makes Spent, Saved, and Left describe distinct concepts, while applying the shared category cascade to Burn Rate prevents Needs overspending from leaving the Wants pace artificially unchanged.

## 2026-07-26 - Use Budget-Sheet Category Totals For Available Money

Decision: Supersede the arithmetic definition of Left above. Current Left is the Budget sheet's Net Total after its Needs, Wants, and Savings margins and cross-category coverage. Spent remains the separately computed elapsed outflow without savings. Category Mix All uses that elapsed itemization, while Needs, Wants, and Savings use the sheet's category subtotals and allocations. Projected mode keeps current category usage and Saved actual, creates penny-safe 50/30/20 budgets from projected income, and cascades those projected balances.

Rationale: Open-month subscription rows contain both full budget commitments and only the charges elapsed so far. Subtracting elapsed Spent and Saved from Income overstated available budget by the unelapsed subscription commitments. Using the sheet's category totals preserves its `$794.00` source-of-truth Net Total while keeping `$5,133.70` Spent an honest actual-outflow metric.

## 2026-07-31 - Treat Savings As One Monthly Overwriteable Bucket

Decision: Supersede the numbered paycheck savings workflow. Current Budget tabs and Templates contain one `Enter Monthly Savings Contribution` row whose Actual value is overwritten by `log_savings`; `query_savings` reads the same value. The row's Ideal is the full Savings allocation (20% of monthly income) and Minimum is half that allocation (10% of monthly income). Expense reports calculate current and projected targets directly from those fixed income rates and never multiply targets by paycheck count or project the actual saved value. Historical numbered rows remain readable only for backward-compatible reporting and checks.

Rationale: Savings is a monthly allocation, not one independent target per paycheck. Repeating a 10% per-row target across a three-paycheck month incorrectly produced a 30% Ideal and made command semantics depend on payroll cadence. One overwriteable total matches the Budget sheet's 50/30/20 model, prevents double-counting, and keeps the sheet, Discord workflow, and report card aligned.

## 2026-07-31 - Retain The Typed Recent Interaction Launcher

Decision: Reaffirm the 2026-07-25 launcher bridge after testing direct delivery. A typed recent-action request sends a short-lived button with no financial data; tapping it returns the list through an ephemeral interaction and removes the launcher. Do not replace it with an ordinary direct DM list unless native Discord interaction semantics change.

Rationale: Direct delivery removes one tap but produces a persistent bot-authored DM without the `Only you can see this · Dismiss message` treatment. The launcher is the required interaction boundary for preserving the preferred temporary, dismissible recent-action workflow while retaining natural-language entry.

## 2026-07-31 - Compress Only Strong Daily-Spending Outliers

Decision: Daily Spending includes entered Rent and Bills & Utilities events as Needs. When the highest day is at least `$500` and `2.5x` the second-highest day, the chart keeps values through a rounded second-highest threshold linear, compresses only the range above that threshold into a short upper band, and labels the axis adjustment in the chart. Totals, tooltips, details, and transaction rows always retain the true dollar amounts; months and filters without a strong outlier keep the existing scale.

Rationale: Rent is a real monthly outflow and belongs in daily cash-flow history, but a normal linear or square-root range makes every other day too small to compare. A disclosed broken-axis treatment keeps rent visible, preserves the relative shape of ordinary spending, and avoids presenting transformed bar heights as unqualified dollar values.

## 2026-07-31 - Scope Subscription Reporting To The Selected Month

Decision: Supersede the 2026-07-26 use of full Budget-sheet category subtotals, margins, and Net Total in expense reports. When a structured subscription schedule is available, monthly subscriptions count only when they have a valid pull day, yearly subscriptions count only in their configured pull month, and undated drafts do not count. Current mode includes scheduled items that have hit through the selected month's elapsed day; Projected includes every dated item scheduled within that same month. Needs/Wants spending, category-cascade balances, Burn Rate availability, Calendar details, and Left all derive from the same active month-scoped breakdown plus actual savings. Sheet subtotals remain a compatibility fallback only when no structured subscription schedule exists.

Rationale: Budget-sheet subscription subtotals aggregate monthly and yearly items without regard to the selected report month. Reusing those totals made annual Amazon Prime and MacroFactor charges appear in July category usage and available-money calculations even though neither charge occurs in July, while Calendar and Daily Spending correctly omitted them. One month-scoped schedule keeps every card and graph reconcilable without inventing dates for incomplete subscription drafts.

## 2026-07-31 - Include Wants Subscriptions In Burn Rate Activity

Decision: Burn Rate Spent includes Food, Shopping, and elapsed Wants subscriptions. Dated Wants subscriptions enter the daily series on their configured pull day; future pulls remain excluded from Current, and any legacy subscription amount without a usable schedule is attributed as a fallback without scaling or redistributing the dated Food/Shopping series. Burn Rate's effective limit remains the active Wants spending plus the post-cascade Wants balance.

Rationale: Category Mix and Daily Spending already classify Wants subscriptions as Wants spending. Excluding them from Burn Rate produced a `$39.96` discrepancy in Brian July and made the generic `Spent` label describe only discretionary activity. Including the same month-scoped subscription events makes all three Wants views reconcile while preserving the category-cascade effect on available money.

## 2026-08-02 - Carry One Prior Paycheck Into New-Month Projections

Decision: When an open selected month has no matching paycheck yet, Expense Breakdown may use the immediately prior calendar month's latest dated paycheck matching the configured biweekly source as projection-only amount and cadence context. Missing current-month source/start configuration inherits from that prior month. The prior paycheck is never counted as selected-month actual income or rendered as an actual selected-month event; a matching selected-month paycheck supersedes it. Older, undated, or mismatched income is not eligible. January may read the previous annual workbook's December tab through the same optional history path.

Rationale: A paycheck near month-end is the most accurate anchor for the next biweekly occurrences, but new month tabs begin with zero income and may omit copied projection configuration. Carrying exactly one prior-month actual preserves Current accounting boundaries while allowing Projected income, savings targets, category budgets, Calendar, Daily Spending, and Burn Rate to work before the first new-month paycheck is logged. Limiting the reference to the immediately prior month avoids silently projecting from stale employment income.

## 2026-08-02 - Live-Render Current-Month Signed Reports

Decision: Supersede the 2026-07-07 snapshot-first rule for the selected current month only. A normal signed current-month Expense Breakdown URL rebuilds from current Sheets data; its saved HTML remains the automatic fallback when the live rebuild fails. Completed-month URLs remain snapshot-first for audit stability. `live=1` continues to force a rebuild for any month, while `snapshot=1` explicitly requests the saved current-month file.

Rationale: Current-month reports are interactive operational views whose Projected values depend on newly logged income and corrected projection logic. Serving the embedded snapshot indefinitely can make a correct backend fix invisible and leave the Projected toggle at `$0.00`. Live-rendering only the open month keeps the page current while preserving resilient fallback behavior and stable historical snapshots.

## 2026-08-03 - Separate Gross Clearing Amount From Personal Split Responsibility

Decision: A shared split keeps the original gross amount in the immutable source action lineage for bank reconciliation and writes the payer's calculated share to the visible expense row used by Budget and Expense Breakdown. A separate visible `Shared Reimbursements` ledger links the source action and records gross, split method, payer share, partner share, and settlement state. Reimbursement receipts settle that ledger without creating income or changing the already-netted expense. Undo may restore gross and void an outstanding allocation; undoing a paid allocation requires a future explicit settlement-handling workflow.

Rationale: One number cannot simultaneously represent the amount that cleared the bank and the amount ultimately borne by the payer. Separating clearing, responsibility, and settlement preserves reconciliation/audit history while making the sheet and report accurately reflect personal spending. Blocking implicit paid-split reversal prevents a completed reimbursement from being erased without an explicit refund or correction decision.

## 2026-08-03 - Treat Split Method Changes As Reversible Lineage

Decision: Changing an outstanding split creates a child split action that recalculates both shares from the preserved gross amount and updates the reimbursement ledger's active split-action reference. Undo restores the immediately prior method and shares. Canceling an outstanding split requires confirmation, restores gross, voids the receivable, marks active split actions undone, and records a cancellation system event so the original transaction can become the active recent-action leaf again. Any received reimbursement blocks these operations until an explicit settlement-correction workflow exists.

Rationale: Editing the original split in place would erase how responsibility changed, while treating cancellation as transaction deletion would corrupt the bank-clearing history. Reversible lineage preserves each allocation decision, keeps reconciliation anchored to gross, and gives outstanding and paid receivables intentionally different safety boundaries.

## 2026-08-07 - Keep Parser Failures Separate From Conversational Fallback

Decision: Retry transient OpenAI transport/server/rate failures at the LLM client boundary. If retries are exhausted, or the provider returns malformed or unknown structured intent data, raise a parser failure and tell the user no change was made. Reserve the `fallback` intent for an explicit valid model decision that the message does not match BookieBot functionality. Route high-confidence bill log/check grammar for Rent, PG&E, Recology, and Water before the LLM.

Rationale: Treating an OpenAI `500` as `fallback` caused a second model call and generic budgeting advice for a valid mutation request. The error boundary must distinguish "unsupported request" from "intent service unavailable," while local routing keeps a small set of safety-critical, unambiguous bill commands operational without turning the router into a second general parser.

## 2026-08-07 - Minimize Reads Before Bill-Payment Writes

Decision: Cache current-month worksheet handles by spreadsheet/month, load a bill row once, reuse that row's prior value for undo metadata, and treat the successful Google Sheets update response as write confirmation instead of issuing a read-before-write plus read-after-write. Retry only classified pre-write read-quota failures with bounded asynchronous backoff and distinguish them from permissions/missing-sheet errors.

Rationale: Google Sheets enforces a per-user read quota for the shared service account. Reopening the same workbook/tab and rereading the target cell around every idempotent bill-cell update consumed avoidable quota. Pre-write read retries are safe because no mutation has occurred; explicit classification also prevents a quota `429` from being presented as a sharing/permission problem.

## 2026-08-11 - Model Covered Expenses As 0/100 Responsibility Allocations

Decision: A shared expense paid by one person but wholly owned by the other uses the existing split lineage with method `covered`, payer share `$0`, and partner share equal to the immutable gross. The source action retains the payer/person and gross for bank reconciliation. The visible shared-expense row retains the gross amount but changes its Person to the responsible partner so that partner's budget/report owns the spending. `Shared Reimbursements` remains payer-owned and adds responsible owner, original person, and responsible person columns; counterpart queries may read that canonical ledger without mirroring rows. Reimbursement settlement remains ledger-only. Covered mode is limited to shared expense rows until personal bill cells support explicit cross-workbook ownership.

Rationale: Payment, budget responsibility, and reimbursement are three separate facts. Logging repayment as income, zeroing the expense, or duplicating the expense would distort reports or bank reconciliation. A 0/100 allocation reuses the established gross/action/settlement lineage while person attribution makes the expense visible to the person who ultimately owns it. One canonical receivable avoids dual-ledger synchronization, and the shared-row boundary prevents implicit cross-workbook mutations for Rent and utilities.

## Pending Decisions

- Where should durable system events live: banking database only, Google Sheets only, or dual-write during transition?
- What exact reconciliation states should replace or extend the current status set?
- What should the canonical model be for recent-action lineages after update, move, delete, and undo?
