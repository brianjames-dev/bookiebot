# Finance Operations Workstream

Last updated: 2026-10-25

## Goal

### Rejected-match recovery and compacted expense references — 2026-10-25

Released via [PR #89](https://github.com/brianjames-dev/bookiebot/pull/89) as `02b0959` (exact source `5738396`). CI #251 and main CI #253 passed **3,129 / zero skips** and all gates. Railway `693c3754-19e1-4485-b0b7-03965be05adb` is active for the exact merge; bot/command/web startup, health, authorization and frontend **804f6d6309517a29b03b065e** exact assets verified. Live Check is enabled and the real shirt remains Needs review; no production confirmation/import/receipt. Production read-only audit traced the $50 shirt rejection to a confirmed $4 ear-plug reference still at Shopping row 20 after history compacted it to row 19. During explicit confirmation only, fresh owner history can relocate a single unchanged matched expense within the same qualified category/month under the existing owner lock. Preserve decisions, amounts, timestamps, additional occurrence aliases and duplicate protection; log the old/new reference. Missing/ambiguous history, changed amounts/scope, groups and pending writes fail closed. Phone and Discord use the same store path. No financial data or production match was changed during diagnosis.

Rejected metadata commands close stale review and automatically read saved state once. True unknown financial responses retain the work guard; header Check status always permits a read-only status request. No automatic command retries. Regression, full verification and sample-browser recovery passed: full **2,647/482 optional skipped**, focused **474/82**, clean types/build and repeated isolated asset parity. Native checklist 158 remains; existing expense/reimbursement balances stay intact.

### Reimbursement percentage and total editor — 2026-10-25

Released through [PR #88](https://github.com/brianjames-dev/bookiebot/pull/88) as `f60df57` (exact combined source `bcaff0b`). Combined CI #247 and main CI #249 passed **3,119 tests / zero skips** and all PostgreSQL/type/build/assets gates. Railway `20058428-31af-4e90-877a-1113457ca671` is successful/active for the exact merge; bot/command/web startup, health, authorization and exact frontend **3e99f84c40b7df1fd441cdf1** assets verified. Live preview/cancel passed $123.45 at 33.33% ($41.15 / $82.30), then restored the saved split. Regression fixes preserve custom percentages in Transactions amount review/confirmation and read personal-bill ancestors from shared monthly history. Local full **2,639 passed / 480 optional PostgreSQL skipped**, focused **438 passed / 277 skipped**, clean Python/frontend types and repeated isolated build parity. Native checklist 157 remains; Transactions keeps 156. No production financial writes.

CI follow-up: the initial push passed **3,054 tests / zero skips**, PostgreSQL, Apps Script, Python/frontend types and build, then failed committed JS parity. The local module graph had pulled transitive packages from another checkout. Regenerated only the JS asset from an isolated archived source/locked install using Node 22.23.3; repeated builds match exactly. Existing asset-parity verification is the regression check. Repair `97a6fcf` passed [CI #241](https://github.com/brianjames-dev/bookiebot/actions/runs/40247447281): **3,054 tests / zero skips** and all PostgreSQL, Apps Script, Python/frontend type, build and committed-asset gates. Eight actual committed-bundle Chromium/WebKit phone cases also passed with mocked APIs only. Source, workflow, database and financial behavior are unchanged; release/native acceptance remains checklist 157. No deployment or production financial writes.

Complete (user-requested slice): eligible payers can edit each Shared expense with a 0–100% slider at 0.01% precision and a separate full-total input. Both shares preview immediately; Save atomically stores gross, custom percentage and exact cent shares through the existing command/revision tables. Cancel changes nothing. Preserve payer-only, active/cash-v1, version, pending/confirmed repayment, reset and completed-projection guards. Custom percentages survive later Discord and reconciliation bill amount corrections; choosing a preset removes obsolete custom metadata. A 100% payer share shows No reimbursement due instead of suggesting a payment was received.

Changed gross totals reopen linked bank matches and pre-split ancestors after verified source/mirror updates, before marking the revision synced; failures recover through Shared refresh. Percentage-only changes retain matching. UI drafts survive refresh but stale reviews cannot save; uncertain requests retain the same request ID. The rebuilt app explicitly deduplicates React after browser QA exposed a duplicate runtime in this checkout. Verification is in STATUS; isolated browser fixtures never contact financial services. Release/native acceptance is checklist 157; no production financial writes. General canonical correction Undo and historical net-accounting edits remain outside this slice.
### Transactions workspace and Overview consolidation — 2026-10-25

Implemented; final verification/release in progress on isolated `codex/app-transactions` checkout so concurrent custom-repayment work remains separate. Overview contains all former Spending content; Transactions replaces the tab and lists recorded expenses/income/payment/cash savings, including verified manual sheet rows, with month/all-month search, type/category/person/split filters and 40-row pages. Read-only batched history/canonical overlays avoid scheduled estimates and generated repayment edits. Current/historical month routing uses worker-local repositories, preserving the real clock/source year. Existing Discord financial actions/canonical guards are reused behind fresh explicit app reviews and durable owner-scoped command claims. Unknown outcomes cannot repeat a writer. Supported Undo persists across reload, including exact deletion records; unfinished confirmations can be checked from another authenticated session. No real transaction or repayment used for testing.

Added isolated SQLite/PostgreSQL command/source/history/API contracts and React recovery/navigation tests. README, Transactions workflow, decisions and manual checklist 156 updated. Local full **2,604 passed / 448 optional PostgreSQL skipped**, Python/frontend types and production build clean; final release evidence follows in STATUS. Native sample 390px search, Move review/cancel and 320px layout/nav inspected. Native user/device financial acceptance remains separate.

### Recent Update/Move quota and responsiveness audit — 2026-10-25

Released. The same synchronous-before-ACK and per-cell preparation pattern was present in Update/Move, including candidate/confirmation/person/category controls and typed replies. These paths now use private progress before owner-scoped worker I/O, one strict menu read, pure view constructors and a shared one-shot/Cancel mutation controller. Fresh batched preparation supplies all current/previous fields and Move extent/destination values. Pre-write quota errors preserve all cells/history; uncertain writes and missing persisted Undo have explicit inspection feedback. Stale candidate IDs never select another recent index. Canonical shared-payment correction and settlement guards are unchanged.

The process-local mutation lock now covers Update/Move/Delete/Undo. Isolated regressions exposed and repaired partial-column/full-display Update snapshots, moved update-ancestor coordinates, and adjacent Move/Delete source gaps during LIFO Undo. Reused the existing additive gap metadata and expanded restoration to full lineage, retaining neighboring edits and bank-link callbacks. Undo field validation also batches its reads. Test fixture pending selections now reset between independent local histories rather than relying on stale-index fallback. Targeted **411 passed**, full local **2,573 passed / 418 optional PostgreSQL skipped**, Pyright clean. [PR #86](https://github.com/brianjames-dev/bookiebot/pull/86) merged as `ed30b40`, with a tree identical to tested `0ba3963`. [CI #233](https://github.com/brianjames-dev/bookiebot/actions/runs/40241712397) passed **2,991 tests / zero skips**, PostgreSQL, Python/frontend types, Apps Script, build and committed asset parity. Railway `10683101-ad24-4f41-9359-2bf495d84c57` successfully deployed the exact merge commit; Discord login/command sync, web startup, health, exact unchanged frontend/assets (`9217df8485c906a6bc2911cc`) and private-data authorization verified. Native user-control acceptance remains checklist 155; no real Update/Move/Delete/Undo, repayment or synthetic Discord message was used for testing. Financial tests use only copied in-memory grids, fixture IDs and mocked Discord/native payload serialization. No real Update/Move/Delete/Undo, sheet edits, repayments or Discord messages. Manual acceptance is checklist 155.

### Recent Delete and recovery implementation — 2026-10-25

Released: one fresh expense-sheet snapshot replaces per-cell deletion reads and supplies extent/Undo/source checks. Shared snapshot callers batch reads as well. Strict Recent/selection reads surface quota/unavailable history instead of an empty list, without advancing failed pagination. Private selection/Delete ACKs precede worker I/O with actor context. Exact-ID deletion, per-control one-shot/Cancel and failed-ACK guards prevent unintended retry/fallback. Safe pre-write errors explicitly report no deletion; uncertain writes and missing persisted Undo records require inspection rather than a repeated writer. No schema or canonical financial-command changes.

Process-local Delete/Undo serialization protects overlapping compactions. Added a regression/fix for adjacent deletions sharing a restore position: LIFO Undo retains the original row order. Existing updated/moved/income and canonical shared-expense/settlement regressions remain part of targeted verification. Real Discord webhook validation covers empty and failed Recent launcher recovery with omitted absent views, private flags and launcher cleanup only after delivery. Timings include action ID/outcome. User explicitly authorized implementation and deployment and forbade deleting the real RJ11 transaction; all delete/Undo acceptance uses isolated fixtures. Targeted **355 passed**, full local **2,517 passed / 418 optional PostgreSQL skipped**, clean Pyright. PR #85 merged as `4cfa2f8`, exactly matching tested `9cbe4d1`; CI #229 passed **2,935 / zero skips**, PostgreSQL, Python/frontend types, build and asset parity. Railway `505bc865-3a2b-4717-9985-77710d3c3814` successfully deployed commit `4cfa2f8`; Discord login/command sync/web startup, health, exact unchanged frontend/assets (`9217df8485c906a6bc2911cc`) and private-data authorization verified. Native user-control acceptance remains checklist 154. No production Delete/Undo or synthetic financial action; the actual RJ11 transaction was untouched. Manual acceptance is checklist 154.

### Silent recent-transaction Delete investigation — 2026-10-25

Status: **diagnosed; repair proposed, not implemented**. User reports RJ11 Delete produced no UI result. Read-only Railway search of October 25 08:00–10:00 Pacific on the then-live PR #83 deployment (`4067d60c`) shows only a gateway resume, with no Delete callback/error. Broader logs show three Delete failures at October 24 **23:08:44, 23:09:34 and 23:27:32 Pacific** (application timestamps; UTC October 25 06:08/06:09/06:27). No selected action ID/name is logged, so these entries cannot be conclusively assigned to RJ11.

All three callbacks enter `delete_recent_action(index=1)` and fail with Sheets `429 Read requests per minute per user` in `_category_snapshot`: one `ws.cell` network read per affected cell. Snapshot setup is before the compaction try/except and before the first delete write, so Discord logs an uncaught view exception and sends no result. An isolated 20-row/four-column snapshot performs **80 reads**; a synthetic quota of 60 reproduces APIError on read 61 with no delete writer or action-log mutation step reached. This demonstrates the inefficient pattern, not the production quota's numeric value.

Additional defects: ordinary selection loads synchronously before interaction ACK; Delete runs synchronously after non-thinking defer, and a rejected defer is ignored. An isolated 3.2-second selection delays ACK by 3.202 seconds on the event-loop thread; rejected ACK still calls the mocked delete. At **23:23:24 / 23:23:32 Pacific**, Recent launcher follow-ups also fail with `TypeError: expected view parameter to be of type View not NoneType`. After the action-log quota error leaves no entries, query_recent_actions passes `view=None` into `_send_recent_followup_chunks`; real Discord payload validation reproduces without making HTTP calls. Existing test doubles accept this invalid parameter.

Proposed coherent repair: use one fresh batched category snapshot for extent/undo data, preserving blank cells and current row/source/lineage checks; acknowledge ownership-validated clicks with visible private progress before any I/O and perform blocking work in a worker with actor sheet context. Catch read/quota failures through preparation and always finish the private response with an accurate result. Retry only safe reads; do not blindly repeat writes or claim no mutation after uncertainty. Bind component Delete to the exact action ID, reject missing/stale selections, guard duplicate submissions and stop if ACK fails. Omit absent webhook views so empty/error recovery messages render. Retain canonical shared-expense settlement guards, compaction, Undo and reconciliation synchronization. Add action-ID/stage/duration/outcome diagnostics without transaction contents.

Verification: existing handler/router tests **280 passed**. Separate temporary isolated callback/quota/native-webhook reproductions verified the defects; no repository application code changed. Future isolated/manual acceptance: large-category Delete uses a bounded read count, injected 429 sends an explicit retryable pre-write result with unchanged cells/log/bank state, slow reads leave the loop responsive with immediate progress, expired/foreign/failed-ACK/stale/double-click controls cannot delete another action, empty Recent renders through real Discord serialization, and successful Delete/Undo preserves neighboring rows, action lineage, canonical anchors and bank reopening. Confirm on production only for a genuinely requested deletion after release; this investigation did not click Delete, send messages, edit sheets or change production configuration.

### Focused daily reconciliation prompts — 2026-10-25

Released: healthy digests offer Reconcile Now/View Inbox only; a failed connection instead asks to refresh and shows one Refresh bank connection action. Generate fresh scoped bank sign-in links after clicking; old recovery controls recheck saved health without another sync after recovery. Preserve persistent IDs, owner checks, morning recovery and post-delivery audit guards. Remove the global daily reimbursement task and attach optional receipt choices to eligible exact saved shared matches in View Inbox; keep post-match shortcuts and separate canonical amount/date/received confirmation. One read-only allocation snapshot, no projection replay, and optional lookup failure cannot block bank review. Targeted 115 passed / 31 optional PostgreSQL skipped, full local 2,491 passed / 418 optional PostgreSQL skipped and clean Pyright. PR #84 merged as `06e0c2f` with a tree identical to tested `fa283b7`; CI #224 passed **2,909 tests / zero skips**, PostgreSQL, Python/frontend types, build and committed asset parity. Railway `b6082101-b8c7-4d4b-8ea1-4cfb596913ee` successfully deployed commit `06e0c2f`; Discord login/command sync/web startup, health, exact frontend/assets (`9217df8485c906a6bc2911cc`) and private-data authorization verified. Native next-normal-digest acceptance remains checklist 153; no forced message or production financial action. Workflow/decision docs and STATUS 153 cover acceptance. No production financial actions or synthetic Discord sends. The October 23 global repayment entry point below is superseded.

### Discord reconciliation receipt confirmation — 2026-10-23

Released: persistent 10 AM digest/private inbox entry, exact saved automatic/manual bank-match choices and optional post-match receipt shortcut. Reuse the web mapper with one shared allocation snapshot, canonical receive/confirm_payment commands, actor ownership, fresh bank/allocation/report evidence and existing projection/reset/settlement guards. An amount/date/note modal leads to a separate confirmation; no receipt on match/open/modal/cancel. Preserve pending sender events, partial amounts and the original command through lost responses, concurrent clicks and parent cancellation; preflight failures cannot bypass fresh bank validation. Current-month latest-200 choices paginate by 25. Focused 108 passed / 30 optional PostgreSQL skipped; full local 2,487 passed / 417 optional PostgreSQL skipped and clean Python types. Real private Discord components and modal serialization pass. PR #81 merged as `787bb3c` from exact source `36510c9`; CI #212 passed **2,904 / zero skips**, PostgreSQL/types/build/asset parity. Railway `adaef0ed` active for PR #81; Discord/command/web startup, health, unchanged exact frontend/assets (`513de9cd01fbaae2b98f933c`) and private authorization verified. Workflow/decision docs updated; manual/native next-digest acceptance is STATUS 151. No production receipts or synthetic Discord messages.

### Separate received-share confirmation in reconciliation — 2026-10-23

Released: exact saved-match → payee-owned canonical allocation shortcut, optional post-match receipt follow-up, and Checked entry actions. Reuse Shared's dated partial receipt/pending sent-payment confirmation and durable idempotent retry; bank confirmation never records a repayment. Changed gross/identity/month, ambiguous/opposite-owner/historical/inactive records fail closed. Preserve typed amounts and freeze receipt versions across external updates; uncertain commands remain mounted with navigation blocked. Receipt events refresh Overview and reconciliation details. New mapping/API/UI regressions cover no automatic receipt, partial amounts, source evidence, stale balances, owner isolation, unchanged bank lineage, response loss, projection pending and safe repeat requests. Full local 2,450 passed / 387 optional skipped; targeted 96 passed; Python/frontend types/runtime/build pass. Sample data dark 390px/light 320px review/cancel and partial receipt pass without overflow; source bank match remains $125 while a $12.34 receipt changes $34.09 owed to $21.75. PR #80 merged as `b0c6fe6` from exact source `bab43a2`; CI #208 passed 2,837 / zero skips plus PostgreSQL/types/build/assets. Railway `36da135c` active; frontend `513de9cd01fbaae2b98f933c`, exact assets, health/private authorization and Discord/command/web startup verified. Live settled shares expose View; outstanding shares expose the separate received form with exact remainder/date. Cancel/Back preserves the balance and bank match; inbox remains 0 Needs review / 8 Pending / 192 Checked. Native iPhone/genuine-payment acceptance remains checklist 150. No production receipts or financial test writes.

### Shared-bill reconciliation follow-up — 2026-10-23

Released: bank transactions contain gross bill totals; most household bills use By income with Hannah. Preserve canonical gross/share/settlement accounting, preview both shares and budget cash amount, and let new supported bills choose By income (default), 50/50 or No split. Existing settled bills must match gross without rewriting net budget cells. Changing settled/pending/cleared historical obligations remains guarded. PR #78 reached Active during clarification; the user subsequently approved temporary rollback, and Railway/public health/version verify PR #77 restored (`c396a4e1d72f00f3268e2557`). Local full 2,430 passed / 387 optional skipped; targeted 147 passed / 35 optional skipped plus UI runtime/types/build. Existing bills use canonical versioned revisions and read-only recovery requires the correct split/projection. Manual acceptance is STATUS 149; PR #79 merged as `0e3a473` from exact tested `0e9a3fd`; CI #204 passed 2,818 / zero skips and all PostgreSQL/types/build/asset checks. Railway `0a27de27` active, frontend `2215b1751d1136d06ed6d25a`, exact assets/health/private authorization verified. Live reload/Reconcile retains 0/8/192 at 3:30 PM; eligible scheduled-payment writes remain verified in isolated fixtures. Discord login/command sync/web startup pass with no startup errors; live snapshot 2.125s. Native checklist 149 remains. No financial test writes.

### Direct scheduled-payment correction — 2026-10-23

Merged through [PR #78](https://github.com/brianjames-dev/bookiebot/pull/78) as `101d172` (exact source `c9ccdf3`): read-only current-source preview and explicit bank-amount confirmation for recurring subscriptions, current bill actuals, optional future bill estimates, and formula-backed automatic bill settings. Update visible/normalized subscription sources together; preserve current payment lineage with canonical updates or a payment Undo action for an unrecorded actual. Bind source identity/recurrence/raw values and workbook/sheet IDs; use the existing durable operation table with schedule-adjustment claims and pending source/occurrence/action reservations. Read-only web verification recovers completed writes; partial/uncertain writes never retry, while unwritten stale claims release with an audit. Completion is event logged. Strong name matches can expose large price changes for manual review without relaxing automatic matching; saved matched history keeps its bank amount. Full local 2,414 passed / 387 optional skipped; targeted 144/80, schedule cases 25, Python/frontend types/runtime/build and dark 390px sample-data review/cancel/completion pass. Light 320px bill review also passed. [CI #201](https://github.com/brianjames-dev/bookiebot/actions/runs/40031309157) passed 2,801 tests / zero skips plus PostgreSQL/types/build/assets. Railway `f3680638` building; expected frontend `8d90e81226511b54e981d4ef`. Live/native acceptance pending in STATUS checklist 148; no production financial test writes.

### Web reconciliation review and performance — 2026-10-23

Merged through [PR #77](https://github.com/brianjames-dev/bookiebot/pull/77) as `30d5322` (exact source `31b557c`): complete saved income sources, filled confirmation controls, prominent suggested match with collapsed selectable alternatives, explicit amount correction, sheet-specific missing-entry copy, and two-step expense/income creation using bank amount/date and owner payment methods. Reuse canonical guarded update and durable import claims; financial confirmation reads fresh evidence and verifies the selected source again before changing its amount. Historical new entries remain unavailable; pending and recovery rows remain protected. Shared service/store initialization, 30-second owner/source and unchanged-row preview caches, metadata-only Ignore/Reopen versions, unused-group suppression and income schedule bypass remove repeated work. Request timing logs support production measurement; no claimed production speed multiplier. Drafts use the work guard and successful sheet writes refresh Overview. Full local 2,383 passed / 384 optional skipped, types/build/runtime contract and sample-data browser acceptance pass. [CI #197](https://github.com/brianjames-dev/bookiebot/actions/runs/40028215229) passed 2,767 tests / zero skips plus PostgreSQL/types/build/asset parity. Railway `3d86cfa2` active; frontend `c396a4e1d72f00f3268e2557`, exact assets, health/private authorization and Discord/web startup verified. Live read-only suggested match, missing-entry form/cancel and unchanged 3/8/189 inbox passed at 2:45–2:47 PM Pacific. Fresh detail timings were 4.649s cold, then 2.822/2.441s; snapshot 2.005s; cached collapse/reopen ~0.64s with no loading/request. Old live Donut preview was ~3.2s browser wall time; do not compare unequal cold/warm samples as an end-to-end multiplier. Sample-data dark 390px and light 320px review passed; native/isolated financial acceptance is STATUS 147. No production financial test writes.

### Automatic morning digest after bank resync — 2026-10-23

Released at the user's request: [PR #76](https://github.com/brianjames-dev/bookiebot/pull/76) merged as `847139b` from exact tested source `a6fe27a`. [CI #193](https://github.com/brianjames-dev/bookiebot/actions/runs/40019888083) passed **2,754 tests / zero skips** and all types/build/asset checks. Active Railway `9df19456`, frontend **dc5f13ef14c73c74abec8887**, exact assets, health/private authorization and Discord/web startup are verified. The production hour remains **10**; authenticated Check passed at **1:41 PM Pacific** with **8 Needs review / 8 Pending / 184 Checked** and no alert/error. Discord's normal digest and failure alert offer an owner-scoped persistent **Resync bank** button; failed login returns a fresh existing-Item reconnect link. The web health alert offers **Resync bank information** alongside required bank sign-in, and foreground visibility refreshes the saved inbox. Reconnect completion and manual resync now force the same recent, owner-scoped reconciliation preview before notifying the delivery loop. A durable morning refresh marker and separate recovery-delivery audit allow one updated digest after a previous normal digest/health alert, with post-success DM recording and normal retries. The existing single loop wakes immediately and retains the 10–11 AM Pacific gate. No automatic expense import or sheet mutation. Full local **2,370 passed / 384 optional skipped**, targeted **86 passed**, clean Python/frontend types and production build/runtime contract. Sample-data browser resync clears the warning and refreshes the check time with 44px actions. One owner-scoped audit read supplies delivery flags; healthy empty recovery also confirms success in Discord. Release is verified above; actual future morning recovery DM and native iPhone foreground acceptance remain in STATUS.

### Existing-Item reconnect and explicit alerts — 2026-10-23

Recovery verified: the user completed a renewed Hosted Link through BookieBot's success screen. Production first success is **October 23, 1:14:06 PM Pacific**; authenticated app Check succeeded again at **1:16:59 PM**, clearing `last_error` and `webhook_pending`. Recovered **33 records through October 23 (25 posted / eight pending)**. Four actual posted replacements match their removed pending authorizations. The app shows **8 Needs review / 8 Pending / 184 Checked** within the 200-row limit, with no reconnect/error alert. All three original account/provider identities and watched settings match the baseline; all 35 sampled saved confirmed/ignored records retain exact decisions, match lineage and resolution timestamps after Check. Earlier bank login stopped before completion and expired; warnings correctly remained until the renewed flow passed. No imports, review decisions, sheet writes or synthetic Discord digest. Next normal morning delivery remains future acceptance.

Release: PR #75 merged as `e4a1ac2`; [Verification #187](https://github.com/brianjames-dev/bookiebot/actions/runs/40012404015) passed exact source `af4ced5` with **2,739 tests / zero skips**, PostgreSQL and all type/build/asset checks. Railway `194155bf` is active, frontend **84489481f5e3279697d8a750** and all assets match, Discord/web startup and private-data authorization pass. Production send-hour override changed **7 → 10** and read back. Actual existing-Item Hosted Link, bank reauthentication and fresh bank/app data passed as recorded above; original accounts 97/98/99 are preserved.

Implementation complete locally at the user's request: signed owner/Item-scoped repair links use Plaid Hosted Link update mode for Discord/iOS browser OAuth, without token exchange, account/product expansion, duplicate Items or cursor resets. Completion checks the original connection with an actual transaction sync before clearing errors. Phone has named Reconnect links and stale-data feedback; failed Check retains known saved state. `/bank_reconnect` returns a private fresh 15-minute link. Daily health alerts are independent of cached review counts and use a separate post-delivery event, so recovery can still produce a normal digest that morning. Default/example and the verified production override use 10 AM Pacific. ITEM ERROR is retained as sync health; LOGIN_REPAIRED requires successful sync. Errors received before a newer successful repair cannot regress the warning state. No new storage schema or sheet mutation paths.

Provider/HTTP/storage/Discord/frontend regressions cover existing identity/cursor/history/watch preservation, owner/disconnection guards, failed repair, pending replacement, health isolation, empty inbox, safe links, DM failure and same-day digest recovery. Full local **2,355 passed / 384 optional skipped** including the final delayed-webhook follow-up; frontend types/contract/build and Pyright pass. Release/CI and the Railway override are complete as recorded above. Actual BofA repair and authenticated app Check passed; native iPhone refresh and the next normal morning digest remain On Deck in STATUS. The investigation below is the pre-repair evidence; no live bank or financial writes during implementation.

### Plaid sync outage investigation — 2026-10-23

Read-only production audit confirmed Brian's existing Bank of America Item fails `/accounts/get` with `ITEM_LOGIN_REQUIRED`. PostgreSQL last success is `2026-10-15T14:00:45.389214+00:00` (7:00:45 AM Pacific); last attempted sync is `2026-10-23T14:59:13.224480+00:00`. The live Discord saved inbox still serves 53 current-month records: 25 automatic matches, nine confirmed/logged, twelve ignored and seven pending, with zero unresolved. This is cached history, not evidence of current bank activity. Today's 10 AM subscription DM is present; actual reconciliation configuration is 7 AM with 60-second checks and the default one-hour morning window.

Application gaps: digest preparation swallows a sync failure into cached results and returns no message when there are no actionable/new matches; phone snapshot only says sync is delayed and Check uses a generic error; webhook processing skips non-TRANSACTIONS events, including Item errors; existing Link setup creates new Items and cannot repair this Item through update mode. Plaid explicitly requires user reauthentication through update mode for this error. No evidence establishes whether credentials, MFA, consent or another bank requirement caused it.

Status: **investigation, implementation, release and real-bank recovery complete**, as recorded above. The audit below describes the pre-repair state. Keep owner-scoped existing-Item repair and explicit phone/Discord health feedback; do not disconnect/purge/relink or reset cursors as a workaround. Next normal 10 AM delivery remains acceptance in `docs/RECONCILIATION.md` and STATUS. The initial investigation itself made no runtime, production configuration, review or sheet changes.

Verification: existing Plaid client, lifecycle recovery, storage contract, Discord digest and phone reconciliation tests **163 passed / 76 optional PostgreSQL skipped**. The pending-to-posted storage contract passes locally; production updates were blocked during the initial audit; subsequent end-to-end recovery is verified above. Public health and the existing live Discord View Inbox response passed. Initial localhost test-server binding restrictions were resolved by rerunning with localhost permission. No durable architecture decision was introduced by this investigation.

### Recorded ESPP withholding correction — 2026-10-23

Implementation and authorized native sheet update complete on `codex/espp-actual-withholding`; review/release remains pending. First actual payroll establishes a gross-based deduction; the earlier net-pay inference understated ESPP. Reused the empty fourth income column, kept the monthly total automatic and targeted 20% of deposit + withholding with cash covering the remainder. Minimum cash remains 7.5% enrolled/10% other. Missing/invalid/orphaned amounts and inconsistent totals stay incomplete; explicit zero is valid. Income amount corrections/Delete/Undo preserve deduction lineage, legacy snapshots/Hannah retain their prior calculations, and estimates never increase actual investment history. No reconciliation lifecycle change.

2026-10-23 work log: atomically updated only Brian October/Template with a private complete backup, entered the confirmed withholding in October E18 on the existing paycheck, and verified native formula parity. Independent readback confirms 13 expected input/formula changes, unchanged income/actual cash/Net Total/dimensions. Native disposable-tab missing/zero/source/date/delete/restore checks passed and the temporary tab was removed. Full local **2,336 passed / 383 optional PostgreSQL skipped**, final focused **50 passed**, Apps Script **5 passed**, types/frontend build clean. Read-only corrected-sheet preview verifies Saved/Income/Investments and separate chart slices. Manual/release checklist 145 is in STATUS. Do not merge/deploy until approved; update the matching saved live Apps Script source with that release before the next rollover. No new production test transactions or saved-action coordinate migrations.

### PG&E receipt sync and bulk received — 2026-10-18

2026-10-18 bulk verification: read-only live preflight passed all 5 outstanding sources/$213.70 and both owners’ Grocery/Shopping formula chains. An offline copy of the actual grids, anchors and formulas passed the actual receive-all service: all received/projected, Brian spending −$213.70/Hannah +$213.70, 11 reads/3 writes and no extra events/calls on repeat. Added formula-inclusive 1/5/80 counts for both payees and seven Google 429 recovery contracts; updated the store contract to span three months. Targeted 233 passed/150 optional PostgreSQL skipped, authenticated API 2 passed, changed store slice 7 passed/7 skipped, Pyright clean; both [PR #73](https://github.com/brianjames-dev/bookiebot/pull/73) CI runs passed exact test head `4bb2ba2`, **2,698 tests / zero skips**, PostgreSQL and the full type/build/asset stack. Documented quota sharing and the copy/Google-recalculation verification boundary in `docs/REIMBURSEMENTS.md`. No real payment/reset was submitted; intentional live receipt acceptance remains STATUS checklist 143.

2026-10-18 button styling released: [PR #72](https://github.com/brianjames-dev/bookiebot/pull/72) merged as `ce47d06` after both feature CI runs passed; [main CI](https://github.com/brianjames-dev/bookiebot/actions/runs/39186905871) passed **2,672 tests / zero skips** and all type/build/asset checks. Railway `fe51b71d-e7f3-4849-8df2-80f17898accd` is successful/active on the exact merge commit. Verified Discord/web startup, health 200/private report 401, frontend **a156a198001505c0f1f4fb8f** and byte-for-byte parity of all three assets. Live authenticated 390px view shows adjacent 44px primary Received/outlined Reset buttons without overflow; each opens its existing distinct review and cancels. Balances remain 5 expenses/$213.70, with no receipt/reset submission. Remaining native iPhone acceptance: STATUS checklist 144.

2026-10-18 presentation follow-up complete: Mark all received and Reset balances share an accessible two-column action group. Received uses the filled primary theme style; Reset uses a muted outline. Visibility/disabled guards, review fields and confirmation behavior are preserved. Rebuilt shipped assets; focused reimbursement UI **2 passed**, frontend typecheck/build and diff checks passed. Sample browser review passed 320/390/1280px in both themes with 44px tap targets and no overflow; each action opens its correct review and cancels safely. Release/iPhone acceptance remains STATUS checklist 144; no production financial writes.

Released 2026-10-18: [PR #71](https://github.com/brianjames-dev/bookiebot/pull/71) merged as `8b74895` after both latest-head checks passed; merged tree matches tested `c855cb6`. [Main CI](https://github.com/brianjames-dev/bookiebot/actions/runs/39185468510) passed **2,672 tests / zero skips** and all type/build/asset checks. Railway `89924ba7-4272-47c7-9a34-6ccd4e5203c6` is successful/active, Discord/web startup verified, health 200/private report 401. Frontend **ec25e87aac4e2da540e648ed** and all three public assets match the tested build. A normal Shared read successfully replayed the one existing pending allocation in 6.30s; live October bills now read **$80.56 Brian / $43.90 Hannah**, and the mirror/app show reimbursed/Received with $43.90 received on October 17. Gross $124.46 and saved action lineage are unchanged. Live Mark all received preview correctly shows 5 expenses/$213.70 and was canceled without submission. Remaining iPhone/isolated mutation acceptance is STATUS checklist 143; this follow-up changes tracking docs only.

Implemented and released; existing production receipt replay is verified above (remaining device checks: STATUS checklist 143). The pre-release read-only audit found the saved `pg&e` category rejected by the `pge`-only bill projector. The $43.90 receipt already existed; before release, version 7 was settled but projected version was 4, and October rows showed $124.46 Brian / $0 Hannah. Added the alias without changing payment history; release replay produced $80.56/$43.90.

Shared now offers Mark all received for the full outstanding payee ledger, with count/total/date review. A single version-fingerprinted, idempotent database transaction confirms pending reports once and fills remaining balances; no opposite-direction or cleared debt is reinterpreted. Batched Sheet projection reuses fresh workbook metadata/row snapshots, reserves receipt rows and ID anchors together, writes grouped absolute targets, verifies all financial rows before mirrors, and marks versions complete only after readback. Durable command-result metadata routes refresh/restart recovery through the same batch path. No new schema or repayment event; release recovery updates only the existing confirmed receipt’s pending projections. Regression/API/UI coverage, including 1/80-expense request-count parity, is recorded in STATUS.

### Savings menu overflow — 2026-10-14

Released 2026-10-15: [PR #69](https://github.com/brianjames-dev/bookiebot/pull/69) merged as `e5232d1` after both feature CI runs passed. [Main CI](https://github.com/brianjames-dev/bookiebot/actions/runs/38754120365) passed **2,633 tests / zero skips** and all type/build/asset checks; merged source matches tested feature `351ed8c`. Railway `6c261567-92c3-493c-9e1e-42a7bbdf2584` is successful/active with verified Discord/web startup, health 200 and private report 401. Version **417c9dda336f1e9eef08193d** and all three public frontend assets match the tested build exactly. This follow-up records release evidence only; phone acceptance remains STATUS checklist 142. No financial test writes.

Complete: raised the isolated Savings card above Investments while retaining visible overflow and the existing full-width backgrounds. The last active or archived goal's menu can cross the section boundary and receive taps. Added a regression that failed before the CSS fix and rebuilt the shipped stylesheet. Focused **15 passed**, full local **2,281 passed / 352 optional PostgreSQL skipped**, clean Python/frontend types and build. Production-build WebKit/Chromium passed 12 width/theme cases for overlap, actions and dismissal; the old layer order reproduced the obstruction in all 12. Device acceptance after deployment is STATUS checklist 142. This is presentation-only; savings allocation and ESPP behavior are unchanged.

### Automatic Student Loan Need expense — 2026-10-14

Main integration follow-up: included indicator restoration `4a2f70e` at the user's request after [exact-commit CI](https://github.com/brianjames-dev/bookiebot/actions/runs/38614833010) passed all checks. Integration adds tracking docs only; live sheet checks already passed and next-digest acceptance remains checklist 141.

User-requested display follow-up: restored the original checkmark/star formulas in October D23 and Template D18. Read-only comparison confirms exactly these two cells changed, preserving $60.23 formulas, automatic mode, totals, history and named ranges; native views show checkmarks. Rollover regression now preserves both formulas; Apps Script checks pass. Updated checklist 141 and the existing read-only heartbeat, whose actual next-digest verification remains pending.

Released/activated: [PR #68](https://github.com/brianjames-dev/bookiebot/pull/68) passed both feature CI runs and merged as `d8bd0d4`; [main CI](https://github.com/brianjames-dev/bookiebot/actions/runs/38612309723) passed **2,632 tests / zero skips** and all type/build/asset checks. Railway `9daf37f3-29b3-4edc-a529-4816760ecf45` is successful/active; startup, health and authorization verified. Native/read-only acceptance confirms the six authorized cells plus one optional schedule column, $60.23/Auto in October and Template, Needs +$60.23, unchanged Wants spending/history/named ranges, and one Needs report item. September remains $119.92. No manual payment or synthetic Discord message; next actual DM check remains STATUS checklist 141.

Implemented after explicit user confirmation: $60.23 monthly counts as an automatic Need expense, without payment logs. Reuse the existing dedicated Needs row/static-bill category and owner schedule; optional `tracking_mode=automatic` requires a positive expectation, while blank/manual retains existing behavior. Loan commands cannot overwrite automatic formulas and status does not claim verified bank payment. Reminders use the fixed amount in the normal seven-day window, with no false overdue notice. No duplicate subscription or historical rewrite.

Fifteen new Python regressions and monthly Template-copy assertions; focused **222 passed**, full local **2,252 passed / 380 skipped**, clean Pyright and Apps Script checks. Saved before/after snapshots verify October C23/D23, Template C18/D18 and schedule K1/K3; September C17=$119.92 is unchanged. The user-requested daily 10:15 AM Pacific read-only heartbeat will inspect the next actual Discord DM and pause after verification; October 15 should omit the already-past automatic loan, while the verified November 5–12 source preview shows $60.23. Existing annual-master maintenance and pre-existing Template shared-import errors remain separate backlog items; no row coordinates changed.

### Fixed Student Loan reminders — 2026-10-14

Released: [PR #67](https://github.com/brianjames-dev/bookiebot/pull/67) passed both feature CI runs and merged as `e2bd168`; [main CI](https://github.com/brianjames-dev/bookiebot/actions/runs/38606607805) passed **2,617 tests / zero skips** and all type/build/asset checks. Railway deployment `c17798ec-cd01-43b2-ac96-f37b6a587b9e` is successful/active. Verified Discord login, command sync, web startup, health 200 and private report 401. This follow-up changes tracking docs only; next normal digest acceptance remains STATUS checklist 140. Today's already-sent message was not reset or resent.

The user corrected the recurring loan to **$60.23 monthly**. Saved only Brian's existing `_BookieBot Bill Schedule!J3` (previously 59.96), retaining monthly/day 12 and owner/source identity. Chrome saved readback and a read-only API check passed; October/Template actuals remain zero, with no duplicate active loan subscription. No payment or manual notification was created.

The sheet reader already supplied expected amounts, but Discord incorrectly used the actual-recorded flag as amount availability and hardcoded overdue rows to amount missing. The adapter now preserves known amounts; overdue rows appear under **Overdue (payment not recorded)** and stay outside next-seven-day totals/missing counts. Existing actual replacement, duplicate suppression, send claims and post-send audit semantics remain. Eight new regressions; focused **158 passed**, full local **2,237 passed / 380 skipped**, Pyright clean. Manual acceptance is STATUS checklist 140; the prior annual-master follow-up remains separate. User accepted the preceding Sheet-label release.

### Reconciliation Sheet labels — 2026-10-14

Released: [PR #66](https://github.com/brianjames-dev/bookiebot/pull/66) passed both feature CI runs and merged as `89dd203` at the user's request. [Main CI](https://github.com/brianjames-dev/bookiebot/actions/runs/38592171163) passed **2,609 tests / zero skips** and the complete type/build/asset stack. Railway deployment `ba00b71a-4d59-40e3-aca4-24e8ed5819cb` is successful/active; verified Discord login, command sync, web startup, health 200 and private report 401. This follow-up changes tracking docs only; existing-digest device acceptance remains STATUS checklist 139.

Reports reuse the existing named-field reader, including canonical split `display_fields`, to show Item at Location (or the available field), Gas with any recorded Location, and a separate Person line. Missing descriptions fall back to the category; complete groups deduplicate Person, while incomplete groups retain the persisted-reference fallback. This changes report presentation only, preserving matching/scoring labels, bank merchant labels, source dates/amounts and the bounded hydration lifecycle. Added 11 regressions and expanded existing formatting, grouping and end-to-end private delivery checks. Focused **127 passed**, full local **2,229 passed / 380 skipped**, Pyright clean. No financial writes.

### Reconciliation Sheet details — 2026-10-14

Read-only acceptance: all seven cards in the user's current screenshot have dates/amounts matching active saved actions and the live October cells. Food descriptions match Item; the split grocery description matches its canonical Item in the existing reimbursement mirror. Gas has no Item/Location fields, so the current first-text heuristic displays Person. Record a pending display improvement for consistent category-aware labels with Item/Location and separate Person. The user requested verification/explanation only; no source or financial data changes were made. STATUS checklist 138 records acceptance.

Released: [PR #65](https://github.com/brianjames-dev/bookiebot/pull/65) passed both feature CI runs and merged into main as `1d47fc6` at the user's request. [Main verification](https://github.com/brianjames-dev/bookiebot/actions/runs/38587455968) passed **2,598 tests / zero skips** and the complete Python/frontend type, Apps Script, build and asset stack. Railway deployment `6a959359-5795-4cdb-9f87-9b958919a0e7` is successful/active; Discord login, command sync, web startup, public health and private report 401 are verified. Device acceptance remains STATUS checklist 138. This follow-up changes tracking docs only.

Implementation released; manual device acceptance is STATUS checklist 138. The user confirmed PR #64's existing-digest delivery fix, then reported `no spreadsheet row (spreadsheet row)`. The persisted inbox deliberately skipped source hydration, losing date/amount/label despite retaining match lineage. It now carries saved references into the report and optionally reads owner-scoped batched action history or referenced schedule sources. Five-second timeout/failure falls back to readable cell/month references instead of withholding the report or claiming no match. Source values are never inferred from the bank row; grouped totals require every linked action. Added 16 regressions; focused **116 passed**, full local **2,218 passed / 380 skipped** (optional PostgreSQL and unavailable frontend test dependencies), Pyright **0 errors / 0 warnings**. No schema, matching decision, bank state or sheet mutation changes.

### Digest View Inbox response repair — 2026-10-14

Released: [PR #64](https://github.com/brianjames-dev/bookiebot/pull/64) passed both feature CI runs and merged into main as `a304eda` at the user's request. [Main CI](https://github.com/brianjames-dev/bookiebot/actions/runs/38584069503) passed **2,582 tests / zero skips** and all Python/frontend type, Apps Script, build and asset checks. Railway deployment `530322e8-c616-4708-a349-f28519c4b4ef` is successful/active; Discord login, command sync, web startup, public health and private report 401 are verified. Existing-digest device acceptance remains STATUS checklist 137. This follow-up changes tracking docs only.

Real Discord webhook tests reproduced `TypeError: expected view parameter to be of type View not NoneType`: multi-page automatic-match reports failed on the first page without controls, and unresolved reports stopped at subsequent pages. Pages without controls now omit `view`; private delivery, typing, current-month persisted reads and control placement retain their existing behavior. Eight regression cases cover one/multiple pages, automatic matches/unresolved items and new/persistent digest callbacks. Focused reconciliation suite: **51 passed**; full local **2,202 passed / 380 skipped** (optional PostgreSQL and unavailable frontend test dependencies), Pyright **0 errors / 0 warnings**. No matching, storage, lifecycle or sheet-mutation changes; the broader digest lifecycle backlog remains pending.

### ESPP web preview revision — 2026-10-13

Implemented requested presentation refinements; the user approved the preview and requested release. All seven branch commits through `94b339c` merged into main as `c81d2ac`, with [main Verification](https://github.com/brianjames-dev/bookiebot/actions/runs/38443718146) passing all **2,574 tests / zero skips** and Python/frontend types, Apps Script, build/asset parity. Railway production deployment succeeded; `/app/version` **98861c66ccd2e70b58d508d3** and all three public assets match the approved build, while unauthenticated personal data remains 401. This release follow-up changes tracking docs only. Device acceptance remains STATUS checklist 136. Income now includes payroll ESPP before withholding, Saved includes monthly cash + ESPP, and Left/Spent retain cash accounting. Existing Saved label and cash-progress targets remain; details omit take-home. Category Mix separates cash/ESPP. Savings goals precede one darker Investments section with the recorded SpaceX ESPP contribution total. Current/Projected labels and incomplete-history safeguards remain.

Local full **2,222 passed / 352 optional PostgreSQL skipped**, focused **88 passed**, Python/frontend type/build checks clean. Rebuilt production assets and reviewed sample-data browser layouts; corrected fitted amount sizing. No reconciliation lifecycle, persistent financial data or live sheet changes. [CI on `32212f2`](https://github.com/brianjames-dev/bookiebot/actions/runs/38432458210) passed **2,574 tests / zero skips**, PostgreSQL, Python/frontend types, Apps Script, production build and committed-asset parity. The follow-up commit changes documentation only. The user approved the final preview and release; main integration is tracked above. Remaining: device acceptance and the first actual enrolled paycheck. Release required no production financial writes or repeated sheet setup.

### ESPP layout simplification — 2026-10-12

Complete live layout/app implementation; application release is tracked above and real-payroll/device acceptance remains STATUS checklist 135. Four-column dated settings now sit below Main Income Source, and one bordered ESPP total stays within the income table. Dark buffer rows separate all four tables; the side panel and separate settings tab are removed. Existing cash targets/actual input and historical/Hannah behavior remain intact.

- Each monthly snapshot owns its dated timeline; rollover copies the full schedule. App/Discord use the same per-paycheck math and visible settings warnings. No separate ESPP transaction is written.
- Structural migration backs up both workbooks and shifts income/cash-savings Undo and shared-income ledger references through each insertion. Native calculations, original-row Delete/restore, rate versions, invalid settings and live report parity are verified; October/Template visual QA passes. No synthetic production financial transactions.
- Final local verification: **2,221 passed / 352 optional PostgreSQL skipped**, clean Python/frontend types; [CI on `e72f203`](https://github.com/brianjames-dev/bookiebot/actions/runs/38318404569) passed **2,573 tests / zero skips**, PostgreSQL contracts, Python/frontend types, Apps Script, build and committed-asset parity. The follow-up commit changes tracking docs only. Release acceptance remains in STATUS. No bank reconciliation backlog or lifecycle change; outstanding work is release acceptance and the first actual enrolled paycheck.

### ESPP and monthly cash savings work log — 2026-10-12

Status: implementation complete; application release is tracked above and real-payroll/device acceptance remains STATUS checklist 135. The user authorized 5% automatic ESPP for Brian's enrolled xAI paychecks beginning 2026-10-23, 15% ideal / 7.5% minimum enrolled cash savings, and continued 20% ideal cash for unrelated income (10% minimum retained). No inferred end date.

- Canonical report, Current/Projected budgets, read-only Ask data and Discord savings queries share derived payroll math. Monthly cash saved stays actual and overwrite-only; ESPP is calculated once per dated enrolled deposit. Corrections/Undo need no separate investment write. Savings shows cash, ESPP estimates, combined contributions and available monthly history.
- Current Brian October and Template now have owner-scoped enrollment controls and formula summary; income, expense and actual savings inputs are preserved. Live Apps Script has only the ESPP patch, retaining its existing validation-restoration fix. Monthly/year rollover is covered by runtime tests; Hannah/historical sheets remain unconfigured.
- Focused calculation/report/Discord/Apps Script regressions pass. Full local suite passed **2,205 tests / 352 optional PostgreSQL skips**. [CI](https://github.com/brianjames-dev/bookiebot/actions/runs/38286482516) on exact implementation tip `d1d4b24` passed **2,557 tests / zero skips**, PostgreSQL contracts, Python/frontend types, Apps Script, build and committed-asset parity. Follow-up changes are tracking documentation only.
- Google Sheets engine checks passed enrolled/unrelated pay, October 23 boundary, source exclusions, undated rows, per-paycheck rounding, empty income, first-row insertion/deletion and original-row Delete/restore. Scratch tab removed. The summary sits below income so structural edits preserve its complete block. Visual QA caught currency-text dependencies in legacy burn-rate cells; allocation references retain their original type. Summary colors follow existing green inputs and remain readable on the dark sheet. October has no formula errors; pre-existing Template import errors remain outside scope.
- No bank/reconciliation lifecycle changes, stock purchases, new cash contributions or historical financial entries. Remaining: check the first actual 10/23 paycheck; expected income remains an explicit expected deposit and may need updating when the new net amount is known.

### Main integration — 2026-10-10

Merged both commits through `e5e97ea` from `codex/web-metric-details` into `main` at the user's request, without conflicts. [Verification #116](https://github.com/brianjames-dev/bookiebot/actions/runs/38068125685) passed the exact source tip: **2,523 tests / zero skips** including PostgreSQL, Python/frontend types, Apps Script, build and asset consistency. Changes beyond that tested tree are release documentation only. Confirm automatic main verification/Railway rollout and perform STATUS checklist 134. No production financial changes.

### Dashboard details and Shared history work log — 2026-10-10

Complete implementation, integrated into main; release verification/rollout and device acceptance pending (STATUS checklist 134). Shared canonical/fallback history retains the five-month/five-expense initial view, but Load all months/expenses reveals the entire remaining history in one click. This supersedes the October 3 incremental-five controls. The choice stays active across refresh/new arrivals and hidden directions; lazy collapsed months, stable disclosure IDs/payment drafts, full balances and mutation scope remain intact. No API/storage/accounting changes.

Left details retain allocation percentages without verbose notes, Spent shows expense bucket totals, and Saved shows one savings total with shared progress and dynamic targets. Runtime contracts verify display semantics and both history implementations. Report suite **635 passed / 88 optional PostgreSQL skipped**; full suite **2,171 passed / 352 optional PostgreSQL skipped**, clean Python/frontend types and build. Production-build WebKit/Chromium passed **72 modal checks** across phone/desktop widths, both themes and modes. [Verification #115](https://github.com/brianjames-dev/bookiebot/actions/runs/38067837038) on `ba4d517` passed **2,523 tests / zero skips** including PostgreSQL, plus Python/frontend types, Apps Script, build and asset consistency. No live financial writes. Prior reconciliation/move/Undo backlog remains separate.

### Main integration — 2026-10-08

Merged all three new commits through `4fbfe39` into `main` at the user's request. [Verification #113](https://github.com/brianjames-dev/bookiebot/actions/runs/37825811309) passed the exact source commit with **2,522 tests / zero skips**, Python types, Apps Script, frontend typecheck/build and asset consistency. The conflict-free merge adds release documentation only beyond that tested tree. Confirm automatic main verification/Railway rollout and perform STATUS checklist 133; the separately authorized Parking restore is already complete and must not be replayed. No additional application or live financial changes during integration.

### Reconciliation regressions work log — 2026-10-08

Complete implementation; local and GitHub verification passed, integrated into main, with rollout/device acceptance pending (STATUS checklist 133). Read-only production evidence confirmed Oliver's Market Grocery row 4 collided with Taco Bell's Food row-4 reservation. Parking's import completed, then was undone; the completed claim incorrectly blocked a new Log. Item 3391 remains intentionally ignored. Neither was mutated during diagnosis.

Subsequent authorized live Parking restore: verified original Undo and absence of any surviving import descendant, then atomically replaced the completed operation under current bank/review versions and account eligibility. Used the normal Sheets writer/action logger once for October Shopping row 19, new active action `dcfd1162`; completed the import and confirmed item 3376. The old action remains undone and the full previous operation is retained in one replacement event. Independent API/formula comparison and browser readback verified one $1 Parking row and only V19:Z19 changed. Claim/completion/replay SQL passed against disposable PostgreSQL before application through the authenticated database editor. No application code changes; manually inspect V19:Z19 and Checked item 3376 without replaying Log.

New references reserve column sets and expense period, so side-by-side categories do not collide while overlapping cells still cannot double-match. Legacy ambiguous expense aliases retain action-ID claims rather than guessing category ownership; ambiguous row-only reversion fails closed. Category/display layouts fix Grocery/Gas amount parsing. Discord/phone distinguish unchanged unavailable evidence from an actual changed review.

A fresh explicit expense Log may replace a completed import only after owner-scoped successful Undo/Delete evidence and absence of surviving imported descendants. The atomic owner/transaction claim retains the full prior operation in an event, issues a new operation ID and preserves bank/review eligibility/version guards. Recovery never writes; old forms, Reopen alone, unavailable history and uncertain/inflight writes cannot release claims. Added 45 regression cases, including real writer→Undo/Delete→reimport, concurrent submission, Discord/web response and SQLite/PostgreSQL reservation/replacement checks. Full PostgreSQL-enabled suite **2,497 passed / 25 optional frontend skips**, Pyright clean. [Verification #111](https://github.com/brianjames-dev/bookiebot/actions/runs/37821413108) on `1476a0b` passed **2,522 tests / zero skips** plus types, Apps Script, frontend build and asset checks. Historical imports, direct canonical correction Undo and manual device acceptance remain separate.

### Main integration — 2026-10-07

Merged the six verified expense-move, split responsiveness and shared reconciliation commits through `9370abb` into main at the user's request. [Verification #109](https://github.com/brianjames-dev/bookiebot/actions/runs/37658952466) passed **2,477 tests / zero skips** plus types, Apps Script, frontend build and asset checks. The merge changes release tracking only beyond that tested feature tree. Implementation is complete; confirm automatic main verification/rollout and perform STATUS manual checklists 130–132. No production financial test writes or extra application changes during integration.

### Verification #107 PostgreSQL follow-up — 2026-10-07

CI found ten import-claim failures: PostgreSQL cannot infer a parameter's type when it appears only in `IS NULL`, including supplied string values sent with unknown parameter types. SQLite accepted the query, so the previous local PostgreSQL skips missed this regression. Explicit `CAST(? AS TEXT)` on both nullable version guards preserves eligibility/optimistic checks without schema or workflow changes. Added four bank/review optional-version combinations across SQLite and real PostgreSQL 16; targeted storage contracts **130 passed / zero skips**. Full PostgreSQL-enabled suite **2,452 passed / 25 optional frontend skips**, Pyright clean. [Verification #108](https://github.com/brianjames-dev/bookiebot/actions/runs/37658383166) on `4d5d2ac` passed **2,477 tests / zero skips**, clean types, Apps Script, frontend build and asset checks. Existing manual checklist 132 applies; no production data changes.

### Shared Discord/phone reconciliation work log — 2026-10-07

Complete implementation; release acceptance pending (STATUS checklist 132). Phone decisions already checked versions, but Discord used stale closures, unguarded terminal Ignore/Confirm/Reopen, and two admin imports bypassed durable claims. Consolidated metadata decisions on the same compare-and-apply store path with prior-state/source events; explicit sheet amount correction runs after eligibility/version/claim checks while the owner/transaction locks exclude another review decision. Import forms include bank/review versions and active linked-account eligibility, with admin imports using the same durable service. Canonical amount updates preserve the bank-reconciliation origin instead of recursively reopening the review being confirmed. Cached inbox Ignore/Unmatch carries its original snapshots. Old controls explain current shared state; app conflicts retain Check status recovery. Fixed coded progress uses the original session total, filters membership before the query limit, clears externally resolved skips and leaves new arrivals for a new session. Added 57 passing regressions plus 16 optional PostgreSQL variants; full **2,107 passed / 362 skipped**, Pyright clean. No live financial writes or deployment. Broader historical-import and canonical correction Undo backlog remains separate.

### Split responsiveness work log — 2026-10-07

Complete in code/automated verification; release and Discord timing acceptance remain STATUS checklist 131. Production traces confirmed split callbacks blocked the event loop in reimbursement mirror metadata reads. Split/create/edit/cancel UI now uses immediate private thinking acknowledgments, worker-thread I/O with actor context, and completed error follow-ups. Typed/post-log explicit splits also run in workers. Source fields load in one range request, ledger lookup reuses its header snapshot, and projector/mirror share workbook/worksheet handles within a sync. Named anchors, current values and budget formulas remain freshly verified.

Recent-action mutations project only the selected allocation, retaining structural-move neighbor repair. Full Shared refresh/settlement/reset still retries the complete pending queue and metadata recovery. Same-expense workers serialize log/ledger writes under an in-process guard with bounded lock lifetime; different expenses remain independent until the existing projection lock. A saved split whose projection lock or Sheets transport fails reports saved/pending rather than inviting a duplicate; source/action/allocation/payment semantics remain unchanged. Split and sync duration logs enable deployed timing review.

Added 29 passing cases plus four optional PostgreSQL variants for acknowledgment ordering, blocked I/O responsiveness, owner context, failures, one source/ledger read, live anchors with reused handles, selected-work isolation and recovery. Full local **2,050 passed / 346 optional PostgreSQL/frontend skips**, Pyright clean. Existing move/settlement/reversal/reset Undo/Redo regressions pass. No production financial writes or deployment during implementation.

### Expense move compaction and reimbursement audit work log — 2026-10-07

Complete (user-reported Shopping gap): the canonical move intentionally cleared its source without compacting (September 16 decision). It now shifts that category's lower cells/anchors upward, with destination relocation and neighboring active/inactive action coordinates in one Sheets batch. Lost responses cannot repeat the structural edit. Ordinary native removal/restoration carries canonical anchors; move Undo compacts its destination; partial drafts are preserved. Neighbor database/mirror coordinates recover absolutely from anchors without changing financial versions or repeating a move.

Regression fixtures confirm Shopping → Needs retains the split/current recent action; a full $163.91 receipt for $464.72 T reduces the Needs source to $300.81, writes the partner receipt under Needs and mirrors Needs/reimbursed. Reversal and separate reset Undo/Redo preserve category/event history. Reversed receipts retain their categories/identities while anchors follow compaction. Added 20 cases; focused **386 passed / 184 optional PostgreSQL skipped**, full **2,021 passed / 342 optional skips**, Pyright clean. Direct canonical correction Undo remains deferred. No live inspection/repair/receipt; existing gaps are not automatically backfilled. Acceptance is checklist 130.

Authorized live follow-up complete: production T already pointed to Needs row 3 with income shares $300.81/$163.91, version/projected version 3/3 and no events. Privately backed up all affected sheet/history/anchor data, then compacted empty Shopping V15:Z15 once with atomic neighboring action-coordinate updates and a unique repair-name reservation. Mirror-tap/curtains now occupy rows 15/16; the fourth shifted record is an undone Parking import's redo position. All curtains anchors followed natively; its canonical source row and reimbursement mirror now say 16, retaining version/projected version 2/2. Historical T Shopping actions and move revision remain intact.

Exact live before/after checks preserve all other purchase values, neighboring formats/dropdowns, both budget formulas, T's allocation and all 18 payment events. Both live October Needs budget import chains verified. An isolated copy of the actual T allocation, canonical command path and saved sheet formulas passed full receipt, replay and reversal: $300.81 source in Needs and a $163.91 Hannah Needs reimbursement row. No live receipt was recorded. Prevention code is pushed on `codex/move-expense-compaction`; release/future-move acceptance and eventual real payment/device acceptance remain checklist 130. Operational snapshots/scripts stay private outside the repository; no new architecture decision or application-code change was needed.

### Utility command routing work log — 2026-10-05

Complete (user-reported bug): amount-first shorthand and Log/Record/Add with an optional expense/payment noun now use the deterministic bill grammar. `124.46 PG&E` and `Log expense 124.46 PG&E` previously fell into the read-only conversation; equivalent Recology and Water forms had the same gap. Existing dedicated bill writers, action metadata and automatic split prompts remain in use. No split preserves the full payment; explicit split directives retain their existing behavior. Questions, negation, plans, invalid amounts, multi-expense messages and bottled-water ambiguity stay guarded.

Added 57 routing/workflow/safety cases. Focused **341 passed**; full local **2,007 passed / 336 skipped** (optional PostgreSQL and unavailable frontend dependencies); Pyright clean. Tests use in-memory sheets and loopback HTTP fixtures, with no production financial writes. Release/manual acceptance: STATUS checklist 129. Split lifecycle backlog remains as previously scoped.

Release: PR #63 passed push/PR CI and merged into main as `b1f2284` on 2026-10-05 Pacific, triggering Railway deployment. CI passed all **2,343 tests** including PostgreSQL and executed frontend contracts, plus Pyright, Apps Script and frontend typecheck/build/asset parity. Deployment outcome is in the completion response; manual acceptance remains checklist 129.

### Mobile Shared history and navigation work log — 2026-10-03

Implemented the requested WebKit presentation slice: independent header glass controls, removed under-bar blur/gradient, 60px expanded navigation, immediate Reconcile tab with loading/retry until bank discovery resolves, and Category Mix selection without a square outline. Shared canonical and historical views offer collapsible newest-first months and explicit five-at-a-time month/expense loading; only the current Pacific month starts expanded. Full totals, settlement/offset/reset scopes and bank mutation guards remain unchanged. Full local suite **1,975 passed / 311 optional PostgreSQL skipped**, clean Pyright/frontend checks, and 12 production-build WebKit width/theme/motion cases passed. Inserted records cannot evict revealed rows/months or their drafts. Device acceptance is STATUS checklist 128.

### Shared balance reset work log — 2026-09-30

Complete (user-requested slice): reviewed all-month/all-year clearing in both directions, separate from repayments and spending. Durable reset groups/action audit, full-preview fingerprints, idempotency and guarded Undo/Redo preserve new debt and reject stale/pending state. Reset projections update the existing reimbursement mirror only, retaining actual receipts, columns/anchors and frozen historical expense sheets. Reports, Ask and Shared widgets distinguish cleared amounts. Source corrections and repayment reversals require undoing an affected reset; unrelated new pending work does not block a valid older group's undo.

Verification: **1,968 passed / 311 optional PostgreSQL skipped**, Pyright and frontend typecheck/build clean; executed UI contracts and 12 WebKit width/theme/motion reset/undo/redo cases passed. Manual acceptance: STATUS checklist 125 and `docs/REIMBURSEMENTS.md`. No live financial writes. General canonical source-correction Undo, historical net-accounting corrections and actual refunds remain separate backlog items; reset Undo/Redo is complete.

Release: PR #61 passed PostgreSQL CI and merged into main as `fedb100` on 2026-09-30 Pacific. Railway reports successful production deployment; public `/app/version` matches **4f6090f26bb0443df0885cc2**. Existing iOS apps can load Update or close/reopen. User device acceptance remains checklist 125; no actual balances were cleared during release verification.

Reimbursement compact receipts/accordion (2026-09-08): compact payer/split metadata and aligned amount rows, smaller headings with month pills, and one open receipt per month. Payer/budget distinctions and fronted semantics remain; all amounts, source reads and settlement behavior are unchanged. Focused reimbursement/motion 76 and full 1,116 tests passed / 61 optional PostgreSQL skipped, Python/frontend checks clean; WebKit passed six layouts and sixteen edge states with unchanged overview pixels. STATUS checklist 104 covers acceptance. No finance-operations backlog or mutation semantics changed.

Reimbursement receipt styling (2026-09-08): serif month headings and explicit Totals controls replace body-like bands and info icons. One expense title and distinct receipt metadata/financial/split groups improve the expanded view; the overview is pixel-identical to the prior build. Focused 69 and full 1,116 tests passed / 61 optional PostgreSQL skipped, Python/frontend checks clean, responsive WebKit passed six layouts and fourteen edge states. STATUS checklist 103 covers acceptance. No finance-operations backlog, settlement, persistence, source-read or mutation semantics changed.

Reimbursement presentation refinement (2026-09-08): a single stacked outstanding bar replaces independent month bars; one-line expenses sit under distinct month headings with on-demand selected-month totals. All existing month/receipt scopes and source reads remain unchanged. Focused 69 and full 1,116 tests passed / 61 optional PostgreSQL skipped, Pyright/frontend checks clean; WebKit passed six viewport/theme layouts, thirteen edge cases and two exact-amount samples. STATUS checklist 102 covers phone acceptance. No finance-operations backlog or mutation semantics changed.

Refresh/history recovery (2026-09-08): production Google Sheets read timeouts temporarily affected reports and unrelated reminders; live connectivity later recovered. Fixed sticky history coverage after successful refresh, safe typed timeout feedback and per-year source diagnostics. Available history and last successful reports stay visible; recovery is bounded to one catalog attempt per new successful report. Full 1,116 tests passed / 61 optional PostgreSQL skipped, Python/frontend checks clean, actual FreshExpenseApp WebKit recovery checks passed. No source retries/deadline increases, reconciliation, settlement, persistence or sheet mutation changes. STATUS checklist 101 covers acceptance.

Unified reimbursement ledger (2026-09-08): compact month-grouped expense/received rows replace separate outstanding and statement disclosures. The report exposes canonical received allocations from the already-read owner-scoped history so older settled expenses remain visible. Monthly receipts and all-month open totals keep their separate calculation scopes; no new sheet reads, settlement, persistence or reconciliation semantics. Full 1,099 tests passed / 61 optional PostgreSQL skipped, Pyright/frontend checks clean; responsive WebKit verified six viewport/theme layouts and twelve edge states. STATUS checklist 100 covers phone acceptance.

Reimbursement visual overview (2026-09-08): outstanding-by-expense-month chart and compact disclosures replace the initial long ledger/statement. All graph inputs are the same outstanding allocations as the headline; selected-expense-month receipts stay separate. Existing carry-forward, owner isolation, settlement and financial calculations remain. Cent/date/coverage/disclosure regressions, responsive WebKit QA and full 1,096-test verification pass; STATUS checklist 99 covers phone acceptance. No finance-operations backlog semantics changed.

Dashboard comparison presentation (2026-09-08): compact matched-day summary, animated calculation details with month-labeled exclusions, month-only selector labels, and masthead owner separator implemented. Current-month routing, comparison lifecycle, financial calculations and mutations are unchanged. Focused 41 passed; full suite 1,096 passed / 61 optional PostgreSQL skipped; Pyright/frontend checks clean. STATUS checklist 98 covers phone acceptance.

Dashboard theme polish (2026-09-07): fixed Safari menu taps being canceled by null-target blur, and the Daily Spending today-color cascade. Theme persistence and existing colors remain; actual WebKit/Chromium checks and focused regressions pass, full suite 1,096 passed / 61 optional PostgreSQL skipped. No finance, persistence or delivery behavior changed. STATUS checklist 97 covers phone acceptance.

Phone notification origin repair (2026-09-07): Enable/preferences were rejected before storage because same-origin fetches inherited the page no-referrer policy and sent Origin:null. Explicit same-origin request referrer policy preserves the real origin; strict server checks remain. Existing-subscription re-enable and durable preference reload regression added; no delivery, reconciliation or sheet mutations changed. STATUS checklist 96 covers phone acceptance.

Dashboard source-read reliability (2026-09-07): confirmed production Sheets per-user read quota exhaustion. Batched fresh report and comparison-year reads, bounded one-minute comparison-only reuse invalidated on refresh, safe quota feedback and actual HTTP-budget regressions are implemented. Reconciliation, settlement, sheet mutations and notification delivery are unchanged. Verification and device acceptance are tracked in STATUS checklist 95.

Dashboard roadmap completion (2026-09-07): all seven passes / ten approved enhancements implemented. Reimbursement carry-forward and cross-year receipt handling remain as pass 1; subsequent report reads/drilldowns/history/explanations preserve canonical financial behavior. Read-only questions expose no mutation tools. Opt-in phone alerts and personal goal allocations use durable phone storage, independent of bank reconciliation and sheet savings. Combined suite: 1,078 passed with real PostgreSQL; Pyright, frontend, Apps Script and dependency audit checks passed. Responsive synthetic acceptance completed; per-phone opt-in and personal goal entry are intentional user actions described in STATUS checklist 91.

Dashboard pass 1 (2026-09-07): complete owner-scoped reimbursement carry-forward across configured annual ledgers and cross-year receipt matching. New read-only history resolves lifecycle copies, flags incomplete coverage, and exposes current all-month outstanding independently of selected-month receipts. Settlement rechecks and updates the authoritative ledger row only. Full local suite 896 passed/22 optional Postgres skipped; focused tie-conflict/agent checks and frontend checks passed. Checklist 90 covers deployed acceptance; all later approved roadmap passes are now complete.

Phone UI polish (2026-09-07): compact header/settings menu, retained refresh/error semantics, stable modal closing and synchronized chart resizing, shared calendar category colors, current Pacific day highlight, and chart-colored reimbursement surface are implemented. No financial mutation or reconciliation changes. Targeted suite 73 passed; full suite 846 passed/22 optional database cases skipped; Pyright and frontend checks passed. Responsive synthetic browser acceptance passed; deployed iPhone visual acceptance is STATUS checklist 89. Prior live phone deployment/setup was confirmed.

Phone-app milestone (2026-09-06): implemented stable authenticated Home Screen access, private per-person Discord pairing, durable 180-day revocable sessions, fresh current-month reads, and installed-app reconnection. Existing avatar assets provide installation branding and daily in-app rotation. No financial mutation/reconciliation changes. Verification: 863 tests passed including real Postgres (one existing Kaleido warning), clean Pyright, frontend typecheck/build, and synthetic browser pairing/refresh/stale/signout/reconnect acceptance. Deployed phone acceptance remains STATUS checklist 88 and docs/PHONE_APP_SETUP.md.

Make BookieBot's finance operations reliable, auditable, and easy to reason about. This includes bank reconciliation, transaction inbox behavior, event logging, and the recent transactions flow for update, move, delete, and undo.

## Priority Source

Fixed-loan activation follow-up (2026-09-09): user-approved J-column configuration is now saved as $59.96 monthly on day12; September’s $119.92 actual and Template zero were verified unchanged. Fixed-cost presentation and exact-cent report/widget/intent tests are complete, with Wants-only Burn Rate preserved. Full local 1,718 passed / 213 optional PostgreSQL skipped; Python/frontend/Apps Script and production WebKit checks passed. Earlier activation approval block is resolved. Remaining separate shared-total, Template-import and annual-master findings are documented in the student-loan audit; no bank/reconciliation or repayment mutations were added.

Standalone student-loan work log (2026-09-09): completed explicit owner-scoped current-month payment/status commands with unique source validation and stable named write targets. Exact source metadata guards their later recent-action edits/undo; matching subscriptions prevent duplicate estimates/reminders and standalone writes. Full local **1,698 passed / 213 optional PostgreSQL skipped**, Pyright/frontend typecheck and Apps Script checks passed. Existing subscription-only loans and bank/reconciliation behavior remain unchanged. Sheet configuration activation is pending approval; source audit and manual steps are in `docs/STUDENT_LOAN_INTEGRATION.md`. This does not close the deferred general recent-action persistence or canonical reimbursement correction backlog.

Current task priority lives in `.agent/STATUS.md`. This file is the centralized backlog and reference for the full finance operations workstream.

Task execution and documentation update rules live in `.Agents`.

## Recent Transactions - Likely Problems To Fix

1. Updated expenses may no longer be movable because `move_recent_action` currently only allows metadata type `expense`, while an updated visible action has type `update`.
2. Moved expenses may not be movable again because the latest visible action has type `move`, not `expense`.
3. Deleting an updated action is risky because delete accepts `update` actions and compacts the current row, but the original source action may remain active or stale.
4. Deleting a moved action can leave source/destination lineage difficult to reason about unless the canonical sheet row is resolved first.
5. The UI does not expose date updates, and user-entered date updates are now rejected. Fixed 2026-06-20; reconciliation-origin automation may still set dates from bank transaction dates.
6. Pending selections live only in process memory, so deploys, restarts, or long pauses lose context.
7. Component views time out after 120 seconds while pending text state may still exist. Fixed 2026-06-18.
8. Income, Need expenses, payments, and savings appear in recent actions but have inconsistent edit/move/delete capabilities. Fixed for new shared-sheet Need expenses as of 2026-07-16; historical personal-budget Need action records remain legacy-only.
9. Match-text search only checks the latest 10 recent actions, so targeted commands can miss older actions.
10. Reconciled actions can be updated, moved, deleted, or undone without updating/reopening reconciliation state. Fixed first pass 2026-06-20 by reopening linked reconciliation items.

## Recent Transactions - What Currently Works

- Listing recent actions and paging with `show more`.
- Selecting actions by index, match text, or action ID.
- Updating configured fields for normal expense rows.
- Deleting normal expense rows with category compaction.
- Moving normal expense rows between configured categories.
- Undoing update, delete, and move in covered happy paths.
- Updating payments and savings amount-only through existing field capability logic.

## Recent Transactions - Target Invariants

- Every user-visible recent action should expose explicit capabilities: `can_update`, `can_move`, `can_delete`, `can_undo`, and `editable_fields`.
- Update/move/delete should operate on a canonical action lineage, not only the latest raw action type.
- A lineage should have one current sheet location when it represents a sheet row.
- Deleting should resolve the canonical current row before compacting.
- Moving should work for an expense lineage even after prior updates or moves.
- Updating should work for an expense lineage even after prior moves.
- Unsupported operations should return a clear reason.
- Pending selections should expire predictably and should not survive as misleading stale state.
- Reconciled action mutation should update or reopen the related reconciliation item.

## Recent Transactions - Implementation Slices

### Slice A - Capabilities And Canonical Lineage

- Add helper functions to resolve a `LoggedAction` to canonical lineage state.
- Add operation capability helpers for update, move, delete, and undo.
- Update recent-action UI to show only valid controls or return clear reasons.
- Add tests for capabilities across expense, update, move, income, Need expense, payment, and savings actions.

Status: Partially complete. Active lineage IDs are now used for delete/undo, and move uses full current category rows instead of only the latest action's changed columns. Explicit user-facing capability helpers still need to be added.

Update 2026-06-18: Explicit capability helpers now exist for update, move, delete, undo, and editable fields. The recent-action decision UI only shows supported controls for the selected transaction, and unsupported direct commands return clearer reasons. Canonical lineage helpers still need to be expanded beyond the targeted move/delete fixes already completed.

### Slice B - Move Updated And Moved Expenses

- Allow moving an expense lineage whose latest visible action is `update` or `move`.
- Resolve source category, current row, current values, and current category from lineage state.
- Add tests for moving an updated expense and moving an already moved expense.

Status: Complete for normal expense lineages as of 2026-06-18.

### Slice C - Safe Delete For Updated And Moved Expenses

- Make delete resolve canonical current row before compaction.
- Ensure original/source actions do not remain active in a misleading way after deleting an updated/moved lineage.
- Add tests for deleting updated expense and deleting moved expense.

Status: Complete for active recent-action lineages as of 2026-06-18.

## Recent Transactions - Completed Work Log

### 2026-06-18

- `move_recent_action` now accepts current expense lineages represented by `expense`, `update`, or `move` action records.
- Moving uses the full current sheet row for the source category, which fixes updated actions whose `action.columns` only contain the edited fields.
- Delete compaction now marks every active action in the selected lineage as undone, preventing deleted updated expenses from reappearing through their original action.
- Delete undo now reactivates all action IDs recorded for that deleted lineage.
- Added regression tests for moving updated expenses, moving already moved expenses, deleting updated expenses, and deleting moved expenses.
- Added explicit recent-action capabilities and wired the selected-transaction controls to hide unsupported operations.
- Added clearer unsupported-operation reasons for Need expenses, payments, savings, and other unsupported cases.
- Income rows can now be updated for source/amount and deleted from recent transactions.
- Added regression tests for expense capabilities, unsupported action capabilities, button visibility, income update, and income deletion.
- Added TTL-backed pending state for recent-action selections, update-field prompts, and move-item prompts.
- Expired pending replies now clear state and return a clear expired-selection message instead of falling through to intent routing or current recent-action indexes.
- Added regression tests for expired delete selections, update-field prompts, move-item prompts, and router numeric replies.
- Recent-action lists, candidate prompts, mutation prompts, and mutation results now send privately to the requesting user when Discord DMs are available.
- Recent-action component responses are ephemeral, and controls reject users other than the original actor.
- Added regression tests for private recent-action delivery and non-owner interaction rejection.
- DM replies to recent-action update prompts now route through pending update-field handling even when the bot is restricted to the configured public channel.
- Recent-action component view timeouts now match the 300-second pending-state TTL.
- Added regression tests for DM update-field replies and five-minute component view timeouts.
- Reconciliation digest channel messages now show a generic unresolved-item count instead of transaction details; detailed review remains ephemeral after `Reconcile Now`.
- Daily reconciliation digest eligibility is now bounded to the configured morning send window, preventing newly synced Plaid items from causing a normal daily digest later in the day.
- Added regression tests for the public digest prompt, morning send window, and after-window Plaid/new-item no-send behavior.
- Reconciliation digests now send by DM with `Reconcile Now` and `View Inbox` controls.
- `Ignore All` moved from individual reconciliation transaction cards to the inbox list view only.
- Bills and subscriptions digests now send by DM instead of posting cash-pull details in the shared channel.

Manual verification steps are tracked in `.agent/STATUS.md`.

### 2026-06-20

- User-entered date updates are hidden/rejected in recent-action update handling; date mutation is reserved for reconciliation-origin automation that can use the bank transaction's reported date.
- Recent-action update, move, delete, and undo now attempt to reopen linked reconciliation items by action-log ID.
- Store-level reconciliation reopening can find grouped matched action IDs such as `action-a+action-b`.
- Normal unresolved reconciliation views now apply a default 60-day transaction age cutoff through `BOOKIEBOT_RECONCILIATION_MAX_AGE_DAYS`.
- Added regression coverage for user date rejection, recent-action reconciliation sync hooks, grouped matched-action reopening, and max-age filtering.

Manual verification steps are tracked in `.agent/STATUS.md`.

### 2026-07-08

- Forced reconciliation inbox views now include recent persisted `matched` reconciliation items when the fresh preview no longer contains the automatic matches from the original digest.
- Auto-match-only inbox reports send the confirmed-match detail without unresolved action buttons, while unresolved inboxes still include `Reconcile Now` and `Ignore All`.
- Added regression coverage for the forced inbox auto-match report path.

### 2026-07-16

- Routed `log_need_expense` through the normal shared-expense writer into the monthly Needs section instead of inserting individual rows into a personal budget sheet.
- Need rows now record date, item, amount, location, and person and use normal expense action metadata/lineage.
- Added Needs to text and button move destinations plus the bank reconciliation expense-category selector.
- Verified shared Needs rows can be updated, moved out, moved back, deleted with category compaction, and restored with undo.
- Extended category totals, highest-category, largest-expense, and top-expense queries so Needs participates like the other shared categories.
- Preserved support for legacy `description` entities by translating them to the new item field at the intent boundary.
- Made the optional Discord typing indicator fail open: transient `send_typing` entry or cleanup failures are logged as warnings and no longer abort intent parsing or a completed request.
- Added message-router regression tests proving typing-entry failures do not block processing and genuine request exceptions still propagate through the wrapper.

Manual verification steps are tracked in `.agent/STATUS.md`.

### Slice D - Pending State Hardening

- Add TTLs for pending update/delete/move selections.
- Clear stale pending state before routing numeric replies.
- Return a clear "selection expired" message.
- Add tests for stale pending selection behavior.

Status: Complete for in-process pending state as of 2026-06-18. Pending selections, update-field prompts, and move-item prompts now expire after 300 seconds and produce a clear expired-selection response.

### Slice E - UI And Field Coverage

- Decide whether date should be editable through UI.
- If date stays supported, add a date button and validation.
- If date is not supported, remove it from parser guidance and handler copy.
- Make category-specific missing fields clear, especially grocery/gas versus food/shopping.

Status: Date decision complete as of 2026-06-20. User-entered date updates are not exposed and are rejected if parsed. Reconciliation-origin code can still provide a date automatically from the bank transaction. Category-specific move prompts now explain when a destination category requires an item name.

### Slice F - Reconciliation Link Synchronization

- When a reconciled action lineage is updated, moved, deleted, or undone, update or reopen the reconciliation item.
- Prefer stable action IDs over sheet row refs where possible.
- Add tests for reconciled row update, move, delete, and undo.

Status: Complete first pass as of 2026-06-20. Recent-action update, move, delete, and undo reopen linked reconciliation items by matched action-log ID, including grouped IDs. Future refinement can decide whether some unchanged moves should stay confirmed instead of reopening.

## Shared Expense Responsibility And Reimbursements

### 2026-09-08 Approved Confirmed-Repayment Ledger — Implemented And Migrated

The user approved payer/ownership hardening, fail-closed mutation guards, canonical storage and repairs. They chose retaining gross under the original payer until confirmed repayment; each partial receipt amends that source and records the debtor's linked expense. Both directions and reviewed equal offsets are in scope. This supersedes the older target invariants below for migrated/new canonical allocations. Paid legacy history remains read-only until a separately reviewed correction/import can establish counterpart history safely.

Implementation adds durable household transactions, idempotency/version checks, pending sender reports/recipient confirmation, partial/full receipt events, atomic offset/reversal groups, ID-anchored recoverable sheet projection, phone actions and a plan-first migration. Full local verification passed 1,617 tests including PostgreSQL, with clean Pyright/frontend/Apps Script checks and responsive WebKit lifecycle acceptance. Main CI passed; production migration registered seven reviewed records, verified all expense/ledger projections, corrected the approved payer/name incident and preserved two received records and void history. An independent source/mirror/both-owner readback passed; no synthetic payments were written. Final phone activation/acceptance is tracked in STATUS checklist 109 and the completion response; `docs/REIMBURSEMENTS.md` records operator and phone acceptance steps.

### 2026-09-08 Read-Only Integrity Audit — Remediation Above

- Confirmed production payer misattribution: a partner name inside an item can populate `person`, which the ordinary split path trusts over the authenticated actor. The resulting logical ledger owner can disagree with the payer workbook; current report ownership filtering then excludes that record. Separate actor, payer/account and beneficiary; validate storage ownership before writing. Preserve a linked audit correction rather than patching one visible cell.
- Reproduced P1 in memory: a reimbursement read failure becomes `[]`; paid-split undo treats the missing allocation as permission, then a later successful update voids the paid allocation and restores gross. Missing/unavailable settlement state must prohibit mutation (`collaboration.list_allocations`, `undo._apply_undo_action`).
- Reproduced concurrent row-race risk in memory: insertion after receipt's final ID check but before numeric-row update can settle another allocation. Review serialization, canonical storage, protected sheet projections and recovery; do not assume a reread is compare-and-swap.
- Design gaps: ordinary splits create only the payer's net expense, no partner expense; receipt commands settle the full share with no amount; paid corrections/partial events and full mutation lifecycle remain pending. The proposed model preserves original gross, both owners' expense shares and receipt cash flows separately. Income weights are fixed constants and should be explicit/snapshotted if made configurable.
- Verification: 85 existing collaboration/settlement/undo/reconciliation tests passed, plus two isolated fault reproductions. No live writes or app logic changes. Detailed incident evidence remains in the user's local report rather than checked into repository history. Remediation and the accounting model require a subsequent implementation pass.

### Legacy Target Invariants (Superseded For Canonical Allocations)

- The original bank-clearing amount remains immutable in the source action lineage and available for reconciliation.
- The visible expense amount/person represent the budget owner responsible for that spending: the payer's share for ordinary splits, or the partner's full amount for a fronted 0/100 allocation.
- Partner responsibility is a reimbursement receivable, not income and not negative spending.
- Settlement changes the reimbursement state only; it does not change the personal expense after the split is applied.
- Every split links the source action, current sheet row, gross amount, method, both shares, and settlement state in the visible `Shared Reimbursements` worksheet.
- `No split` cancels only the split workflow and leaves the already logged full expense intact.

### Slice G - Initial Split And Settlement Workflow

Status: Complete in code and automated/browser verification as of 2026-08-03; production confirmation remains in `.agent/STATUS.md` checklist item 74.

2026-10-05 follow-up complete: repaired utility shorthand/expense routing into the existing bill writers and split prompts; exact PG&E incident and Recology/Water equivalents have in-memory end-to-end coverage. Release acceptance is STATUS checklist 129.

- Added income-weighted splitting from Brian `$156,000` and Hannah `$85,000` annual incomes, plus 50/50 splitting with penny-safe allocation.
- Added the post-log split prompt and explicit command directives. Grocery, Rent, PG&E, Water, Recology, and Gameday prompt automatically; internet is deliberately excluded.
- Added `Split` to applicable expense/payment recent-action workflows and kept already-split actions from being split again.
- Net the visible expense row to the payer's share while retaining the original gross in source action metadata for bank matching.
- Store reimbursement receivables in `Shared Reimbursements`, support outstanding-balance queries and received-state updates, and audit settlement without logging income.
- Added a responsive Shared Reimbursements web-report card and itemization. Primary expense charts continue to consume only the visible personal share.

### Slice H - Split Lifecycle Completion

2026-10-02 personal-bill follow-up complete: confirmed repayments for split Rent, PG&E, Recology and Water target the partner's exact bill row in the original expense month, with cumulative named-range replay and reversal guards. The payer source and generated ledger remain part of the same pending projection. PR #62 passed CI, merged to main and deployed on Railway. The saved October rent receipt was replayed once: production allocation version/projected version read 3/3, Brian/Hannah October Rent read $2,103.73/$1,146.27, and Brian reimbursement row 19 read `reimbursed` with $1,146.27 received. Native iOS display acceptance remains STATUS checklist 126.

Status: Canonical recent-action corrections completed 2026-09-16: gross/details, method, category move, cancellation/re-split and deletion use durable revisions and verified source projections. Pending/confirmed repayments require resolution/reversal first. Historical net-accounting corrections and direct canonical Undo remain deferred.

2026-10-07 move follow-up complete: atomic source compaction and neighboring active/inactive history repair; absolute row/mirror recovery; verified Needs reimbursement/reversal and reset Undo/Redo. Ordinary move Undo closes its destination gap. Canonical deletion compaction and direct correction Undo remain separate follow-ups; this move audit does not expand them.

1. Complete 2026-08-03: change the split method and recalculate both shares without losing the original gross or settlement history.
2. Complete 2026-08-03: remove an outstanding split by restoring the gross visible expense and voiding the receivable.
3. Complete 2026-09-16: correct gross and transaction details while retaining the method and recalculating both shares.
4. Complete 2026-09-08: partial/full confirmed receipts, pending sender reports and equal reviewed offsets maintain both owners' balances with durable replay and expense projections.
5. Partial 2026-09-08: reviewed payment reversals (whole-group for offsets) restore both expense projections. Removing a paid split or recording an actual refund remains a separate linked correction workflow.
6. Partial 2026-09-16: canonical update/move/delete, method/cancel and re-split are ledger-aware with source anchors and reconciliation lineage synchronization. Direct canonical Undo remains blocked; explicit correction actions and payment reversals preserve audit history.
7. Partial 2026-09-08: allocation/payment events and request recovery are durable across deploys. Pre-registration Discord split selections still use the existing short-lived interaction lifecycle.

### 2026-09-16 Work Log - Restore Split Expense Actions

Fixed the Cancel-only recent menu for canonical split expenses. Split now opens allocation edits/cancellation; Update keeps amount/location/item/account fields. Added versioned database correction audit, payment/version/ownership guards, retryable named-range source changes, atomic category relocation and void/deleted lifecycle handling. Recent and bank reads overlay current details without rewriting original logs; ancestor matches reopen and deleted purchases stop matching. Fully reversed receipts retain old category/labels. Fixed bill labels remain exact. Focused UI, ledger, source-fault and lineage regressions cover these paths; final counts are in STATUS. Manual checklist 124 and `docs/REIMBURSEMENTS.md` cover isolated acceptance. Remaining scope: direct canonical correction Undo, historical net-accounting edits and actual refund workflows.

### Slice I - Fronted Shared Expenses

Status: Complete in code and automated verification as of 2026-08-11; production confirmation remains in `.agent/STATUS.md` checklist item 78.

- Added canonical `fronted` allocation state and the `Fronted` control as a 0/100 allocation for shared expense rows only.
- Preserve the payer and gross source action for reconciliation while moving the visible full expense to the partner's Person bucket.
- Extend the reimbursement ledger with responsible owner, original person, and responsible person fields through an append-only migration of existing ledgers.
- Support fronted-at-log-time language, Recent Transactions application, method changes, undo/cancel restoration, and reimbursement queries in both owed-to-me and owed-by-me directions.
- Keep personal budget payment cells out of fronted mode until cross-workbook Rent/utility attribution has an explicit design.

### 2026-08-11 Work Log

- Implemented Slice I with ledger migration, Discord UI/parser/router support, person-aware split lineage, report payload detail, and focused regression coverage.
- Confirmed Brian-side fronted spending becomes Hannah-side shared expense activity without changing the source action's bank-clearing gross.
- Confirmed fronted method changes, undo, and cancellation keep the current row and reimbursement ledger synchronized; paid allocations retain the existing protected lifecycle.
- Migrated the sole live pre-cleanup `$11.99` allocation from the discarded development value `covered` to canonical `fronted`; verified its linked Hannah expense, Brian owed-to-me lookup, and August Expense Breakdown entry. This was a one-time data correction, not a compatibility alias.

### 2026-08-03 Work Log

- Added split-specific Recent Transactions controls for method changes and cancellation across normal expenses and bill/payment cells.
- Recorded method changes as reversible split-lineage children, retained gross source actions for bank matching, and kept ledger/current-sheet changes synchronized with rollback on persistence failures.
- Added confirmed outstanding-split cancellation with gross restoration, reimbursement voiding, a system audit event, and safe re-splitting. Received reimbursements remain protected pending the explicit paid-settlement workflow.
- Implemented Slice G with focused calculation, ledger, recent-action, router, handler, report, and undo regression coverage.
- Confirmed source action amounts remain gross while split leaf actions and the reimbursement ledger carry the personal allocation state.
- Verified the report at desktop and mobile widths and recorded the remaining lifecycle work in Slice H.

## Bank Reconciliation - Known Problems

2026-09-10 reliability/web pass: matching now requires exact cents, meaningful name evidence and an unambiguous candidate; common bill aliases and occurrence-scoped references replace fragile recurring matches. Pending authorizations are visible read-only, duplicate pending/posting records collapse, and protected review/import lineage survives force rescoring. Owner-scoped phone review uses existing stores and matching without sheet imports or amount adjustments. Full verification/release is tracked in STATUS; `docs/RECONCILIATION.md` documents the scope and acceptance checks.

1. Reconciliation reminders do not always send at the expected time.
2. Snoozed reminders and daily digests use different lifecycle behavior.
3. The transaction inbox can surface very old unresolved bank transactions.
4. Event logging exists only as sheet-backed system-state entries, which is weak for debugging and auditing.
5. Reconciliation item statuses do not clearly separate new, presented, auto-matched, confirmed, ignored, stale, and failed states.
6. Confirming a reconciliation candidate updates the sheet amount to the bank amount when the user intentionally selects that row as the match. This is intended behavior.
7. Updating, moving, or deleting a recent action can leave reconciliation references stale unless explicitly coordinated.
8. Reconciliation behavior is spread across several modules, which makes lifecycle guarantees harder to reason about.

## Bank Reconciliation - Target Invariants

- Normal actionable reconciliation only shows eligible, fresh, posted, watched transactions. Phone Pending may show fresh watched authorizations read-only until posted.
- Historical transactions require an explicit debug/admin/historical review mode.
- A digest is sent once per actor per day unless explicitly forced by an admin/debug path.
- Normal daily digest sends only during the configured morning send window.
- Every meaningful reconciliation state transition is event logged.
- Matching a bank transaction to a sheet row does not silently rewrite the sheet unless the user selected that action.
- If a matched sheet action is updated, moved, deleted, or undone, the reconciliation linkage is updated or reopened.
- Reconciliation UI should present one clear next action at a time.

## Bank Reconciliation - Implementation Slices

### Slice 1 - Inbox Freshness And Stale Handling

- Add owner-level default freshness policy, likely `BOOKIEBOT_RECONCILIATION_MAX_AGE_DAYS`.
- Add query filters so normal unresolved inbox excludes transactions before the cutoff.
- Add a `stale` or `hidden_stale` reconciliation state, or a computed exclusion with explicit debug visibility.
- Add tests proving old transactions do not appear in normal digest/session flows.

Status: Complete first pass as of 2026-06-20. Normal unresolved views use a 60-day max age cutoff by default. Old records are hidden from normal review but are not yet marked with an explicit stale status.

### Slice 2 - Digest Lifecycle

2026-10-14 Sheet-detail follow-up: CI-verified and deployed through PR #65; bounded optional source enrichment and persisted-reference fallback restore useful match comparisons. Manual device acceptance is STATUS checklist 138; the user's screenshot confirms prior report delivery. Durable digest claim work remains separate.

2026-10-14: completed, CI-verified and deployed the View Inbox multi-page delivery repair through PR #64. Manual existing-digest acceptance is STATUS checklist 137. Durable claimed/sent/failed lifecycle remains separate and pending.

- Introduce an explicit digest lifecycle: `claimed`, `sent`, `failed`.
- Ensure daily sends use consistent event semantics.
- Keep public digest prompts generic and route transaction detail into actor-scoped ephemeral review.
- Add tests for duplicate prevention, send failure, and morning-window enforcement.

### Slice 3 - Structured Event Logging

- Add durable event APIs with typed event names and JSON payloads.
- Log sync, preview, inbox item creation, digest, prompt start, skip, ignore, confirm, reopen, amount mismatch, sheet update, move, delete, and undo events.
- Keep `record_system_event` only for legacy dedupe until replaced.
- Add debug command support to inspect recent reconciliation events.

### Slice 4 - Reconciliation State Machine

2026-10-08: category identity, unchanged-conflict feedback and completed expense-import replacement after verified removal are implemented using existing claim/event tables, with no schema migration. Fresh explicit review authority is required. STATUS checklist 133 tracks release acceptance.

2026-10-07: shared phone/Discord transition checks and lifecycle events are complete for manual confirm/ignore/reopen; stale controls, batch inbox actions, explicit amount correction races and import eligibility now use reviewed versions. Fixed session progress and cross-medium acceptance remain queued for release in STATUS checklist 132. No new persisted statuses or storage schema.

- Define allowed statuses and transitions in one place.
- Make store methods enforce transitions instead of ad hoc status updates.
- Add timestamps for `presented_at`, `last_prompted_at`, `resolved_at`, `ignored_at`, and `stale_at`.
- Add tests for invalid transitions and idempotent confirmations.

2026-09-10: implemented atomic version-checked phone confirm/ignore/reopen with transition, active-account, pending, import, ownership and duplicate-evidence guards plus durable prior-state events. Force preview preserves terminal/import lineage; removed transactions release claims, hidden accounts retain them. Existing lifecycle mechanisms are reused; this does not introduce new global statuses or a new sheet mutation engine.

### Slice 5 - Safer Match Confirmation

- Treat the user's match selection as explicit confirmation that the selected sheet row represents the bank transaction.
- If the selected row amount differs, update the sheet/action amount to the bank transaction amount after that confirmation.
- Keep grouped matches strict by default, but allow an explicit selected-row adjustment to make the grouped total match the bank transaction.
- Log whichever path the user chooses if structured event logging is added later.
- Add tests for mismatch flows.

Status: Complete first pass as of 2026-06-20. Existing-row match confirmation updates the sheet/action amount to the bank amount after the user selects the row as the match. Grouped matches still reject total mismatches by default, and now provide a button-based row adjustment path plus an internal `adjust_action_id` tool path to update one selected row and confirm the group.

### 2026-06-20 Reliability Follow-Up

- One-word `recent` now routes directly to recent actions before LLM parsing, preventing misclassification into unrelated logging flows.
- Expense sheet access during logging now retries once before returning a user-facing sheet access failure.
- Large recent-action DM lists now split on complete transaction blocks, keep Markdown code fences balanced, attach controls to the final DM, and acknowledge successful private delivery in the public channel.

### Slice 6 - Simplify Module Boundaries

- Keep matching/scoring in a reconciliation engine module.
- Keep lifecycle persistence and events in a store/service layer.
- Keep Discord UI/session flow in core workflow modules.
- Avoid sheet mutation logic inside reconciliation matching code.

### 2026-07-16 Shifted Dated Income Layout Follow-Up

Status: Complete. Live May-July migration and report verification finished; Income mutation lifecycle coverage now includes anchored configuration and formula preservation.

- Shifted the Brian Budget 2026 Template Income table to `B:D` with Date, Source, and Amount while preserving the biweekly-income configuration in `E:F`.
- Repaired the Template monthly-income total and budget-banner formula lineage for the shifted Amount column.
- Income writes now discover visible headers and support both the legacy Employer/Amount layout and the new Date/Source/Amount layout.
- BookieBot/API writes stamp a Pacific date directly because Google Sheets API writes do not fire `onEdit`; bank-origin income uses the bank transaction date when available.
- The global Apps Script now installs personal-budget edit triggers and stamps an empty Income date when a user manually enters an amount.
- Migrated Brian and Hannah May, June, and July plus Hannah's Template to the canonical `B:D` layout while preserving existing Income source/amount rows and month totals.
- Backfilled dates only from reliable BookieBot action-log timestamps, preserved Brian July's xAI configuration, and migrated Income action-log column metadata and matching row references.
- Expense report parsing now anchors to the visible Date/Source/Amount headers rather than row contents, so adjacent biweekly configuration labels cannot hide valid income rows.
- Updated Income actions remain deletable; deletion compacts the sheet and related action-row references, while undo reinserts the row and restores the affected lineage.
- Live report check: Brian July returned xAI `$3,774.59` on `7/2/2026` and internet stipend `$150.00` on `7/15/2026`; Hannah July returned Sonic paycheck `$1,619.47` on `7/10/2026`.
- Reduced the live Brian Template to one Income seed row and preserved its visible style, validation, notes, Monthly Income formula, and budget formula lineage.
- Reduced the live Hannah Template to the same one-seed layout, standardized the seed label to `<Enter Source>`, and preserved the biweekly configuration plus shifted formula lineage.
- BookieBot now replaces the Template seed row instead of inserting ahead of it, then inserts later rows only when another Income event is logged and repairs the summary range without retaining a trailing placeholder.
- BookieBot explicitly reapplies the seed row's cell format, validation, notes, borders, and row height because the Sheets API's inherited-row insertion omits some of those properties.
- Whole-row Income deletion now snapshots the affected `B:F` properties and preserves the first Income row's anchored biweekly configuration instead of shifting or deleting it with the transaction.
- Income delete undo clears the temporarily preserved anchor before reinsertion, restores the deleted row's explicit formatting/validation/notes/height, and rebuilds Monthly Income from the discovered header and summary coordinates.
- Manual Source/Amount edits use Apps Script for date stamping and summary-formula repair without appending a placeholder, regardless of whether Source or Amount is entered first.
- Live Hannah verification: a temporary Template copy accepted two sequential dated BookieBot Income entries with matching row properties, totaled `$191.34`, and was deleted after the check.
- Live Brian July verification: temporary-copy first-row delete/undo, later-row delete/undo, and immediate undo all preserved the `E:F` biweekly configuration, kept summary totals/formulas correct, restored baseline values/formulas, and left no QA tabs behind.
- Manual test: deploy the script and run `setupBudgetSystemAutomation()`, enter a manual Income amount, then log, update, delete, and undo a BookieBot income entry on month tabs copied from both Templates.

### 2026-07-17 Income Source And Just-In-Time Row Follow-Up

Status: Complete. The duplicate Source and extra trailing placeholder reported from Brian July are fixed in code and on the live sheet.

- Income Source and label values are whitespace-normalized and overlapping values are collapsed, so `source=xAI` plus `label=xAI` writes `xAI` once while distinct details remain available.
- A Template retains one initial seed row; the first Income event restores that row's undo state, and subsequent events insert copied/formatted rows immediately above Monthly Income only when needed.
- Apps Script keeps automatic date stamping and summary repair but no longer appends a blank placeholder after a completed manual entry.
- Brian July's live Source was corrected from `xAI xAI` to `xAI`, the extra placeholder was removed, and PDF/API verification confirmed `$7,698.22` Monthly Income plus intact Budget and biweekly configuration formulas.
- Manual test: after deploying the Apps Script and bot revision, log another Income event whose parser repeats Source and label; confirm a single Source value, one newly inserted formatted transaction row, no trailing placeholder, and a correct Monthly Income total.

### 2026-07-17 Actual-Date Biweekly Projection Follow-Up

Status: Complete. Current-month report projections now account for paychecks that arrive slightly early or late.

- The configured Biweekly Income Start remains the bootstrap schedule before a dated paycheck is available.
- Once the configured Income source has a dated paycheck, future calendar projections advance in 14-day increments from the latest actual date instead of leaving an obsolete configured occurrence in the past.
- Projected Income now adds only the remaining future occurrences to the current logged total, avoiding both stale projection days and dropped month-end paychecks.
- Live Brian July verification produced actual xAI events on July 2 and July 17 plus a projected `$3,774.11` paycheck on July 31; the projected monthly total is `$11,472.33`.
- Manual test: log a configured paycheck one to two days early or late, open the current expense breakdown, and confirm the next projected paycheck is exactly fourteen days after the actual event with no stale projection left behind.

### 2026-07-17 Chart Tooltip Anchor Follow-Up

Status: Complete after lifecycle correction. Report tooltips no longer animate from the chart origin after briefly losing hover, and their five-second hold/fade behavior remains intact.

- The shared chart tooltip content caches the last active payload and overrides Recharts' immediate inactive visibility only until the five-second hold plus 180 ms fade completes.
- The wrapper records its last non-empty Recharts transform and restores it whenever the inactive render clears that transform.
- Transform transitions are disabled for the unpositioned wrapper and enabled only after the first real anchor is painted, eliminating the initial `(0, 0)` flight.
- Point-to-point transitions remain enabled after that first anchor, so sequential hover and non-sequential re-entry both move smoothly from the prior position.
- Rebuilt the embedded JavaScript asset and added a report regression assertion for the transform-retention hook.
- Local browser verification covered initial hover, adjacent movement, empty-space re-entry, the five-second visible hold, fade phase, and final hide.
- Manual test: move between non-adjacent bars, slices, and line points while briefly crossing empty chart space; confirm no top-left fly-in, no janky re-entry, and a smooth fade after about five seconds.

### 2026-07-17 Carousel Tooltip Dismissal Follow-Up

Status: Complete. Changing the top-chart carousel or any chart data-view toggle now dismisses the previous tooltip without leaking cached data into the next view.

- Every chart or data-view switch publishes a shared dismissal revision before changing its visible dataset and cancels the active tooltip's normal five-second hold timer.
- A visible tooltip uses the existing 180 ms fade-out instead of being hidden abruptly by the carousel cooldown.
- Cached payloads stay suppressed after the transition until a deliberate mouse move or pointer press occurs inside the selected chart, preventing arbitrary new-graph data from occupying the old tooltip position.
- The regular five-second tooltip lifecycle and fresh-hover behavior remain unchanged after that interaction gate is released.
- The dismissal provider now spans the full report, covering Projected mode, Category Mix, Calendar, Daily Spending, and Expense Highlights selectors in addition to carousel navigation.
- Regression markers cover every toggle trigger plus the switch/fade hooks in generated report HTML; focused and full report tests, Pyright, frontend typecheck/build, and local browser switching checks pass.
- Manual test: show a tooltip, change the current chart with either a carousel control or an in-card data toggle, confirm the old tooltip fades away with no replacement, then hover or tap the new view and confirm its correct tooltip appears.

### 2026-07-17 Selective Calendar Filter Transition Follow-Up

Status: Complete. Switching the report Calendar between All and Subs no longer remounts or reanimates the full calendar panel.

- Removed the filter-keyed panel boundary so the month heading, Current/Projected label, weekday header, day cells, and calendar container retain stable DOM identity across filter changes.
- Each potentially visible event marker now remains stably keyed and changes an explicit visibility state; markers leaving or entering the selected view fade and collapse individually on desktop and mobile.
- Per-day rendering retains only markers that can occupy the three visible slots in at least one filter, while separate stable overflow controls represent each filter's remaining events.
- The outflow amount and event count crossfade independently when their values change; the month and mode labels do not receive change animations.
- Regression markers cover the stable calendar shell, static labels, changing values, and marker transitions. Full unit tests, Pyright, frontend typecheck/build, and a local All-to-Subs browser fixture pass with no console warnings or errors.
- Manual test: open Calendar on All, switch to Subs, and confirm only non-subscription event pills fade/collapse, the amount/count crossfade to subscription values, and the calendar/month/mode labels remain visually stationary; switch back and confirm the removed events return smoothly.

### 2026-07-17 Concise Expense Breakdown Reply Follow-Up

Status: Complete. Discord now sends a compact expense-breakdown summary while the web report remains the detailed view.

- Removed the category-by-category amounts and percentages from the Discord message body.
- Retained the report heading, Total Spent, signed `Open full report` link, and attached pie chart.
- Continued passing every non-zero category to the pie-chart renderer, so only the duplicated text payload changed.
- Manual test: request an expense breakdown and confirm the Discord reply has only the compact summary and chart; open the signed link and confirm the full category detail remains available.

### 2026-07-17 Category Mix Envelope Follow-Up

Status: Complete. The donut, connector stems, and metric labels now remain inside the chart border as its available height changes.

- Category Mix observes its actual chart-host size and solves for the largest radius whose complete visual envelope fits with responsive edge padding.
- Envelope bounds include the donut radius, stem endpoints, text gap, measured label width/height, and the same per-category x/y deltas applied during rendering.
- Sector midpoint calculations mirror Recharts' `0°` to `360°` distribution and one-degree slice padding so later categories do not accumulate angular drift.
- The full envelope is re-centered after ResizeObserver updates, including when expanding Categories reduces the chart host height.
- Regression coverage confirms the fitted-host hooks are embedded in generated reports; frontend type-check/build and browser geometry checks cover the ten-slice Brian example.
- Manual test: open Brian's July report at desktop width, expand and collapse Categories, and confirm all labels and stems keep a small gap from every chart border.

### 2026-07-17 Category Mix Layout Motion Follow-Up

Status: Complete after animation-pipeline correction. Category Mix retains the envelope solver's per-view fit while smoothly moving and reshaping the pie between the All, Needs, Wants, and Savings centers without a delayed or interrupted sector morph.

- Each filter change records the previous fitted center and initially offsets the newly rendered stable Recharts pie group back to that visual origin.
- The offset returns to zero over 520 ms while Recharts performs its existing slice morph, so the donut, stems, and labels float together into the new fitted position instead of snapping.
- Wrapper phase state now lives outside a memoized Recharts pie surface, preventing the primed, active, and idle updates from reconciling the sector-animation subtree mid-morph.
- The Recharts pie animation starts at zero delay so sector interpolation and center travel share the same 520 ms window; the wrapper keeps its compositor state for an additional 80 ms before settling idle.
- The fit solver remains authoritative for every destination; no fixed center or radius is introduced, and endpoint label/stem padding remains unchanged.
- Tooltip interaction is temporarily suppressed during the layout transition and restored after completion; interrupted or near-zero transitions settle explicitly to idle so rapid toggles cannot leave the chart inert.
- Reduced-motion users receive the final fitted position without the translation animation.
- Regression hooks expose motion phase, revision, travel, offsets, render isolation, and synchronized animation in generated reports. Full unit tests, Pyright, frontend typecheck/build, and browser frame sampling pass; the sampled sector changed continuously until its stable tail and never resumed after becoming stable.
- Manual test: switch Category Mix through All, Needs, Wants, and Savings, confirm the complete pie/label group glides and reshapes continuously into each fitted location without a pause, then toggle two tabs quickly and confirm the chart settles and tooltips remain interactive.

### 2026-07-17 Category Rollover And Overspend Follow-Up

Status: Complete. Needs and Wants Category Mix views now show their category-specific available income and overspend pressure.

- Report parsing prefers the Budget sheet's Rollover column aligned with the Needs and Wants subtotal rows, while retaining the older Margins-row fallback for legacy sheets.
- Dedicated Needs/Wants rollover payload fields preserve the existing margin metrics and Burn Rate target instead of silently changing those established calculations.
- Positive rollover is added to the selected pie as `Income left`; negative rollover is excluded from the pie and shown in a compact single-bar overspend indicator.
- Wants uses its cascaded rollover value, so Needs overspend is already deducted; the Wants view explicitly identifies that carried impact.
- Projected mode mirrors the sheet sequence by calculating Needs at 50% of projected income and Wants at 30%, then carrying Needs rollover into Wants.
- Regression coverage preserves negative rollover values and the cross-category payload; browser checks cover current positive rollovers, Needs overspend, Wants impact, projected mode, and chart containment.
- Manual test: open Category Mix for a month with positive rollovers, verify both `Income left` slices, then temporarily overspend Needs and confirm Needs shows the overspend bar while Wants drops by the same amount and explains the deduction.

### 2026-07-17 Daily Spending Grid Follow-Up

Status: Complete after contrast follow-up. Every Daily Spending filter now separates foreground boundaries/X labels from the muted-grey interior scale/Y labels.

- Recharts' first generated horizontal line (`$0`) and final unlabeled top boundary are solid and use the report's theme-aware foreground color.
- X-axis labels use that same foreground tone; Y-axis dollar labels retain the muted-grey color.
- Interior lines explicitly use the muted-grey color, `1px` width, `3 3` dash spacing, and butt caps so no segment differs in hue or dot size.
- Stable grid and X-label classes are embedded in generated report assets for regression coverage.
- Browser SVG checks verified computed colors, widths, caps, and dash patterns for All, Needs, and Wants with no console warnings or errors.
- Manual test: switch Daily Spending through All, Needs, and Wants in light and dark mode, confirm the top/bottom boundaries and X labels use the foreground tone, and confirm the Y labels plus uniformly dotted interior lines remain grey.

### 2026-07-17 Daily Spending Bar Radius Follow-Up

Status: Complete. Needs and Wants bars now share the blue bar's subtle four-corner radius in every Daily Spending filter.

- One typed `[2, 2, 2, 2]` radius constant drives both stacked bars and the single filtered bar, preventing color-specific radius drift.
- Focused regression coverage asserts all three Daily Spending bar definitions consume the shared constant and rejects the former purple `6px` top corners.
- Browser SVG checks confirmed identical `A 2,2` corner arcs for blue and purple bars across All, Needs, and Wants with no console warnings or errors.
- Manual test: compare blue and purple bars in All, then switch to Needs and Wants and confirm every bar retains the same subtle rounding.
- Verification: `405 passed, 1 skipped`, Pyright reported zero errors, frontend typecheck/build passed, focused report tests passed, and `git diff --check` passed.

### 2026-07-17 Three-Bucket Category Cascade Follow-Up

Status: Complete. Category Mix now preserves separate Needs, Wants, and Savings balances and exhausts donor buckets in the requested source-specific order.

- Current reports parse all three raw values from the Budget sheet Margins row, including zero balances, while retaining the older Rollover payload fields for compatibility and unchanged Burn Rate behavior.
- Needs overspend borrows from Wants then Savings; Wants overspend borrows from Savings then Needs; over-saving borrows from Wants then Needs.
- The backend emits the raw balances, adjusted balances, transfer ledger, source deficits, and final total overspend so current-mode behavior is regression tested and auditable.
- Category Mix adds a Savings tab, uses Amount Saved as its activity slice, and shows its adjusted positive balance as `Income left`.
- Red alerts describe the overspent source and how donors covered it; amber alerts identify deductions from a selected donor; All shows a budget-overspend alert only after all category funds are depleted.
- Projected mode recomputes the same three-bucket cascade from projected 50/30/20 allocations and projected category totals.
- Manual test: create a temporary overage in each source category, confirm donor impacts follow its priority, then exceed all three available balances and confirm the All-tab budget-overspend amount equals the uncovered remainder.
- Verification: `404 passed, 1 skipped`, Pyright reported zero errors, frontend typecheck/build passed, and local browser checks covered live balances, all donor orders, projected mode, total overspend, and chart containment.

### 2026-07-22 Digest Inbox And Three-Paycheck Savings Follow-Up

Status: Complete. The three-paycheck workflow remains active; its projected-savings-amount behavior was superseded by the 2026-07-26 actual-only savings decision below.

- Reconciliation digest and inbox component actions now use an explicit private thinking defer before sending follow-ups, fixing the silent `View Inbox` interaction and keeping the response actor-scoped.
- Callback regression coverage invokes the real `View Inbox` button and confirms it defers privately before dispatching the inbox workflow.
- Savings commands now support numbered first, second, and third paycheck rows through shared row-discovery, check, and logging helpers with standard undo metadata.
- Modern savings rows expose their own Ideal and Minimum values; the reader retains the legacy two-row fallback where Ideal and Minimum were split across the first and second rows.
- Expense reports emit current/projected savings target metadata and paycheck counts. Projected mode derives one monthly Ideal/Minimum rate from the reached sheet targets and applies it once to projected income.
- Historical behavior estimated unentered future contributions and fed that amount into Saved, Left, and Savings Category Mix. The 2026-07-26 follow-up keeps Saved actual in both modes instead.
- Read-only inspection confirmed three savings rows on both live July sheets and Templates. A follow-up corrected the initial per-row scaling error: Brian July's `$11,472.33` projected income now produces a `$2,294.47` monthly Ideal and `$1,147.23` Minimum, not a three-row `$3,441.69` Ideal.
- Historical browser verification covered the prior contribution projection; current expected behavior is recorded in the 2026-07-26 follow-up.
- Verification: `410 passed, 1 skipped`; Pyright clean; frontend typecheck/build passed; `git diff --check` passed.

### 2026-07-26 Expense Report Financial Semantics Follow-Up

Status: Complete in code, automated verification, and live browser verification; deployment confirmation remains in `.agent/STATUS.md`.

- Spent uses detailed elapsed Needs/Wants expense itemization without savings. Left uses the Budget sheet's Net Total after its category margins and cross-category coverage; it is not derived by subtracting elapsed outflow and savings from income.
- Category Mix All remains the elapsed-outflow view. Needs and Wants use their source Budget-sheet subtotals and allocations so percentages match the workbook even when full subscription budgets differ from subscriptions elapsed so far. The Savings tab remains separate and uses only the actual saved amount read from the sheet.
- Projected mode keeps Saved and current category usage unchanged. It applies a penny-safe 50/30/20 split to projected income, cascades the resulting category balances, and updates the monthly Ideal/Minimum targets without inventing future savings deposits.
- Calendar keeps the month name as its heading, restores the original visible non-income outflow total as the subtitle beneath it, and renders its current/projected event count as one spaced value. Both animated values continue to respond to All/Subs and Projected state.
- Largest includes every non-Rent actual shared expense, entered bill/utility, and elapsed subscription in descending order. The graph shows the top ten while the expandable table retains all non-Rent rows.
- Burn Rate derives effective Wants availability after the category cascade, places the daily pace beside its summary, and names both donor and covered category in the impact callout.
- The Saved metric is a color-coded zero-to-Ideal progress bar with a Minimum marker; mode/paycheck prose was removed. Daily Spending details start open only on desktop, and the header places the timestamp beside the title with Projected immediately left of the rightmost theme control.
- Live Brian July verification showed Current Income `$7,698.22`, Spent `$5,133.70`, Left `$794.00`, Needs `$4,098.47 / $3,849.11 (106.48%)`, Wants `$1,266.11 / $2,309.47 (54.82%)`, and Saved `$1,539.64 / $1,539.64`. Projected showed `$11,472.33` Income, `$4,568.11` Left, unchanged Saved `$1,539.64`, and `$2,294.47` Ideal.
- Live Hannah July source verification showed `$618.53` Left with `$688.12 / $809.74` Needs, `$312.82 / $485.84` Wants, and `$0.00 / $323.89` Savings.
- Verification: focused report suite, full suite, Pyright, frontend typecheck/build, `git diff --check`, and live desktop/mobile browser checks are recorded in `.agent/STATUS.md`.

### 2026-07-24 Persisted Reconciliation Inbox Follow-Up

Status: Complete in code and focused verification; production deployment confirmation remains in `.agent/STATUS.md`.

- Replaced the digest button's forced reconciliation rebuild with a persisted-state inbox read. `View Inbox` no longer starts a Plaid sync, rescoring preview, action-log read, or schedule-sheet hydration after deferring the Discord interaction.
- The persisted report includes current-month unresolved and automatic-match items and retains `Reconcile Now`, `Ignore All`, and `Unmatch` controls where applicable.
- Match reports infer schedule, spreadsheet-row, and spreadsheet-group source types from persisted lineage when source hydration is intentionally skipped.
- Inbox loading is bounded by `BOOKIEBOT_RECONCILIATION_INBOX_TIMEOUT_SECONDS` (15 seconds by default); timeouts and exceptions return a private no-mutation retry message instead of leaving Discord's thinking state unresolved.
- Regression coverage proves the fast path never calls sync/rescoring, returns persisted automatic matches, retains batch-ignore behavior, and closes the deferred interaction on preparation failure.
- Verification: focused core/reconciliation suite `66 passed`; full suite `412 passed, 1 skipped`; Pyright clean; `git diff --check` passed.

### 2026-07-25 Deferred Discord Response Lifecycle Follow-Up

Status: Complete in code and focused verification; production deployment confirmation remains in `.agent/STATUS.md`.

- Corrected the remaining Discord lifecycle issue: after `thinking=True`, the first inbox result now edits the original deferred interaction response instead of creating a separate follow-up that leaves the thinking placeholder unresolved.
- Empty, timeout, exception, Ignore All, and Unmatch outcomes also complete their original deferred responses in place.
- Multi-chunk reports edit the original response with the first chunk and reserve follow-ups for later chunks. `Reconcile Now` uses a non-thinking defer because its established review flow sends follow-up cards.
- Regression coverage verifies successful reports, empty state, timeout/failure, and batch-ignore response completion.
- Verification: focused core/reconciliation suite `68 passed`; full suite `414 passed, 1 skipped`; Pyright clean; `git diff --check` passed.

### 2026-07-25 Persisted Inbox Data Accuracy Follow-Up

Status: Complete in code and focused verification; production deployment confirmation remains in `.agent/STATUS.md`.

- Persisted inbox previews now load current-month cache buckets from the banking store, so Stored, Needs review, Matched, Confirmed, Ignored, and Pending counts no longer fall back to zeros.
- Unresolved review rows are formatted before automatic-match history and their action controls are attached to the first Discord response. Long match reports continue in later messages without hiding the actionable inbox.
- Regression coverage reproduces unresolved items alongside multi-message match history and verifies accurate cache totals, visible review rows, and immediate controls.
- Verification: focused finance-ops suite `92 passed`; full suite `414 passed, 1 skipped`; Pyright clean; `git diff --check` passed.

### 2026-07-25 Interaction Typing And Recent Privacy Follow-Up

Status: Complete in code and automated verification; production confirmation remains in `.agent/STATUS.md`.

- `View Inbox`, digest `Reconcile Now`, and inbox `Reconcile Now` now use silent component defers while a resilient channel typing context displays Discord's normal `BookieBot is typing...` UI.
- Inbox success, empty, timeout, failure, Ignore All, and Unmatch results are private follow-ups rather than edits to a temporary thinking response.
- Recent-action button/select prompts, ownership errors, and action outcomes remain ephemeral, with new callback-level regression coverage.
- Discord does not support `ephemeral=True` on ordinary `User.send` or DM channel messages. Typed recent-action requests now receive a short-lived launcher with no financial data; opening it deletes the launcher and sends the list through an ephemeral interaction.
- The active follow-up webhook is retained for the ten-minute workflow window, keeping typed pagination, update/move replies, cancellations, expiry notices, and results in the same ephemeral session.
- DM-originated requests no longer receive the redundant `I sent your recent transactions list to your DMs.` acknowledgement; requests from a shared channel still do.
- Verification: focused recent/message-router suite `135 passed`; full suite `418 passed, 1 skipped`; Pyright clean; `git diff --check` passed.

### 2026-07-31 Recent Ephemeral Launcher Restoration

Status: Complete in code and automated verification; production confirmation remains in `.agent/STATUS.md`.

- Restored the short-lived launcher after production testing confirmed that direct bot-authored DM lists are persistent and do not carry Discord's native ephemeral footer.
- Tapping `Open Recent Transactions` silently creates the interaction context, returns the list and selector ephemerally, and deletes the launcher immediately.
- The active interaction follow-up remains available for the ten-minute workflow window so pagination, typed update/move replies, cancellations, expiry notices, and outcomes stay ephemeral where Discord permits.
- Verification: focused recent/message-router suite `134 passed`; full suite `422 passed, 1 skipped`; Pyright clean; `git diff --check` passed.

### 2026-08-02 Prior-Month Paycheck Projection Follow-Up

Status: Complete in code and automated/read-only verification; production browser confirmation remains in `.agent/STATUS.md` checklist item 73.

- New-month expense reports use the immediately prior month's latest dated paycheck matching the configured biweekly source as projection-only amount and cadence context.
- A missing current-month source/start configuration inherits from the immediately prior month, covering Brian's live August tab without changing either sheet.
- The prior paycheck never enters Current income or the selected month's actual calendar. A matching current-month paycheck supersedes it; unrelated, mismatched, undated, or older income does not become the projection basis.
- January optionally loads the previous annual workbook's December tab, while access/configuration failures retain the existing safe fallback behavior.
- Current-month signed report links rebuild from Sheets by default so a pre-fix saved HTML snapshot cannot keep returning a `$0.00` projection. The saved file remains the route's failure fallback; completed months remain snapshot-first, and `snapshot=1` explicitly requests the current-month file.
- Read-only Brian August verification found the July 31 `xAI` paycheck at `$3,137.49` and produced `$6,274.98` Projected income with August 14 and 28 projected events while Current remained `$0.00`.
- Browser verification opened a normal signed current-month URL backed by a deliberately stale snapshot and confirmed the live Projected cards show Income `$6,274.98`, Left `$2,339.42`, Minimum `$627.50`, and Ideal `$1,255.00` with no console errors.
- Verification: report suite `44 passed`; full suite `432 passed, 1 skipped`; Pyright clean; frontend typecheck/build passed; `git diff --check` passed.

### 2026-08-02 Daily Spending Compression-Pill Follow-Up

Status: Complete in code and focused/browser verification; production confirmation remains in `.agent/STATUS.md` checklist item 70.

- Removed the visible `Axis compressed above ...` pill and its dedicated CSS from Daily Spending.
- Preserved the conditional outlier-compression calculation, transformed chart values, raw-value axis labels/tooltips, totals, and itemized details.
- Regression coverage rejects the removed markup and styling while continuing to assert the compression trigger and chart data paths.
- Live Brian August browser verification confirmed the chart still compresses the rent outlier, the pill and copy are absent, the page has no horizontal overflow, and browser logs are clean.
- Verification: focused report suite `44 passed`; full suite `432 passed, 1 skipped`; Pyright clean; frontend typecheck/build passed; `git diff --check` passed.

### 2026-08-07 Intent And Bill-Payment Reliability Follow-Up

Status: Complete in code and automated verification; production confirmation remains in `.agent/STATUS.md` checklist item 76.

- Unambiguous Rent, PG&E, Recology/trash, and Water logs/checks route locally before the LLM. This keeps critical bill mutation available during a transient OpenAI incident and preserves LLM parsing for genuinely ambiguous purchases.
- The OpenAI client retries transient server/rate/connection failures with bounded backoff. Parser infrastructure failures and invalid/unknown structured responses now raise through the parser boundary instead of becoming a legitimate `fallback` and triggering generic advice.
- Google Sheets `429` read-quota errors are distinct from permissions and missing worksheets. Bill-payment reads retry asynchronously and report a no-mutation outcome after exhaustion.
- Current-month worksheet handles are cached per spreadsheet/month. Bill-payment logging reuses the loaded row's previous value and removes two redundant `acell` reads, reducing the mutation path from three income-sheet reads to one after worksheet resolution.
- Verification: focused reliability suite `221 passed`; full suite `488 passed`; Pyright clean; `git diff --check` passed.
- Manual test: deploy, send `Water bill 148.82` and a bill-status query, then confirm local routing, the normal success/split flow, and the bounded no-generic-response behavior under simulated OpenAI `500` and Sheets read-quota `429` failures.

### 2026-08-07 Quarterly Utility History Follow-Up

Status: Complete in code and automated/browser verification; production confirmation remains in `.agent/STATUS.md` checklist item 77.

- Utility history now resolves quarterly cadence and configured pull months from the normalized bill schedule before producing chart points.
- Off-cycle months are absent from a quarterly series instead of being represented as `$0`. Monthly bills remain month-by-month, and a configured quarterly pull month can still show `$0` when an expected bill has not been entered.
- Regression coverage uses May/August Recology hits, rejects June/July points, and requires Recharts to connect valid hits across the off-cycle gaps. Local browser verification confirmed one quarterly line with nodes only at May/August alongside continuous monthly series, with no browser warnings or errors.
- Verification: report suite `47 passed`; full suite `490 passed`; Pyright clean; frontend typecheck/build passed; `git diff --check` passed.
- Manual test: open a report spanning quarterly billing and off-cycle months and confirm configured pull months remain connected while only those months receive nodes for that quarterly bill.

### 2026-08-16 Fixed Expense-Report Carousel Stage Follow-Up

Status: Complete in code and automated/responsive browser verification; production confirmation remains in `.agent/STATUS.md` checklist item 79.

- Replaced the per-slide top-chart cards with one edge-to-edge shaded band that acts as the shared carousel viewport for Category Mix, Burn Rate, Calendar, and Bills & Utilities. The band itself is borderless and square, while each graph/calendar surface is transparent and borderless rather than appearing as another container.
- Kept the existing swipe, desktop previous/next, tooltip dismissal, and active-indicator behavior; navigation remains outside the shared viewport.
- Established one fixed responsive stage height for all four pages. Burn Rate and Bills & Utilities use the full available chart row when details are closed and surrender space to bounded, scrollable inline details when opened without changing the stage height.
- Moved the larger Category Mix and Calendar detail datasets into bounded native dialogs so opening them never changes carousel geometry. Category Mix All now reports the summed category budget and its percentage used.
- Changed Calendar rows to equal fractional tracks and consolidated every multi-event date into one marker whose tooltip lists all events. Event count can no longer enlarge a date cell or the shared stage.
- Kept the carousel and its slides flush with both viewport edges, then added separate responsive gutters inside each chart page: `16px`-to-`56px` horizontally and `16px`-to-`32px` vertically. The shaded swipe surface remains visibly full bleed while text, graphs, and controls stay safely inset from every edge. All four pages use a common header/body/footer grid; graphs fill the variable middle row while the details-control row stays aligned at the bottom.
- Removed redundant Category Mix/Calendar outer titles and the duplicate Bills & Utilities title. Category Mix retains only its Spent/Saved summary and Calendar retains its month/outflow summary.
- Locked the underlying document while Category/Calendar dialogs are open, bounded scrolling to the dialog body, restored the prior Y position on close, and made Calendar details render the complete subscription list without a nested `View all` step.
- Preserved valid selected-month dates for non-paycheck income calendar events. On phone widths, consolidated busy-day markers show a compact `+N` beside the node; the Calendar count pill precedes All/Subs; and the Burn Rate pace pill aligns with the graph's right content edge.
- Isolated dialog touch gestures from the carousel and restored scrollbar-width compensation on close, so horizontal drags within either modal cannot change pages and opening/closing details cannot widen or shift the full-bleed stage.
- Added effective donor usage to filtered Category Mix views: coverage transferred out of Wants or Savings becomes a visible chart slice and participates in the filtered Spent/% used headline, while the recipient retains its actual overspend and the All view avoids transfer double-counting.
- Added focused source regressions and rebuilt the embedded report assets. Desktop and `390x844` checks confirmed stable `640px`/`540px` stage heights, exact viewport-width slides at `x=0`, horizontal content alignment at `x=56`/`x=16`, matching `32px`/`16px` top and bottom insets on all four pages, aligned lower regions, cleaned headings, complete subscription details, page-scroll isolation, one marker per date, aggregate tooltips, accurate transfer-adjusted usage, no horizontal overflow, and clean browser diagnostics.
- Verification: report suite `54 passed`; full suite `511 passed, 1 skipped`; Pyright clean with the project Python 3.12 environment; frontend typecheck/build passed; `git diff --check` passed. A `390x844` browser check confirmed visible `+1` nodes, count-before-tabs ordering, an unchanged Calendar transform during a modal swipe, exact `375px` carousel restoration with zero overflow, and matching `x=359` Burn Rate pill/graph right edges.
- Manual test: open a report at desktop and phone widths; switch/swipe across all four panels and confirm the shaded shell enters from both viewport edges while every page's text, graph, and footer controls retain the same horizontal, top, and bottom gutters. Confirm the stage and lower control row never move and each graph fills its available middle row. Confirm Category shows only Spent/Saved, Calendar shows only month/outflow, and Bills & Utilities appears once. Open Category and Calendar details after scrolling the page, attempt to scroll outside the dialog, scroll a long dialog internally, close it, and confirm the page remains at its prior Y position. Confirm Calendar details lists every Needs/Wants subscription. In a report where Needs overspend is covered by Wants, compare both filtered charts and subtitles with the coverage callout and confirm All does not double-count the transfer. Confirm multi-event calendar dates retain one marker whose tooltip lists every event and the indicator remains outside below the band.

### 2026-08-16 Brian Expense Payment-Method Default

Status: Complete in code and automated verification; production confirmation remains in `.agent/STATUS.md` checklist item 80.

- Split each user profile's historical/query person labels from its active expense payment-method labels. Brian's historical BofA/AL data remains in normal query coverage, while the active logging default contains only `Brian (BofA)`.
- An expense with no explicit person/card now logs immediately when exactly one active method exists. Multiple active methods continue to pause before mutation and show the existing chooser.
- Added `BRIAN_EXPENSE_PAYMENT_METHODS` and `HANNAH_EXPENSE_PAYMENT_METHODS` examples. The chooser builds its buttons from the configured list, so a future card can be added through configuration instead of another code change.
- Verification: routing/handler suite `134 passed`; full suite `516 passed, 1 skipped`; Pyright `0 errors`; `git diff --check` passed.
- Manual test: as Brian, log an ordinary expense without naming a card and confirm it writes `Brian (BofA)` without a card prompt. Temporarily configure two active methods, restart, confirm the chooser contains those exact labels and no row is written before selection, then restore the BofA-only production value.

## Open Questions

- What should the canonical recent-action lineage model look like?
- Should updated/moved actions replace the source action or remain separate visible events?
- Should date updates be supported in the UI? Decided 2026-06-20: no user-entered date updates; reconciliation-origin automation only.
- How long should pending selections remain valid?
- Should old unresolved bank items be automatically ignored, marked stale, or hidden until manually reviewed?
- What is the right default freshness window: 30, 45, 60, or 90 days? Decided first pass 2026-06-20: 60 days.
- Should amount mismatches default to asking every time? Decided 2026-06-20: selecting the matching row is the confirmation; after that, use the bank amount as source of truth for single-row matches.
- Should a moved reconciled expense stay confirmed automatically if amount/date/person are unchanged?
- How much event state should live in Google Sheets versus the banking database?

## Candidate Commands To Add Or Improve

- `/debug_bank_events`
- `/debug_bank_reconciliation_inbox`
- `/debug_bank_mark_stale_before`
- `/debug_bank_review_history`
- `/debug_bank_reopen`
- `/debug_bank_reconciliation_policy`
- `/debug_recent_actions`
- `/debug_recent_action_lineage`

## Conversational Agent Finance Boundary

Status: Read-only LangGraph response layer complete in code and automated verification as of 2026-08-17; production confirmation remains in `.agent/STATUS.md`.

- An explicit valid parser `fallback` and recognized read intents supported by the graph's tools enter the conversational graph. The latter use tool data for an LLM-synthesized answer instead of the legacy preformatted handler response. Parser/provider failures retain the existing no-change error and never become agent runs.
- Existing deterministic and intent-handler paths remain authoritative for logging, payment, update, move, split, delete, undo, and reconciliation behavior.
- Imperative bank-transfer language is refused before parsing and cannot be reinterpreted as a monthly savings write. Past completed transfers require an explicit request to record the contribution.
- Agent tools derive the budget owner from trusted Discord runtime context. The model cannot supply or switch an owner identifier.
- The initial tool set reads current budget posture, category/store spending, largest/date-specific expenses, subscriptions, and bill status. It exposes no bank, action-log, reconciliation, or sheet mutation tool.
- A canonical `get_financial_report` tool exposes focused overview, categories, cash flow, commitments, burn rate, activity, and reimbursement sections. Its Current and Projected views are server-computed from the same Expense Breakdown report model and payload used by the web page.
- Conversation checkpoints are keyed by guild/channel/user. Postgres is used when `BOOKIEBOT_AGENT_DATABASE_URL` or `BANK_DATABASE_URL` is configured; otherwise memory is process-local.
- Model calls, tool calls, recursion, and elapsed runtime are bounded. Tool failures return a no-mutation result so the agent can explain unavailable data without leaking implementation errors.

### 2026-08-17 Work Log

- Replaced the stateless legacy fallback ChatCompletion with a LangGraph/LangChain agent while preserving the command router and the explicit parser-failure boundary.
- Added actor-scoped read adapters for BookieBot financial data and regression coverage for user isolation, no-write schemas, runtime tool-context injection, per-thread memory, fallback integration, and Discord response chunking.
- Upgraded the OpenAI client SDK, moved intent parsing to a configurable current model with JSON response mode, and added configurable persistent checkpointing through Postgres.
- Verification: focused agent/parser/router/handler/LLM suite `182 passed`; full suite `530 passed` with one existing Kaleido warning; Pyright clean; graph/checkpointer construction, dependency resolution, and `git diff --check` passed.
- Routed tool-supported read intents—including the budget, category, largest expense, subscriptions, date, merchant, and bill questions exercised in production—through the graph. The agent now synthesizes an answer from tool data while visual/report and unsupported query intents retain their specialized handlers.
- Added a pre-parser bank-transfer refusal after production testing showed `Transfer $50 from checking to savings` could be misclassified as `log_savings`; the exact request now performs no mutation. Verification: focused agent/parser/router/handler suite `188 passed`; full suite `539 passed` with one existing Kaleido warning; Pyright and `git diff --check` clean.
- Moved the web report's Current/Projected transformation into the server payload and retained the React calculations only as backward compatibility for older saved reports. Added a sectioned actor-scoped agent tool over that payload, expanded conversational routing for non-visual read intents, and rebuilt the frontend asset. A read-only live Brian August smoke check returned coherent Current/Projected overview data from the new tool. Verification: focused agent/router/handler/report suite `237 passed`; full suite `541 passed` with one existing Kaleido warning; Pyright clean; frontend typecheck/build passed; `git diff --check` clean.

Open follow-up: any future write-capable planner must emit high-level proposals, reuse existing guarded handlers, and pause for explicit Discord approval; raw Sheets or reconciliation mutation functions must not become model tools.

## Files To Inspect Before Editing

- `src/bookiebot/sheets/undo.py`
- `src/bookiebot/intents/handlers.py`
- `src/bookiebot/core/message_router.py`
- `src/bookiebot/ui/recent_actions.py`
- `src/bookiebot/banking/service.py`
- `src/bookiebot/banking/store.py`
- `src/bookiebot/banking/postgres_store.py`
- `src/bookiebot/banking/reconciliation.py`
- `src/bookiebot/core/bank_reconciliation.py`
- `src/bookiebot/core/bank_reconciliation_flow.py`
- `unit_tests/intents/test_handlers.py`
- `unit_tests/core/test_message_router.py`
- `unit_tests/banking/test_reconciliation.py`
- `unit_tests/banking/test_store.py`
- `unit_tests/core/test_bank_reconciliation.py`

### 2026-09-05 Deterministic Income Projection Follow-Up

Status: Complete in code; production deployment/manual confirmation remains in `.agent/STATUS.md` checklist item 83. This supersedes only the earlier one-month configuration inheritance limit; prior-month observed paycheck amounts retain their freshness boundary.

- Explicit source/start/mode/fixed amount settings persist across blank months, including earlier settings in the configured previous annual workbook. The selected month's explicit settings win; changing employers resets the inherited salary plan, and `off` stops projections.
- Removed arbitrary income/keyword/fuzzy-label and hardcoded-cadence fallbacks. Complete employer labels and a finite set of standard payroll suffixes match deterministically; bonuses/rewards remain additional actual income.
- Fixed monthly take-home mode projects only the unreceived salary portion and uses one labeled month-end estimate. Current/completed months stay actual-only; report/agent totals remain shared, with a visible resolved basis or missing-setting message.
- Added regressions for July-to-September inheritance with actual August payroll label variants, rewards isolation, fixed targets/over-target salary, no double-counting, three-paycheck months, employer changes, off/invalid settings, year rollover, and missing source/anchor/history.
- README documents editable sheet settings. No sheet mutation or deployment was performed; latest verification is recorded in `.agent/STATUS.md`.

- Verification: focused reports/agent suite `96 passed`; full suite `568 passed` with one existing Kaleido warning; Pyright clean; frontend typecheck/build and `git diff --check` passed. A read-only live July–September check resolves `xAI` and projects `$7,654.39` from August 28 salary plus September actual income.

### 2026-09-05 Unified Income Grid And Permanent Anchor

Status: Complete in code and live four-tab migration; deployed-bot and next natural rollover confirmation remain `.agent/STATUS.md` checklist item 84.

- Unified `E1:F5` grids on Brian/Hannah Budget 2026 Template and September tabs, preserving `xAI` / July 2 and `Sonic` / August 21 respectively. Both retain biweekly mode with fixed salary blank; strict dropdown, currency, and date validation are installed.
- Updated the repository and live Apps Script income helpers/month/year rollover; executed the targeted migration successfully. New months copy latest settings, annual rollover carries the prior plan, and existing months preserve edits. Unrelated live script code was preserved.
- Canonical Paycheck Anchor Date is permanent; actual receipts fill nearby scheduled slots without cadence drift. Legacy anchor semantics remain compatible. The unified anchor survives first-income deletion and undo; exact Monthly Income matching prevents fixed salary from corrupting actual reads/writes.
- Executed Node regression coverage for migration and month/year rollover plus Python schedule, lookup, and lifecycle tests. Full suite `577 passed`, Pyright clean. API readback and browser checks verified all four grids and no value/formula changes outside them. Existing unrelated Template reference errors remain untouched.
- README and durable decisions document setup and semantics. Agents.md records the user's default commit/push preference.


### 2026-09-05 - Final Horizontal Income Settings And Explicit Expectations

Status: Complete; deployed-bot/natural-rollover manual checks are in STATUS checklist 85.

- Migrated both annual budgets' Template and September to B4:E5 settings above B7:D7 transactions with a blank buffer row. Kept darker green styling, biweekly default, and persistent source/mode/expectation/anchor controls.
- Biweekly forecasts now use the entered per-paycheck expectation; fixed monthly uses one persistent monthly net target. Actual receipts fill periods within +/-3 days, including across month/year boundaries, without changing the expectation or moving actual dollars. Multiple deposits fill one period; undated/out-of-window receipts fill none.
- Removed live Apps Script automatic placeholder-row insertion/styling. New monthly settings reference the preceding configured grid; explicit overrides remain local. Historical layouts retain required compatibility handling.
- Shifted six September action-log row references and two split-ledger source rows with the layout migration. Verified all other values/formulas after reference adjustment; old dropdown/note remnants were removed. Added delete-snapshot compatibility so undo cannot restore the obsolete settings area.
- Full verification: `597 passed`, Pyright clean, Node migration/rollover/reference checks passed. Four-tab API readback and visual checks passed. Existing unrelated Template reference errors and Hannah's zero-income division errors remain unchanged.

### 2026-09-05 - Income Card Presentation

- Removed Income card subtext in Current and Projected views; retained calculation and report-tool metadata. Rebuilt the committed frontend asset.
- Verification: frontend typecheck/build passed. Manual check: generate a fresh expense report and toggle both modes; the Income card displays only its label and amount.

### 2026-09-05 - Unpaid Utility Chart Points

- Bills & Utilities chart now leaves unpaid current/future billing months blank (`null`), with zero appearing only after the month closes. Quarterly off-cycle months remain omitted; actual off-cycle payments remain visible. Regression checks cover monthly/quarterly rollover and actual receipts. Verification: 600 tests passed (existing Kaleido warning), Pyright clean, frontend typecheck/build passed. Manual check after deployment: generate a fresh September report; unpaid monthly utilities have no September dot and unpaid Recology stays blank outside its configured February/May/August/November cycle.

### 2026-09-06 Expense Report Design Overhaul

- Complete: redesigned the frontend as a paper/ink ledger, with a unified four-metric summary, explicit view controls, named carousel navigation, and consistent typography, tables, focus, and light/dark themes. Existing financial computations, chart stages/gestures/details, Daily Spending, and expense highlights remain intact.
- Complete: simplified reimbursement presentation to an Outstanding summary plus a three-line account statement and expandable expense records. All original summary/item information remains available, with received amounts also visible per record.
- Complete: following user design review, introduced distinct, stronger category colors shared by pie slices and daily labels, with matching square markers. Removed scheduled daily-row bucket color overrides; Needs/Wants subscriptions now use the same distinct labels/colors as the category chart.
- Verification: 113 report tests, 604 full-suite tests (one existing Kaleido warning), clean Pyright, frontend typecheck/build, and diff check. Synthetic browser checks covered desktop/mobile layouts, both themes/modes, chart/detail interactions, reimbursements, and exact pie/daily color correspondence.
- Pending: deployed visual acceptance in STATUS checklist 86. No reconciliation, transaction mutation, persistence, or split lifecycle behavior changed.

### 2026-09-06 Expense Report Motion And Responsive Polish

Status: Implementation and combined verification with incoming main complete. Deployed manual acceptance is STATUS checklist 87, alongside the initial design checklist 86.

- Reused one symmetric 240ms disclosure transition for inline details, full lists, and controlled reimbursement expansion. Dialogs now animate entry and exit while retaining focus trapping and page scroll locking until exit completes; closed disclosure content is inert and reduced-motion preferences remain supported.
- Added measured sliding selections across report modes, chart navigation, filters, and highlights, plus a sliding theme switch. Expense Highlights keeps both views mounted for smooth transitions. Top metric amounts fit their actual column width on one line and restore their natural size when space returns.
- Calendar markers adapt to day-cell width instead of relying only on viewport breakpoints, reducing from full labels to amounts to dot/count without overflow. Exact event information remains in tooltips and accessible labels.
- Daily Spending grids now follow visible axis ticks, retain only the solid zero baseline, and include an upper dollar tick for empty and ordinary datasets; the compressed outlier's true-value upper guide remains near the top.
- Verification so far: `122` report tests passed; frontend typecheck/build passed and embedded assets rebuilt. Browser QA passed across 320–1280px, with sampled intermediate motion, contained calendar labels/counts, exact long/signed metric fitting, upper daily guides, and preserved modal/highlight behavior. Combined verification with incoming main: `781 passed, 9 skipped` (optional local Postgres contracts; one existing Kaleido warning), Pyright `0 errors`. CI supplies Postgres for those opt-in contracts. Financial calculations, reconciliation, persistence, and split lifecycle behavior are unchanged.

## 2026-09-06 Architecture Audit Remediation

User authorized all batches incrementally on 2026-09-06. STATUS is the active queue; existing deployment checks remain pending. Audited commit: 863432f162af95b6c29cf4567629e3fddf2b52f0. Offline baseline: 599 suite tests passed; isolated Kaleido test passed outside sandbox; Pyright, frontend typecheck/build, and Node rollover checks passed. All findings have offline reproductions; no live financial inspection was performed.

| Batch | Findings / acceptance | Status |
| --- | --- | --- |
| 1 | A01: bill questions/negation never write; A02: updated payments/savings retain their type and cannot delete budget rows | Complete 2026-09-06; 647 tests and Pyright passed |
| 2 | A03–A04: income row shifts update only the correct owner's references, including bill/savings actions | Complete 2026-09-06; 663 tests and Pyright passed |
| 3 | A05: delete/move undo preserves another user's intervening edits and consistent action history | Complete 2026-09-06; 669 tests and Pyright passed |
| 4 | A06–A07: reject unsupported historical destinations before writing; durable claims prevent stale/concurrent/retried duplicate imports | Complete 2026-09-06; 707 tests and Pyright passed |
| 5 | A08–A09: changed matches reopen; transient reminder failures retry; webhook processing recovers after restart | Complete 2026-09-06; 733 tests and Pyright passed |
| 6 | A10–A11: every private report route enforces signed access; live rendering yields the event loop; history uses bounded batch reads | Complete 2026-09-06; 746 tests and Pyright passed |
| 7 | A12: incident contents remain data; ordinary changes run quality gates; storage lifecycle tests exercise Postgres | Complete 2026-09-06; 773 tests incl. real Postgres and quality gates passed |
| 8 | Remove proven unused rendering code and consolidate responsibilities where earlier batches establish safe seams | Complete 2026-09-06; 777 tests and final local quality gates passed |

Preserve intentional semantics: existing affirmative bill shorthand, actual/expected income separation, historical report compatibility, bank confirmation before import, immutable gross split amount, and reimbursement settlement without income. Historical bank writes may fail closed until destination-aware undo is supported. Audit completion is separate from deployment/manual confirmation; do not silently run migrations or mutate live test transactions.

### Audit Batch 1 work log — 2026-09-06

Completed affirmative bill grammar/read-only diversion before pending edits, canonical payment/savings update lineage, capability restrictions, and physical income-table deletion guards. Historical repeated-update records recover source type from loaded lineage without extra Sheets reads or migration. Added 47 regression cases; full suite 647 passed and Pyright clean. Manual acceptance is recorded in STATUS. Next: owner-scoped row shifting.

### Audit Batch 2 work log — 2026-09-06

Completed one owner-alias-aware personal-budget reference repair path used by insert/delete/restore/placeholder cleanup. Repairs active/inactive action lineages, fixed payment/savings references, saved income boundaries, and the owner's linked split-ledger rows. Reference failure regressions prove rollback; stale fixed-label guards fail before mutation. Added 16 cases; focused 277/full 663 passed, Pyright clean. Manual acceptance is in STATUS. Next: shared expense undo preservation.

### Audit Batch 3 work log — 2026-09-06

Completed transaction-only restoration into current category contents. Undo no longer replays stale neighboring rows; it tracks intervening deletes, preserves corrections/new/draft rows, and repositions restored action lineages. Destination verification protects moved rows and occupied legacy restore positions. Six reproduced regressions now pass; focused 283/full 669 passed, Pyright clean. Manual acceptance is in STATUS. Next: durable bank imports.

### Audit Batch 4 work log — 2026-09-06

Completed shared expense/income import orchestration and durable SQLite/Postgres operation schema. Claims recheck owner, status, watched/posted state, amount and date atomically; uncertain outcomes hold the claim. Recovery links one tagged active action without invoking writers again. Completed or intentionally reopened items cannot be reimported by stale forms. Imports support only the current month until historical destination-aware undo exists; matching historical entries remains available. Added 38 cases; targeted 167/full 707 passed, Pyright clean. Manual acceptance is in STATUS. Next: bank/reminder/webhook lifecycle recovery.

### Audit Batch 5 work log — 2026-09-06

Completed atomic material-bank-change reopening and durable previous-match events without Sheets mutations; preserve explicit ignore policy. Reminder evaluation failure no longer consumes daily evaluation, and automatic retries use 60-second exponential backoff capped at one hour. Webhook claims expire after five minutes, use fencing tokens and per-item serialization, and retain pending state until work is acknowledged. Imports carry and verify target-month/year metadata during recovery. Added 26 cases; targeted 193/full 733 passed, Pyright clean. Manual acceptance is in STATUS. Next: reports.

Batch 5 copy follow-up: explicitly tell users that a sheet entry may already exist when an import needs recovery, so they inspect the sheet before resolving it. This clarifies the partial-write outcome; import behavior and the passing 733-test verification remain unchanged.

### Audit Batch 6 work log — 2026-09-06

Completed signed access on all report routes, no-store responses, bounded asynchronous live builds with actor-safe in-flight coalescing and cancellation isolation, batched formatted history reads, and non-provisioning optional sheet lookup. Historical payload/snapshot fallback remains supported behind signed access. Added 13 cases; targeted 280/full 746 passed, Pyright clean. Manual acceptance is in STATUS. Next: automation and database quality gates.

### Audit Batch 7 work log — 2026-09-06

Completed file-based autofix metadata and failure diagnostics, ordinary push/PR CI, and one storage contract across SQLite/Postgres. Tests prove owner isolation, transaction rollback, unique import claims, changed-match events, stale-worker fencing and concurrent same-item webhook serialization on a real temporary Postgres16 database. Nine arbitrary-text regressions also pass. Targeted 31/full 773 passed; Pyright, Node, frontend typecheck/build and asset parity passed. Remote Verification subsequently passed on Batch 7 and the final implementation commit. Next: focused cleanup and final verification.

### Audit Batch 8 work log — 2026-09-06

Completed proven-unused HTML helper removal and separated worksheet transport from report assembly/calculations. Owner/lineage repair and import orchestration were consolidated in earlier batches; no additional abstraction was needed. Kept active payload and React historical fallback behavior. Added four reader contract cases; targeted 141 passed; comparison preserved 71 payloads and 26 HTML pages byte-for-byte; final full suite 777 passed including real Postgres, with Pyright/Node/frontend/asset parity clean. STATUS and AUDIT_REMEDIATION_2026-09-06.md contain final scope and manual acceptance.

All twelve primary audit findings are addressed by the eight batches. Remaining design work is distinct: destination-aware historical import/undo, recovery for ordinary Sheets mutations whose action-log append fails, and the already deferred split/pending-selection lifecycle work. Separate Sheets and action-log writes are not globally atomic; Batch 4 specifically guards bank import duplication. Deployed/manual acceptance is pending; no live financial test mutations were performed during this implementation.

Final remote verification: implementation commit `6fd7ce8` passed every GitHub Verification gate ([run](https://github.com/brianjames-dev/bookiebot/actions/runs/34051590441)). The disposable local Postgres container was stopped and removed; deployed/manual acceptance is the first on-deck item.

### Dashboard passes 2–7 work log — 2026-09-07

Completed recorded/scheduled drilldowns, configured month history and matching-period comparisons, canonical metric explanations, presentation preferences and frontend update prompts. Added ephemeral owner-scoped Ask, durable opt-in phone push lifecycle with bounded delivery retries, and exact personal goal/contribution history. Fixed browser native-fetch receiver binding, late expired-endpoint replacement races, cold PostgreSQL schema concurrency and unmounted permission continuations. Bank-import/recent-action lifecycle backlog is unchanged. No production test transactions or external test notifications were created. Full regression and browser acceptance are recorded in STATUS; setup, architecture decisions and the ten-item dashboard roadmap are current.

### Dashboard mode-switch regression — 2026-09-07

Fixed a frontend-only blank page when Current/Projected or category filters changed the number/order of pie slices. Recharts renders previous sectors before synchronizing its data store; category-key matching replaces unsafe array-index lookup, with noninteractive departing slices. Real React/Recharts regression and phone-width stress checks cover transitions and correct drilldown targets. Full local suite 1,022 passed / 57 optional PostgreSQL skipped; frontend and type checks passed. Financial calculations, bank/reconciliation lifecycle and persistence are unchanged. Manual acceptance: STATUS checklist 92.

### Dashboard reliability and layout follow-up — 2026-09-07

Completed configurable matching-period comparisons with a bounded single-request phone lifecycle, stable modal geometry/focus, native iPhone notification enable and immediate preference persistence, same-person endpoint rebind with PostgreSQL ownership serialization, and the requested header/chart/detail refinements. The ten-item dashboard roadmap remains complete; bank reconciliation and recent-action backlog are unchanged. Full suite 1,104 passed with real PostgreSQL; typecheck/build, Pyright, Apps Script and phone/desktop browser checks passed. Per-phone opt-in/delivery acceptance is STATUS checklist 93.

### Dashboard refresh/comparison recovery — 2026-09-07

Completed refresh coordination, independently bounded browser aborts, and comparison-only 10-second successful-report handoff with full identity scoping/fresh-read invalidation. Added finite gspread socket timeouts without mutation retries or early worker-slot release. Regression fixtures reproduced duplicate source reads and stalled transport recovery; phone QA recovered both error banners without app restart. Full local 1,051 passed / 60 optional PostgreSQL skipped; typecheck/build/Pyright passed. Reconciliation/recent-action backlog is unchanged; STATUS 94 records acceptance.

### 2026-09-10 Reconciliation Matching And Phone Review

Implemented exact-cent/merchant/ambiguity guards, bank authorization/posting date handling, recurring occurrence reservations and shared action/schedule evidence. Batched bill actual reads and avoided caching partial source failures. Phone review reuses those candidates with lazy reads, fresh confirmation, per-owner check coalescing, active-account eligibility and atomic versioned metadata commands. No automatic import or sheet amount update was added. Store contracts cover pending replacement, stale and duplicate decisions, ownership, terminal/import lineage, removed transactions, hidden-account reservations and the same 200-row check/list boundary. Frontend contracts cover optional navigation, exact inflows, pending/mismatch/recovery rows, transport/auth/conflict handling and preserved drafts. Full-suite, browser and release evidence is tracked in STATUS; manual acceptance is checklist 123. Existing historical-import and broader recent-action lifecycle backlog remains separate.
