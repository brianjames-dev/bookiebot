# Bills in Settings

Open **Settings → Bills → Manage bills & subscriptions**. Filter by Subscriptions, Variable bills or Fixed bills, or choose **Add bill**.

- **Subscription:** a monthly or yearly charge, under Needs or Wants.
- **Variable bill:** enter an optional estimate when setting it up, then use **Enter monthly amount** for the actual payment. Estimates stay in Projected until an amount is recorded.
- **Fixed bill:** a known amount repeating monthly, quarterly or yearly. It follows the saved payment date as an automatic budget expense.

Set the recurring amount, payment day, frequency, account and **Applies from** month. That month is inclusive: a November start configures November and every later occurrence until another change. Opening a bill with a scheduled change loads that upcoming configuration; the list shows the configured recurring price rather than this month’s paid amount. Quarterly billing uses a first month and repeats every three months; day 31 uses the month's last day when needed. Review before confirming. Changes and **Stop bill** apply from the chosen month forward; earlier months retain their versions and values. Restart a stopped bill by opening it and reviewing its new starting month. Recorded charges, including fully repaid charges with zero remaining cash expense, keep their existing source and require a later starting month for the recurring rule. A missing payment date can be repaired without changing the recorded amount or split.

Type is editable from the chosen starting month too. Converting a quarterly bill to a subscription selects Monthly; Yearly remains available. Review shows the resulting type. Review is read-only, and Confirm becomes available after its slide settles so a rapid repeat tap cannot save. Bills reuses Transactions' merchant/company logos and category fallbacks. In either DUO pose, tap the selected bill to close its editor or another bill to switch directly; drafts and prepared reviews return when selecting the prior bill while browsing. Cancel, leaving the workspace or a completed confirmation clears that editing session.

**Recurring split** opens a separate native editor inside Bills, with the same circles, income reset, slider and slide animation as Transactions. **Use split** returns its draft to the configuration; the bill’s Review/Confirm saves it from the selected month onward. Cancel restores the prior split. By income is calculated from the household income split when each new charge is recorded. Equal, fronted and custom percentages remain available. Existing charges and repayments are untouched by a recurring default.

If this month already has a charge, Review asks **Include this month?** Choose **Future charges only** or **Review this month too**. The recurring review states the actual effective month **onward**. The second choice first saves that recurring rule, then opens the recorded charge within Bills for its own native amount and split reviews/confirmations. Each uses Transactions’ existing canonical writer, permissions, source versions and saved-status recovery. A scheduled subscription has a separate preparation review before editing its recorded occurrence; its original total is preserved. Cancelling a current-charge review leaves the already-saved recurring rule in place. No repayment is marked received by changing a split. Variable estimates never replace a recorded actual amount.

**Enter monthly amount** remains a separate action for an unpaid variable bill. Corrections to an individual recorded payment remain available in Transactions; recurring configuration no longer navigates there.

Settings replaces the BookieBot brand with a contextual **Settings**, **Bills** or **Widget setup** title and a chevron-only Back control using the same glass surface/press feedback as Message and Settings. Closed DUO places the configuration editor below the selected bill with the native transaction guide and expansion. Its divider stays below the complete expanded editor, then returns to the row after closing. Open landscape uses Transactions’ exact fold, reserved right-strip geometry and pane insets: the list scrolls independently and the editor keeps its controls above the dock. Fields, labels, tinted surfaces, review rows and footer buttons retain Transactions’ styling. Configuration, recurring split, monthly amount, Stop, scope selection and current-charge views use native slides, including their reviews. Drafts, raw invalid percentages and prepared reviews survive switching views and folding; reduced motion settles directly.

If a save loses its response, use **Check saved status**. **Retry same confirmation** retains the original request ID and cannot repeat an already claimed writer. Unresolved bill and transaction commands block another financial confirmation for that owner. Reconnecting retains owner-scoped server recovery.

## Sheet storage and compatibility

Schedules remain in each owner's annual budget workbook:

| Hidden tab | Authority |
| --- | --- |
| `_BookieBot Bill Schedule` | Fixed and variable bill versions, with the existing leading columns preserved |
| `_BookieBot Subscription Schedule` | Subscription versions after the first explicit subscription save |
| `_BookieBot Bill Charges` | Stable plan/month source mapping and recorded occurrence metadata |
| `_BookieBot Bill Settings Log` | Atomic configuration/projection save receipts |

Native settings append stable plan IDs, exclusive effective intervals, type/category, active status, recurring split defaults and version/request metadata. Each schedule tab enrolls independently on an explicit save. Baselines retain earlier versions. Unknown columns and extra source formulas are preserved; editable names and values are literal cells, never executable formulas.

Changing type retains the plan's original hidden tab, source label and identity; effective `bill_type` metadata determines its classification. A physical monthly source remains physical across later changes. Subscriptions assigned to Rent or Bills & utilities also use monthly sources, preserving their category in budget cells and report readers rather than disappearing from the Needs/Wants subscription summaries.

Converting an automatic bill to Variable clears unrecorded schedule-price formulas from the effective month. Its estimate stays in Projected; literal actual payments and recorded charge/split sources remain unchanged. Month preparation also removes an unrecorded automatic formula copied by an older rollover script for a variable plan.

Before enrollment, the visible `Subscriptions` tab remains the legacy source. After enrollment, the hidden subscription schedule is authoritative and legacy sync cannot overwrite it. The visible tab is retained as the legacy reference. Existing monthly subscription formulas are rebound to the appropriate hidden price versions, with prior calculated values frozen where needed. Reports, Transactions, reminders, widgets and bank schedule reads use effective versions; an empty/stopped managed schedule cannot revive its old visible mirror.

Monthly sources use B for their stable label, C for Needs and D for Wants. New sources append below existing data with named anchors and extend the corresponding subtotal; they do not insert rows through income or transaction history. Existing recorded cash cells and confirmed repayments remain authoritative. A physical monthly source suppresses the corresponding virtual subscription occurrence. Confirmed zero cash expense is still recorded and cannot generate another forecast estimate.

Adopting a virtual subscription updates its physical source, charge mapping and that month's subscription summary in one atomic batch. Summary projection excludes recorded plan/month occurrences even after full repayment, while future virtual occurrences remain scheduled. An unenrolled subscription schedule enrolls its complete legacy baseline in that confirmed adoption; Review never enrolls it. An unidentifiable summary blocks adoption before any write.

Summary recovery recognizes an empty amount only in its category's column: C for Needs and D for Wants. A zero in the other column remains untouched.

Ordinary personal bills remain separate between owners. A confirmed repayment for a newly configured shared bill may provision a uniquely identified partner source, such as **Brian · Student Loan**, without overwriting that person's own loan. Existing shared Rent/PG&E/Recology/Water labels remain compatible. Recipient entries are read-only repayment projections and cannot create forecast bills.

Financial changes reuse the canonical action history, split allocation and repayment services. SQL stores operational claims/frozen requests, not the recurring schedule database. Review and Save bind the owner, source snapshot, plan version and exact shares. Bills and Transactions share the existing owner claim lock and block each other's uncertain writes. Source batches also use the existing mutation/projection locks. A source save that cannot finish split/history recording is recovered as recorded and directed to the native transaction editor; its amount is never submitted twice.

Legacy Discord bill amount writers and bank schedule-price mutations cannot bypass managed configuration/history. Enter managed amounts in Bills and edit recorded charges in Transactions. Read-only Discord subscription and spending queries use managed authority.

The background recurring worker runs independently of reminder opt-in. It prepares missing monthly sources and applies explicitly saved split defaults to new due charges once. It never regenerates a cleared existing amount. New months and years are supported by the Apps Script rollover changes and a claimed backend carry-forward/preparation fallback, including installations with an older external script. Charge mappings remain in their original annual book; schedule version history carries forward.

Month/year preparation retains each operational claim. A definitively rejected or pre-write failure gets a new retry identity; running, uncertain and successful attempts retain their identity and cannot repeat the writer. Unknown outcomes still require receipt recovery.

## Verification

Tests use isolated worksheet transports, SQLite/PostgreSQL command stores and synthetic browser fixtures. They cover effective dates, unknown columns/formulas, exact shares, partial/zero repayments, new recipient sources, future forecasts, duplicate/lost/stale requests, cross-flow uncertainty, reminder dates and rollover. Browser cases use the shipped bundle in Chromium/WebKit at 320px, 382px and open DUO widths, both themes, folding, independent scroll ownership and optional in-Bills current-charge reviews/recovery. No synthetic financial writes are made to production workbooks.

Native acceptance: STATUS checklists 282–286. For real use, only confirm a legitimate bill or amount; configuration and amount reviews can otherwise be cancelled without writes.
