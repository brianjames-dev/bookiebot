# September 6 audit remediation

All eight approved batches are implemented. The original twelve findings were reproduced offline and addressed incrementally, with separate verified commits. No live financial test transactions or worksheet migrations were performed.

| Batch | Result |
| --- | --- |
| 1 — Commands and capabilities | Bill questions/negation cannot dispatch payment writes. Updated payments/savings preserve their type and cannot delete whole budget rows. |
| 2 — Owner references | Income insert/delete/restore/placeholder cleanup repairs only the correct owner's action and split-ledger references, including later bill/savings cells and inactive undo lineage. |
| 3 — Shared undo | Restores the removed transaction using current neighboring rows, preserving another user's later edits and additions. Changed move destinations fail safely. |
| 4 — Bank imports | One durable operation guards each import across repeated forms, concurrent submissions, restarts, and uncertain responses. Recovery links a known action without writing again. Unsupported dates reject before writing. |
| 5 — Lifecycle recovery | Material bank changes reopen prior matches with durable audit events. Failed reminder preparation retries. Webhook leases recover abandoned work and reject stale acknowledgements. |
| 6 — Reports | Every report route requires signed access. Live builds run off the event loop with bounded concurrency; history reads are batched and optional lookups never create sheets. |
| 7 — CI and automation | Incident text stays in files rather than shell code. Push/PR CI runs Python, types, real Postgres contracts, Apps Script, frontend build and asset parity. |
| 8 — Cleanup | Removed 21 unused HTML helpers and separated worksheet transport from report calculations. Historical payload/frontend compatibility remains supported. |

## Verification

- Final combined Python suite: **777 passed**, including native chart rendering and **18 SQLite/Postgres contract cases**. One existing Kaleido deprecation warning remains.
- Pyright: **0 errors**.
- Apps Script income migration, settings, month/year rollover and collision checks: passed.
- Frontend typecheck/build and committed-asset parity: passed.
- Cleanup comparison: **71 identical payloads and 26 byte-identical HTML pages** across seven months.
- GitHub Verification is enabled for pushes and pull requests. Final remote result is reported with the delivery; local results above are independently verified.

## Manual acceptance after deployment

Use a test workbook and Plaid Sandbox items for changes below.

1. Ask `Can I afford $2100 rent?`, `Do not log my $148.82 water bill`, and `Rent $2100?`. Confirm no payment changes. Then log `Water bill 148.82` and verify the intended payment.
2. Log both owners' payments. Add/delete/undo Brian income; update both owners' payments and savings. Verify the correct labels/amounts and split-ledger references. Repeated bill updates must never expose whole-row deletion.
3. Brian deletes or moves an expense; Hannah edits another amount and adds a row; Brian undoes. Verify all later values survive and subsequent Recent updates still target the right rows.
4. Open two forms for one current-month bank item and submit both. Verify one row/action/link. Try an earlier-month item: no write. For an interrupted import, inspect its operation and sheet history; a recorded action may recover without another row.
5. Change a confirmed Sandbox bank amount. Verify Needs Review and its previous-match event without a sheet change. Simulate a failed reminder read, restore access, and verify successful delivery without premature sent state. Reclaim an expired webhook and verify the old claim cannot acknowledge it.
6. Open a fresh signed report. A missing/expired/tampered/different-file token must deny filename access. Refresh concurrently while using Discord; then edit the test sheet and verify a later refresh sees the edit. Missing optional worksheets must remain missing.
7. Review the Verification workflow on a push/PR. Run the autofix metadata helper with a fixture containing apostrophes, multiline text, backticks and literal shell substitutions; generated text must remain data.
8. Compare Current, Projected, and historical reports against known fixtures for identical totals, charts, and compatibility behavior.

## Remaining boundaries

- Bank imports support the current month only. Historical destination-aware writing and undo remain future work; historical matching/reporting remain supported.
- An uncertain import with no unique recorded action, an ambiguous record, an intentional undo/reopen, or a period rollover requires inspection. Time alone never resets a potentially written claim.
- Ordinary Sheets mutations and action-log writes still cannot share a transaction. General recovery for an action-log failure after a non-import mutation remains a documented follow-up.
- Existing split lifecycle, durable pending-selection, and deployment checklists remain in the workstream. Completing these eight batches does not claim those separate backlog items are finished.

Tracking: `STATUS.md` is the active queue, `WORKSTREAM_FINANCE_OPS.md` records batch completion, and `DECISIONS.md` records the durable semantics.
