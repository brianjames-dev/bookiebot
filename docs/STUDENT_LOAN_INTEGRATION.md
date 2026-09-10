# Student loan integration and sheet audit

Audited September 9, 2026 in Chrome: [Brian Budget 2026](https://docs.google.com/spreadsheets/d/1ArI4qapaj-LGg7v5OC47WdfYijjLdu3QPRPgKLbgD3U/edit) and [Shared Expenses 2026](https://docs.google.com/spreadsheets/d/1t2Nm5luEjm-RKiiMyuIFvJBhdI0ubufWkrdjRzBsTgU/edit). The second supplied link is the shared workbook, not Hannah's personal budget. Read-only exports supported the audit; formulas with shared-formula encoding were verified in the live formula bar before deciding whether a repair was necessary.

## Loan configuration

- Brian's September and internal Template have `Student Loan` in B14. September C14 contains **$119.92**, preserved and verified again after activation. Template C14 stays **0** so a new month never begins falsely marked paid.
- September D14 already correctly uses `=IF(C14 <> 0, "✅", "⭐")`. The missing **Template D14** formula was restored to the same expression during the original audit and verified saved.
- The user confirmed **$59.96 monthly on the 12th** and approved activation. Brian’s existing row 3 remains monthly, day **12**, Checking, Student Loan.
- Activation completed in Chrome: appended column **J**, set **J1=`expected_amount`** and **J3=59.96** in `_BookieBot Bill Schedule`. Verified the saved header/value, recurrence and exact source label, plus September’s unchanged $119.92 and Template’s zero actual. The original automatic approval rejection was resolved by the user’s subsequent approval; populated schedules are still never resized by background reads.
- Brian has no duplicate student-loan subscription in the inspected subscription tabs. The former global subscription-only rule remains the default unless a particular owner explicitly opts into a standalone bill. Hannah's existing subscription behavior is preserved by regression tests; her personal workbook was not part of these supplied links.

## Behavior

Projected reserves **$59.96** for an unrecorded current/future month. Current stays at $0 until an actual is entered. A recorded $59.96 replaces the estimate; September’s $119.92 also replaces it without an extra $59.96. An overdue expectation remains an estimate, and closed months do not acquire invented payments. The loan remains a Needs bill but joins **Static Bills & Subscriptions**, outside the variable Bills & Utilities history chart. Calendar details and category drilldowns retain Bill identity and distinguish Scheduled amounts from Recorded amounts. Fixed bills and Xfinity/subscription totals are added once without overwriting either source.

Burn Rate spending is Food, Shopping and Wants subscriptions. Needs bills affect the effective Wants allowance only through existing category coverage: with $500 Needs budget and $400 other Needs, the $59.96 loan leaves Wants unchanged; with $500 other Needs it creates a $59.96 shortfall that draws from available Wants. It never enters the actual Wants-spending curve. Budget/category/upcoming widgets reuse those canonical modes and schedule values.

`Log student loan $59.96` sets the current month's recorded loan payment total to $59.96; it is not an additional $59.96 transaction or a bank transfer. Only use it for an actual payment. `Did I pay my student loan?` reads the recorded amount. Commands scope to the authenticated author and require one configured schedule and one exact budget row. Stable source/amount named ranges protect the write from row insertion; exact source metadata protects later recent-action edits. An uncertain write is never automatically retried. A matching active subscription blocks standalone commands and suppresses duplicate forecast amounts, without erasing actual financial rows.

Monthly tabs copy the internal Template and use the same annual bill schedule, so the row and expectation now recur within 2026. Annual rollover copies **separate master template files**; the annual masters must also contain the new row and expected-amount configuration before 2027. No third workbook or annual master was changed in this audit.

## Formula and row-insertion audit

| Area | Finding |
| --- | --- |
| Brian September Needs subtotal | C22 = `SUM(C13:C21)` includes Student Loan C14 correctly. |
| Brian September shared links | Groceries → F4, Gas → L4, Various Needs → AJ4, Eating Out → T4 and Shopping → AB4 all reference the correct September shared tab. |
| Existing reimbursements after insertion | Named anchors moved PG&E to row 15 and Water to row 17. Projection identity guards prevent writes into the inserted loan row. Some old action-log coordinates remain stale; guarded recent-action edits may refuse rather than target the wrong bill. |
| Internal Template imports | Several imports still reference an old shared workbook/January; Various Needs C21 points to L4 instead of AJ4. Monthly Apps Script relinks these labels when creating a month, so September is correct. Old Template formulas were left unchanged and should be cleaned up separately. |
| Shared September grand totals | AM27/AM28/AM31 sum only AB/T/L/F, omitting Needs AJ3/AJ4/AJ5. The displayed $1,080.05 excludes $589.72 in Needs; all five categories total **$1,669.77** at audit time. Shared Template has the same omission. Individual category totals and Brian's correct imports are unaffected. No shared totals were edited. |

## Acceptance

After the updated report is deployed:

1. Refresh Brian’s September report. Verify $119.92 under Static Bills & Subscriptions and in Calendar’s Fixed bills details, with no extra $59.96 and no Student Loan series in Bills & Utilities.
2. In a disposable next-month fixture with zero actual, compare Current (no loan actual) with Projected ($59.96); check day 12 and widget/report agreement. Confirm the monthly Template status begins unpaid.
3. In that disposable fixture, record a test payment via the explicit command, verify the exact loan row and normal recent-action undo, including after inserting an unrelated or similarly named row above it. Never add synthetic payments to the live budget.
4. Verify Hannah retains subscription-only behavior. Before annual rollover, update/review the separate annual master templates and confirm the January row and schedule.

Final verification: **1,718 passed / 213 optional PostgreSQL skipped**, clean Python/frontend/build/Apps Script checks. Production WebKit passed 14 layout/source cases in both modes and six final focus/navigation cases; details are recorded in `.agent/STATUS.md`. Regressions cover exact cents, Current/Projected/category/widget parity, actual-vs-scheduled provenance, subscription coexistence and unchanged Wants spending. No live payment or notification was created.
