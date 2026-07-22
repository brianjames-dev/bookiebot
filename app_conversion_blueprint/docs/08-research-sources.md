# Research Sources

Checked on 2026-07-09. Use these as starting points and re-check before implementation because iOS, Plaid, and model APIs change.

## Apple

- Apple Intelligence overview: https://developer.apple.com/apple-intelligence/
  - Notes: Apple describes Foundation Models as a native Swift API for Apple Foundation Models on device and in Private Cloud Compute, plus providers conforming to the Language Model protocol. It also positions App Intents as the system integration path for natural-language actions.
- Foundation Models documentation: https://developer.apple.com/documentation/foundationmodels
  - Notes: Relevant for guided generation, sessions, and tool calling.
- Foundation Models context window technote: https://developer.apple.com/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window
  - Notes: Apple documents a 4096-token context window for the on-device model, which is why it should be fallback/lightweight mode rather than the primary full assistant.
- Foundation Models guided generation: https://developer.apple.com/documentation/foundationmodels/generating-content-and-performing-tasks-with-foundation-models
  - Notes: Relevant for structured planner output instead of raw JSON parsing.
- Foundation Models tool calling: https://developer.apple.com/documentation/foundationmodels/expanding-generation-with-tool-calling
  - Notes: Relevant for assistant tools that call app code.
- Core ML documentation: https://developer.apple.com/documentation/coreml/
  - Notes: Relevant for bundled local model fallback on Apple devices.
- SwiftData documentation: https://developer.apple.com/documentation/swiftdata
  - Notes: Relevant for local persistence if the project accepts SwiftData's migration and security tradeoffs.
- Maximum build file sizes: https://developer.apple.com/help/app-store-connect/reference/app-uploads/maximum-build-file-sizes/
  - Notes: iOS app bundles have size limits, and Apple points larger assets toward Background Assets.
- Background Assets: https://developer.apple.com/documentation/backgroundassets
  - Notes: Relevant for downloading a large local model pack after install.
- Apple-hosted asset packs: https://developer.apple.com/help/app-store-connect/manage-asset-packs/overview-of-apple-hosted-asset-packs/
  - Notes: Relevant if the model pack is hosted through App Store Connect rather than self-hosted.

## Local Model Candidates

- Qwen3-4B model card: https://huggingface.co/Qwen/Qwen3-4B
  - Notes: Primary candidate for the first local AI pack spike. The model card lists 4.0B parameters, native 32K context, longer-context options through YaRN, and agent/tool-oriented capabilities.
- Google Gemma 3n overview: https://ai.google.dev/gemma/docs/gemma-3n
  - Notes: Strong alternate candidate because it is explicitly positioned for phones, laptops, tablets, and low-resource devices.
- Microsoft Phi-4-mini-instruct model card: https://huggingface.co/microsoft/Phi-4-mini-instruct
  - Notes: Alternate candidate for a compact reasoning-focused local model.

## Plaid

- Plaid Link iOS SDK: https://plaid.com/docs/link/ios/
  - Notes: LinkKit handles account linking on iOS. The app must request a `link_token` from a server. On success, the app sends the `public_token` to the app server.
- Plaid Link overview: https://plaid.com/docs/link/
  - Notes: Link is mandatory for normal user account connection flows.
- Plaid Transactions API: https://plaid.com/docs/api/products/transactions/
  - Notes: `/transactions/sync` returns incremental transaction updates and uses cursors.
- Plaid Transactions webhooks: https://plaid.com/docs/transactions/webhooks/
  - Notes: `SYNC_UPDATES_AVAILABLE` is the webhook to use with `/transactions/sync`.
- Plaid Transactions add-to-app guide: https://plaid.com/docs/transactions/add-to-app/
  - Notes: Useful for the initial sync model and transaction lifecycle.

## Google

- Google OAuth for iOS and desktop apps: https://developers.google.com/identity/protocols/oauth2/native-app
  - Notes: Installed apps cannot keep client secrets and should use system-browser based OAuth flows.
- Google Sign-In for iOS and macOS: https://developers.google.com/identity/sign-in/ios/start-integrating
  - Notes: Current SDK setup and OAuth client configuration for iOS.
- Google Sheets API overview: https://developers.google.com/workspace/sheets/api/guides/concepts
  - Notes: Sheets API can create spreadsheets, read/write values, update formatting, and manage sheets.

## Current BookieBot Local Sources

- Product context: `README.md`
- Roadmap: `src/ROADMAP.md`
- Portable app ideas: `src/PORTABLE_APP_ROADMAP.md`
- Bank integration roadmap: `src/READ_ONLY_BANK_INTEGRATION_ROADMAP.md`
- Finance workstream: `.agent/WORKSTREAM_FINANCE_OPS.md`
- Current architecture decisions: `.agent/DECISIONS.md`
