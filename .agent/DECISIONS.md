# Agent Decisions

Record durable technical decisions here. Keep entries short and dated.

## 2026-06-14 - Use Agent Tracking Files

Decision: Add a root `.Agents` protocol file and a `.agent/` folder for current status, workstream backlog, and architecture decisions.

Rationale: Reconciliation and recent-action work spans bank storage, Discord workflows, Google Sheets mutation, and audit behavior. A small protocol keeps future agent work aligned without forcing a heavy project-management system.

## 2026-06-14 - Centralize Finance Operations Backlog

Decision: Use `.agent/WORKSTREAM_FINANCE_OPS.md` as the centralized workstream for bank reconciliation, transaction inbox behavior, and recent-action update/move/delete stabilization. Keep `.agent/STATUS.md` as the short on-deck view for the next implementation focus.

Rationale: Reconciliation and recent transactions share action-log lineage, sheet mutation, audit events, and user confirmation semantics. A single backlog prevents related work from drifting across separate documents.

## 2026-06-18 - Treat Recent Expense Mutations As Lineages

Decision: Recent expense move/delete behavior should operate on the active action lineage rather than only the latest raw action record. Deletes record all active action IDs in the deleted lineage so undo can restore the expected visible state.

Rationale: Updates and moves create new action records while preserving the same underlying sheet transaction. Operating on only the latest record caused updated or moved expenses to become hard to move/delete safely and could let stale source actions reappear after deletion.

## 2026-06-18 - Use Status As The Priority Queue

Decision: Use `.agent/STATUS.md` as the active priority queue, `.agent/WORKSTREAM_FINANCE_OPS.md` as the centralized backlog and context sheet, `.agent/DECISIONS.md` for durable decisions, and `.Agents` as the required task completion loop.

Rationale: The workstream document is intentionally broad, while active implementation needs a smaller on-deck surface. This keeps day-to-day task selection simple without losing the larger reconciliation and recent-transactions roadmap.

## 2026-06-18 - Centralize Recent Action Capabilities

Decision: Recent-action UI and handlers should use one capability helper for supported operations, editable fields, and user-facing unsupported-operation reasons.

Rationale: Update, move, delete, and undo support differs by action type. Centralized capabilities prevent the UI from presenting invalid controls and keep direct command failures consistent with selected-transaction workflows.

## 2026-06-18 - Expire Pending Recent-Action State With Component Views

Decision: In-process pending recent-action selections, update-field prompts, and move-item prompts expire after 300 seconds.

Rationale: Five minutes gives users a more practical reply window while still preventing old numeric replies or free-text values from mutating a transaction the user no longer has visible context for.

## 2026-06-18 - Keep Recent-Action Workflows Private To The Actor

Decision: Recent-action lists, follow-up prompts, and mutation results should be private to the user who triggered the workflow. Text-command recent lists are sent by DM when possible, component responses are ephemeral, and controls reject interactions from other users.

Rationale: Recent transactions can expose personal financial details. Keeping the workflow actor-scoped prevents other Discord users in the channel from seeing transaction details or mutating someone else's pending recent-action state.

## 2026-06-18 - Use Generic Public Reconciliation Digest Prompts

Decision: Scheduled reconciliation digest messages in the shared channel should show only a short unresolved-item count and route the detailed review into ephemeral interaction responses.

Rationale: Discord cannot provide a persistent channel message whose body is visible only to one user. A generic persistent prompt preserves the channel reminder and buttons while keeping bank transaction details private.

## 2026-06-18 - Bound Daily Reconciliation Digest To Morning Window

Decision: The normal daily reconciliation digest is eligible only inside the configured morning send window, defaulting to 60 minutes from `BOOKIEBOT_BANK_RECONCILIATION_SEND_HOUR`.

Rationale: The previous `current.hour >= send_hour` gate allowed newly synced Plaid transactions to cause a digest later in the day if no digest had been sent during the morning. A bounded window keeps daily digest behavior predictable.

## 2026-06-18 - Remove Reconciliation Digest Snooze

Decision: Reconciliation digest snooze/reminder functionality should be removed rather than hardened. The persistent public digest prompt now offers only `Reconcile Now`, and private review sessions provide `Ignore All` for dismissing the current review batch.

Rationale: Snooze created a second digest delivery path that could make reconciliation prompts appear later in the day. Removing it simplifies the lifecycle to daily scheduled sends plus explicit review actions.

## 2026-06-19 - Send Finance Digests By DM

Decision: Reconciliation and bills/subscriptions digests should send detailed finance content to the target user's DM. Reconciliation digest controls should offer `Reconcile Now` and `View Inbox`; list-level `Ignore All` belongs only on the inbox view.

Rationale: DM delivery avoids exposing finance details in shared channels. Keeping `Ignore All` on the inbox list makes the destructive bulk action apply only to the displayed batch, while one-at-a-time reconciliation stays focused on the current transaction.

## 2026-06-20 - Do Not Expose User-Entered Date Updates

Decision: Recent transaction update flows should not ask users for dates or accept parsed user-entered `date` updates. Date mutation is only allowed for reconciliation-origin automation that can use the bank transaction's reported date.

Rationale: Users should not have to reason about sheet dates manually during update/move/delete workflows. Reconciliation has the authoritative bank transaction date, so any automatic date correction should happen there.

## 2026-06-20 - Reopen Reconciliation Links After Recent-Action Mutation

Decision: When a recent action linked to reconciliation is updated, moved, deleted, or undone, reopen matching reconciliation items by action-log ID rather than leaving them confirmed/matched.

Rationale: A sheet mutation can invalidate the prior reconciliation decision. Reopening keeps the system conservative and visible until a later state-machine pass decides which unchanged mutations can safely stay confirmed.

## 2026-06-20 - Use 60 Days For Normal Reconciliation Freshness

Decision: Normal unresolved reconciliation digest, inbox, and session views should exclude posted bank transactions older than 60 days by default through `BOOKIEBOT_RECONCILIATION_MAX_AGE_DAYS`.

Rationale: Old Plaid or cached transactions were resurfacing as if they were current work. Hiding older items from normal review keeps the inbox actionable without deleting historical records.

## 2026-06-20 - Use Bank Amount After User Confirms A Match

Decision: Confirming an existing sheet/action row during reconciliation is the user's approval that the row represents the bank transaction. If that row's amount differs, BookieBot should update the sheet/action amount to the bank transaction amount and then confirm the reconciliation item.

Rationale: The human-in-the-loop step is selecting the matching row. After that selection, the bank transaction is the source of truth for the amount, and the user should not have to manually edit the price before reconciliation can complete.

## 2026-06-20 - Require Explicit Row Choice For Grouped Amount Adjustments

Decision: Grouped reconciliation matches should still reject mismatched totals by default. If the user chooses one row in the group to absorb the difference, BookieBot may update that row amount to make the grouped total match the bank transaction and then confirm the group.

Rationale: Grouped matches involve multiple sheet rows, so BookieBot should not guess which row should change. The human confirmation is selecting both the group and the specific row to adjust.

## 2026-07-05 - Snapshot Closed-Month Formula Outputs

Decision: Monthly Google Apps Script rollover should freeze previous-month personal budget formula outputs for Burn Rate and subscription totals as static values before creating or relinking the new month.

Rationale: Closed-month review cells should remain auditable snapshots. Live formulas such as burn rate and subscription totals can recalculate after the calendar rolls forward, making historical months misleading.

## Pending Decisions

- Where should durable system events live: banking database only, Google Sheets only, or dual-write during transition?
- What exact reconciliation states should replace or extend the current status set?
- What should the canonical model be for recent-action lineages after update, move, delete, and undo?
