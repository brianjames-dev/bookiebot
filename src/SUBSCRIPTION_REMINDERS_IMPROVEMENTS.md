# Subscription and Bill Pull Reminders

BookieBot now has a working pull-reminder flow for fixed subscriptions and dynamic bills:

- The visible `Subscriptions` sheet remains the user-facing subscription source.
- BookieBot syncs subscriptions into `_BookieBot Subscription Schedule`.
- BookieBot tracks fixed-date dynamic bills in `_BookieBot Bill Schedule`.
- The daily digest includes subscriptions and bills expected to pull today through the next 7 days.
- Reminders send once per user per day after the configured Pacific send hour.

This document tracks what is implemented now and what remains on the roadmap.

## Current Implementation

### Hidden Subscription Schedule

Status: implemented.

The hidden `_BookieBot Subscription Schedule` tab now contains only the columns BookieBot currently uses:

```text
cadence | name | amount | pull_day | pull_month | source_range | updated_at
```

Notes:

- Canceled subscriptions should be deleted from the visible sheet.
- The hidden sheet is rewritten from the visible `Subscriptions` sheet during sync.
- Manual formatting on the hidden sheet generally persists because BookieBot updates values in place.
- If the hidden sheet is deleted and recreated, manual formatting is lost.
- Old hidden schedule layouts are not supported.

### Hidden Bill Schedule

Status: implemented.

BookieBot creates `_BookieBot Bill Schedule` for fixed-date bills with dynamic amounts.

Current columns:

```text
bill_key | display_name | recurrence | pull_day | pull_months | source_label | account | notes | updated_at
```

How it works:

- Row existence means the bill is tracked.
- Blank template rows do not create reminders.
- `recurrence` supports `monthly` and `quarterly`.
- Quarterly bills require explicit `pull_months`, such as `2,5,8,11`.
- `source_label` maps to the existing monthly amount row used by commands like PG&E, Water, Rent, or Student Loan.
- `account` and `notes` are currently human/debug metadata.

### Daily Cash-Pull Digest

Status: implemented.

The digest combines subscriptions and scheduled bills in one Discord message.

Example:

```text
<@user> `$428.07` will be pulled by bills and subscriptions in the next 7 days.

Today:
`iCloud Storage - $2.99 - May 16`

Upcoming:
`Water - $117.36 - May 18`
`Recology - $145.36 - May 20`
`PG&E - $132.36 - May 22`
```

Behavior:

- Empty `Today`, `Tomorrow`, and `Upcoming` sections are omitted.
- Known bill amounts are included in the headline total.
- Missing bill amounts are counted separately.
- Overdue missing bill amounts appear daily until entered or until the month changes.
- Duplicate daily digests are suppressed through the action log.
- Deleting the relevant action-log row allows manual reminder retesting.

### Warning and Debug Flow

Status: implemented.

BookieBot surfaces schedule issues it cannot resolve automatically.

Examples:

```text
Subscriptions!B12:D12: missing amount
Subscriptions!J8:L8: invalid yearly date "13/40"
_BookieBot Bill Schedule!A5:I5: quarterly bill missing pull months (Water)
```

Implemented behavior:

- Subscription parse warnings are collected from the visible grouped layout.
- Bill schedule warnings are collected from the hidden bill schedule.
- Warning digests are sent after the configured send hour.
- Warnings are deduped once per day through the action log.
- `/debug_subscriptions` syncs subscriptions and reports parsed bill schedules and warnings.

### Timing and Ownership

Status: implemented.

- Global send hour defaults to 10 AM Pacific.
- Owner-specific send-hour overrides are supported through `BRIAN_SUBSCRIPTION_REMINDER_SEND_HOUR` and `HANNAH_SUBSCRIPTION_REMINDER_SEND_HOUR`.
- Each user has their own personal budget sheet and therefore their own hidden subscription and bill schedules.
- Shared duplicate-prevention state is stored in the action log.

## Product Decisions

- Subscription cancellation means deleting the visible subscription row.
- Bill removal means deleting the hidden bill schedule row.
- `Account` means bank account, credit card, or payment method; it does not mean the budget owner.
- Hidden sheets are agent infrastructure, but can be unhidden for debugging.
- Manual debug commands are useful backstops, not required operating steps.
- BookieBot should only surface schedule errors when it cannot safely recover automatically.

## Roadmap

### 1. Read-Only Bank Integration

Status: future.

This is the biggest next step for making reminders more accurate.

Useful capabilities:

- Confirm whether expected bills and subscriptions actually posted.
- Compare posted transactions against expected amounts.
- Detect missed manual bill entries.
- Detect duplicate logs.
- Show cash-flow risk before large upcoming pulls.

Constraints:

- Read-only access only.
- Never move money.
- Surface only actionable differences.

### 2. Posted-Pull Reconciliation

Status: future, depends on bank/provider data.

Current bill logic knows what should pull and whether a manual amount was entered. It does not know whether the bank transaction actually posted.

Future behavior:

```text
PG&E was expected May 22 for $132.36, but no matching bank transaction has posted yet.
```

This should eventually replace manual confirmation with automatic reconciliation.

### 3. Price Change Detection

Status: future.

Near-term price detection is limited because BookieBot only sees what the user typed into the sheet.

Useful future behavior:

```text
Apple iCloud posted at $9.99, but the subscription schedule expected $2.99.
```

This becomes valuable after bank/provider integrations exist.

### 4. Payment Method in Digest

Status: optional.

The hidden schedules already have room for bill `account`, and the visible subscription sheet may eventually expose a subscription account/payment method.

Possible future line:

```text
PG&E - $132.36 - May 22 - BofA
```

This should only be added if it makes notifications more actionable without making the digest noisy.

### 5. Per-User Reminder Settings Beyond Send Hour

Status: future.

Potential settings:

- Different lookahead windows.
- Different digest channels.
- Separate bills/subscriptions digests.
- Weekend/holiday adjustment preferences.

The current implementation intentionally keeps the product simple: one daily cash-pull digest per budget owner.

### 6. Dedicated Reminder Log

Status: deferred.

The action log currently stores duplicate-prevention events for:

- Cash-pull digest sent.
- Subscription reminder sent.
- Bill reminder sent.
- Subscription parse warning sent.
- Bill schedule warning sent.

A dedicated reminder log could make debugging easier later, but it adds another hidden tab and is not necessary yet.

Revisit this only if action-log debugging becomes too noisy.

## Testing Checklist

Use this list when changing reminder behavior:

- Subscription pulling today appears in `Today`.
- Subscription pulling tomorrow appears in `Tomorrow`.
- Subscription pulling in 2-7 days appears in `Upcoming`.
- Empty timing sections are omitted.
- Monthly bill with entered amount appears with amount.
- Monthly bill without entered amount appears as `amount missing`.
- Quarterly bill only appears in configured pull months.
- Quarterly bill without `pull_months` produces a warning.
- Overdue missing bill repeats daily until amount is entered.
- Daily digest does not repeat unless the action-log event is deleted.
- `/debug_subscriptions` reports parsed subscriptions, bill schedules, and warnings.

## Related Roadmap Items

This feature maps to `ROADMAP.md` item 3, Bill and Subscription Pull-Date Reminders.

The next major unlock is `ROADMAP.md` item 4, Read-Only Bank Account Integration.
