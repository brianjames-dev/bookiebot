# Assistant Agent Framework

## Goal

BookieBot should act like a financial assistant, not a JSON command bot. The local model should understand intent, plan a small number of safe tool calls, ask clarifying questions, and explain outcomes.

## Core Pattern

Use a tool-based assistant runtime:

```text
Conversation
  -> Local model planner
  -> Structured Plan
  -> Policy validation
  -> Tool execution
  -> Confirmation or result
  -> Durable audit event
```

The model is never allowed to mutate the database directly.

## Runtime Components

### Conversation Store

Stores assistant threads, messages, tool calls, and summaries. Keep raw financial data local.

### Context Builder

Builds the smallest useful context for the model:

- Current date/time and locale.
- Active budget period.
- Relevant recent transactions.
- Relevant pending reconciliation items.
- User preferences and merchant rules.
- Tool catalog.

Avoid dumping the full ledger into the prompt.

### Planner

The planner returns a structured plan:

```text
Plan
  intent_summary
  confidence
  tool_calls[]
  required_confirmations[]
  clarifying_question?
  user_visible_response_draft
```

Use the configured `AssistantModelProvider`. The target primary provider is a downloadable Qwen 4B-class local model pack; Apple Foundation Models should remain a fallback/lightweight provider and should conform to the same planner protocol.

### Tool Registry

Tools expose typed inputs, typed outputs, permission class, confirmation requirement, and audit event type.

Tool categories:

- Ledger tools.
- Reconciliation tools.
- Query/reporting tools.
- Settings tools.
- Export tools.
- Assistant memory tools.

### Policy Validator

Rejects or pauses unsafe plans before execution.

Examples:

- A bank transaction import requires confirmation.
- A settings patch that changes category mappings requires confirmation.
- A delete requires a visible target transaction.
- A reconciliation amount mismatch must be shown.
- A query that needs unavailable context should ask for clarification.

### Confirmation Manager

Creates app-native confirmation cards:

- "Log this expense?"
- "Import this Plaid transaction?"
- "Change Starbucks default category from Food to Coffee?"
- "Update the amount to match the bank transaction?"

Confirmations should show before and after data, not vague language.

### Tool Executor

Runs deterministic app code. It should be testable without a model.

### Audit Logger

Every mutation writes an event:

- actor
- source
- tool name
- input snapshot
- result snapshot
- related entity IDs
- model plan ID if applicable
- confirmation ID if applicable

## Tool Catalog V1

Ledger:

- `logExpense(amount, date, merchant, item, category, accountId, memberId, source)`
- `logIncome(amount, date, source, label, accountId, memberId)`
- `updateTransaction(transactionId, patch)`
- `moveTransaction(transactionId, categoryId, patch)`
- `deleteTransaction(transactionId)`
- `undoAction(actionEventId)`
- `searchTransactions(query)`

Budget:

- `getBudgetSummary(periodId)`
- `setBudgetLimit(periodId, categoryId, amount)`
- `explainBudgetVariance(periodId)`

Banking:

- `listReconciliationInbox(filters)`
- `previewBankMatch(bankTransactionId)`
- `confirmBankMatch(reconciliationItemId, ledgerTransactionId)`
- `importBankTransaction(reconciliationItemId, ledgerDraft)`
- `ignoreBankTransaction(reconciliationItemId, reason)`
- `reopenReconciliationItem(reconciliationItemId, reason)`

Settings:

- `getSettings(scope)`
- `proposeSettingsPatch(scope, patch, rationale)`
- `applySettingsPatch(proposalId)`
- `createMerchantRule(merchantPattern, defaults)`
- `updateMerchantRule(ruleId, patch)`

Export:

- `previewGoogleSheetsExport(periodId)`
- `runGoogleSheetsExport(exportPlanId)`

## Settings Edited By AI

All settings should be represented as typed data. The assistant may propose patches against that data.

Examples:

```text
User: "Always treat Costco as grocery unless I say clothes."
Assistant plan:
  proposeSettingsPatch(
    scope: merchant_rules,
    patch: add rule for Costco default category Grocery with exception hint "clothes"
  )
```

Rules:

- Low-risk display preferences can be auto-applied if the user enables auto-apply.
- Finance-affecting settings require confirmation.
- Bank connection settings require direct UI flows.
- The assistant must explain durable rules in plain language.

## Clarifying Questions

Ask a clarifying question when:

- Amount is missing.
- Category is ambiguous.
- Merchant maps to multiple learned categories.
- The requested mutation target is unclear.
- A bank transaction could match multiple ledger rows.
- The user asks for something outside available tools.

Good question:

```text
Was the Target charge groceries, shopping, or household needs?
```

Poor question:

```text
Please provide the missing JSON field.
```

## Local Model Strategy

Preferred path:

1. Build the assistant around an `AssistantModelProvider` protocol from the beginning.
2. Make a downloadable Qwen 4B-class instruct model pack the first serious primary-model spike for full chat, tool routing, and richer finance-agent behavior.
3. Deliver that model after install through a managed asset/download flow rather than prebundling it in the base app.
4. During onboarding, explain that the local AI pack is large, runs privately on the device, and is optional but recommended for the best assistant experience.
5. Use Apple's Foundation Models framework as fallback/lightweight mode on supported devices.
6. Keep deterministic fallback flows for critical finance actions when no model is available.

Do not design v1 around cloud model APIs.

Recommended default modes:

```text
Full Local Assistant:
  Downloaded Qwen 4B-class model, context capped for device comfort, all finance tools local.

Lightweight Local Assistant:
  Apple Foundation Models where available, smaller context, good for simple tool routing.

No-Model Mode:
  Deterministic forms, shortcuts, search, and reconciliation flows.
```

The first implementation should benchmark Qwen, Gemma, and Phi-class candidates, but Qwen 4B should be the named starting point because its model card emphasizes agent/tool capability and native 32K context.

## Evaluation Strategy

Port BookieBot's intent cassettes into assistant evaluations:

- natural expense logging
- typo handling
- recent-action update/delete/move
- category ambiguity
- income logging
- budget queries
- reconciliation confirmation

Each eval should assert:

- plan shape
- tool calls
- confirmation requirements
- final state
- user-facing response
