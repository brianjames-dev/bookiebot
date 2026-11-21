# Savings transfers

Open **Settings → Savings transfers → Manage savings transfers → Add transfer**.
Choose a name, amount, first date and One time, Every 2 weeks, Monthly, Quarterly or Yearly.
Every 2 weeks repeats on the original 14-day date anchor across month/year
boundaries; changing only the future amount keeps that anchor.
From/To are optional account labels. Link one of your active personal savings
goals, or leave No goal. **Review → Confirm** saves the schedule; Review itself
never writes. BookieBot records the scheduled savings; your bank performs the
money movement.

On each scheduled Pacific date, one occurrence increases the month's **Saved**
and, if linked, that goal's balance. It is neither income nor Needs/Wants
spending. A $150 transfer linked to Emergency fund increases Saved by $150 and
allocates those same $150 to the goal. It does not create another $150 deposit.
Future occurrences appear in **Projected** and Calendar; **Current**, goal
balances and Transactions include only dates that have arrived. No midnight
financial writer or separate goal-contribution copy is needed.

**Category Mix** separates Savings transfers from other cash saved. All and
Savings partition the same cash total, alongside separate payroll ESPP. The
Transfers scope shows their share of total cash saved. Savings transfers never
become Needs/Wants slices, spending drilldowns or bills.
**Calendar** has a distinct Transfers legend color/icon, dated entries and native
day details. **Transactions** shows due entries with a transfer icon/label and
account/goal details. All includes transfers alongside purchases, while its
graph stacks a separate gold Transfers layer above Needs/Wants. Its legend and tooltip separate all three amounts; Total activity includes the transfer without increasing expense-only Spent. Transfers and Savings filters include the
appropriate savings activity; Needs/Wants filters exclude it.

Changing or stopping a transfer affects future occurrences, starting tomorrow.
Amounts, names, dates and goal links already counted remain unchanged. The
next-date field defaults to the first future occurrence, even on a due date.
Month-end and leap-day schedules retain their original day anchor. One-time
transfers move to Past transfers when counted; stopped transfers are retained
there too. In Transactions, **Edit** or **Delete** changes only the selected due transfer. The native review shows its Saved contribution and any goal allocation changes; its original date and recurring schedule stay unchanged. Edit can change amount, name, account labels and goal. **Undo** restores that individual change, including Saved, goal history, Calendar, Category Mix and the graph. Transfers have no expense Split/Move actions.
To archive a goal, first unlink or stop its future transfers; prior allocations
remain in its history.

The monthly sheet's cash input remains the manually recorded component. Saved
combines that input, scheduled transfer occurrences and recorded payroll ESPP.
The existing **log savings $300** command still sets the cash total to $300:
with $150 already due from transfers, it stores $150 additional manual cash.
It cannot remove completed scheduled transfers by entering a lower total.
The query includes transfers once, and existing manual Undo restores only that
manual component. Manual goal contributions retain their separate allocation
behavior and do not independently increase monthly Saved.

## Storage and recovery

Transfer financial rules live in the owner's existing **2026 personal budget
workbook**, in hidden **_BookieBot Savings Transfers**. This is one lifetime
configuration, retained across annual rollover; do not fork it into each new
annual book or remove the original workbook configuration. The table has
`transfer_id`, `revision`, and literal `definition_json`. Complete effective-dated
versions preserve past occurrences. Dated adjustments and deletion tombstones are retained inside the latest rule definition, independently versioned by original date. Future schedule changes carry them forward. The existing Settings Log receipt contains the dated Undo audit in the same atomic batch; public command recovery omits the private audit. Goal history has a derived transfer revision so correction refreshes never change manual goal edit versions. New transfers cannot precede November 15,
2026, the feature's first supported date. Earlier reports retain their existing
read paths and amounts.

Use the existing Bills/Transactions owner claims and projection lock. A confirmed
rule and its existing **_BookieBot Bill Settings Log** receipt share one atomic
Sheets batch. Monthly cash cells, expense amounts, Shared allocations, repayments,
bank records and goal contribution rows are not written by this schedule writer.
Goal definitions and manual contributions retain their existing app store; due
transfer allocations are read from the same Sheets rule as Saved. Goal history
marks them as scheduled transfers and does not offer a separate reversal.
Goal archiving shares the financial owner lock to prevent racing a new link.

The browser stores the original owner-scoped request before POST. Lost responses
offer Check saved status and Retry same confirmation, retaining the original ID
through reload. Definitive validation/claim rejections clear the unrecorded request and return to editing; errors remain visible after refresh. Read-only Refresh can recheck a resolved Bills claim. A successful atomic receipt completes recovery without repeating
the writer. Missing, corrupt or unavailable transfer data fails verification;
it is never silently substituted with zero. Source reads and GETs do not create
tabs or record contributions.

## Native acceptance

In both DUO orientations, editors expand below their row with the native guide
and divider. Row switches animate together. The open Settings sidebar remains
available beside the scrolling detail pane. Closed DUO uses pull-to-refresh,
and open DUO uses the toolbar refresh button.

Create a legitimate future transfer, inspect Review, then confirm. Check Current
versus Projected, its separate Category Mix slice, Calendar event and goal history.
On the due date it should appear once in Transactions and increase Saved and
the linked goal once. Change only the future amount/link, then stop it and inspect
Past transfers. Correct or delete one due entry in Transactions and use Undo; verify only that occurrence, Saved, its linked goal and the gold graph layer change. Fold with an edit/review open; short landscape controls must fit above the dock. Existing schedule dates/amount/goal remain intact. Automated financial tests use
isolated fixtures; release verification does not alter live money.

## Creation request errors

“Make transfer changes from BookieBot” means the request failed the same-origin
check before Review or saving. Transfers requests use the same explicit
same-origin referrer policy as Bills and Transactions under the private page
policy. Update/reopen the Home Screen app; opaque and foreign request origins
remain rejected. No schedule is saved by a rejected Review.
