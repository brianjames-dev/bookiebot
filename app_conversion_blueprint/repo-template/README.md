# BookieBot App

Native iOS-first personal finance assistant inspired by BookieBot.

## Planned Architecture

- `ios/`: SwiftUI app, local database, assistant runtime, charts, settings, reconciliation inbox.
- `server/plaid-bridge/`: minimal backend for Plaid Link tokens, token exchange, transaction sync, webhooks, and disconnect.
- `shared/contracts/`: JSON schemas and API contracts shared by iOS and bridge.
- `docs/`: product, architecture, ADRs, and implementation notes.

## First Milestone

Build a local-only finance ledger before Plaid or Sheets:

1. Household/member/account/category setup.
2. Manual expense and income logging.
3. Local dashboard.
4. Action event log and undo.
5. Assistant tool runtime with deterministic tools.
6. Downloadable Qwen 4B-class local AI model pack spike, with Apple Foundation Models as fallback/lightweight mode.

## Privacy Policy For Engineering

- Local model inference by default.
- No cloud LLM API calls in the default app.
- The full assistant should use an optional downloaded local AI pack, not a prebundled multi-GB model.
- Apple Foundation Models are fallback/lightweight mode.
- Plaid data crosses the Plaid boundary only when the user links accounts.
- Google Sheets export runs only after explicit user authorization.
- All finance mutations are audited.

## Suggested Commands Once Projects Exist

```bash
# iOS
xcodebuild test -scheme BookieApp -destination 'platform=iOS Simulator,name=iPhone 16'

# Plaid bridge
cd server/plaid-bridge
python -m pytest
python -m pyright
```
