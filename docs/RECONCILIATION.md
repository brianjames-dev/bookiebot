# Bank reconciliation

BookieBot checks bank transactions against expenses you already logged. It does not automatically log purchases or move money.

## In the app

**Reconcile** appears when your account has a connected bank account with transaction watching enabled. Brian and Hannah see only their own accounts. Existing Discord review remains available.

1. Open **Reconcile**. The initial list reads saved bank data without querying Sheets or starting a bank sync.
2. Tap **Check** to sync your bank and compare recent transactions with existing logs and schedules. The timestamp describes the bank data; the bank may still report a delayed or pending charge.
3. Open a **Needs review** row to see suggestions. **Confirm match** checks an exact-amount match without rewriting an expense.
4. **Pending** shows authorizations and tentative matches. These remain read-only until posted; the posted replacement replaces its pending entry.
5. **Checked** includes automatic matches, confirmed matches and ignored transactions. **Reopen review** changes the reconciliation status only; it does not undo an expense or an earlier sheet correction.

If amounts differ, both amounts are shown. Correct the logged expense in BookieBot, then tap Check. An unlogged bill expectation is labeled **Not logged yet**; it cannot confirm that a payment was recorded. Existing subscription totals already count their scheduled occurrences, so an exact subscription match can verify that occurrence without adding another expense.

Unmatched purchases remain for manual logging. Phone review does not provide the existing Discord import or amount-adjustment workflows. An import already in progress stays read-only and requires its existing recovery flow.

After a failed request, **Check status** reloads saved state before another action. Switching tabs preserves review state. Normal review covers the configured recent window (60 days by default), up to the latest 200 watched transactions; older history remains outside the normal inbox.

## Matching safeguards

- Automatic expense matches require exact cents, meaningful name evidence, a nearby transaction/authorization date and a clear winner. Similar amounts, unrelated merchants and ambiguous repeats stay in review.
- Normalized names recognize common bill variants, including PG&E/Pacific Gas and Electric and Comcast/Xfinity. The word “payment” alone is not evidence of a transfer.
- Recurring matches reserve an individual occurrence, rather than blocking that schedule forever. A monthly bill's recorded amount cannot prove a historical month's payment; unlogged expectations remain suggestions.
- Logged history is read across the relevant recent month/year boundaries in batches. Monthly rows retain their expense-month identity, and a logged bill plus its schedule share one claim. Reads never create a missing worksheet; source failures keep prior matching intact.
- Pending charges cannot finalize a match. A material bank change reopens prior matching; removed transactions stop reserving their old matches.
- Confirmed, ignored and in-progress import records survive rescoring with their lineage intact. Hiding an account does not release an existing claim on a logged expense.
- Phone decisions validate the reviewed bank version and fresh candidate values. Database checks prevent two bank transactions from claiming the same expense. Review events retain the previous state for auditing.

## Verification checklist

Use synthetic fixtures or Plaid Sandbox for financial-action testing; do not create test purchases in a real budget.

- Check Brian/Hannah isolation, disabled watching and a disconnected account.
- Exercise a pending authorization followed by its posted replacement; confirm only the posted transaction is actionable.
- Test exact bill/subscription names, merchant aliases, a one-cent difference, unrelated equal amounts, repeated purchases and a recurring payment next month.
- Confirm an exact match; refresh and repeat the request. Verify no extra expense row and no duplicate claim.
- Leave a row open, change its bank/logged amount, then confirm: require fresh review.
- Ignore/reopen a row, run Check and verify confirmed/ignored/import lineage remains intact.
- Simulate sync failure and lost responses; keep saved data visible and recover with Check status.
- On iPhone, verify all five tab targets, the compact bar, readable expanded comparisons and smooth disclosure motion in light/dark mode.
