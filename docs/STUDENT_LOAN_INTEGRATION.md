# Student loan integration and sheet audit

Audited September 9, 2026 in Chrome: [Brian Budget 2026](https://docs.google.com/spreadsheets/d/1ArI4qapaj-LGg7v5OC47WdfYijjLdu3QPRPgKLbgD3U/edit) and [Shared Expenses 2026](https://docs.google.com/spreadsheets/d/1t2Nm5luEjm-RKiiMyuIFvJBhdI0ubufWkrdjRzBsTgU/edit). The second supplied link is the shared workbook, not Hannah's personal budget. Read-only exports supported the audit; formulas with shared-formula encoding were verified in the live formula bar before deciding whether a repair was necessary.

## Loan configuration

- Brian's September and internal Template have `Student Loan` in B14. September C14 contains **$119.92**, preserved pending confirmation that it is an actual payment. Template C14 stays **0** so a new month never begins falsely marked paid.
- September D14 already correctly uses `=IF(C14 <> 0, "✅", "⭐")`. The missing **Template D14** formula was restored to the same expression and verified saved. This was the only live edit in this task.
- Brian's existing bill-schedule row 3 says monthly, day **12**, Checking, Student Loan. The day was preserved; the user specified **$59/month**, but has not yet confirmed the existing day or September's actual.
- Activation is pending approval to append column **J**, header **`expected_amount`**, and put **59 in J3** of `_BookieBot Bill Schedule`. The populated sheet currently ends at I; the code deliberately does not resize populated legacy schedules. Automatic approval review rejected the structural insertion, and it has not been performed through another channel.
- Brian has no duplicate student-loan subscription in the inspected subscription tabs. The former global subscription-only rule remains the default unless a particular owner explicitly opts into a standalone bill. Hannah's existing subscription behavior is preserved by regression tests; her personal workbook was not part of these supplied links.

## Behavior

With explicit configuration, Projected reserves $59 for an unrecorded current/future month. Current stays at $0 until an actual is entered. Recording $59 results in $59 actual, not $118; recording $119.92 uses $119.92, not $178.92. An overdue expectation remains an estimate, and closed months do not acquire invented payments. Calendar, Needs/bills totals, budget remaining, daily availability and widgets use the same canonical calculation. Bill history remains actual-only.

`Log student loan $59` sets the current month's recorded loan payment total to $59; it is not an additional $59 transaction or a bank transfer. Only use it for an actual payment. `Did I pay my student loan?` reads the recorded amount. Commands scope to the authenticated author and require one configured schedule and one exact budget row. Stable source/amount named ranges protect the write from row insertion; exact source metadata protects later recent-action edits. An uncertain write is never automatically retried. A matching active subscription blocks standalone commands and suppresses duplicate forecast amounts, without erasing actual financial rows.

Monthly tabs copy the internal Template and use the same annual bill schedule, so the row and expectation recur within 2026 once activated. Annual rollover copies **separate master template files**; the annual masters must also contain the new row and expected-amount configuration before 2027. No third workbook or annual master was changed in this audit.

## Formula and row-insertion audit

| Area | Finding |
| --- | --- |
| Brian September Needs subtotal | C22 = `SUM(C13:C21)` includes Student Loan C14 correctly. |
| Brian September shared links | Groceries → F4, Gas → L4, Various Needs → AJ4, Eating Out → T4 and Shopping → AB4 all reference the correct September shared tab. |
| Existing reimbursements after insertion | Named anchors moved PG&E to row 15 and Water to row 17. Projection identity guards prevent writes into the inserted loan row. Some old action-log coordinates remain stale; guarded recent-action edits may refuse rather than target the wrong bill. |
| Internal Template imports | Several imports still reference an old shared workbook/January; Various Needs C21 points to L4 instead of AJ4. Monthly Apps Script relinks these labels when creating a month, so September is correct. Old Template formulas were left unchanged and should be cleaned up separately. |
| Shared September grand totals | AM27/AM28/AM31 sum only AB/T/L/F, omitting Needs AJ3/AJ4/AJ5. The displayed $1,080.05 excludes $589.72 in Needs; all five categories total **$1,669.77** at audit time. Shared Template has the same omission. Individual category totals and Brian's correct imports are unaffected. No shared totals were edited. |

## Acceptance

After approving configuration and confirming the existing actual/day:

1. Refresh Brian's September report. If $119.92 is a real recorded payment, both modes must use it with no extra $59.
2. In a disposable next-month fixture with zero actual, compare Current (no loan actual) with Projected ($59); check day 12 and widget/report agreement. Confirm the monthly Template status begins unpaid.
3. In that disposable fixture, record a test payment via the explicit command, verify the exact loan row and normal recent-action undo, including after inserting an unrelated or similarly named row above it. Never add synthetic payments to the live budget.
4. Verify Hannah retains subscription-only behavior. Before annual rollover, update/review the separate annual master templates and confirm the January row and schedule.

Final local verification: **1,698 tests passed / 213 optional PostgreSQL skipped**, Pyright and frontend typecheck clean, Apps Script migration/rollover and diff checks passed. Regressions cover amount/source/owner guards, stable writes and later undo/update, duplicates across subscriptions/reports/reminders, both modes and widget parity. Release evidence belongs in `.agent/STATUS.md` and the task completion response. No live payment or notification was created.
