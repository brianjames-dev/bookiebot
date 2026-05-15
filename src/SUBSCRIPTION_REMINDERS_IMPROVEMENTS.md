# Subscription Reminder Improvements

BookieBot now has a first working subscription reminder flow:

- The visible `Subscriptions` sheet remains the user-facing source of truth.
- BookieBot syncs that sheet into a hidden normalized tab named `_BookieBot Subscription Schedule`.
- BookieBot creates a hidden `_BookieBot Bill Schedule` tab for dynamic fixed-date bills.
- Reminders are sent once per user per day after the configured Pacific send hour and include every subscription and scheduled bill expected to pull in the next 7 days.
- Multiple due reminders are grouped into one Discord cash-pull digest per user.

This document tracks improvements that would make the feature more reliable, more automatic, and easier to debug when something goes wrong.

## Current Implementation Status

- Implemented: hidden normalized subscription schedule per user.
- Implemented: background sync refreshes hidden normalized schedules even before the daily notification window.
- Implemented: reminder digest grouped by timing window.
- Implemented: digest headline includes the total amount expected in the next 7 days.
- Implemented: `Today` digest grouping is supported.
- Implemented: every subscription due in the next 7 days is included; reminder selection is no longer limited to only 0, 1, 3, and 7 days.
- Implemented: hidden bill schedule support for fixed-date dynamic bills such as Rent, PG&E, Recology, Water, and Student Loan Payment.
- Implemented: combined cash-pull digest includes subscriptions and scheduled bills together.
- Implemented: bill reminders distinguish known amounts from missing monthly bill amounts.
- Implemented: overdue bill rows with missing amounts are included daily until the amount is entered or the month changes.
- Implemented: quarterly bill schedules use explicit pull months such as `2,5,8,11`.
- Implemented: once-per-user daily digest tracking prevents repeated subscription digests later the same day.
- Implemented: admin `/debug_subscriptions` command syncs the hidden sheet and reports parse warnings.
- Implemented: parse warnings are collected for malformed rows in the pretty grouped layout and surfaced through `/debug_subscriptions`.
- Implemented: proactive parse-warning notifications are sent after 10 AM when rows cannot be normalized, with once-per-day duplicate prevention.
- Implemented: per-user notification send-hour overrides through `BRIAN_SUBSCRIPTION_REMINDER_SEND_HOUR` and `HANNAH_SUBSCRIPTION_REMINDER_SEND_HOUR`.
- Implemented: bill schedule warnings are surfaced when a non-template hidden bill row cannot be normalized.

## Product Decisions

- No `Active` column for now. If a subscription is canceled, it should be removed from the visible sheet instead of kept around as inactive data.
- `Account` means bank account, credit card, or payment method. It does not mean the budget owner/person; the owner is already implied by which user's budget spreadsheet is being synced.
- The user-facing flow should be automatic by default. Manual commands are useful as admin/debug backstops, not as required operating steps.
- Surface subscription errors only when BookieBot cannot resolve them automatically.
- Price-change detection becomes much more useful after bank/API integrations exist. Without external transaction data, BookieBot can only notice changes that the user already typed into the sheet.

## 1. Automatic Sync Health and Self-Healing

Status: mostly implemented. BookieBot syncs before reminder checks and also refreshes hidden normalized schedules in the background before the notification window. Missing hidden sheets are recreated by the repository layer. Malformed visible rows are surfaced through parse warnings.

BookieBot should automatically keep the hidden normalized schedule in sync with the visible `Subscriptions` sheet.

Desired behavior:

- Sync on bot startup.
- Sync before reminder checks.
- Detect if the hidden `_BookieBot Subscription Schedule` tab is missing and recreate it.
- Detect malformed hidden rows and regenerate them from the visible source.
- Avoid notifying the user when the issue can be fixed automatically.

Why this matters:

- The hidden sheet should feel like infrastructure, not something the user has to manage.
- Manual debugging should be rare.

## 2. Parse Warnings and User-Facing Errors

Status: implemented for the current pretty grouped layout. BookieBot sends a concise warning digest after 10 AM when rows cannot be normalized, and avoids repeating the same warning every hour.

When BookieBot reads the visible `Subscriptions` sheet, it should detect rows that look like subscriptions but cannot be normalized.

Examples:

```text
Subscriptions!B12:D12: missing amount
Subscriptions!J8:L8: invalid yearly date "13/40"
Subscriptions!B15:D15: missing subscription name
```

Preferred behavior:

- If BookieBot can infer a safe value, fix or normalize it silently.
- If BookieBot cannot safely infer the value, send a concise Discord warning after 10 AM.
- Include the visible source range so the user can fix the exact cells.
- Do not repeatedly warn about the same unresolved parse issue every hour.

Why this matters:

- Silent skips are risky because a typo could prevent a reminder from firing.
- The user should only be interrupted when BookieBot cannot confidently recover.

## 3. Manual Sync and Debug Command

Add a Discord command that forces BookieBot to rebuild the hidden normalized subscription schedule immediately.

Possible commands:

```text
sync subscriptions
debug subscriptions
/subscriptions sync
/subscriptions debug
```

Expected output:

```text
Synced 13 subscriptions for Brian.
Hidden sheet: _BookieBot Subscription Schedule
Skipped 1 row:
- Subscriptions!B12:D12: missing pull date
```

Why this matters:

- Useful during development and sheet-format changes.
- Useful when the user wants to verify a change immediately.
- Should not be required for normal operation.

## 4. Optional Visible Columns for Payment Method and Reminder Windows

Keep the pretty grouped layout, but optionally support extra visible columns in each block.

Recommended block format:

```text
Recurring | Name | Amount | Account | Reminders
21st      | ChatGPT | $20.00 | BofA | 7,3,1
```

Column meaning:

- `Account`: bank account, credit card, or payment method used for the subscription.
- `Reminders`: per-subscription reminder windows, such as `14,7,3,1`.

Why this matters:

- Payment method makes reminders more actionable.
- Per-subscription windows let large or important charges get more warning.

## 5. Same-Day Reminders

Status: implemented by default. Reminder windows now include `7,3,1,0`.

Optionally add a `0` day reminder window.

Example digest:

```text
Today:
`Railway - $5.00 - May 15`
```

Why this matters:

- Some users may want a final morning warning before the charge hits.
- This can be opt-in globally or per subscription.

## 6. Cash-Flow Rollups

Status: implemented for subscription reminder digests. The first notification line includes the total amount expected to pull in the next 7 days.

Add totals to reminder digests.

Example:

```text
<@user> `$44.99` will be pulled by subscriptions in the next 7 days.

Today:
`None`

Tomorrow:
`Railway - $5.00 - May 15`
`LinkedIn Premium - $39.99 - May 15`

Upcoming:
`None`
```

Why this matters:

- The user can quickly understand the expected bank impact.
- Larger upcoming pulls become easier to spot.

## 7. Bill Confirmation and Reconciliation

Status: implemented as first-class scheduled bills. BookieBot reads `_BookieBot Bill Schedule`, checks the existing manually logged monthly payment fields, and includes bills in the same cash-pull digest as subscriptions.

Compare expected pulls against payments already logged in BookieBot.

Example:

```text
<@user> `$245.00` known + `1 missing amount` will be pulled by bills and subscriptions in the next 7 days.

Tomorrow:
`PG&E - amount missing - May 19`
```

Near-term version:

- Use BookieBot's manually logged payment fields as the monthly amount source.
- Use `_BookieBot Bill Schedule` for fixed autopay dates.
- Include known bill amounts in the digest total.
- Count missing amounts separately so the notification preview does not understate known cash needs.
- Repeat overdue missing bill notices daily until the amount is entered or the month changes.

Future version:

- Pull bill status from provider websites or APIs where possible.
- Pull bank transactions through read-only bank integration.
- Confirm whether expected autopays actually posted.

Why this matters:

- Dynamic bills are harder to model as fixed subscriptions.
- This connects the schedule to real-world payment confirmation.

## 8. Dedicated Reminder Log

Move duplicate-prevention state out of the action log and into a dedicated hidden reminder log.

Possible hidden tab:

```text
_BookieBot Subscription Reminder Log
```

Possible columns:

```text
sent_at | budget_owner_key | subscription_id | pull_date | days_until | discord_message_id
```

Why this might be useful:

- The current action log works, but it mixes reminder state with undo/action history.
- A dedicated reminder log would make it easier to answer, "Did BookieBot already send this?"
- It would make reminder debugging less noisy.

Why it might not be worth doing yet:

- It adds another hidden tab.
- The current duplicate-prevention mechanism is already functional.
- This is mainly useful once reminders become more complex.

Recommendation:

- Keep using the action log for now.
- Revisit a dedicated reminder log when debugging reminder history becomes painful.

## 9. Price Change Detection

Compare current synced amount against the previous synced amount and alert when a subscription price changes.

Example:

```text
Apple iCloud changed from $2.99 to $9.99.
```

Near-term limitation:

- Without bank/API data, BookieBot can only detect changes after the user updates the visible sheet.
- That means the user probably already noticed the change.

Future version:

- Compare expected subscription amounts against actual bank transactions.
- Alert when a posted transaction differs from the expected amount.

Recommendation:

- Defer until read-only bank integration or provider/API data exists.

## 10. Per-User Notification Settings

Status: implemented for send hour through owner-specific environment variables.

Allow each budget owner to configure reminder timing.

Examples:

```text
Brian: 10 AM
Hannah: 8 AM
```

Why this matters:

- Different users may want reminders at different times.
- The feature is already per-user, so notification settings can follow that same model.

## Suggested Priority

1. Automatic sync health and self-healing
2. Parse warnings and user-facing errors
3. Manual sync/debug command as a backstop
4. Optional visible columns for `Account` and `Reminders`
5. Same-day reminders
6. Cash-flow rollups
7. Bill confirmation/reconciliation
8. Dedicated reminder log if action-log debugging becomes painful
9. Price change detection after bank/API integrations
10. Per-user notification settings beyond send hour
