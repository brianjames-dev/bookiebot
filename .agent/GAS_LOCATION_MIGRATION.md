# Gas Location — cutover record (2026-11-03)

## Published state

[Implementation PR #130](https://github.com/brianjames-dev/bookiebot/pull/130)
merged as `766eadecf28e0e62fca1abb0b75417069c7cecd0`. Both required CI runs
(41775432131 / 41775438165) passed **3,457 tests with zero skips**, Python types,
Apps Script checks, frontend types/build and exact asset comparison. The final
local run passed **2,892 tests with 565 optional PostgreSQL skips**. Frontend
assets did not change.

The live migration is complete: all 9 shared tabs (8 existing months and
Template), the separate annual shared master, 735 action records, 56 quoted
personal imports, 19 current canonical payloads and 86 bank/import column
reservations. Restored 11 of 44 existing Gas locations: 5 in June, 2 in July and
4 in October. The remaining 33 stay blank. Deleted, ambiguous and conflicting
evidence was excluded; no financial transaction was created or guessed.

Independent readback preserved all original purchase fields, category totals,
DB monetary values, lifecycle state, repayments, resets, commands and immutable
audit events. It verified 132 exact native SUMIF references, 56 unchanged
personal import outputs, 9 free-text Location / preserved Person validator
pairs and all 233 named ranges with their original IDs and shifted bounds.

The live read-only `auditGasLocationSetup` completed at 9:16 PM Pacific and
verified shared tabs, the annual master and both current budgets. Existing
clocks/triggers were retained; the evening preparation had finished at 8:41 PM.

## Maintenance and product verification

Writers were stopped with `railway down --yes` from an exactly verified linked
maintenance folder. All app deployments were REMOVED and `/health` returned 404
before mutation; Postgres remained running. Scaling to zero did not stop the
real replica on this service. Do not use a scale response as proof of shutdown.

The verified build resumed as deployment
`effa857f-5b8d-4024-a46b-6b0628f61a49`, status SUCCESS, `stopped=false`, with the
original one-replica `us-west2` configuration. `/health` returned 200 and the
unauthenticated `/app/transactions` route returned 401.

Actual Transactions listing readback covered both actors and 39 Gas rows in
their available personal-budget months. All 11 recovered locations were
visible and editable. Nine purchases resolve existing merchant artwork; two
unregistered brands retain the category-colored Gas fallback. The audit used a
read-only repeatable-read DB snapshot and 8 read-only Google requests. No
synthetic purchase or correction was submitted.

## Column mapping and compatibility

Gas is H Date / I Amount / J Location / K Person. Food moves to O:S, Shopping to
W:AA and Needs to AE:AI. Summary amounts move L→M, T→U, AB→AC and AJ→AK; F stays
unchanged. Grand totals move AL:AM→AM:AN. January predates Needs, grows from 32
to 33 columns and moves totals AD:AE→AE:AF. Native insertion preserves formulas,
formats, merges, validators, conditional rules and named anchors.

Header resolution supports untouched old-year layouts; migrated saved actions
carry `gas_location_v1`. Personal annual masters still reference the untouched
old shared workbook. Their old-source literals must stay unchanged; annual
preparation regenerates imports from the actual new-year shared header. See
`docs/GAS_LOCATION.md` for the full flow and controlled migration procedure.

## Evidence and next steps

- Initial snapshots and exact Apps Script source backups:
  `/private/tmp/bookiebot-gas-location-2026-11-03`.
- Fresh stopped-writer capture, applied plan, DB comparison, financial audit and
  native screenshot: `/private/tmp/bookiebot-gas-location-cutover-2026-11-03`.
  Directories are private (0700), files 0600. Do not commit financial backups
  or reuse the applied plan after writers resume.
- Live script source was read back byte-for-byte: 76,847 bytes, SHA256
  `7364ead7667dc636ea606e06337cacf18495d4206ef48ceb36f6f3cb8a216244`.
- Fetch named ranges separately from bounded grid reads: Sheets filters names
  when ranges are supplied. The independent full inventory retained all 233.
- Native user acceptance remains in STATUS checklist 251: inspect existing
  recovered/blank purchases, review/cancel Merchant, then verify the next
  intended real purchase or correction. No financial test writes are needed.
- Actual working tree: `work/quiet-header-release`; the outer checkout is stale.
  Preserve its pre-existing untracked `work/` directory.
