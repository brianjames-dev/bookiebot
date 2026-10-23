# Bank reconciliation

BookieBot checks bank transactions against expenses you already logged. It does not automatically log purchases or move money.

## In the app

**Reconcile** appears when your account has a connected bank account with transaction watching enabled. Brian and Hannah see only their own accounts. Existing Discord review remains available.

1. Open **Reconcile**. The initial list reads saved bank data without querying Sheets or starting a bank sync.
2. Tap **Check** to sync your bank and compare recent transactions with existing logs and schedules. The timestamp describes the bank data; the bank may still report a delayed or pending charge.
3. Open a **Needs review** row to see suggestions. **Confirm match** checks an exact-amount match without rewriting an expense.
4. **Pending** shows authorizations and tentative matches. These remain read-only until posted; the posted replacement replaces its pending entry.
5. **Checked** includes automatic matches, confirmed matches and ignored transactions. **Reopen review** changes the reconciliation status only; it does not undo an expense or an earlier sheet correction.

If your bank needs another sign-in, Reconcile shows **Reconnect [bank name]** and warns that transactions and pending statuses may be out of date. Tap it, then **Reconnect bank**, and complete the secure Plaid/bank sign-in. The return page verifies a real sync and reports success or a retryable failure. Return to Reconcile and tap **Check** to compare the newly available transactions. Plaid may deliver the missed updates asynchronously after authentication; repeat Check if necessary. Canceling bank sign-in leaves the existing data and warning intact.

If amounts differ, both amounts are shown. Correct the logged expense in BookieBot, then tap Check. An unlogged bill expectation is labeled **Not logged yet**; it cannot confirm that a payment was recorded. Existing subscription totals already count their scheduled occurrences, so an exact subscription match can verify that occurrence without adding another expense.

Unmatched purchases remain for manual logging. Phone review does not provide the existing Discord import or amount-adjustment workflows. An import already in progress stays read-only and requires its existing recovery flow.

After a failed request, **Check status** reloads saved state before another action. Switching tabs preserves review state. Normal review covers the configured recent window (60 days by default), up to the latest 200 watched transactions; older history remains outside the normal inbox.

## In Discord

Discord and the app use the same saved review status. If a transaction is reviewed in the app while a Discord card or import form remains open, its old controls explain the current decision and safely continue the session. Changed/reopened transactions require a fresh review. The reverse order also produces an app conflict; **Check status** displays the saved decision.

Normal morning reconciliation uses **10–11 AM Pacific**. A failed bank sync produces a clear private health alert even if no cached transactions need review. A login-required alert includes a Reconnect button and the last successful sync time. Run **`/bank_reconnect`** at any time for a fresh private link; links expire after 15 minutes. Alerts are recorded only after Discord delivers them and do not consume the normal digest, so a successful morning repair can still produce that day's review prompt. Generic shared-channel fallback messages disclose no transaction or bank details.

The session retains its original batch: **Reconciling item `2` of `4`** follows the first decision. Both numbers use inline code. Skipped items can be reviewed later, items resolved in the app stop counting as skipped, and newly queued transactions wait for a new session. A completion message describes that batch rather than claiming no new transactions exist.

Discord's explicitly selected single/group amount corrections retain their existing behavior and validate the current bank/review state before changing Sheets. Normal forms and admin imports share one durable import operation; retries recover a recorded row or require inspection rather than writing another row. Pending, hidden, disconnected and changed transactions cannot be imported from an old form. An import in progress cannot be ignored/reopened by another review.

## Matching safeguards

- Automatic expense matches require exact cents, meaningful name evidence, a nearby transaction/authorization date and a clear winner. Similar amounts, unrelated merchants and ambiguous repeats stay in review.
- Normalized names recognize common bill variants, including PG&E/Pacific Gas and Electric and Comcast/Xfinity. The word “payment” alone is not evidence of a transfer.
- Recurring matches reserve an individual occurrence, rather than blocking that schedule forever. A monthly bill's recorded amount cannot prove a historical month's payment; unlogged expectations remain suggestions.
- Logged history is read across the relevant recent month/year boundaries in batches. Monthly rows retain their expense-month identity, and a logged bill plus its schedule share one claim. Reads never create a missing worksheet; source failures keep prior matching intact.
- Pending charges cannot finalize a match. A material bank change reopens prior matching; removed transactions stop reserving their old matches.
- Confirmed, ignored and in-progress import records survive rescoring with their lineage intact. Hiding an account does not release an existing claim on a logged expense.
- Both surfaces validate the reviewed bank/reconciliation version; phone confirmation also compares fresh candidate values. Database checks prevent two bank transactions from claiming the same expense. Review events retain the previous state for auditing.

## If bank updates stop

An available app or a working Discord DM does not prove that Plaid is receiving fresh bank data. Compare `bank_sync_state.last_success_at`, `last_sync_at` and `last_error` for the affected Item. The phone's **Checked** timestamp is the last successful application sync; **Check** requests a sync, while opening Reconcile or Discord **View Inbox** reads cached bank records. A successful sync itself does not guarantee that the bank has posted an authorization yet.

The October 23, 2026 investigation found Brian's Bank of America connection requires reauthentication: Plaid returns `ITEM_LOGIN_REQUIRED` at `/accounts/get`, before transaction sync. Last success was **October 15 at 7:00:45 AM Pacific**; the October 23 morning attempts still failed. The saved current-month inbox contains 53 records, including seven pending authorizations and zero unresolved items. These authorizations cannot be assumed to remain pending at the bank while updates are blocked.

At investigation time, Discord's 10 AM bill/subscription reminder continued working while reconciliation was separately configured for 7 AM. The old digest hid sync errors behind an empty cached preview, and Item-error webhooks were skipped. The reconnect release changes the default/example send hour to 10; update the existing Railway `BOOKIEBOT_BANK_RECONCILIATION_SEND_HOUR` override to **10** during rollout as well. It exposes phone/Discord health alerts and handles Item ERROR and LOGIN_REPAIRED notifications. A queued error received before a newer successful sync cannot undo the healthy state.

Recovery uses [Plaid Link update mode](https://plaid.com/docs/link/update-mode/) for the **existing Item**, followed by the user's bank reauthentication. BookieBot uses [Hosted Link](https://plaid.com/docs/link/hosted-link/) for the secure browser/OAuth screens. Both the app alert and `/bank_reconnect` generate owner/Item-scoped links; credentials remain with Plaid/the bank. The original access token, Item/account IDs, watched settings, cursor and reconciliation/import history are retained. `/debug_bank_link` remains new-bank setup and is not the repair flow. Do not purge history, reset the cursor or create a duplicate bank link to clear the error. Completion never exchanges a public token and clears the warning only after a real successful sync. No bank authentication cause beyond Plaid's login-required signal has been established.

Release and real-bank acceptance:

1. Complete the existing Item's bank reauthentication personally; retain saved review/import history and watched settings.
2. Run **Reconcile → Check**. Verify `last_success_at` advances beyond October 15, `last_error` clears and newly available bank transactions appear. Confirm the app shows the new check time.
3. Compare an actual posted transaction with its old pending authorization. Show only the posted replacement when the bank supplies the link/removal; do not create test purchases or assume all pending records should post.
4. Verify **View Inbox** reads the same saved decisions and dates. Observe the next normal **10–11 AM Pacific** reconciliation window for newly actionable items; preserve one successful digest per day and record delivery only after Discord succeeds. No review items is a valid quiet outcome only when sync health is clear.
5. Use synthetic fixtures/Sandbox for failure, cancellation and concurrent/delayed webhook checks. Automated regressions cover zero-item health alerts, separate post-delivery events, same-morning recovery, update-mode payloads, original token/cursor/history/watch preservation, pending replacement, HTTP/command owner scope and safe frontend links. Actual user sign-in, fresh production bank data and the next normal digest remain release acceptance; never create financial test transactions.

## Verification checklist

Use synthetic fixtures or Plaid Sandbox for financial-action testing; do not create test purchases in a real budget.

- Check Brian/Hannah isolation, disabled watching and a disconnected account.
- Exercise a pending authorization followed by its posted replacement; confirm only the posted transaction is actionable.
- Test exact bill/subscription names, merchant aliases, a one-cent difference, unrelated equal amounts, repeated purchases and a recurring payment next month.
- Confirm an exact match; refresh and repeat the request. Verify no extra expense row and no duplicate claim.
- Leave a row open, change its bank/logged amount, then confirm: require fresh review.
- Ignore/reopen a row, run Check and verify confirmed/ignored/import lineage remains intact.
- Simulate sync failure and lost responses; keep saved data visible and recover with Check status.
- Review the same transaction in both surfaces, submit stale controls in each order, and race a Discord amount correction against an app decision. Preserve the winning decision and one claim; verify fixed session progress through skips and new arrivals.
- On iPhone, verify all five tab targets, the compact bar, readable expanded comparisons and smooth disclosure motion in light/dark mode.
