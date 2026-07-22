# Agent Protocol

This repository is the iOS app rewrite of BookieBot. The current product direction is local-first personal finance with an AI assistant, Plaid reconciliation, and Google Sheets export.

## Required Reading

Before non-trivial work, read:

- `README.md`
- `docs/product.md`
- `docs/architecture.md`
- `docs/agent-framework.md`
- `docs/data-model.md`
- `docs/backlog.md`
- latest ADRs in `docs/adrs/`

## Engineering Rules

- Keep the app local-database-first.
- Keep assistant behavior tool-based and policy-validated.
- Treat a downloadable Qwen 4B-class local AI model pack as the target primary assistant provider, with Apple Foundation Models as fallback/lightweight mode.
- Never let model output directly mutate the database.
- Preserve review-first Plaid imports.
- Add tests for every finance mutation and reconciliation state transition.
- Keep backend scope narrow: Plaid tokens, cursors, sync, webhooks, and disconnect.
- Document durable architecture choices as ADRs.

## Verification Defaults

Use the smallest useful test first, then broader tests.

```bash
xcodebuild test -scheme BookieApp -destination 'platform=iOS Simulator,name=iPhone 16'
cd server/plaid-bridge && python -m pytest
```

## Finance Safety Rules

- Do not import bank transactions into the ledger without explicit confirmation.
- Do not hide amount mismatches.
- Do not surface stale historical bank transactions in normal review.
- Reopen or revalidate reconciliation links after linked ledger mutations.
- Write audit events for creates, updates, moves, deletes, imports, confirmations, ignores, settings patches, and exports.
