# Target Architecture

## Recommended Shape

The future product should be a local-first iOS app with a small user-owned Plaid bridge.

```text
iOS app
  SwiftUI views
  Assistant runtime
  Domain services
  Local encrypted database
  Google Sheets export client
  Plaid LinkKit client

Plaid bridge
  Link token creation
  Public token exchange
  Access token storage
  Transactions sync
  Webhook dirty flags

External services
  Plaid
  Google OAuth / Sheets API
```

The iOS app is the product. The bridge exists because Plaid secrets and access tokens cannot safely live in an app binary. It should not run model inference and should not become the primary finance brain.

## Source Of Truth

Use a local app database as the source of truth:

- Ledger transactions.
- Bank transaction cache returned by Plaid sync.
- Reconciliation state.
- Budget periods and category envelopes.
- Recurring schedules.
- Merchant rules and assistant settings.
- Audit/action events.
- Google Sheets export bindings.

Google Sheets export should be reproducible from local data. If a future bidirectional Sheets sync is added, use import previews and conflict records rather than mutating app state invisibly.

## Storage Recommendation

Start by evaluating two options:

1. SwiftData for developer speed and native integration.
2. GRDB plus SQLCipher for mature SQLite control, explicit migrations, and stronger encryption options.

For personal finance data, the conservative recommendation is GRDB plus SQLCipher unless SwiftData encryption and migration needs are clearly satisfied by the target OS and security model.

Use Keychain for:

- Local database encryption key material.
- Google OAuth refresh tokens if stored on device.
- Session credentials for the Plaid bridge.

Use iOS file protection for local database files.

## Assistant Runtime Boundary

The assistant is not a controller that directly changes state. It is a planner and conversational layer over deterministic domain tools.

```text
User utterance
  -> Conversation context builder
  -> Local model session
  -> Structured plan
  -> Plan validator
  -> Tool execution
  -> Confirmation manager
  -> Audit log
  -> Response renderer
```

All finance mutations must go through tool implementations in app code.

### Assistant Model Delivery

Use a provider-based model layer:

```text
AssistantModelProvider
  QwenLocalPackProvider       primary target for full assistant chat
  AppleFoundationProvider     fallback/lightweight mode
  DeterministicProvider       no-model critical finance fallback
```

The app should recommend a downloadable Qwen 4B-class instruct model pack during onboarding rather than bundling it in the base app. This keeps the initial install small, avoids squeezing a multi-GB model into the app bundle, and lets the user explicitly choose the stronger private on-device assistant.

Apple Foundation Models should remain useful for supported devices when the local model pack is not installed, when the user wants lightweight mode, or when the device cannot run the downloaded model comfortably.

## Backend Boundary

The Plaid bridge should handle:

- `/plaid/link-token`
- `/plaid/exchange-public-token`
- `/plaid/sync`
- `/plaid/webhook`
- `/plaid/disconnect`

The bridge should avoid storing full user ledgers. For v1, it can store encrypted Plaid item tokens, sync cursors, account metadata, webhook events, and minimal transaction cache if needed for reliability. The iOS app should still be the canonical ledger.

## Why Not Pure On-Device Plaid

Plaid Link can run in iOS, but Link requires a short-lived `link_token` created by a server. After Link succeeds, the `public_token` must be sent to a server to exchange it for an access token. That access token is a secret and should not be stored in the app bundle or exposed to client-side code.

## Module Layout For The New Repo

Recommended starting layout:

```text
bookiebot-app/
  ios/
    BookieApp/
    BookieAppTests/
    BookieAppUITests/
  server/
    plaid-bridge/
  shared/
    contracts/
  docs/
    adrs/
    product/
    architecture/
  scripts/
```

## App Module Boundaries

Suggested iOS modules:

- `AppShell`: navigation, app lifecycle, dependency injection.
- `FinanceDomain`: ledger, budgets, categories, recurring schedules.
- `BankingDomain`: Plaid item/account/transaction/reconciliation models.
- `AssistantRuntime`: model session, planning, tools, confirmations.
- `Persistence`: migrations, repositories, encryption setup.
- `Integrations`: Plaid bridge client and Google Sheets export client.
- `DesignSystem`: shared components and chart styling.

## Design Direction

This is an operational finance app, not a marketing site. The UI should be quiet, fast, and dense enough for repeated use.

Primary navigation:

- Today
- Assistant
- Inbox
- Ledger
- Budget
- Settings

The assistant should be globally accessible, but dashboard and inbox views should expose direct controls for common work. Do not force every action through chat.
