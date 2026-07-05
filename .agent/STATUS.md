# Agent Status

Last updated: 2026-07-05

## Active Focus

Recent transactions and reconciliation are in manual verification mode after the latest reliability fixes.

## On Deck

1. Manually verify recent transactions and reconciliation after the latest reliability fixes.
2. Consider a richer Discord button flow for grouped amount adjustments if the current UX feels too manual.
3. Harden recent-action pending state across restarts/deploys, since selections currently live only in process memory.
4. Improve targeted recent-action search so commands can find older matches, not only the latest 10 recent actions.
5. Explore clarifying questions before logging when BookieBot is uncertain instead of guessing or silently failing.

## Completed 2026-07-05

- Daily Spending transaction category labels now use the same category colors as the expense breakdown pie chart.
- Expense report top metrics now render in the requested order: Monthly Expenses, Monthly Income, Personal Outflows, Shared Expenses, Remaining Needs Budget, Remaining Wants Budget, Amount Saved, and Income After Expenses.
- Remaining Wants Budget is pulled from the second money value on the Budget sheet margins row, and Amount Saved sums the column `E` values on the `Enter 1st Paycheck Deposit` and `Enter 2nd Paycheck Deposit` rows while ignoring the separate savings total row.
- Daily Spending chart average now divides shared spending by every calendar day in the selected month instead of only days with logged expenses.
- Google Apps Script monthly rollover now snapshots previous-month personal budget Burn Rate and subscription total formula outputs into static cell values before creating/relinking the new month.
- Monthly tab creation no longer fails when a copied template is missing the exact `Month` placeholder; it falls back to a top-left existing month label and logs instead of aborting if no label can be found.
- Expense breakdown report pages now include a `Burn Rate` tab in the Budget Charts toggle, with a comparison chart for actual food plus shopping spend, expected spend, and the selected month's remaining-wants-budget-derived target.
- Rebuilt the embedded React expense report assets and added regression coverage for the burn-rate payload math.
- Spreadsheet access errors now include the active service account email when available, making deployed Google Sheets permission or credential mismatches easier to diagnose.
- Daily Spending chart now appears at the top of the Daily Spending transaction card instead of inside the Budget Charts toggle.
- Burn Rate now renders as a full-month daily variance line chart with a zero baseline, red over-pace values above zero, and green under-pace values below zero.
- Burn Rate chart rendering now uses continuous day-to-day colored segments so the mobile line does not visually disconnect when switching between over-pace and under-pace days.
- Burn Rate tooltips now render one active-day variance row and shared chart tooltips filter duplicate payload rows, preventing duplicate values from accumulating while tapping nodes on mobile.

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
   - Expected: the DM/private inbox list shows unresolved transactions with `Reconcile Now` and `Ignore All`.
20. Run the expense breakdown command for the current month and for a completed prior month.
   - Expected: the report link opens a page with a `Burn Rate` tab inside Budget Charts; the tab shows a full-month daily variance line with red values above the zero baseline and green values below it, and the elapsed portion stays visually connected on mobile even when the color changes; tapping several burn-rate nodes in succession shows one tooltip value for the active day without duplicate rows accumulating; current-month pace counts elapsed days, completed months count every day in that month, and Amount Saved equals the two paycheck deposit values from column `E` without double-counting the savings total row.
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
   - Expected: Average day equals shared spending divided by the total calendar days in that selected month.
44. Run `budgetSystemRollover` from Apps Script on a test copy or after making a safe template backup.
   - Expected: the previous personal budget month has static values in Burn Rate, Static Bills & Subscriptions (Needs), and Subscriptions (Wants) formula output cells; the current month tab exists even if the copied template did not contain an exact `Month` placeholder.

## Verification Baseline

Recommended targeted tests for the active workstream:

```bash
python -m pytest unit_tests/banking/test_reconciliation.py unit_tests/banking/test_store.py unit_tests/core/test_bank_reconciliation.py
python -m pytest unit_tests/intents/test_handlers.py unit_tests/core/test_message_router.py
```

Latest verification:

```bash
cd web/expense-report && npm run typecheck
# passed

cd web/expense-report && npm run build
# passed

python -m pytest unit_tests/reports/test_expense_breakdown.py
# passed

git diff --check
# passed

python -m pytest unit_tests
# passed: 349 passed, 1 skipped

python -m pyright
# failed: /opt/anaconda3/bin/python: No module named pyright
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
