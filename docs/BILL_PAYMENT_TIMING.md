# Entered bills and withdrawal dates

An entered monthly bill amount is a known planned payment. It counts as paid on
its saved withdrawal/autopay date, using Pacific time. This is the user's autopay
assumption, not bank-posting confirmation. Logging time and a separate invoice
due date do not determine transaction placement.

Before withdrawal, the amount stays in Calendar and Projected spending, category
balances and planning. It is excluded from Current spending and the Transactions
list, totals, graph, search and pagination. On/after withdrawal it appears once
in Current and Transactions, under the withdrawal date. An amount entered today
for an already elapsed withdrawal date appears immediately.

The amount remains in its existing monthly budget cell. Reads derive timing;
there is no midnight financial writer, new transaction, new column, database
migration or copying of amounts. Existing undated bill actions and manually
entered bill cells use the same rule. Source IDs, edits, split gross/net amounts,
repayments, Undo and audit history are preserved. Sheet cells/formulas continue
to represent the entered monthly plan; the app separates Current from Projected.

Timing requires exactly one valid matching Bill Schedule entry. Its source,
display name or key must match; punctuation/case are normalized. Missing,
invalid, overlapping or off-cycle quarterly schedules leave the amount queued
with no invented date. Those amounts remain in Projected and `queuedBills`,
including in the read-only assistant's Projected commitments. Correct the saved
schedule to resolve them. A day beyond the month's end clamps to its final day.
The existing schedule is the date authority, so correcting it also corrects
derived placements; no historical amount or saved action is rewritten.

Expected amounts without an entered monthly amount stay estimates even after
their scheduled date passes. They never acquire recorded transaction actions.
Known queued amounts replace their own expectation rather than adding to it.
Subscription schedule behavior is unchanged.

Transactions reads fetch the bill schedule in the existing personal-workbook
batch. Their cache includes the Pacific date, so yesterday's cached list cannot
hide a newly paid bill. Normal app opening/foreground refresh or pull-to-refresh
recalculates views; a saved static report is still a snapshot.

Later bank matching uses the same entered bill's source action and monthly
schedule occurrence, including when the amount was logged more than seven days
early. Both references are reserved together to prevent a second charge from
consuming the same payment again. Matching does not create another bill, change
an amount without review, or mark a partner repayment received.

Verification: use isolated fixtures before/on/after withdrawal, past/future
months, quarterly schedules, short/leap months, missing/duplicate dates, unknown
amounts, sheet subtotal fallbacks, recorded/estimated provenance, midnight cache
changes, edits and duplicate bank reservations. Native acceptance: refresh the
app; confirm a future bill remains in Calendar/Projected and an elapsed bill
appears once on its saved date in Transactions. Review only; no synthetic live
purchase, bank confirmation or repayment is needed.
