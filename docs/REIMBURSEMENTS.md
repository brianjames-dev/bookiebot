# Shared reimbursements

The payer keeps the full purchase in their expenses until repayment is confirmed. A confirmed partial repayment reduces that original expense and adds one linked expense for the person repaying, dated when they paid. The original purchase amount stays available for bank matching. Repayments are not income, and BookieBot never transfers money.

For a $200 purchase split equally, the payer initially records $200 and is owed $100. Confirming $40 changes the original expense to $160, records a $40 reimbursement expense for the other person, and leaves $60 owed. Confirming the remaining $60 leaves each person with $100 of expenses.

## Phone workflow

- **Owed to you / You owe** shows both directions and the net difference. The month segments describe which purchases make up the selected balance.
- A direction with no outstanding debt shows a simple message. Existing settled history remains available; an empty direction has no expense-list disclosure.
- Expand an expense to see its split, confirmed payments and remaining amount.
- **Record received** confirms a full or partial amount already received.
- **Record sent payment** records the debtor's report. It stays pending until the recipient selects **Confirm received**. Pending reports must be resolved before recording another direct receipt or offset for that expense.
- **Offset balances** previews specific amounts allocated to expenses in each direction. Equal totals on each side cancel debt without implying a cash transfer. Review and confirm the selection; BookieBot never offsets automatically.
- Payment history supports a reviewed reversal. An offset reversal restores the entire linked group together. Rows remain in the audit history.
- A syncing notice means the payment is saved but one or more expense-sheet projections are pending. Refresh retries the same absolute targets. An uncertain command retry retains its original request ID; reopening a screen is not proof that a prior write failed.

Received historical splits imported from the older model are read-only. Importing them does not invent past counterpart expenses, guess missing payment dates, or duplicate repayments recorded manually.

## Storage and integrity

The existing durable phone database stores allocations, payment events, versions and idempotency records. SQLite supports local development; PostgreSQL serializes household operations across production processes. Expense shares plus each outstanding/settled balance reconcile in integer cents. Debtor reports cannot confirm receipt; stale versions, overpayments, invalid ownership, pending-payment ambiguity and unequal offsets are rejected before any balance change.

The database commits each allocation/settlement atomically. Google Sheets is a separately recoverable projection. Source and payment cells have allocation/event-specific named ranges. New receipt cells and their names are created in one Sheets batch; retries find the existing row. Existing anchors follow row insertion and are validated before use. Source edits, ambiguous identities, deleted/detached anchors and unverifiable outcomes stop projection and retain the pending status. Application locks do not create conditional compare-and-swap guarantees against arbitrary manual sheet edits.

Before changing shared expenses, the projector verifies that each affected personal budget still imports the matching live category total. A frozen or changed summary needs review; recording a payment remains durable while its sheet update stays pending. This also covers payments dated in earlier months. The Shared Reimbursements worksheet is an ID-anchored generated view of the same ledger, including ownership repairs and receipt dates. Unrelated rows, void history and extra columns are preserved. A version is fully synced only after both expense rows and this worksheet view verify successfully.

Generated repayment rows are not ordinary purchase action-log entries, so they do not compete with the original gross bank transaction in purchase reconciliation. Canonical splits cannot pass through the old direct row undo/change/delete flow; payment reversals use the ledger. Gross corrections, split-method edits and cancellation after migration require a separate linked correction workflow rather than bypassing these guards.

## Controlled rollout

`BOOKIEBOT_REIMBURSEMENTS_ENABLED` defaults to `false` until the existing ledgers have been inspected and migrated. The frontend then retains the existing reimbursement section. Keep the feature disabled during the first migration.

Generate a private plan from configured existing annual ledgers:

```bash
PYTHONPATH=src python scripts/migrate_reimbursements.py --plan /tmp/reimbursement-plan.json
```

The optional `--corrections` JSON maps allocation IDs to explicitly verified `payerOwner`, `payerPerson`, `item`, `expectedSourceAmount`, `expectedSourcePerson` and `expectedSourceItem`. Never commit that file or the financial plan. The plan rejects incomplete history, inconsistent ownership and changed source rows. Review every issue and proposed source before applying the exact saved plan:

```bash
PYTHONPATH=src python scripts/migrate_reimbursements.py --plan /tmp/reimbursement-plan.json --apply
```

Reusing that plan resumes its existing registrations/projections. Do not generate a different request to guess whether a timed-out mutation succeeded. After verified migration, enable `BOOKIEBOT_REIMBURSEMENTS_ENABLED=true` on the existing service. No new database credentials or banking integration are required.

After migration, disabling the feature is not a financial rollback: the source rows now follow the confirmed-repayment model. Keep canonical mutations enabled or suspend writes for maintenance while repairing a failed deployment; do not resume legacy split/receipt writes against migrated records.

## Acceptance checks

In isolated workbooks/database, test both payer directions, partner names inside item descriptions, both active Brian accounts, income/equal/fronted splits, partial/full/sent-confirmed payments, pending-payment rejection, equal offsets, whole-group reversal, payment dates across months/years, stale views and repeat requests. Check gross bank matching and that each linked expense appears once. Inject failures after database commit, after anchor/row creation and after Sheets value updates; verify retry converges without duplicate expenses. Confirm both phone themes and narrow date-input layout. Use a disposable PostgreSQL database for concurrent-process contracts; never point `BOOKIEBOT_TEST_POSTGRES_URL` at production.
