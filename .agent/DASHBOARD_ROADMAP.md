# Expense Dashboard Enhancement Roadmap

Approved by the user on 2026-09-07. Deliver in separate, reviewable passes; preserve the compact design and existing financial behavior. Active priority lives in STATUS.md. Each pass includes focused regressions, applicable broader checks, tracking updates, commit/push to main and deployment verification. The user subsequently authorized autonomous completion of all passes in this run. Keep separate verified commits; no additional user decisions are required for implementation. Notification delivery still requires each device’s explicit in-app opt-in.

| Pass | Approved scope | Status | Acceptance |
| --- | --- | --- | --- |
| 1 | Outstanding reimbursements carry forward across months | Complete | Owner-scoped unpaid items remain visible until settled/voided, including year rollover; group by partner, retain dates, keep monthly received history secondary and monthly metrics unchanged. |
| 2 | Chart-to-transaction drilldowns; recorded vs scheduled labels | Complete | Category/day selections show the relevant entries through one consistent detail flow. Scheduled/projected amounts remain visibly distinguishable from recorded activity. |
| 3 | Historical months and fair comparisons | Complete | Month picker uses authenticated, bounded historical reads. Compare matching elapsed periods by default; handle short months/missing history and provide an obvious return to the current month. |
| 4 | Explain headline totals; remember preferred view; deployed-update prompt | Complete | Income/Spent/Left/Saved explain canonical calculations. Each phone restores its own chart/mode preference. Update action loads the new frontend while preserving its authenticated connection. |
| 5 | Ask BookieBot about the displayed report | Complete | Read-only, owner-scoped questions reuse the existing agent/report calculations, including selected month/mode; answers can identify supporting report details. Keep the entry point compact. |
| 6 | Optional phone notifications | Complete | User chooses useful notification types, timing and amount visibility; explicit opt-in, per-device unsubscribe, deduplication, delivery tracking and no duplicated Discord reminders by default. |
| 7 | Savings goals beyond the current month | Complete | Durable goal targets and accumulated balances, clear personal/shared ownership, progress without double-counting monthly savings. |

## Implemented defaults

- Notifications require each phone’s opt-in. Monday at 10 AM Pacific is the initial weekly preference, tomorrow payments are optional, and lock-screen amounts start hidden. Existing Discord reminders are unchanged.
- Savings goals belong to the signed-in person. Users explicitly enter targets, dates, starting balances and contributions. Contributions are manual allocations, never inferred bank balances or duplicated monthly savings. Shared goals await an explicit household-membership model.
- Assistant answers are ephemeral and read-only; there is no persistent app conversation.

## Scope boundary

The user selected priorities 1–4, all three small refinements, and all three larger improvements from the audit: ten approved improvements across seven passes. Separate Daily Spending search/Today controls and an upcoming-payments agenda (audit priorities 5–6) were not selected for this roadmap.
