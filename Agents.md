# BookieBot Agent Protocol

This repository uses agent tracking files to keep long-running BookieBot work organized.

## Required Reading

Before making non-trivial changes, read:

- `README.md` for product and integration context.
- `src/ROADMAP.md` for the broader product direction.
- `.agent/STATUS.md` for current focus and next steps.
- `.agent/WORKSTREAM_FINANCE_OPS.md` before touching bank reconciliation, transaction inbox, or recent-action update/move/delete behavior.
- `.agent/DECISIONS.md` before changing architecture, persistence, event logging, reconciliation state, or sheet mutation flows.
- This `Agents.md` file before starting implementation work that should update project tracking docs.

## Working Protocol

1. Start by identifying the active workstream and checking `.agent/STATUS.md`.
2. Inspect existing code and tests before proposing or editing.
3. Keep changes scoped to the requested behavior.
4. Prefer existing project patterns over new abstractions unless the current shape is causing repeated complexity.
5. For bug fixes, add or update focused regression tests.
6. Run the smallest useful verification first, then broader tests when the change touches shared flows.
7. Update `.agent/STATUS.md` after meaningful milestones.
8. Add a `.agent/DECISIONS.md` entry for choices that affect architecture, data storage, event protocols, reconciliation lifecycle, or user-facing workflow.

## Task Workflow

Use this loop for each implementation task.

### Priority Source

Pick the next task from `.agent/STATUS.md` only. Treat `.agent/WORKSTREAM_FINANCE_OPS.md` as the full backlog and reference material, not as the active priority list.

### Execution Loop

1. Read `.agent/STATUS.md` and identify the first on-deck item.
2. Read the matching section in `.agent/WORKSTREAM_FINANCE_OPS.md` for context, invariants, and related files.
3. Inspect the current code and tests before editing.
4. Add or update regression tests before or alongside the code change.
5. Implement the smallest coherent slice.
6. Run targeted verification first.
7. Run broader verification when the change touches shared behavior.
8. Update `.agent/STATUS.md` before stopping:
   - remove or reorder completed on-deck items
   - add a dated completed-work entry
   - record latest verification results
   - add manual test steps for user-facing behavior
9. Update `.agent/WORKSTREAM_FINANCE_OPS.md` when backlog status changes:
   - mark slices complete, partial, blocked, or still pending
   - add a dated work-log entry for meaningful changes
   - add new open questions or follow-up slices discovered during the task
10. Update `.agent/DECISIONS.md` only for durable decisions that affect architecture, data shape, lifecycle semantics, or user workflow.
11. Final response must summarize code changes, tests run, docs updated, and manual test steps.

### Completion Standard

A task is complete only when:

- The requested behavior is implemented.
- Relevant regression tests exist.
- Verification has been run or a clear blocker is documented.
- `.agent/STATUS.md` reflects the new on-deck state.
- `.agent/WORKSTREAM_FINANCE_OPS.md` reflects any backlog status changes.
- Manual testing instructions are documented for user-facing behavior.

## Quality Gates

Use these commands as the default verification stack:

```bash
python -m pytest unit_tests
python -m pyright
```

For narrower work, run targeted tests first, for example:

```bash
python -m pytest unit_tests/banking/test_reconciliation.py unit_tests/banking/test_store.py unit_tests/core/test_bank_reconciliation.py
python -m pytest unit_tests/intents/test_handlers.py unit_tests/core/test_message_router.py
```

If a verification command fails, fix the smallest real issue, add a regression test when appropriate, and rerun the failed command.

## Reconciliation Safety Rules

Reconciliation and recent-action changes must preserve these invariants:

- Do not write imported bank transactions into budget sheets without explicit user confirmation.
- Do not silently mutate a sheet row during reconciliation when there is an amount mismatch; surface the choice to the user unless the workstream explicitly says otherwise.
- Do not allow very old bank transactions into the normal review inbox unless the user intentionally requests historical review.
- Do not clear a snooze or mark a digest as sent before the Discord message send succeeds, unless the system records a recoverable claimed/failed state.
- Keep bank transaction state, reconciliation item state, and sheet action-log lineage synchronized when an expense is updated, moved, deleted, confirmed, ignored, or reopened.
- Log lifecycle events for important reconciliation actions so behavior can be audited later.

## Documentation Rules

- `.agent/STATUS.md` is the active priority queue and on-deck view.
- `.agent/WORKSTREAM_FINANCE_OPS.md` tracks the centralized backlog for reconciliation, transaction inbox, and update/move/delete expense stabilization.
- `.agent/DECISIONS.md` records durable decisions with dates and rationale.
- This `Agents.md` file defines how each task moves from priority selection through implementation, verification, and documentation updates.
- Keep docs concise. Add enough detail for the next agent to resume safely.
