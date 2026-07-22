# Data Model

## Principles

- Local database is canonical.
- Sheets exports are derived.
- Model output is never canonical until tools validate and write it.
- Every user-facing mutation creates an audit event.
- Bank transactions and ledger transactions are different entities until reconciled.

## Core Entities

### Household

Represents the local finance workspace.

Fields:

- `id`
- `name`
- `timezone`
- `currencyCode`
- `createdAt`
- `updatedAt`

### Member

Fields:

- `id`
- `householdId`
- `displayName`
- `defaultAccountId`
- `isActive`

### SpendingAccount

User-facing payment source or bank account.

Fields:

- `id`
- `householdId`
- `memberId`
- `displayName`
- `kind`: `manual_card`, `checking`, `credit_card`, `savings`, `cash`, `other`
- `institutionName`
- `mask`
- `isBudgetVisible`
- `isPlaidLinked`

### Category

Fields:

- `id`
- `householdId`
- `name`
- `kind`: `need`, `want`, `income`, `transfer`, `ignored`
- `parentCategoryId`
- `isActive`
- `sortOrder`

### BudgetPeriod

Fields:

- `id`
- `householdId`
- `startDate`
- `endDate`
- `status`: `open`, `closed`
- `incomeTarget`
- `savingsTarget`

### BudgetEnvelope

Fields:

- `id`
- `budgetPeriodId`
- `categoryId`
- `plannedAmount`
- `rolloverPolicy`

### LedgerTransaction

This is the app's budget ledger entry.

Fields:

- `id`
- `householdId`
- `budgetPeriodId`
- `date`
- `amount`
- `direction`: `outflow`, `inflow`
- `merchant`
- `item`
- `categoryId`
- `memberId`
- `accountId`
- `source`: `manual`, `assistant`, `plaid_import`, `sheet_import`, `recurring`
- `status`: `active`, `deleted`
- `createdAt`
- `updatedAt`

### LedgerActionEvent

Replaces the sheet-bound undo/action log.

Fields:

- `id`
- `householdId`
- `actorMemberId`
- `actionType`: `create`, `update`, `move`, `delete`, `undo`, `reconcile`, `settings_patch`, `export`
- `entityType`
- `entityId`
- `beforeJson`
- `afterJson`
- `source`: `direct_ui`, `assistant`, `plaid_reconciliation`, `import`, `system`
- `assistantPlanId`
- `confirmationId`
- `createdAt`
- `revertedByActionEventId`

### PlaidItem

Stored in the Plaid bridge, mirrored minimally in app.

Fields:

- `id`
- `householdId`
- `providerItemId`
- `institutionName`
- `status`
- `lastSyncAt`
- `lastError`

### BankAccount

Plaid account metadata.

Fields:

- `id`
- `plaidItemId`
- `providerAccountId`
- `accountName`
- `mask`
- `type`
- `subtype`
- `isWatched`
- `latestBalanceSnapshotId`

### BankTransaction

A real bank transaction from Plaid. This is not a ledger row until imported or matched.

Fields:

- `id`
- `bankAccountId`
- `providerTransactionId`
- `pendingTransactionId`
- `date`
- `authorizedDate`
- `name`
- `merchantName`
- `amount`
- `pending`
- `paymentChannel`
- `rawCategory`
- `removedAt`
- `firstSeenAt`
- `lastSeenAt`

### ReconciliationItem

Tracks review lifecycle.

Fields:

- `id`
- `householdId`
- `bankTransactionId`
- `classification`: `expense`, `income`, `subscription_or_bill`, `transfer_or_payment`, `refund_or_credit`, `ignore`, `needs_review`
- `status`: `new`, `auto_matched`, `needs_review`, `presented`, `confirmed`, `imported`, `ignored`, `stale`, `conflict`, `reopened`, `failed`
- `confidence`
- `matchedLedgerTransactionId`
- `matchedActionEventId`
- `firstSeenAt`
- `lastPresentedAt`
- `resolvedAt`
- `notes`

### RecurringSchedule

Unified model for subscriptions, bills, and expected income.

Fields:

- `id`
- `householdId`
- `name`
- `kind`: `subscription`, `bill`, `income`
- `expectedAmount`
- `cadence`: `monthly`, `yearly`, `quarterly`, `custom`
- `pullDay`
- `pullMonth`
- `categoryId`
- `accountId`
- `merchantPattern`
- `isActive`

### MerchantRule

Assistant-editable memory that affects classification.

Fields:

- `id`
- `householdId`
- `merchantPattern`
- `defaultCategoryId`
- `defaultItem`
- `defaultMemberId`
- `requiresClarification`
- `notes`
- `createdBy`: `user`, `assistant_proposal`, `import`

### AssistantPlan

Fields:

- `id`
- `conversationId`
- `inputMessageId`
- `intentSummary`
- `confidence`
- `rawModelOutput`
- `validatedPlanJson`
- `status`: `proposed`, `executed`, `partially_executed`, `rejected`, `awaiting_confirmation`, `failed`
- `createdAt`

### AssistantToolCall

Fields:

- `id`
- `assistantPlanId`
- `toolName`
- `inputJson`
- `outputJson`
- `status`
- `startedAt`
- `finishedAt`

### SettingsPatchProposal

Fields:

- `id`
- `householdId`
- `scope`
- `patchJson`
- `rationale`
- `riskLevel`: `low`, `medium`, `high`
- `status`: `pending`, `applied`, `rejected`, `expired`
- `createdAt`
- `resolvedAt`

### GoogleSheetsExport

Fields:

- `id`
- `householdId`
- `spreadsheetId`
- `periodId`
- `exportKind`: `full_snapshot`, `monthly_budget`, `ledger_rows`, `subscriptions`, `audit`
- `status`: `draft`, `running`, `succeeded`, `failed`
- `startedAt`
- `finishedAt`
- `error`

## Reconciliation State Rules

- `BankTransaction.pending == true` can be shown as context but should not become normal reconciliation work.
- `ReconciliationItem.confirmed` means a bank transaction matches an existing ledger row.
- `ReconciliationItem.imported` means a new ledger row was created from the bank transaction after user confirmation.
- Mutating a confirmed ledger row should reopen or revalidate linked reconciliation items.
- Old unresolved items should become `stale` or hidden behind historical review, not normal inbox work.

## Google Sheets Export Shape

Export from the local data model into predictable sheets:

- `Ledger`
- `Income`
- `Categories`
- `Budget Periods`
- `Recurring`
- `Reconciliation`
- `Audit Events`
- `Dashboard Snapshot`

Keep stable IDs in hidden columns so repeated exports can update rows idempotently.
