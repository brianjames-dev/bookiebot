# Risks And Open Questions

## Highest Risks

### 1. Local Model Delivery And Availability

The desired primary assistant experience needs a stronger local model than Apple's lightweight on-device model. A Qwen 4B-class model pack is likely a multi-GB download and may not perform comfortably on every iPhone.

Mitigation:

- Define `AssistantModelProvider`.
- Deliver the stronger model as an optional downloaded local AI pack, not as part of the initial app bundle.
- Explain size, storage, privacy, and performance tradeoffs during onboarding.
- Benchmark Qwen, Gemma, and Phi-class candidates on real devices before locking the default.
- Keep Apple Foundation Models as fallback/lightweight mode where available.
- Build deterministic tools and UI flows for no-model mode.
- Support strict local-only mode.
- Keep cloud LLM support out of the default plan.

### 2. Plaid Requires A Backend

The iOS app cannot safely hold Plaid secrets. A bridge is required, which weakens a pure local-only story.

Mitigation:

- Make the bridge small and auditable.
- Store only Plaid tokens, cursors, minimal item/account metadata, and optional transaction cache.
- Let users self-host for maximum privacy.
- Keep model inference out of the bridge.

### 3. Local Database Choice

SwiftData is productive, but finance apps need explicit migrations, encryption, and debuggable persistence.

Mitigation:

- Spike SwiftData and GRDB plus SQLCipher before committing.
- Write migration tests early.
- Keep repositories protocol-driven.

### 4. Assistant Overreach

If the model can update settings and transactions too freely, users will lose trust.

Mitigation:

- Model proposes; tools execute.
- Finance-affecting mutations require visible confirmation.
- All changes write audit events.
- User can inspect and revert recent changes.

### 5. Reconciliation Complexity

BookieBot already has hard-earned safety rules around amount mismatches, stale transactions, and action lineage. Rewriting this incorrectly would cause silent data errors.

Mitigation:

- Port reconciliation tests before porting behavior.
- Treat bank transactions and ledger entries as separate until resolved.
- Reopen reconciliation items after linked ledger mutations.

## Open Product Questions

- Is the app single-user first or household-shared from day one?
- Should household sync use iCloud, the Plaid bridge, or wait until after v1?
- What is the minimum dashboard that replaces the current expense report?
- Should the assistant be the default first tab, or should Today be first with a persistent assistant entry point?
- How much onboarding should happen before the user can log the first expense?
- Which categories should ship as defaults?
- Should the local AI pack be recommended during first-run onboarding or after the user logs a few transactions?

## Open Technical Questions

- SwiftData or GRDB plus SQLCipher?
- Should the Plaid bridge be Python/FastAPI to reuse current BookieBot code, or Swift/Vapor for a single-language stack?
- Should Google Sheets export run from iOS directly or through the bridge?
- Which Qwen/Gemma/Phi-class model, quantization, context cap, and runtime should be the default local AI pack?
- How should local model prompts, model pack versions, and eval results be versioned?
- What is the exact state machine for reconciliation items?
- How should recurring schedule matching handle amount drift?

## Decisions To Make Before Coding The New App

1. Database technology.
2. Minimum supported iOS version.
3. Local model provider strategy, including Qwen local AI pack delivery and Apple Foundation fallback.
4. Plaid bridge language and hosting model.
5. Single-user versus household v1.
6. Export-only versus import/export Google Sheets v1.

## Suggested Early Spikes

### Persistence Spike

Implement the same tiny ledger in SwiftData and GRDB plus SQLCipher:

- 100 ledger rows.
- 20 bank transactions.
- 5 reconciliation items.
- migration adding a field.
- database reset/export.

Pick the option with clearer migrations and security.

### Assistant Spike

Implement three tools:

- `logExpense`
- `searchTransactions`
- `proposeSettingsPatch`

Test:

- clear log request
- ambiguous Target request
- settings edit
- Qwen 4B-class local model pack install/remove lifecycle
- Apple Foundation Models fallback when the model pack is missing

### Plaid Spike

Implement:

- Link token endpoint.
- iOS LinkKit open.
- public token exchange.
- Sandbox sync.
- display transactions locally.

Do not add reconciliation until the sync path is stable.
