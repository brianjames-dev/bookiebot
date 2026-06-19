# Agent Status

Last updated: 2026-06-18

## Active Focus

Harden the recent transactions flow where a user chooses a logged action and updates, moves, or deletes it.

## On Deck

1. Decide whether date updates should be exposed in the UI.
2. Synchronize reconciled action mutation with reconciliation items.
3. Add regression tests for date update behavior and reconciled action mutation.

## Completed 2026-06-18

- Updated expenses can now be moved to another expense category.
- Already moved expenses can now be moved again.
- Deleting an updated expense now deletes the active action lineage, so the original expense does not reappear in recent actions after deletion.
- Deleting a moved expense now deletes the active moved lineage without reactivating stale source actions.
- Undoing those deletes restores the expected sheet rows and action visibility.
- Added regression tests for updated-action move, moved-action move, updated-action delete, and moved-action delete.
- Added explicit recent-action capabilities for update, move, delete, undo, and editable fields.
- Recent-action decision buttons now only show supported operations for the selected transaction.
- Unsupported delete/move/update paths now return clearer reasons, including income, Need expense, payment, and savings cases.
- Added regression tests for capability computation, button visibility, and unsupported income deletion.
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
- Reconciliation freshness, digest lifecycle, and event logging remain important, but they are not the immediate implementation focus.
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
   - Expected: only `Cancel` is offered in the action decision controls.
8. Try to delete a recent income row by index.
   - Expected: the bot says income cannot be deleted from recent transactions yet and suggests undo if it was the last logged action.
9. Select a recent payment or savings deposit.
   - Expected: `Update` and `Cancel` are offered, while move/delete controls are not shown.
10. Ask to delete a matching transaction, wait more than 5 minutes, then type `1`.
   - Expected: the bot says the recent transaction selection expired and does not delete anything.
11. Start an update from the controls, wait more than 5 minutes at the "Reply with the new ..." prompt, then reply.
   - Expected: the bot says the recent transaction selection expired and does not update the row.
12. Move a grocery/gas transaction to food without an item, wait more than 5 minutes, then reply with an item name.
   - Expected: the bot says the recent transaction selection expired and does not move the row.
13. Run `recent actions` from Discord.
   - Expected: the transaction list appears in your DM, while the channel only receives a generic acknowledgement.
14. Click a recent-action control from the DM workflow.
   - Expected: follow-up prompts/results are only visible to you.
15. Select `Update`, choose `Item`, `Amount`, or `Location`, then reply in the DM with the new value.
   - Expected: the selected transaction updates and the reply is not ignored or routed to unrelated intent parsing.
16. Have another user try to operate on a recent-action component from your workflow if a stale/public component exists.
   - Expected: the bot says the workflow belongs to another user and does not mutate anything.
17. Let the scheduled reconciliation digest post in the morning window.
   - Expected: the digest appears in the target user's DM with `Reconcile Now` and `View Inbox`.
18. Click `View Inbox` on the reconciliation digest.
   - Expected: the DM/private inbox list shows unresolved transactions with `Reconcile Now` and `Ignore All`.
19. Click `Reconcile Now` from either the digest or inbox view.
   - Expected: the one-at-a-time transaction review appears, and individual transaction cards do not include `Ignore All`.
20. Let the scheduled bills/subscriptions digest run.
   - Expected: cash-pull details appear in the target user's DM, not the shared channel.
21. Trigger or wait for a Plaid sync after the morning window.
   - Expected: new unresolved items do not cause a daily digest to appear in the channel later that day.

## Verification Baseline

Recommended targeted tests for the active workstream:

```bash
python -m pytest unit_tests/banking/test_reconciliation.py unit_tests/banking/test_store.py unit_tests/core/test_bank_reconciliation.py
python -m pytest unit_tests/intents/test_handlers.py unit_tests/core/test_message_router.py
```

Latest verification:

```bash
python -m pytest unit_tests -q
# 306 passed

python -m pytest unit_tests/banking/test_reconciliation.py unit_tests/banking/test_store.py unit_tests/core/test_bank_reconciliation.py -q
# 80 passed

python -m pytest unit_tests/intents/test_handlers.py unit_tests/core/test_message_router.py -q
# 100 passed

python -m pyright
# Did not run: pyright is not installed in the current Python environment.
```
