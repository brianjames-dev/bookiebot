# Expense Dashboard Enhancement Roadmap

Approved by the user on 2026-09-07. Deliver in separate, reviewable passes; preserve the compact design and existing financial behavior. Active priority lives in STATUS.md. Each pass includes focused regressions, applicable broader checks, tracking updates, commit/push to main and deployment verification. The user subsequently authorized autonomous completion of all passes in this run. Keep separate verified commits; no additional user decisions are required for implementation. Notification delivery still requires each device’s explicit in-app opt-in.

| Pass | Approved scope | Status | Acceptance |
| --- | --- | --- | --- |
| 1 | Outstanding reimbursements carry forward across months | Complete | Owner-scoped unpaid items remain visible until settled/voided, including year rollover; group by partner, retain dates, keep monthly received history secondary and monthly metrics unchanged. |
| 2 | Chart-to-transaction drilldowns; recorded vs scheduled labels | Queued | Category/day selections show the relevant entries through one consistent detail flow. Scheduled/projected amounts remain visibly distinguishable from recorded activity. |
| 3 | Historical months and fair comparisons | Queued | Month picker uses authenticated, bounded historical reads. Compare matching elapsed periods by default; handle short months/missing history and provide an obvious return to the current month. |
| 4 | Explain headline totals; remember preferred view; deployed-update prompt | Queued | Income/Spent/Left/Saved explain canonical calculations. Each phone restores its own chart/mode preference. Update action loads the new frontend while preserving its authenticated connection. |
| 5 | Ask BookieBot about the displayed report | Queued | Read-only, owner-scoped questions reuse the existing agent/report calculations, including selected month/mode; answers can identify supporting report details. Keep the entry point compact. |
| 6 | Optional phone notifications | Queued | User chooses useful notification types, timing and amount visibility; explicit opt-in, per-device unsubscribe, deduplication, delivery tracking and no duplicated Discord reminders by default. |
| 7 | Savings goals beyond the current month | Queued | Durable goal targets and accumulated balances, clear personal/shared ownership, progress without double-counting monthly savings. |

## Product decisions to settle when the relevant pass starts

- Notifications: event types, quiet hours, whether amounts appear on the lock screen, and how phone alerts complement existing Discord reminders. Implementing notification infrastructure does not authorize unsolicited messages.
- Long-term savings: goal names, target amounts/dates, starting balances, funding source, and personal versus household ownership. Reuse reliable existing data where possible; do not infer account balances from budget availability.
- Assistant: keep answers read-only; confirm desired history retention when adding persistent app conversations.

## Scope boundary

The user selected priorities 1–4, all three small refinements, and all three larger improvements from the audit: ten approved improvements across seven passes. Separate Daily Spending search/Today controls and an upcoming-payments agenda (audit priorities 5–6) were not selected for this roadmap.
