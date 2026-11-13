# Bills in Settings

Open **Settings → Bills → Manage bills & subscriptions**. Filter by Subscriptions, Variable bills or Fixed bills, or choose **Add bill**.

- **Subscription:** a monthly or yearly charge, under Needs or Wants.
- **Variable bill:** enter an optional estimate when setting it up, then use **Enter monthly amount** for the actual payment. Estimates stay in Projected until an amount is recorded.
- **Fixed bill:** a known amount repeating monthly, quarterly or yearly. It follows the saved payment date as an automatic budget expense.

Set the payment day, frequency, account and starting month. Quarterly billing uses a first month and repeats every three months; day 31 uses the month's last day when needed. Review before confirming. Changes and **Stop bill** apply from the chosen month forward; earlier months retain their versions and values. Restart a stopped bill by opening it and reviewing its new starting month. Recorded charges, including fully repaid charges with zero remaining cash expense, require a later starting month. A missing payment date can be repaired without changing the recorded amount or split.

**Split new charges** uses the same circles, income reset and slider as Transactions, expressed as percentages. By income is calculated from the household income split when a charge is recorded. Equal, fronted and custom percentages remain available. An existing charge's split never changes when a recurring default changes.

For an existing payment, choose **Edit this charge / split**. Transactions opens the native editor with a removable date filter. A scheduled subscription can first be made editable through a separate review; its total is preserved and its schedule occurrence is replaced for that month only. Previously recorded splits keep their original gross, confirmed receipts and remaining balance.

Closed DUO places the configuration editor below the selected bill. Open landscape keeps the list and editor in equal panes. Form values, reviews and percentage validation survive folding. The normal navigation dock remains in place.

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

Before enrollment, the visible `Subscriptions` tab remains the legacy source. After enrollment, the hidden subscription schedule is authoritative and legacy sync cannot overwrite it. The visible tab is retained as the legacy reference. Existing monthly subscription formulas are rebound to the appropriate hidden price versions, with prior calculated values frozen where needed. Reports, Transactions, reminders, widgets and bank schedule reads use effective versions; an empty/stopped managed schedule cannot revive its old visible mirror.

Monthly sources use B for their stable label, C for Needs and D for Wants. New sources append below existing data with named anchors and extend the corresponding subtotal; they do not insert rows through income or transaction history. Existing recorded cash cells and confirmed repayments remain authoritative. A physical monthly source suppresses the corresponding virtual subscription occurrence. Confirmed zero cash expense is still recorded and cannot generate another forecast estimate.

Ordinary personal bills remain separate between owners. A confirmed repayment for a newly configured shared bill may provision a uniquely identified partner source, such as **Brian · Student Loan**, without overwriting that person's own loan. Existing shared Rent/PG&E/Recology/Water labels remain compatible. Recipient entries are read-only repayment projections and cannot create forecast bills.

Financial changes reuse the canonical action history, split allocation and repayment services. SQL stores operational claims/frozen requests, not the recurring schedule database. Review and Save bind the owner, source snapshot, plan version and exact shares. Bills and Transactions share the existing owner claim lock and block each other's uncertain writes. Source batches also use the existing mutation/projection locks. A source save that cannot finish split/history recording is recovered as recorded and directed to the native transaction editor; its amount is never submitted twice.

Legacy Discord bill amount writers and bank schedule-price mutations cannot bypass managed configuration/history. Enter managed amounts in Bills and edit recorded charges in Transactions. Read-only Discord subscription and spending queries use managed authority.

The background recurring worker runs independently of reminder opt-in. It prepares missing monthly sources and applies explicitly saved split defaults to new due charges once. It never regenerates a cleared existing amount. New months and years are supported by the Apps Script rollover changes and a claimed backend carry-forward/preparation fallback, including installations with an older external script. Charge mappings remain in their original annual book; schedule version history carries forward.

## Verification

Tests use isolated worksheet transports, SQLite/PostgreSQL command stores and synthetic browser fixtures. They cover effective dates, unknown columns/formulas, exact shares, partial/zero repayments, new recipient sources, future forecasts, duplicate/lost/stale requests, cross-flow uncertainty, reminder dates and rollover. Browser cases use the shipped bundle in Chromium/WebKit at 320px, 382px and open DUO widths, both themes, folding and the native Transactions handoff. No synthetic financial writes are made to production workbooks.

Native acceptance: STATUS checklist 282. For real use, only confirm a legitimate bill or amount; configuration and amount reviews can otherwise be cancelled without writes.
