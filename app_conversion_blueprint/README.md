# BookieBot App Conversion Blueprint

This folder is a standalone handoff package for turning BookieBot into a native iOS application. It is intentionally separate from the current Discord bot implementation so it can be copied into a new repository and used as the starting context for another agent.

The plan keeps the essence of BookieBot:

- AI-first interaction, but through an assistant runtime with tools, memory, confirmations, and audit trails instead of raw JSON intent routing.
- Active user participation: users can still log expenses conversationally, and Plaid transactions are reconciled through review/confirmation rather than silently imported.
- Privacy-first local inference: no transaction, budget, or banking data should be sent to frontier LLM providers by default.
- Local database as the app source of truth, with Google Sheets becoming an export and reporting target instead of the primary datastore.

## Start Here

Read these in order:

1. [Product Vision](docs/00-product-vision.md)
2. [Target Architecture](docs/01-target-architecture.md)
3. [Assistant Agent Framework](docs/02-agent-framework.md)
4. [Data Model](docs/03-data-model.md)
5. [Integrations](docs/04-integrations.md)
6. [Porting Map](docs/05-porting-map.md)
7. [Roadmap And Backlog](docs/06-roadmap-and-backlog.md)
8. [Risks And Open Questions](docs/07-risks-open-questions.md)
9. [Research Sources](docs/08-research-sources.md)

## Copy-Ready Repo Template

The [repo-template](repo-template/) directory is a suggested new-project layout. Copy its contents into a new repo after this blueprint is copied.

Recommended first commands in the new repo:

```bash
cp -R app_conversion_blueprint/repo-template/* .
git init
mkdir -p ios server/plaid-bridge shared/contracts docs/adrs
```

Then create the Xcode project under `ios/` and a small Plaid bridge under `server/plaid-bridge/`.

## Key Architecture Decisions For The New App

- Build native iOS first with SwiftUI.
- Use a local encrypted database as the primary ledger. Start with SwiftData only if its migration and encryption posture are good enough for finance data; otherwise use SQLite through GRDB plus SQLCipher.
- Keep all assistant actions behind deterministic tools. The model may propose plans and settings changes, but app code validates and executes them.
- Make the primary assistant model a downloadable local AI pack, with Qwen 4B-class instruct models as the first serious spike. Explain during onboarding that it is downloaded after install to keep the base app small and to let the user choose a private on-device model.
- Use Apple Foundation Models as the lightweight/fallback provider for supported devices, not as the main assistant brain for the full finance-chat experience.
- Use Plaid LinkKit in iOS, but fetch `link_token`s and exchange `public_token`s through a minimal backend because Plaid client secrets cannot ship in the app.
- Export to Google Sheets from the app or a user-owned bridge. Do not make Sheets the canonical store.
- Preserve BookieBot's reconciliation safety rules: no bank transaction writes to the ledger without explicit user approval, and amount mismatches must be visible.

## Non-Goals For The First App Version

- No multi-household SaaS platform.
- No movement of money.
- No cloud LLM fallback that sends personal finance data to third-party model APIs.
- No automatic Plaid import directly into the budget ledger.
- No attempt to keep the Discord bot and iOS app running against the same mutable sheet model.

## Handoff Standard

A future agent should be able to use this folder to:

- Understand the current BookieBot behavior worth preserving.
- Create a new iOS-first repository without touching the existing bot.
- Implement a minimal local-first finance ledger.
- Add a tool-based assistant runtime.
- Integrate Plaid safely.
- Add Google Sheets export after the database model is stable.
