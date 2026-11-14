# Bills in Settings

Open **Settings → Bills → Manage bills & subscriptions**. Filter by Subscriptions, Variable bills or Fixed bills, or choose **Add bill**.

- **Subscription:** a monthly, quarterly or yearly charge, under Needs or Wants.
- **Variable bill:** the app predicts an unentered amount from past bills. Use **Enter monthly amount** when the actual arrives; it replaces the prediction. An optional configured estimate overrides the historical average.
- **Fixed bill:** a known amount repeating monthly, quarterly or yearly. It follows the saved payment date as an automatic budget expense. Fixed and variable bills support Needs, Wants, Rent and Bills & utilities categories.

Legacy Rent is classified as Fixed even if its older schedule has no automatic-tracking flag. This classification does not change an amount, enroll a schedule, or infer a recurring split.

## Variable bill predictions

Bills and Projected Overview/Calendar mark predictions with a small sparkle icon. Tap it for the amount, history count and month range; Projected Spent uses the same marker in its existing explanation button. Current excludes these variable predictions, and Transactions stays actual-only.

The baseline is the arithmetic mean, rounded to cents, of positive personal bill amounts in available completed months before the selected month. Reads include the annual workbook and its available previous-year history. Blank/zero placeholders, refunds, spreadsheet errors, duplicate sources/periods, current/future months and other predictions do not train the estimate. Quarterly/yearly bills forecast only in their configured billing months. A bill without usable history or a configured estimate stays unknown.

Existing future worksheets also require one verified blank/zero source before showing an estimate. Errors, refunds, missing or ambiguous rows stay unknown. Duplicate checks use the same bill identity across spelling/punctuation aliases, including explicit configured estimates.

The source is your recorded personal budget amount, which may already reflect historical split repayments; it is not a newly quoted full purchase price or a repayment promise. Predictions do not create transactions, change splits, enroll settings or write budget cells. Saved estimates retain their existing explicit override behavior. Enter the actual purchase/payment amount through the normal reviewed monthly-amount flow; its existing split defaults and recorded date remain authoritative. A recorded zero after reimbursement also suppresses the prediction.

Bills and Overview use the same calculation. Opening a prediction explanation preserves an editor draft. Folding, native refresh and editor animations retain their existing behavior; the explanation closes when the view changes. Already-entered amounts retain the normal queued/recorded timing, and never get replaced by an average.

Confirming a variable invoice records its **bill amount**, not a payment. Its prediction disappears and a small clock opens its scheduled details. The saved autopay date controls when that known amount enters Current and Transactions. Projected/Calendar include it on that date beforehand; Transactions stays actual-only regardless of Overview mode. Correct a scheduled invoice through **This month’s bill → Edit amount**, using the existing canonical review/confirmation inside Bills. If the initial split needs recovery, that action becomes **Review split**. The original amount/source/action, split and repayments remain authoritative, including zero personal exposure.

An early reimbursement is a separate cash event: it never marks the payer's utility paid. A fully confirmed recipient repayment retains its real receipt date. November's already confirmed invoice amounts and settled splits are preserved; timing changes do not log them or their repayments again. Automatic posting follows the saved date, without requiring a bank match or a second paid confirmation.

A future recurring change, including a new split, does not hide this month’s confirmed variable-bill amount in the list. If no confirmed amount is available, retain a verified prediction when one exists. **Amount needed** means neither is available; it does not describe the recurring split. The configuration’s Recurring split row shows the saved/drafted split separately.

## Daily amount check-in

On opening/resuming the app, a native **Confirm upcoming bills** prompt groups variable bills still needing an invoice amount in the current prepared billing month. The default window starts seven days before autopay and continues if an amount is overdue. Only the payer is prompted. A known amount, confirmed zero, stopped bill, off-cycle month or unavailable source is excluded. The window begins no earlier than that prepared billing month; opening the app never creates future worksheets or records an estimate.

Choose a bill to open **Bill amount** directly in its existing Bills editor. **Review → Confirm amount** replaces the prediction and keeps the saved autopay date. **Amount check-in** allows 1, 3, 7, 14 or 30 days before payment, or Off. **Later** dismisses the grouped prompt until the next Pacific day, across that person's devices. No push permission is needed. Active drafts, pending/uncertain changes, text entry, messaging and other dialogs defer the prompt. Abandoned display reservations expire instead of consuming the day.

## Recurring configuration

Set the recurring amount, payment day, frequency and account. **Applies from** defaults to the current month, or the saved upcoming version's month when opening that version. Choose the current month or a later month; changes continue from that month onward until changed again. An eligible, unrecorded November charge can use the change in November. Recorded charges, including fully repaid charges with zero remaining cash expense, keep their existing source and the recurring rule starts later. Review states the actual effective month **onward** and explains any separate current-charge confirmation. Copied future worksheet values no longer push the starting month forward; existing literal amounts and explicitly recorded future charges/allocations stay protected. Opening a bill with a scheduled change loads that upcoming configuration; the list shows the configured recurring price rather than this month’s paid amount. Quarterly billing uses a first month and repeats every three months for all bill types; day 31 uses the month's last day when needed. Payment day can be cleared and retyped naturally; Review requires a whole day from 1 to 31. **Stop bill** retains its separate safe Stop from month; cancelling Stop preserves the configuration month, and earlier months retain their versions and values. Restart a stopped bill by opening and reviewing its configuration. A missing payment date can be repaired without changing the recorded amount or split.

Type is editable for eligible new charges too. Changing type retains Quarterly; selecting Subscription restricts the category to Needs/Wants and resets an incompatible draft category to Needs. Existing historical subscription categories remain readable. Review shows the resulting type. Review is read-only, and Confirm becomes available after its slide settles so a rapid repeat tap cannot save. Bills reuses Transactions' merchant/company logos and category fallbacks. In either DUO pose, tap the selected bill to close its editor or another bill to switch directly; drafts and prepared reviews return when selecting the prior bill while browsing. **Add bill** is always an available button, retaining a new draft on repeated taps. During an unresolved save, it queues opening the draft until that original change is verified. Cancel, leaving the workspace or a completed confirmation clears that editing session.

**Recurring split** opens its native controls immediately in both DUO poses, without a second enable checkbox. An unsplit bill starts a By income draft; an existing split keeps its percentages. The circles sit side by side with the income button between them, and the editable values and full-width slider below. **Remove split** returns a No split draft to the configuration; it still requires Review/Confirm. **Use split** returns its draft to the configuration; the bill’s Review/Confirm saves it for eligible current/future charges onward. Cancel restores the prior split. By income is calculated from the household income split when each new charge is recorded. Equal, fronted and custom percentages remain available. Existing charges and repayments are untouched by a recurring default.

After a recurring change requested from the current month is successfully saved, an already-hit current-month charge opens **Update November too?** (using the current month). Choose **Keep November as is** or **Review charge**. Selecting a future Applies from month skips this offer. Reviewing opens the recorded charge within Bills for its own native amount and split reviews/confirmations. Each uses Transactions’ existing canonical writer, permissions, source versions and saved-status recovery. A scheduled subscription has a separate preparation review before editing its recorded occurrence; its original total is preserved. Cancelling the question or a current-charge review leaves the already-saved recurring rule in place. No repayment is marked received by changing a split. Variable estimates never replace a recorded actual amount.

**Enter monthly amount** remains separate from recurring configuration. Scheduled invoice corrections stay inside Bills; paid transactions remain editable through the existing Transactions flow too.

Settings replaces the BookieBot brand with one connected glass Back/title capsule for **Settings**, **Bills** or **Widget setup**, using Message/Settings’ surface and press feedback. Closed DUO places the configuration editor below the selected bill with the native transaction guide and expansion. Switching rows closes/opens both editors concurrently; each divider stays below its complete editor until closing finishes. Open landscape uses Transactions’ fold, reserved right strip, scrollbar styling/location and pane insets: only the left list scrolls, while the roomier right editor keeps its controls above the dock. Selecting another bill moves opaque surfaces through one stable, clipped pane with standard 440 ms easing, avoiding exposed overlapping panels or a fade; configuration, recurring split, monthly amount, Stop and current-charge steps retain native 440 ms slides. Edit bill has only its heading and icon-only trash, without repeated merchant/month subtitles. Fields, labels, tinted surfaces, review rows and footer buttons retain Transactions’ styling. The active editor remains mounted through folding, preserving raw invalid percentages and prepared canonical reviews. Reduced motion settles directly.

Open DUO shows Refresh next to Add bill, with a rotating icon while its request runs. Closed DUO uses the existing pull-to-refresh gesture, with no toolbar refresh button. Refresh preserves an editing draft and is unavailable during an unresolved financial operation. The bill filter reuses the actual Category Mix dropdown and always stays enabled, including while refreshing or confirming. A selected bill remains visible as its draft's row anchor even when it does not match the filter.

If a save loses its response, use **Check saved status**. **Retry same confirmation** retains the exact reviewed command and original request ID, including a current-charge confirmation that never reached the server and has no receipt. An already claimed writer cannot be repeated. A retained Transactions tab verifies its own pending receipt after Bills settles it, so recovery does not leave a stale navigation guard. Unresolved bill and transaction commands block another financial confirmation for that owner. Reconnecting retains owner-scoped server recovery.

## Sheet storage and compatibility

Schedules remain in each owner's annual budget workbook:

| Hidden tab | Authority |
| --- | --- |
| `_BookieBot Bill Schedule` | Fixed and variable bill versions, with the existing leading columns preserved |
| `_BookieBot Subscription Schedule` | Subscription versions after the first explicit subscription save |
| `_BookieBot Bill Charges` | Stable plan/month source mapping and recorded occurrence metadata |
| `_BookieBot Bill Settings Log` | Atomic configuration/projection save receipts |

Native settings append stable plan IDs, exclusive effective intervals, type/category, active status, recurring split defaults and version/request metadata. Quarterly subscriptions persist their cycle in a trailing `pull_months` column; old leading columns and legacy yearly `pull_month` reads remain compatible. Each schedule tab enrolls independently on an explicit save. Baselines retain earlier versions. Unknown columns and extra source formulas are preserved; editable names and values are literal cells, never executable formulas.

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

Native acceptance: STATUS checklist 292 supersedes the relevant UI/scope expectations in 282–291. For real use, only confirm a legitimate bill or amount; configuration and amount reviews can otherwise be cancelled without writes.
