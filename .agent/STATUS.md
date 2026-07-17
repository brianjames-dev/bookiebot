# Agent Status

Last updated: 2026-07-17

## Active Focus

Shared Needs-category logging, the shifted dated Income layout, and the four-block personal subscription layout are implemented. Hannah's live subscription sheet now matches Brian's Monthly/Yearly structure while retaining her data and totals.

## On Deck

1. Manually verify shared Needs logging plus update/move/delete/undo behavior in Discord and Google Sheets.
2. Manually verify recent transactions and reconciliation after the latest reliability fixes.
3. Consider a richer Discord button flow for grouped amount adjustments if the current UX feels too manual.
4. Harden recent-action pending state across restarts/deploys, since selections currently live only in process memory.
5. Improve targeted recent-action search so commands can find older matches, not only the latest 10 recent actions.
6. Explore clarifying questions before logging when BookieBot is uncertain instead of guessing or silently failing.

## Completed 2026-07-16

- Replaced personal-budget Need row insertion with normal shared-expense logging in the monthly Needs section (`AD:AH`).
- Need logging now separates item, location, person, and amount while applying the automatic shared-expense date.
- New Need rows now use standard expense lineages and support item/amount/location/person updates, moves into or out of Needs, delete compaction, undo, and reconciliation-link reopening.
- Added Needs to move buttons, direct text routing, and bank reconciliation expense categories.
- Included Needs in category totals, highest-category, largest-expense, and top-expense queries.
- Added regression coverage for storage location, legacy description compatibility, editable fields/capabilities, move/delete/undo behavior, category routing/selectors, parser instructions, and Needs query inclusion.
- Shifted the Brian Budget 2026 Template Income table from `A:C` to `B:D`, repaired the monthly-income total and budget-banner formula lineage, and preserved the adjacent biweekly-income configuration.
- Made income logging discover Date, Source/Employer, and Amount from visible headers so existing legacy month tabs and newly copied dated Template tabs both work during rollout.
- Added bot-side Pacific-date stamping, reconciliation transaction-date propagation, recent-action/update compatibility, and header-driven Apps Script date stamping for manual Income entries.
- Migrated the May, June, and July tabs in both Brian and Hannah Budget 2026, plus Hannah's Template, to the `B:D` Date/Source/Amount layout without changing the existing source/amount data or monthly totals.
- Backfilled Income dates only where a matching BookieBot action timestamp provided reliable history, preserved Brian July's xAI biweekly configuration, and migrated action-log column metadata/row references for the new locations.
- Updated the expense breakdown parser to read the Income table from its visible headers, including income rows that share a sheet row with biweekly configuration labels.
- Income actions remain editable after an update and can now be deleted with row compaction; undo reinserts the row and restores the full active lineage and affected action-row references.
- Discord typing-indicator API failures are now non-fatal, so a transient Discord `5xx` cannot abort intent parsing or prevent an otherwise valid transaction from being logged.
- Added regression coverage for failed typing-context entry and for preserving real parser/handler exceptions through the typing wrapper.
- Reduced the live Brian Budget 2026 Template Income section to one `Date / Source / Amount` placeholder row while preserving its formatting, validation, notes, total formula, and budget-banner reference.
- Income logging now fills the trailing placeholder in place and creates exactly one new placeholder beneath it with inherited formatting; the summary formula is repaired after each append.
- The Apps Script applies the same behavior to manual edits, including source-first or amount-first entry order, automatic date stamping, row-height/style copying, and legacy Employer placeholders.
- Reduced the live Hannah Budget 2026 Template Income section to one `<Enter Source>` row while preserving its style, validation, notes, Monthly Income formula, budget-banner reference, and adjacent biweekly configuration.
- BookieBot now reapplies the seed row's explicit formatting, validation, notes, borders, and row height after Google Sheets inserts a new Income row, covering properties that `inheritFromBefore` omits.
- Live Hannah integration verification logged two sequential dated Income entries on a temporary Template copy, retained exactly one trailing placeholder, calculated `$191.34`, and removed the temporary QA tab afterward.
- Income delete and immediate undo now snapshot and restore anchored biweekly configuration cells, explicit row properties, and the Monthly Income summary formula while compacting whole rows.
- Live Brian July verification on a temporary copy covered first-row delete/undo, later-row delete/undo, and immediate undo; every path preserved the `E:F` configuration, repaired the `D` summary formula, and restored the original sheet values/formulas exactly before the QA tab was removed.
- Replaced Hannah's live two-block Subscriptions tab with Brian's native four-block Needs/Wants Monthly/Yearly layout, preserving all eight Needs and three Wants entries as monthly data plus the `$180.20` and `$23.97` subtotals.
- Extended Brian's Needs Monthly body styling through Hannah's eighth row, repaired Template/May/July references to the new Monthly+Yearly subtotal cells, retained the old tab as a hidden backup, and kept unknown pull dates blank instead of inventing them.
- Live Google Sheets and PDF-render verification confirmed matching reference styles, correct formulas/totals, parser-ready block structure, hidden infrastructure tabs, no broken cell formulas, and no remaining staging sheet.
- Subscription schedule sync now retains rows with valid cadence/name/amount but unknown pull dates as normalized drafts; reminder readers continue to exclude those drafts until `pull_day` is populated.
- After Hannah removed Amazon Prime, repopulated her live `_BookieBot Subscription Schedule` with all ten current monthly rows, blank date fields, source ranges, and timestamps; current visible subtotals are `$163.94` Needs and `$23.97` Wants.
- Replaced Hannah's visible subscription roster from the final dated list: seven monthly Needs, one yearly Need, five monthly Wants, and one yearly Want; visible subtotals are `$521.07`, `$32.99`, `$47.95`, and `$59.99` respectively.
- Synced all fourteen dated entries into `_BookieBot Subscription Schedule` with cadence, amount, pull day/month, source range, and timestamp metadata; every row is reminder-eligible and a repeat sync produced no warnings.
- Restored Internet as a `$0.00` Needs Monthly placeholder with a blank pull day; the normalized schedule retains it as an undated draft while the fourteen dated subscriptions remain reminder-eligible.
- Removed the standalone `Student Loan Payment` budget row from Hannah's Template, May, June, and July tabs; each tab compacted cleanly, retained its subscription-backed Needs row, and automatically shifted subtotal, rollover, margins, savings, and net formulas to the new locations.
- Retired the dedicated student-loan log/check intents, handlers, sheet helpers, intent-explorer entries, fixtures, and legacy default bill-schedule row; pre-existing student-loan bill rows are ignored so the payment is represented only by subscription autopay, while historical report categorization remains available.
- Manual verification: deploy the updated Apps Script, run `setupBudgetSystemAutomation()` once, enter an amount in a new dated Income table, then confirm manual and BookieBot income dates plus update/delete/undo behavior.

## Completed 2026-07-08

- Reconciliation `View Inbox` now includes recent persisted automatic matches when a forced inbox refresh no longer has those matches in the fresh preview.
- Auto-match-only reconciliation inbox reports no longer show `Reconcile Now` / `Ignore All` actions, avoiding a misleading action view when there are no unresolved rows.
- Expense breakdown Discord replies keep signed report tokens but render them behind a short `Open full report` markdown link.
- Expense report top charts now use a carousel instead of the four-chart tab bar; mobile can swipe between charts and desktop has previous/next controls with active indicators.
- The `Subs` chart now uses an inline All/Needs/Wants filter, highlights the current day, animates calendar switches, shows hit-so-far subscription totals with a projected monthly total, and keeps subscription detail tables collapsed behind `Details`.
- Current/future-month subscription category totals now use scheduled hit-so-far subscription amounts from the Subscriptions sheet, while completed months keep using the Budget sheet totals.
- The Income card now has a temporary `2x` paycheck forecast toggle that updates income-dependent top-card values client-side.
- Expense Highlights now places its Largest/Most Frequent toggle in the card header, and table expanders append remaining rows with the collapse control at the bottom.
- Rebuilt the embedded React expense report assets and added regression coverage for the short report link, reconciliation auto-match inbox behavior, and the new report UI hooks.

## Completed 2026-07-07

- Expense report pages now support system-aware dark mode with a header toggle that persists manual light/dark choices.
- Rebuilt the embedded React expense report assets and added regression coverage for the dark-mode toggle, persisted theme key, and system preference CSS.
- Expense report tabs now size to their labels instead of stretching, Amount Saved only uses the positive accent when it is near the savings goal, loose personal-budget NEED rows appear as `Need Expenses`, and the old bottom Rent and Income Entries tables have been removed.
- Bills & Utilities now renders a historical comparison chart from prior budget month tabs, and the largest-expenses chart truncates long item labels on the axis.
- The top `Budget Charts` card now replaces the old `Needs vs Wants` tab with `Subscriptions` and `Bills & Utilities` tabs, removing the duplicate lower Subscriptions and Bills & Utilities cards.
- Expense report display copy now shortens subscription labels to `Subs` in Budget Charts and category breakdown labels while preserving the original spreadsheet labels for parsing.
- Expense report top metrics now remove the Fixed Commitments and Burn Rate cards; Budget Charts panels now place their primary totals/status above each graph with right-aligned pills for Burn Rate, Subs, and Bills & Utilities.
- Expense report links now serve the saved HTML snapshot before attempting a live Google Sheets rerender, optional historical workbook reads no longer block reports after the month tabs are resolved, and the Discord handler reports sheet access errors cleanly.
- Expense report dashboard now uses four top cards (`Income`, `Spent`, `Left`, `Saved`), defaults Budget Charts to Burn Rate when available, and moves secondary chart stats and long tables behind `Details` / `View all`.
- Discord startup now logs each login attempt, respects retry-after hints on login rate limits, emits periodic backoff progress logs, and preserves retry metadata in JSON logs with real microsecond timestamps.
- Expense report pages no longer render the top burn-rate signal strip; loose personal-budget NEED rows are included in daily activity, merchant totals, and largest-expense highlights as undated Need Expenses; expanded highlight tables now reveal only the remaining rows instead of duplicating the first five.

## Completed 2026-07-06

- Expense report top metrics now replace the redundant `Personal Outflows` card with `Fixed Commitments`, calculated from rent, bills/utilities, subscriptions needs, and subscriptions wants.
- Expense report pages now combine `Largest Expenses` and `Frequent Merchants` into one `Expense Highlights` toggle card, with a chart and itemized list for each view.
- The `Largest Expenses` itemized list now uses only Item, Category, and Amount columns.
- Expense report subscription tables now include all active subscriptions from the Subscriptions sheet, including yearly items outside the selected report month such as Amazon Prime and MacroFactor, while fallback monthly bucket totals remain selected-month scoped.
- Rebuilt the embedded React expense report assets and added regression coverage for fixed commitments, subscription table completeness, and the combined expense highlights card labels.
- Expense report subscriptions now render as one tabbed Needs/Wants card with a selected-month calendar visual above each source-of-truth itemized list; monthly subscriptions appear in the selected month, while yearly subscriptions only appear on the calendar for their pull month.
- Pyright is now installed through `requirements.txt` with a source-focused `basic` config, and the source modules touched to satisfy the initial gate now pass `python -m pyright`.
- Expense report copy is more compact, generated time moved into the header pill, Expense Highlights now uses `Largest` and `Most Frequent` tab labels, Daily Spending bar hover uses a clearer highlighted cursor, and the Subscriptions card now defaults to an `All` calendar tab alongside Needs and Wants.
- Expense report Subscriptions `All` mode now shows compact side-by-side Needs and Wants itemized tables on desktop, stacks them on mobile, and calendar markers use visible hover/focus tooltips instead of unreliable native title text.
- Expense report subscription tables now omit the `Kind` column, All-mode compact tables include `Pull Date`, subscription tab switches use a subtle fade/slide animation, and the side-by-side All tables stay top-aligned even when one table is shorter.

## Completed 2026-07-05

- Daily Spending transaction category labels now use the same category colors as the expense breakdown pie chart.
- Expense report top metrics now render in the requested order: Monthly Income, Monthly Expenses, Personal Outflows, Burn Rate, Remaining Needs Budget, Remaining Wants Budget, Amount Saved, and Income After Expenses.
- Remaining Wants Budget is pulled from the second money value on the Budget sheet margins row, and Amount Saved sums the column `E` values on the `Enter 1st Paycheck Deposit` and `Enter 2nd Paycheck Deposit` rows while ignoring the separate savings total row.
- Daily Spending chart average now divides shared spending by elapsed days for the selected month, using the full calendar month only for completed months.
- Google Apps Script monthly rollover now snapshots previous-month personal budget Burn Rate and subscription total formula outputs into static cell values before creating/relinking the new month.
- Monthly tab creation no longer fails when a copied template is missing the exact `Month` placeholder; it falls back to a top-left existing month label and logs instead of aborting if no label can be found.
- Expense breakdown report pages now include a `Burn Rate` tab in the Budget Charts toggle, with a comparison chart for actual food plus shopping spend, expected spend, and the selected month's remaining-wants-budget-derived target.
- Rebuilt the embedded React expense report assets and added regression coverage for the burn-rate payload math.
- Spreadsheet access errors now include the active service account email when available, making deployed Google Sheets permission or credential mismatches easier to diagnose.
- Daily Spending chart now appears at the top of the Daily Spending transaction card instead of inside the Budget Charts toggle.
- Burn Rate now renders as a full-month daily variance line chart with a zero baseline, red over-pace values above zero, and green under-pace values below zero.
- Burn Rate chart rendering now uses continuous day-to-day colored segments so the mobile line does not visually disconnect when switching between over-pace and under-pace days.
- Burn Rate tooltips now render one active-day variance row and shared chart tooltips filter duplicate payload rows, preventing duplicate values from accumulating while tapping nodes on mobile.
- Burn Rate tooltips now explain each selected day with day spent, cumulative spent, and expected-by-day values, while the static side stats no longer duplicate expected spend against the monthly wants target.
- Burn Rate tab now removes the redundant title/description side copy and uses a smoothed animated line chart so first-open behavior matches the other Recharts views more closely.
- Category Mix pie slices now label category plus dollar amount directly, and the burn-rate line uses a smooth baseline-aware gradient so over-zero sections render red and under-zero sections render green.
- Burn Rate hover dots now match the hovered point's over/under baseline color, report chart tooltips disable wrapper position animation, and Category Mix pie labels plus connector lines fade in smoothly with matching slice colors and text/stem spacing.
- Category Mix hides pie labels and connector stems on phone widths while keeping the full-size donut, and Burn Rate only plots elapsed days for the selected current month while keeping the `$0` baseline inside the chart domain.
- Merchant analysis shows the top 10 merchants and no longer appears as a Budget Charts tab or side-stat panel.
- The Spending By Person / Card panel has been removed, and zero-dollar paycheck savings deposits now render Amount Saved as `$0.00` instead of `N/A`.

## Completed 2026-07-03

- Expense breakdown report pages now define a browser-safe `window.process.env.NODE_ENV` shim before loading the embedded React bundle.
- The expense report Vite build now replaces `process.env.NODE_ENV` with `"production"`, preventing Node-style dependency checks from crashing report pages in Chrome.
- Rebuilt the committed React expense report asset and added regression coverage for the process shim in rendered report HTML.
- Expense breakdown report mobile styling now uses a shared responsive page gutter for the header and content cards.
- Report cards, grids, tabs, charts, and table wrappers now shrink within the viewport on narrow phones, with dense tables scrolling inside their cards instead of pushing the page sideways.
- Expense report metric cards now render two per row on narrow mobile, producing three compact rows without overflowing 320px-wide viewports.

## Completed 2026-06-20

- User-entered date updates are no longer accepted in the recent transaction update flow; the date field is reserved for reconciliation-origin automation that can use the bank transaction date.
- Recent-action update, move, delete, and undo paths now reopen linked reconciliation items by action-log ID so confirmed/matched bank items do not stay stale after the sheet row changes.
- Reconciliation action-link reopening supports grouped match IDs such as `id1+id2`.
- Normal unresolved reconciliation inbox/digest/session views now use a 60-day max transaction age through `BOOKIEBOT_RECONCILIATION_MAX_AGE_DAYS`.
- Old unresolved reconciliation records remain in storage, but they are excluded from normal unresolved review views unless lower-level/admin code asks without an age cutoff.
- Added regression tests for date rejection, reconciliation reopen hooks after recent-action mutations, grouped action-link reopening, and the 60-day unresolved-item cutoff.
- Existing-row reconciliation amount mismatches are resolved by the user's match confirmation: once the user chooses the matching row, BookieBot updates the sheet amount to the bank transaction amount and confirms the reconciliation item.
- Added regression coverage proving single-row mismatch confirmation updates the matched sheet/action row to the bank amount after the user selects the match.
- Recent-action move prompts now explain when an item name is needed because the destination category requires it.
- Pending move-item replies can now be canceled without using `cancel` as the item name.
- Recent-action move no longer asks users to supply missing dates manually; missing source-row dates produce a system/source-row correction message.
- Move category buttons now omit the transaction's current category and use source-category-aware prompt copy.
- Grouped reconciliation amount mismatches now offer a normal button-based adjustment path: choose one selected row to absorb the delta, update it to the bank-total-compatible amount, and confirm the group.
- Added regression coverage for grouped match adjustment, adjustment buttons, and updated mismatch guidance.
- One-word `recent` now routes directly to recent transactions instead of falling through to LLM parsing.
- Expense sheet access now retries once before failing, which protects normal expense logging from a transient Google Sheets access miss.
- Updated income recent-action rows now display as income and keep the amount/source in the correct fields after source-only updates.
- Large recent-action DM lists are now split into Discord-safe chunks by complete transaction blocks, with controls attached to the final chunk and a generic channel acknowledgement after successful DM delivery.

## Completed 2026-06-18

- Updated expenses can now be moved to another expense category.
- Already moved expenses can now be moved again.
- Deleting an updated expense now deletes the active action lineage, so the original expense does not reappear in recent actions after deletion.
- Deleting a moved expense now deletes the active moved lineage without reactivating stale source actions.
- Undoing those deletes restores the expected sheet rows and action visibility.
- Added regression tests for updated-action move, moved-action move, updated-action delete, and moved-action delete.
- Added explicit recent-action capabilities for update, move, delete, undo, and editable fields.
- Recent-action decision buttons now only show supported operations for the selected transaction.
- Unsupported delete/move/update paths now return clearer reasons for Need expense, payment, savings, and other unsupported cases.
- Income rows can now be updated for source/amount and deleted from recent transactions.
- Added regression tests for capability computation, button visibility, income update, and income deletion.
- Added 300-second TTLs for pending recent-action selections, pending update-field replies, and pending move-item replies.
- Expired pending replies now return a clear "selection expired" message instead of falling through to unrelated commands or current recent-action indexes.
- Added regression tests for expired pending delete selection, expired update-field replies, expired move-item replies, and router numeric replies.
- Recent-action lists, candidate prompts, mutation prompts, and mutation results now send privately to the requesting user when Discord DMs are available.
- Recent-action component responses are now ephemeral, and controls reject interactions from users other than the original actor.
- Added regression tests for private recent-action delivery and non-owner interaction rejection.
- DM replies to recent-action update prompts are now accepted even when BookieBot is restricted to a configured public channel.
- Recent-action component view timeouts now match the 300-second pending-state TTL.
- Added regression tests for DM update-field replies and five-minute component view timeouts.
- Reconciliation digest channel messages now show only a generic count/summary and instruct the target user to review privately.
- Daily reconciliation digest eligibility is now limited to the configured morning send window instead of any time after the send hour.
- Added regression tests proving after-window Plaid/new-item availability does not post a daily digest later in the day.
- Reconciliation digests now send by DM with `Reconcile Now` and `View Inbox` controls.
- Reconciliation `Ignore All` now lives only on the inbox list view, not on each individual transaction review.
- Bills and subscriptions digests now send by DM instead of posting cash-pull details to the shared channel.

## Current Notes

- The broader backlog now lives in `.agent/WORKSTREAM_FINANCE_OPS.md`.
- The task execution/update process lives in `.Agents`.
- Reconciliation freshness and digest lifecycle remain important, but they are not the immediate implementation focus.
- Structured event logging is deferred. Railway/app logs are enough for now unless future debugging gaps prove otherwise.
- We decided not to add a stale status right now; normal unresolved review uses the 60-day freshness filter only.
- The current recent-action tests pass for existing happy paths:
  - listing and paging
  - updating normal expense fields
  - deleting normal expenses with compaction
  - moving normal expenses with compaction
  - undoing update/delete/move

## Manual Test Checklist

Use a test row or low-risk real row in Discord:

1. Log a food expense, then update its amount, then move it to shopping.
   - Expected: food cells clear, shopping receives the updated amount, recent actions show the moved transaction.
2. Log a grocery expense, move it to food, then move it again to shopping.
   - Expected: grocery and food cells clear, shopping contains the transaction once.
3. Log two food expenses, update the older one, then delete the updated one.
   - Expected: the other food expense shifts up, the deleted/updated one does not reappear in recent actions.
4. Immediately run `undo last transaction` after that delete.
   - Expected: the updated deleted row is restored and appears as the current recent action again.
5. Log a grocery expense, move it to food, then delete the moved expense.
   - Expected: the food row clears and the old grocery source does not reappear.
6. Run `undo last transaction`.
   - Expected: the moved food row is restored.
7. Log income, then select it from recent actions.
   - Expected: `Update`, `Delete`, and `Cancel` are offered; `Move` is not shown.
8. Update a recent income row's source and amount, then undo it.
   - Expected: the income sheet source and amount change, then undo restores the original values.
9. Delete a recent income row by index, then undo it if needed.
   - Expected: the logged income row is removed from the income sheet.
10. Select a recent payment or savings deposit.
   - Expected: `Update` and `Cancel` are offered, while move/delete controls are not shown.
11. Ask to delete a matching transaction, wait more than 5 minutes, then type `1`.
   - Expected: the bot says the recent transaction selection expired and does not delete anything.
12. Start an update from the controls, wait more than 5 minutes at the "Reply with the new ..." prompt, then reply.
   - Expected: the bot says the recent transaction selection expired and does not update the row.
13. Move a grocery/gas transaction to food without an item, wait more than 5 minutes, then reply with an item name.
   - Expected: the bot says the recent transaction selection expired and does not move the row.
14. Run `recent actions` from Discord.
   - Expected: the transaction list appears in your DM, while the channel only receives a generic acknowledgement.
15. Click a recent-action control from the DM workflow.
   - Expected: follow-up prompts/results are only visible to you.
16. Select `Update`, choose `Item`, `Amount`, or `Location`, then reply in the DM with the new value.
   - Expected: the selected transaction updates and the reply is not ignored or routed to unrelated intent parsing.
17. Have another user try to operate on a recent-action component from your workflow if a stale/public component exists.
   - Expected: the bot says the workflow belongs to another user and does not mutate anything.
18. Let the scheduled reconciliation digest post in the morning window.
   - Expected: the digest appears in the target user's DM with `Reconcile Now` and `View Inbox`.
19. Click `View Inbox` on the reconciliation digest.
   - Expected: the DM/private inbox list shows unresolved transactions with `Reconcile Now` and `Ignore All`; if the digest only has automatic matches, the inbox shows the confirmed match report without unresolved action buttons.
20. Run the expense breakdown command for the current month and for a completed prior month.
   - Expected: the report link appears as a short `Open full report` link and opens a page whose top chart card title changes with the active carousel chart (`Category Mix`, `Burn Rate`, `Subs`, or `Bills & Utilities`); mobile can swipe between charts and desktop can use previous/next controls plus active indicators; the Burn Rate chart keeps the red/green variance behavior and cursor-stable tooltip; Category Mix labels show category plus amount on desktop and hide labels on phone widths; the Income card `2x` forecast toggle immediately updates income-dependent top-card values; the `Subs` chart has an inline All/Needs/Wants filter, shows the month-only label above the hit-so-far amount, shows projected monthly subs as secondary text, uses a `# total` pill, highlights the current day, animates view switches, keeps itemized sub tables collapsed behind `Details`, uses `Pull` as the pull-date column, and shortens monthly/yearly cadence to `M`/`Y` on mobile; Expense Highlights keeps its Largest/Most Frequent toggle in the card header; table expanders append remaining rows and place Collapse at the bottom; Daily Spending has no subtitle copy and its bar hover has a subtle highlighted background.
21. If the expense breakdown command reports that a spreadsheet cannot be opened.
   - Expected: the error includes the active Google service account email so the spreadsheet share settings or deployment credential can be checked directly.
22. Click `Reconcile Now` from either the digest or inbox view.
   - Expected: the one-at-a-time transaction review appears, and individual transaction cards do not include `Ignore All`.
23. Let the scheduled bills/subscriptions digest run.
   - Expected: cash-pull details appear in the target user's DM, not the shared channel.
24. Trigger or wait for a Plaid sync after the morning window.
   - Expected: new unresolved items do not cause a daily digest to appear in the channel later that day.
25. Try to update a recent transaction's date through text or parsed entities.
   - Expected: BookieBot rejects `date` as an editable field and the sheet date cell does not change.
26. Reconcile a bank transaction to an existing recent action, then update that recent action's amount/item/location.
   - Expected: the linked reconciliation item is reopened for review instead of staying silently confirmed.
27. Reconcile a bank transaction to an existing recent action, then move, delete, or undo that recent action.
   - Expected: the linked reconciliation item returns to the inbox/review state so the user can confirm what should happen next.
28. Add or leave an unresolved posted bank transaction older than 60 days, then open the normal reconciliation digest or inbox.
   - Expected: the old transaction does not appear in the normal unresolved list; recent unresolved transactions still appear.
29. Confirm an existing sheet/action row whose amount does not match the bank transaction.
   - Expected: BookieBot treats your match selection as confirmation, updates the sheet amount to the bank transaction amount, and confirms the reconciliation item.
30. Move a grocery or gas transaction into food without providing an item name.
   - Expected: BookieBot asks for the item name and explains it is needed for the destination category.
31. Reply `cancel` to a pending move item-name prompt.
   - Expected: BookieBot cancels the move and does not write `cancel` as the item name.
32. Try moving a source row that is missing its date.
   - Expected: BookieBot refuses the move with a source-row/date correction message instead of asking you to type a date.
33. Start a move from a grocery transaction using the move controls.
   - Expected: the destination category buttons do not include `Grocery`.
34. Try a grouped reconciliation match whose selected rows do not exactly total the bank transaction.
   - Expected: BookieBot shows the mismatch and offers buttons for which selected row should absorb the difference.
35. Click the row that should absorb the difference.
   - Expected: BookieBot updates that row amount to make the group total match, then confirms the grouped reconciliation item.
36. Type `recent`.
   - Expected: BookieBot shows recent transactions directly and does not attempt to log or access the expense sheet.
37. If Google Sheets has a one-time access hiccup while logging an expense.
   - Expected: BookieBot retries once before reporting a sheet access failure.
38. Update only the source/name on a recent income row, then run `recent`.
   - Expected: the row displays as `Updated: Income` and still shows the original amount with the updated source.
39. Run `show 15 recent transactions`, `show 20 recent transactions`, or `show 25 recent transactions`.
   - Expected: BookieBot sends the list privately across multiple DM messages, each transaction stays within a single DM message, code blocks render cleanly, controls appear on the final DM, and the public channel gets a generic sent-to-DMs acknowledgement.
40. Run the expense breakdown command for a recent month and open the generated report link in Chrome.
   - Expected: the React expense dashboard renders instead of a blank page, and the console does not show `process is not defined`.
41. Open the expense breakdown report on a narrow mobile viewport, such as 320px or 390px wide.
   - Expected: the title card and content cards have matching left/right gutters, the eight metric cards render as four two-card rows, and the page has no document-level horizontal scroll.
42. Open the Daily Spending table in the expense breakdown report.
   - Expected: the Daily Spending chart appears above the itemized day-by-day transaction table, and each bold category label uses the same color as that category in the breakdown pie chart and legend.
43. Open the Daily Spending chart in a report for a known month.
   - Expected: Average day equals shared spending divided by elapsed days for the selected month, while completed months use every calendar day in that month.
44. Run `budgetSystemRollover` from Apps Script on a test copy or after making a safe template backup.
   - Expected: the previous personal budget month has static values in Burn Rate, Static Bills & Subscriptions (Needs), and Subscriptions (Wants) formula output cells; the current month tab exists even if the copied template did not contain an exact `Month` placeholder.
45. If Discord login hits a global `429` rate limit during startup.
   - Expected: Railway logs show the login attempt number, retry delay, retry-at timestamp, and periodic backoff progress until the next login attempt. Avoid repeated redeploys while Discord is still rate-limiting the bot.
46. Log `Need expense $40 for a doctor copay at Kaiser` from Hannah's Discord account, then inspect the current month in Shared Expenses and both personal budget sheets.
   - Expected: one Needs row appears in Shared Expenses with an automatic date, item `doctor copay`, location `Kaiser`, person `Hannah`, and `$40.00`; no individual transaction row is inserted into Hannah's personal budget sheet, whose Needs bucket receives only the aggregate.
47. From `recent`, update that Need transaction's item, location, amount, and person/card one field at a time.
   - Expected: all four fields update in the Shared Expenses Needs row, the date remains unchanged, and the recent action remains editable/movable/deletable.
48. Move the Need transaction to Shopping, then move it back to Needs using both the Discord buttons and a text command such as `move it to Needs`.
   - Expected: the source category cells clear/compact, the destination receives the complete transaction exactly once, and Needs is offered as a move destination unless it is already the current category.
49. Place two test transactions in Needs, delete the older one from recent actions, then immediately undo.
   - Expected: the newer Needs row compacts upward after delete; undo restores both rows in order with all date/item/amount/location/person values intact.
50. On a migrated May, June, or July personal budget tab, log an Income entry, update its source or amount, delete it from recent actions, and immediately undo.
   - Expected: Date/Source/Amount populate in `B:D`, the report includes the dated entry, delete compacts the Income rows, and undo restores the row and its editable lineage without changing the monthly total beyond the expected transaction amount.
51. Retry `Brian (BofA) purchased celebration dinner at Jackson's bar and grill for $140` after deployment.
   - Expected: the expense reaches intent parsing and logs normally; if Discord's typing endpoint returns another transient error, logs show a warning that processing continued instead of `Failed to parse intent` from `send_typing`.
52. After deploying the Apps Script, enter a real Source and Amount in the sole Income placeholder on a safe month tab, then log a second Income entry through BookieBot.
   - Expected: the first entry replaces the seed row, each completed entry receives a date, exactly one new placeholder appears directly below with matching format/validation, later entries remain sequential, and Monthly Income includes every completed row.
53. Copy Hannah's Template to a safe test month and log two Income entries through Hannah's BookieBot account.
   - Expected: the entries occupy consecutive `B:D` rows with dates, every generated row retains the seed's formatting/validation/notes/height, exactly one `<Enter Source>` placeholder remains, and the Monthly Income formula includes both entries.
54. In Brian July, delete and undo the first Income entry, then repeat with the later entry and with an immediate undo after logging test Income.
    - Expected: the `Biweekly Income Start` configuration remains anchored in `E:F`, Monthly Income always sums the current `D` rows, the Budget section retains its total reference, and undo restores the deleted row's values and formatting.
55. Run `/debug_subscriptions` after deployment and inspect Hannah's visible and normalized subscription sheets.
    - Expected: fourteen dated entries are reminder-eligible; Internet is retained as a `$0.00` monthly draft with one expected missing-pull-date warning; the four visible subtotals remain `$521.07`, `$32.99`, `$47.95`, and `$59.99`.
56. Open Hannah Budget 2026 Template, May, June, and July and inspect the Needs section.
    - Expected: no standalone `Student Loan Payment` row remains; `Subscriptions (Needs)` and `Various Need Transactions` remain intact; May's net is `-$606.05`, July's Needs subtotal is `$688.12 (84.98%)`, and July's net is `$618.53`.
57. After deployment, send `student loan paid?` and `log student loan payment 242.29`, then run `/debug_subscriptions`.
    - Expected: neither message invokes a dedicated student-loan payment command or mutates a budget row; the Student Loan subscription/autopay remains present and reminder-eligible in Hannah's normalized subscription schedule.

## Verification Baseline

Recommended targeted tests for the active workstream:

```bash
python -m pytest unit_tests/banking/test_reconciliation.py unit_tests/banking/test_store.py unit_tests/core/test_bank_reconciliation.py
python -m pytest unit_tests/intents/test_handlers.py unit_tests/core/test_message_router.py
```

Latest verification:

```bash
PYTHONPATH=src venv/bin/python -m pytest unit_tests
# passed: 393 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

PYTHONPATH=src venv/bin/python -m pytest unit_tests/intents/test_parser.py unit_tests/intents/test_handlers.py unit_tests/intents/test_outputs.py unit_tests/sheets/test_bills.py unit_tests/sheets/test_utils.py unit_tests/core/test_subscription_reminder_schedule.py unit_tests/reports/test_expense_breakdown.py
# passed: 190 passed, 1 warning

Live Hannah Student Loan Payment row removal and formula/visual audit
# passed: no matching row in Template/May/June/July; formula ranges shifted cleanly; no QA tabs remain; final PDF renders clean

PYTHONPATH=src venv/bin/python -m pytest unit_tests/reports/test_expense_breakdown.py unit_tests/sheets/test_utils.py
# passed: 57 passed

Live Hannah Internet subscription placeholder sync
# passed: Internet persisted at Subscriptions!B14:D14 and in the normalized schedule; 14 eligible rows plus 1 expected missing-date warning

PYTHONPATH=src venv/bin/python -m pytest unit_tests/sheets/test_subscription_reminders.py unit_tests/core/test_subscription_reminder_schedule.py
# passed: 28 passed

Live Hannah subscription roster and normalized schedule sync
# passed: 14 dated rows, 0 parse warnings; repeat sync stable

Live Hannah subscription formula and visual audit
# passed: visible subtotals $521.07/$32.99/$47.95/$59.99; Template/May/July Needs $554.06 and Wants $107.94; final PDF render clean

PYTHONPATH=src venv/bin/python -m pytest unit_tests/sheets/test_subscription_reminders.py
# passed: 10 passed

venv/bin/python -m pytest unit_tests
# passed: 392 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

node --check < scripts/google-apps-script/budget-system-automation.gs
# passed

git diff --check
# passed

Live Hannah subscription draft sync
# passed: 10 monthly rows persisted with blank dates; 0 reminder-eligible until dates are supplied

Live Google Sheets API style/formula audit plus PDF render of Hannah Budget 2026 / Subscriptions
# passed: Brian reference style match, $180.20 Needs, $23.97 Wants, formula links repaired, parser-ready layout, hidden backup

venv/bin/python -m pytest unit_tests
# passed: 391 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

node --check < scripts/google-apps-script/budget-system-automation.gs
# passed

git diff --check
# passed

venv/bin/python -m pytest unit_tests
# passed: 389 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

node --check --input-type=commonjs < scripts/google-apps-script/budget-system-automation.gs
# passed

git diff --check
# passed

venv/bin/python -m pytest unit_tests
# passed: 387 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

git diff --check
# passed

venv/bin/python -m pytest unit_tests
# passed: 385 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

node --check --input-type=commonjs < scripts/google-apps-script/budget-system-automation.gs
# passed

git diff --check
# passed

venv/bin/python -m pytest unit_tests
# passed: 378 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

git diff --check
# passed

cd web/expense-report && npm run build
# passed

python -m pytest unit_tests/reports/test_expense_breakdown.py
# passed: 11 passed

python -m pyright
# passed

python -m pytest unit_tests
# passed: 363 passed, 1 skipped

git diff --check
# passed
```

Previous supporting checks:

```bash
python -m py_compile src/bookiebot/reports/expense_breakdown.py
# passed

node --check --input-type=commonjs < scripts/google-apps-script/budget-system-automation.gs
# passed

python -m pytest unit_tests/reports/test_expense_breakdown.py
# 5 passed

Headless Chrome mobile emulation for generated report HTML at 320px and 390px
# document scrollWidth matched viewport width; metric cards rendered as two equal columns with no metric value overflow.

Headless Chrome mobile emulation for generated report HTML at 390px
# top metric card labels/values matched requested order; Daily Spending category colors matched breakdown legend colors.

Headless Chrome mobile emulation for generated June report HTML
# Daily Spending tab showed Average day $10.00 for $300 shared spending across 30 calendar days.

python -m pytest unit_tests
# 348 passed, 1 skipped

git diff --check
# passed

python -m pyright
# Failed: pyright is not installed in the current Python environment.
```
