# Gas Location

Gas uses an optional merchant/location, matching Grocery and the other purchase
categories. Discord, card selection, shortcuts and confirmed bank imports retain
it; Transactions can show/search/edit it, and the existing merchant resolver uses
it for logos in the list, calendar and report previews. Blank locations retain
the category-colored fuel fallback. No new logo matching algorithm is needed.

## Physical column change

Insert **J**, between Gas Amount and Person. Never overwrite the occupied Gas
summary columns. Google Sheets shifts native formulas, merges, formatting,
validation, conditional rules and named ranges; quoted external imports and JSON
coordinates require explicit translation.

| Block | Previous fields | New fields | Summary amount column |
| --- | --- | --- | --- |
| Grocery | A:D | A:D | F, unchanged |
| Gas | H:J | H:K (H Date, I Amount, J Location, K Person) | L → M |
| Food | N:R | O:S | T → U |
| Shopping | V:Z | W:AA | AB → AC |
| Needs | AD:AH | AE:AI | AJ → AK |
| Grand totals | AL:AM | AM:AN | Native formulas shift |

Every column from old J onward moves one position. January predates Needs and
has its totals at AD:AE → AE:AF; do not interpret these as purchase rows. Gas
Location is text, with no currency format or Person dropdown. Person keeps its
original strict choices. Only the new column is resized.

## Compatibility and history

The fresh Gas header selects the legacy/new layout. Identifiable headers with
unknown category positions fail before writing. Saved actions carry an explicit
`expense_layout=gas_location_v1` tag, so their fields never depend on today's
year or a later worksheet read. Old untagged history retains its legacy mapping.
Move, compaction snapshots, Delete/Undo, manual rows, analytical queries, bank
reservations and reimbursement receipts use the corresponding layout.

The migration translates live action coordinates, including source/destination
snapshots; current canonical reimbursement source maps and embedded correction
baselines; and bank/import physical reservations. It preserves action IDs,
request fingerprints, statuses, financial versions, amounts, shares, repayments,
reset balances, immutable database audit rows and completed confirmation receipts.
Restarting the app clears ephemeral selections and previews before writers resume.

Both personal budgets' quoted IMPORTRANGE cells must be updated explicitly, in
all affected months and their internal Template. Annual preparation reads the
source header for imports, template validation and all five date stamps. Update
the separate Shared Expenses annual master as well. The personal annual masters
still reference an older, untouched shared workbook; do not shift those literal
references. Annual initialization regenerates imports for the new year's source.

## Exact historical recovery

Use a persisted bank-to-action link only when its owner/account, exact amount,
and posted or authorized purchase date agree independently with the active saved
Gas action and its current unique sheet row. Require a nonempty saved merchant.
Reject pending/removed bank rows, other owners, deleted/changed/duplicate sources
and conflicting eligible merchants. No amount-only joins, fuzzy merchants, date
windows or new financial transactions. Unknown locations stay blank.

The 2026-11-03 preflight found 11 eligible existing rows (June 5, July 2,
October 4), 735 coordinate-bearing action records, 56 quoted personal imports,
19 current reimbursement payloads and 86 bank/import references. Retained
conversation checkpoints contained no additional exact Gas logging evidence;
the one canonical Gas allocation with a saved location was deleted and must not
be recreated. The fresh stopped-writer cutover retained these exact counts and
completed successfully; verification is recorded in STATUS and the task record.

## Controlled cutover

1. Verify and release compatible code first. Back up the live Apps Script and
   compare it with Git; publish the compatible script without running setup or
   a financial recovery helper. Keep existing triggers and Pacific clocks.
2. Stop the app's stateless deployment with `railway down --yes` in an exactly
   verified linked maintenance folder. Confirm all app deployments are REMOVED
   and the former health route is unavailable before writing. Scaling zero was
   insufficient on this service: the connector rejects 0 and CLI scale 0 retained
   a live replica. Record the original one-replica configuration and resumable
   verified build ID; do not stop Postgres. Schedule outside the Pacific 8–9 PM
   preparation / 1–2 AM closing windows and confirm no Apps Script execution is
   active. Capture fresh Sheets values/formulas/native
   metadata, action logs, DB projection/reservation tables and bank evidence into
   a private directory (0700; files 0600). Do not commit financial backups.
3. Run `scripts/migrate_gas_location.py --capture /private/tmp/<capture>` for a
   reviewable JSON plan. Inspect recovery evidence and counts. The plan cannot
   silently change any pre-existing purchase field or monetary value.
4. Run the same plan with `--apply --writers-stopped --env-file <local env>` under
   the authorized production DB environment. The script checks pending commands,
   projection versions and every workbook before its first mutation. It writes
   each workbook atomically, verifies all original purchase fields and category
   SUMIF outputs, reads back history/imports, then commits coordinate-only DB
   updates under the existing projection advisory lock. A lost response resumes
   the same plan; never rebuild a mixed-state plan blindly.
5. Migrate the separate annual shared master through the owner-connected Sheets
   API (the bot service account does not have access). Back up/read back native
   headers, dimensions, formulas and validators. Personal annual masters retain
   their references to the unmigrated old workbook.
6. Run the read-only Apps Script `auditGasLocationSetup` and compare DB money,
   lifecycle, command and repayment records to the backup. Verify new Location
   has no validator while Person retains its validator. Redeploy the recorded
   verified build, wait for SUCCESS and the original one-replica config with
   stopped=false, then verify health 200, private 401 and the exact deployed SHA.
   Read real transaction data. Never create a test purchase on production.

Fetch the complete named-range inventory separately from bounded grid reads;
Sheets can filter the names returned with ranges. The cutover preserved all 233
named ranges and their IDs, and verified all 132 native category formula
references and all 56 personal import outputs against the backups.

If any step fails, leave writers stopped and inspect the private plan/backups.
Do not force a retry through an unknown schema. Reversing a structural change
requires coordinated reversal of Sheets, imports and saved coordinates; never
delete J by itself after writers resume.

## Verified cutover

[Implementation PR #130](https://github.com/brianjames-dev/bookiebot/pull/130)
merged as `766eade`. Both required CI runs passed 3,457 tests with zero skips;
locally 2,892 passed with 565 PostgreSQL-only skips. Types/build/assets pass.
The live Apps Script audit completed without writes; all original financial
values/lifecycle, 132 formula references, 56 import outputs, 9 validation pairs and
233 named anchors passed independent readback. The exact verified build resumed
successfully in the original one-replica configuration; health 200/private 401.
The actual Transactions listing returned 39 Gas rows across both owners, and all
11 recovered locations were visible and editable. The existing artwork resolver
recognizes 9 of those purchases; 2 unregistered station brands use the correct
Gas fallback. No new logo artwork or synthetic financial transaction was added.

## Manual acceptance

- Open a recovered October Gas purchase: merchant/logo and search should work;
  an unrecovered Gas row still uses the fuel fallback and has a blank Merchant.
- On the next real Gas purchase, provide a merchant via Discord/shortcut/card
  selection and verify H/I/J/K, the inline Merchant field and the existing logo.
- Review a real Merchant correction; confirm only if intended. Check Update,
  category Move, Split, Delete and Undo preserve the merchant and correct person.
- Verify Food, Shopping and Needs totals against both budgets, older January,
  shared repayment details and upcoming receipts. No synthetic financial writes.
- Before the next rollover, verify both internal templates and the annual shared
  master have Location; the read-only audit verifies current imports and headers.
