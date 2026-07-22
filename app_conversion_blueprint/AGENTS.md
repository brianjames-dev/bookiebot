# Agent Instructions For The App Conversion Blueprint

This folder is a planning and handoff artifact. Do not edit the current Discord bot runtime when working from this folder unless the user explicitly asks for cross-repo changes.

## Required Reading

Before implementing a new app from this blueprint, read:

- `README.md`
- `docs/00-product-vision.md`
- `docs/01-target-architecture.md`
- `docs/02-agent-framework.md`
- `docs/03-data-model.md`
- `docs/04-integrations.md`
- `docs/05-porting-map.md`
- `docs/06-roadmap-and-backlog.md`
- `docs/07-risks-open-questions.md`
- `docs/08-research-sources.md`

If you are working inside the original BookieBot repository, also read the root `Agents.md`, `README.md`, `src/ROADMAP.md`, `.agent/STATUS.md`, `.agent/WORKSTREAM_FINANCE_OPS.md`, and `.agent/DECISIONS.md`.

## Operating Rules

- Treat the future iOS app as local-database-first.
- Treat Google Sheets as export/sync, not the canonical store.
- Keep Plaid imported transactions review-first.
- Never store Plaid secrets in the iOS app bundle.
- Never let the model mutate the database directly.
- Build assistant behavior through typed tools, validated plans, explicit confirmations, and audit events.
- Prefer small vertical slices that can be tested end to end.

## Privacy Rules

- The default assistant mode must be local-only.
- No budget, transaction, bank, or settings data should be sent to remote LLM providers by default.
- Recommend a downloadable Qwen 4B-class local AI model pack during onboarding for the primary assistant experience. Apple Foundation Models are fallback/lightweight mode.
- If a future user intentionally enables a cloud model, make it an explicit opt-in with clear data disclosure and a local-only fallback.
- Plaid is an unavoidable external data processor for linked bank data. Keep that boundary explicit in product copy and architecture.

## First Implementation Target

Build the smallest useful app:

1. Local ledger and settings database.
2. Manual conversational expense logging through deterministic tools.
3. Transaction list, monthly overview, and category totals.
4. Audit/action log with undo support.
5. Assistant plan validation and confirmation UI.
6. Downloadable local AI model onboarding copy and provider selection.

Plaid and Google Sheets should follow after the local ledger and assistant runtime are stable.
