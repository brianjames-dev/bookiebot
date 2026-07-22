# Integrations

## Plaid

### Recommended Role

Plaid provides bank account linking, account metadata, balances, and transaction sync. It does not replace user confirmation.

Use:

- LinkKit on iOS for account connection.
- `/link/token/create` on the bridge to create Link tokens.
- `/item/public_token/exchange` on the bridge after Link succeeds.
- `/transactions/sync` for incremental transaction updates.
- `SYNC_UPDATES_AVAILABLE` webhooks to mark items dirty.

Avoid in v1:

- Transfer or money movement products.
- Income verification products.
- Investments and liabilities unless later product scope requires them.

### Bridge Responsibilities

The bridge should:

- Store Plaid access tokens encrypted.
- Store per-item sync cursors.
- Handle webhooks.
- Return normalized transactions to the app.
- Support disconnect/delete-data flows.
- Redact tokens and sensitive IDs from logs.

The bridge should not:

- Run LLM calls.
- Mutate the local app ledger directly.
- Become the primary budget datastore.

### iOS Flow

1. App requests a Link token from bridge.
2. App opens Plaid LinkKit.
3. User completes Link.
4. App sends `public_token` to bridge.
5. Bridge exchanges it for an access token.
6. Bridge stores access token and returns linked item/account metadata.
7. App starts initial sync and stores returned transactions locally.
8. Reconciliation engine creates review items.

## Google Sheets

### Recommended Role

Sheets should become export and reporting output.

Use cases:

- Export monthly ledger snapshots.
- Export audit logs for transparency.
- Export dashboard summaries.
- Support user-owned spreadsheet backups.

Avoid v1:

- Treating Sheets as the canonical store.
- Bidirectional sync that edits local app state without preview.
- Preserving the current row/column mutation model as the app's internal model.

### OAuth Direction

For a consumer iOS app, use Google Sign-In / OAuth for user authorization. A service-account setup may still be useful for personal self-hosted deployments, but it is not the right general iOS user experience.

## Local AI

### Default Policy

Use local inference by default. No transaction or budget data should go to frontier model APIs unless a user explicitly opts in later.

The recommended primary assistant path is a downloadable Qwen 4B-class local AI model pack. It should be offered during onboarding with clear copy:

```text
Download Local AI
Recommended for the full BookieBot assistant.
Runs on this iPhone. Your budget and transaction chat stay local.
Large download, offered separately so the base app stays small.
```

The exact model, quantization, and context cap should be chosen by benchmark, not assumption. Start with a Q4 or similarly compact quantization and cap context at a practical mobile limit before attempting long-context modes.

### Downloaded Local Model Pack

Use Apple Background Assets or an equivalent managed download path for the model pack. The app bundle should remain small, while the model pack is downloaded after install and can be removed or updated independently.

The onboarding flow should:

1. Explain why the model is not prebundled.
2. Show approximate download size and storage impact.
3. Recommend stronger devices for full assistant mode.
4. Offer Apple Foundation Models or no-model mode as fallback.
5. Let the user delete/re-download the model from settings.

### Apple Foundation Models

Fallback/lightweight path on supported OS/devices:

- Structured planning through guided generation.
- Tool calling against app-defined tools.
- Sessions for context management.

Important caveat: Apple documentation describes access to on-device and Private Cloud Compute models, and availability varies by device, region, OS, and language. The app needs a strict local-only mode and a fallback when unavailable.

### Custom Local Model Fallback

Keep an internal `AssistantModelProvider` protocol so the app can support:

- Downloaded Qwen 4B-class local model provider.
- Apple Foundation Models provider for fallback/lightweight mode.
- Downloaded or bundled Core ML model provider for future model options.
- Future local model provider that conforms to Foundation Models `LanguageModel` where practical.
- Deterministic no-model fallback for core finance actions.

## Speech And Shortcuts

Voice entry should be an input method, not a separate finance brain.

Use later:

- iOS dictation or Speech framework for message input.
- App Intents for Shortcuts and Siri actions.

Candidate App Intents:

- Log expense.
- Show today's spending.
- Open reconciliation inbox.
- Add merchant rule.
- Export current month.

## Notifications

Use local notifications for:

- Reconciliation review reminders.
- Upcoming bill/subscription pulls.
- Budget threshold warnings.
- Export completion.

Push notifications require a backend and should wait until the Plaid bridge and account model are stable.

## Privacy Boundary Summary

Local only:

- Assistant inference by default.
- Ledger.
- Budgets.
- Settings.
- Merchant rules.
- Audit events.

External by explicit integration:

- Plaid: bank linking and transactions.
- Google: Sheets export.
- Optional app backend: Plaid token bridge and webhook handling.
