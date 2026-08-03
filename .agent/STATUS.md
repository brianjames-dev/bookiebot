# Agent Status

Last updated: 2026-08-02

## Active Focus

New-month expense reports now carry the immediately prior month's last dated paycheck into Projected mode without counting it as current income, and current-month signed links rebuild live instead of reopening stale snapshots. The next step is deployment confirmation alongside the subscription, Daily Spending, monthly savings, recent-action, and reconciliation updates.

## On Deck

1. Deploy and manually verify prior-month paycheck carry-forward in Projected mode in checklist item 73.
2. Deploy and manually verify Wants subscriptions in Burn Rate in checklist item 72.
3. Deploy and manually verify selected-month subscription scoping in checklist item 71.
4. Deploy and manually verify Daily Spending bill coverage and outlier scaling in checklist item 70.
5. Deploy and manually verify the monthly savings workflow and corrected Saved-card targets in checklist items 60-61 and 69.
6. Deploy and manually verify the expense-report corrections in checklist item 67.
7. Deploy and manually verify typed `recent` opens the short-lived launcher and keeps the resulting DM session ephemeral.
8. Deploy and manually verify `View Inbox` and `Reconcile Now` show `BookieBot is typing...` without a temporary thinking message.
9. Manually verify shared Needs logging plus update/move/delete/undo behavior in Discord and Google Sheets.
10. Manually verify recent transactions and reconciliation after the latest reliability fixes.
11. Consider a richer Discord button flow for grouped amount adjustments if the current UX feels too manual.
12. Harden recent-action pending state across restarts/deploys, since selections currently live only in process memory.
13. Improve targeted recent-action search so commands can find older matches, not only the latest 10 recent actions.
14. Explore clarifying questions before logging when BookieBot is uncertain instead of guessing or silently failing.

## Completed 2026-08-02

- Added a projection-only reference to the expense-report model. When the selected month has no matching paycheck yet, it uses the immediately prior month's latest dated paycheck for amount and biweekly cadence without adding that prior transaction to Current income or the selected month's calendar.
- Inherited missing biweekly source/start configuration from the immediately prior month. This covers the live August tab, whose copied Income section has no projection configuration even though July retains the `xAI` configuration and dated paycheck history.
- Current-month matching paychecks continue to supersede the carry-forward reference, unrelated income remains actual-only, stale/mismatched/undated prior entries are ignored, completed months remain actual-only, and January can load the prior December tab from the previous annual workbook when available.
- Corrected the web serving path that could preserve a pre-fix `$0.00` projection inside the signed link's saved HTML. Current-month links now rebuild from Sheets by default and retain the saved snapshot as an error fallback; completed-month links remain snapshot-first, and `snapshot=1` can explicitly request a current-month snapshot.
- Read-only live Brian August verification resolved the July 31 `xAI` paycheck at `$3,137.49`, kept Current income at `$0.00`, and produced Projected income `$6,274.98` with projected paychecks on August 14 and 28.
- Browser verification opened a normal current-month signed URL pointing at a deliberately stale `$0.00` snapshot; the route rebuilt live and the Projected toggle showed Income `$6,274.98`, Left `$2,339.42`, Minimum `$627.50`, and Ideal `$1,255.00` with no browser errors.
- Verification: focused report suite `44 passed`; full suite `432 passed, 1 skipped`; Pyright reported zero errors; frontend typecheck/build passed; `git diff --check` passed. Manual verification is checklist item 73 below.

## Completed 2026-07-31

- Added elapsed Wants subscriptions to Burn Rate's Spent total and daily series. Each subscription is attributed to its actual pull day; future pulls stay out of Current, and schedule-less fallback amounts remain accounted for without distorting dated Food/Shopping activity.
- Updated the Burn Rate explanation to name Food, Shopping, and Wants subscriptions. Live Brian July now reconciles Burn Rate Spent, Wants Category Mix, and Wants Daily Spending at `$1,556.33`; the effective Limit is `$3,250.71`, Left is `$1,694.38`, Allowed/day is `$104.86`, and Actual/day is `$50.20`.
- Verification: focused report suite `36 passed`; full suite `425 passed`; Pyright reported zero errors; frontend typecheck/build passed; `git diff --check` passed; live browser checks confirmed all three Wants totals match. Manual verification is checklist item 72 below.
- Scoped structured subscriptions to the selected report month everywhere. Monthly items require a dated pull in that month; yearly items appear only in their configured pull month; undated drafts and yearly items from other months no longer enter cards, Category Mix, Calendar details, balances, or totals.
- Preserved the report toggle semantics inside that boundary: Current uses subscriptions that have hit through the selected month's elapsed day, while Projected uses the full dated subscription schedule for that same month.
- Rebased Needs/Wants usage, category-cascade balances, Burn Rate availability, and Left on the active month-scoped breakdown plus actual savings instead of the Budget sheet's full subscription subtotals, margins, and Net Total. Sheets without a structured subscription schedule retain subtotal fallback compatibility.
- Live Brian July verification now reconciles Spent `$5,620.89`, Needs `$4,064.56`, Wants `$1,556.33`, Saved `$2,167.14`, and Left `$3,047.68`. July subscription totals are `$229.36` Needs and `$39.96` Wants; `brianjames.dev` remains included, while October's Amazon Prime and February's MacroFactor are absent from Current and Projected.
- Verification: focused report suite `36 passed`; full suite `425 passed`; Pyright reported zero errors; frontend typecheck/build passed; `git diff --check` passed; live desktop browser checks confirmed the Current/Projected and Needs/Wants totals with the out-of-month yearly subscriptions absent. Manual verification is checklist item 71 below.
- Added entered Rent and Bills & Utilities calendar events to Daily Spending and its itemized table. They follow the existing Needs bucket, appear in All/Needs, stay out of Wants, and respect Current/Projected event timing without changing their exact dollar values.
- Replaced rent-flattened Daily Spending geometry with a conditional, explicitly labeled axis compression. It activates only when a `$500+` peak is at least `2.5x` the next-highest day, keeps values through the next-highest day linear, and reserves a short upper band for the outlier; tooltips, totals, Highest day, and table rows continue to use raw amounts.
- Live Brian July verification found Rent `$2,100.00` on day 1, Water `$141.43` on day 18, and PG&E `$165.13` on day 22. All totals `$5,620.89`, Needs totals `$4,064.56`, Wants totals `$1,556.33`, and the second-highest bar is `87.4%` of the rent bar height. Desktop and `390x844` checks found the compression note inside the chart, no document overflow, mobile Details closed by default, and no browser warnings/errors.
- Verification: focused report suite `36 passed`; full suite `424 passed, 1 skipped`; Pyright reported zero errors; frontend typecheck/build passed; `git diff --check` passed. Manual verification is checklist item 70 below.
- Migrated the live Hannah Budget 2026 July and Template tabs from three numbered paycheck savings rows to the same one-row `Enter Monthly Savings Contribution` structure already used by Brian.
- Preserved Hannah's existing `$0.00` monthly contribution, changed Ideal to the full 20% Savings allocation, changed Minimum to 10% of income, and repaired the shifted Savings subtotal, Margins, and Net Total formulas. July remains `$618.53` Net Total with `$323.89` Ideal and `$161.95` Minimum.
- Corrected the expense-report Minimum calculation to round 10% of current/projected income directly instead of halving an already rounded 20% Ideal. This removes Hannah's `$161.94` versus `$161.95` sheet/card mismatch.
- Added a penny-boundary regression for Hannah's `$1,619.47` income. Verification: focused report suite `35 passed`; full suite `423 passed, 1 skipped`; Pyright reported zero errors; targeted live formula checks and before/after PDF renders passed; `git diff --check` passed.
- The Template tabs' existing placeholder-driven `#REF!` outputs remain unchanged and visually match Brian's Template baseline; the migrated savings formulas themselves contain no formula errors.
- Manual verification is checklist item 69 below.
- Restored the five-minute `Open Recent Transactions` launcher after confirming that an immediately returned ordinary DM remains persistent and cannot carry Discord's native ephemeral footer.
- Tapping the launcher returns the recent list and selector ephemerally, deletes the launcher immediately, and retains the interaction follow-up for the remaining recent-action workflow window.
- Regression coverage verifies the ephemeral launcher/list lifecycle, multi-chunk private lists, selector placement, and DM-only acknowledgement behavior.
- Verification: focused recent/message-router suite `134 passed`; full suite `422 passed, 1 skipped`; Pyright reported zero errors; `git diff --check` passed.
- Manual verification is checklist item 66 below.
- Replaced the three numbered paycheck savings commands with one `log_savings` overwrite and one `query_savings` check for the monthly contribution bucket.
- Migrated the live Brian Budget 2026 July and Template tabs from three savings input rows to one `Enter Monthly Savings Contribution` row. July preserved the prior rows' `$1,539.64` combined actual; Template remains `$0.00`.
- Changed the single row's Ideal formula to the full Savings (20%) budget and Minimum to half of that budget (10% of income). Live July now shows `$2,167.14` Ideal and `$1,083.57` Minimum from `$10,835.71` income.
- Removed paycheck-count fields and target multiplication from the expense-report savings payload. Current and projected Ideal are always 20% of their respective income values, Minimum is 10%, and Saved remains actual in both modes.
- Retained read compatibility for historical numbered savings rows without exposing the retired numbered intents.
- Verification: focused suite `178 passed`; full suite `422 passed, 1 skipped`; Pyright reported zero errors with the project Python 3.12 environment; frontend typecheck/build passed; `git diff --check` passed.
- Live Google Sheets and browser verification confirmed the July formulas/values and the Saved card in both Current and Projected modes.
- Manual verification is checklist items 60-61 below.

## Completed 2026-07-26

- Separated savings from spending throughout the expense-report payload and UI. Needs/Wants itemization is the primary expense total, savings subtotals are excluded, and Needs/Wants subtotal totals remain a fallback when itemized rows are unavailable.
- Kept Saved actual in both Current and Projected modes while retaining projected monthly Ideal/Minimum targets. Brian July now remains `$1,539.64` Saved in both modes while Projected shows `$2,294.47` Ideal from `$11,472.33` projected income.
- Confirmed Category Mix already excluded Saved from its All/Needs/Wants spending slices and added an explicit guard so a savings row cannot enter the spending mix. Fixed `Subscriptions (Needs)` summary rows being duplicated as individual Need expenses.
- Replaced Calendar's outflow total with the month name and made the count a single spaced value such as `17 total`.
- Expanded Largest to include all shared expenses, entered bills/utilities, and elapsed subscriptions; retained every row for the expandable table and sorted both payload and frontend descending by amount.
- Applied the three-bucket category cascade to Burn Rate's effective Wants availability and added a visible transfer-impact callout. Live Brian July showed `$249.36` of Needs overspend deducted from Wants.
- Verification: focused report suite `33 passed`; full suite `421 passed, 1 skipped`; Pyright reported zero errors; frontend typecheck/build passed; `git diff --check` passed.
- Live browser verification covered Brian and Hannah July Current/Projected metrics, Calendar labels/counts, descending Largest data, Burn Rate category coverage, and clean browser logs.
- Manual verification is checklist item 67 below.
- Corrected `Left` to use the Budget sheet's cascaded Net Total instead of subtracting elapsed outflow from income. Brian July now shows `$794.00`, matching the sheet after the `$249.36` Needs overage is covered by Wants, while Spent remains the separate `$5,133.70` elapsed-outflow metric.
- Split elapsed report itemization from Budget-sheet category usage. Brian's Needs and Wants views now show `$4,098.47 / $3,849.11 (106.48%)` and `$1,266.11 / $2,309.47 (54.82%)`; Savings remains `$1,539.64 / $1,539.64`.
- Projected category budgets use a penny-safe 50/30/20 split of projected income and subtract the current sheet subtotals without projecting savings deposits. Brian Projected now shows `$4,568.11` Left and a `$2,294.47` Savings Ideal.
- Restored Calendar's original visible non-income outflow total and moved it into the subtitle beneath the month name, replacing the redundant Current/Projected label. The animated value continues to follow All/Subs and Current/Projected state; live Brian July checks showed `$2,669.89` Current All, `$263.33` Current Subs, and `$269.32` Projected Subs.
- Replaced the Saved card's mode/paycheck copy with a color-coded progress bar from zero through Minimum to Ideal. The projected toggle changes only its target scale, not the saved amount.
- Moved the generated timestamp beside the title, kept Projected immediately left of the rightmost theme control, opened Daily Spending details by default only above the desktop breakpoint, and anchored the daily pace badge beside the Burn Rate summary.
- Reworded the Burn Rate transfer callout to name the donor and covered category, and excluded Rent from Largest in both generated payloads and the frontend compatibility filter.
- Follow-up verification: focused report suite `34 passed`; full suite `422 passed, 1 skipped`; Pyright reported zero errors; frontend typecheck/build passed; live Brian Current/Projected desktop/mobile checks passed.
- Manual verification remains checklist item 67 below.

## Completed 2026-07-25

- Diagnosed the follow-up production hang after the persisted-only inbox fix: BookieBot was sending the first result through Discord's follow-up webhook, which left the original deferred `BookieBot is thinking` response unresolved.
- Changed the first inbox chunk, empty state, timeout, and failure paths to edit the original deferred response in place. Only additional report chunks use follow-up messages.
- Applied the same lifecycle rule to inbox `Ignore All` and `Unmatch` actions, while `Reconcile Now` uses a non-thinking defer because its existing workflow sends follow-up review cards.
- Added regression coverage for successful persisted reports, empty inboxes, timeout/failure paths, and inbox actions replacing their deferred response.
- Verification: focused reconciliation suite `68 passed`; full suite `414 passed, 1 skipped`; Pyright reported zero errors; `git diff --check` passed.
- Manual verification is checklist item 63 below.
- Corrected the persisted inbox preview to load its Bank cache buckets from the banking store instead of displaying the synthetic preview model's all-zero defaults.
- Reordered inbox content so unresolved review rows appear before potentially long automatic-match history, and attached unresolved inbox controls to the first response instead of the final history chunk.
- Added screenshot-shaped regression coverage proving real cache totals, unresolved transaction rows, and `Reconcile Now` / `Ignore All` controls are returned together even when the match report spans later messages.
- Verification for the data-accuracy follow-up: focused finance-ops suite `92 passed`; full suite `414 passed, 1 skipped`; Pyright reported zero errors; `git diff --check` passed.
- Manual verification is checklist item 64 below.
- Replaced reconciliation component `thinking=True` defers with silent component acknowledgements plus the normal channel-level `BookieBot is typing...` indicator for both `View Inbox` and `Reconcile Now`.
- Inbox results, caught-up notices, failures, timeouts, and inbox actions now arrive as private interaction follow-ups, so no temporary thinking placeholder is created.
- Audited recent-action buttons/selects and added regression coverage proving prompts, ownership rejections, and action results are ephemeral. Ordinary messages initiated from typed DM text require an interaction bridge to carry Discord's ephemeral footer.
- Verification: focused reconciliation/recent suite `203 passed`; full suite `417 passed, 1 skipped`; Pyright reported zero errors; `git diff --check` passed.
- Manual verification is checklist item 65 below.
- Added a five-minute `Open Recent Transactions` launcher for typed recent-action requests. The launcher carries no transaction data, is scheduled for deletion, and deletes immediately after opening the ephemeral list.
- Retained the active interaction follow-up for ten minutes so typed `show more`, update values, missing move items, cancellations, expiration notices, and subsequent recent-action results stay ephemeral throughout the workflow.
- Suppressed `I sent your recent transactions list to your DMs.` when the request already originated in a DM; channel-originated requests still receive that acknowledgement.
- Verification: focused recent/message-router suite `135 passed`; full suite `418 passed, 1 skipped`; Pyright reported zero errors; `git diff --check` passed.
- Manual verification is checklist item 66 below.

## Completed 2026-07-24

- Diagnosed the production `View Inbox` hang from the post-defer path: the button was starting a fresh Plaid sync, reconciliation preview, action-log read, schedule-sheet read, and match hydration instead of displaying the state already persisted by the 7:00 AM digest.
- Added a persisted-only inbox builder that reads unresolved and matched reconciliation items from the banking store and formats the report without Plaid sync or Google Sheets access.
- Preserved match source classification from stored action/sheet lineage even when the fast inbox path intentionally skips source hydration.
- Added a configurable `BOOKIEBOT_RECONCILIATION_INBOX_TIMEOUT_SECONDS` ceiling (15 seconds by default) and guaranteed private timeout/error responses so Discord cannot remain indefinitely in `BookieBot is thinking` after a failed load.
- Added regression coverage proving `View Inbox` does not invoke sync/rescoring, still returns recent automatic matches, preserves inbox actions, and finishes the deferred response when preparation fails.
- Verification: focused reconciliation suite `66 passed`; full suite `412 passed, 1 skipped`; Pyright reported zero errors; `git diff --check` passed.
- Manual verification is checklist item 62 below.

## Completed 2026-07-22

- Fixed the reconciliation digest `View Inbox` callback to create an explicit private deferred response before loading the inbox, so Discord acknowledges the component and the follow-up renders reliably.
- Added a callback-level regression test that invokes the real digest button, verifies the private thinking defer, and confirms inbox dispatch.
- Added third-paycheck savings intents, parser guidance, intent-explorer entries, handlers, sheet checks, sheet logging, and undo metadata.
- Generalized savings-row discovery across first, second, and third paycheck rows, reading each row's Actual, Ideal, and Minimum values while retaining compatibility with the older two-row shared-target layout.
- Added a report savings-projection payload that tracks saved amounts, Ideal/Minimum totals, and applicable paycheck counts. The original contribution-estimation behavior was superseded on 2026-07-26; Projected now changes targets without estimating future saved dollars.
- Added the Savings Category Mix view and Saved-card paycheck/Ideal/Minimum context. The 2026-07-26 follow-up keeps Saved actual and out of Spent/outflow totals while reserving the actual saved amount from Left in both modes.
- Read-only live-sheet inspection confirmed both Brian and Hannah July tabs and Templates contain three savings rows; legacy May/June two-row tabs remain supported.
- Corrected the first three-paycheck projection, which multiplied an already income-scaled target once per savings row and incorrectly turned the monthly 20% Ideal into 30%. Brian July now projects Ideal `$2,294.47` and Minimum `$1,147.23` from `$11,472.33` income.
- Historical browser verification covered the original projected-contribution behavior; current expected values and live verification are recorded in the 2026-07-26 section.
- Verification: `410 passed, 1 skipped`; Pyright reported zero errors; frontend typecheck/build passed; `git diff --check` passed.
- Manual verification steps are checklist items 59-61 below.

## Completed 2026-07-17

- Fixed Income descriptions so parser payloads that repeat the same Source and label, such as `xAI` / `xAI`, write one clean Source value instead of `xAI xAI`.
- Changed the Income-row lifecycle so a Template starts with one seed row, the first entry consumes it, and later BookieBot entries insert a formatted row only when the transaction is logged; completed Income tables no longer retain a blank placeholder.
- Updated the Apps Script to stamp manual Income dates and repair the Monthly Income formula without appending a placeholder row.
- Corrected Brian July's live `7/17/2026` Income row to Source `xAI`, removed the extra `<Enter Source>` row, and verified that Monthly Income remains `$7,698.22`, the Budget formula now follows `D8`, and the biweekly configuration remains intact.
- Added regression coverage for repeated/overlapping Source-label values, seed consumption, just-in-time row insertion and property copying, no-placeholder Apps Script behavior, and Income delete/undo summary formulas.
- Verification: `398 passed`, Apps Script syntax check passed, `git diff --check` passed, and Pyright reported zero errors.
- Reworked current-month biweekly Income projections so the configured start date bootstraps the cadence, then the latest dated paycheck from the configured source becomes the anchor for future 14-day occurrences.
- Live Brian July report verification now shows actual xAI paychecks on July 2 and July 17 plus the remaining projected paycheck on July 31; regression coverage also confirms an early July 15 paycheck moves the next projection to July 29.
- Calendar-fix verification: `400 passed`, `git diff --check` passed, and Pyright reported zero errors.
- Manual verification: after deployment, open Brian's current expense breakdown and confirm the calendar shows July 2 and July 17 as actual xAI Income plus July 31 as the only remaining projected paycheck.
- Fixed report chart tooltips so their Recharts wrapper retains its last valid transform while briefly inactive; the next hover now animates from the prior data point instead of flying in from the chart's top-left corner.
- Rebuilt the embedded report assets and added a regression marker assertion; focused report tests, frontend type-checking, and the production build pass.
- Manual verification: after deployment, hover non-adjacent bars/slices with a brief gap between points and confirm the tooltip resumes from its last position while adjacent point-to-point movement remains smooth.
- Tooltip-fix verification: `400 passed`, frontend and Python type checks passed, the Vite production build passed, and `git diff --check` passed.
- Corrected the tooltip anchor follow-up so Recharts cannot immediately hide cached tooltip content: the last active payload now stays visible through the five-second hold, fades for 180 ms, and then hides.
- Delayed transform animation until after the first real tooltip anchor is painted, removing the initial top-left fly-in while retaining smooth point-to-point and post-gap motion.
- Local browser verification covered first hover, sequential movement, re-entry from empty chart space, full-opacity hold through five seconds, the fade phase, and final removal.
- Tooltip-lifecycle verification: `400 passed`, Pyright reported zero errors, frontend typecheck/build passed, and `git diff --check` passed.
- Reduced the Discord expense-breakdown response to its heading, Total Spent, signed full-report link, and attached pie chart; category amounts and percentages remain available in the web report instead of being duplicated in message text.
- Added an exact-response regression test that also confirms the full non-zero category dataset still reaches the pie-chart renderer.
- Manual verification: request an expense breakdown in Discord and confirm the reply contains only the concise summary text plus the pie-chart attachment, while the linked web report retains the complete breakdown.
- Concise-reply verification: `400 passed`, Pyright reported zero errors, and `git diff --check` passed.
- Replaced Category Mix's fixed desktop radius/margins with a measured layout that fits the donut, connector stems, label gap, rendered label widths, and per-category x/y deltas inside the chart host.
- Matched Recharts' real sector start/end/padding-angle math and re-centers the full visual envelope after chart or details-panel resizing, retaining at least 16px requested padding in collapsed and expanded states.
- Local browser verification used the reported ten-slice Brian category mix and found zero label/stem boundary violations with 17px minimum measured clearance in both the 460px collapsed host and 342px expanded host.
- Manual verification: after deployment, open and expand/collapse Categories in Brian's July report and confirm every stem and label stays inside the chart border with visible edge padding.
- Category-envelope verification: `400 passed`, Pyright reported zero errors, frontend typecheck/build passed, and browser geometry checks found zero boundary violations.
- Category Mix Needs and Wants views now add an `Income left` slice from their Budget-sheet Rollover values, including the sequential Needs-to-Wants carryover already encoded by the sheet formulas.
- Negative category rollover renders as a compact overspend bar instead of an invalid pie slice; Wants explicitly shows when Needs overspend has already reduced its available rollover.
- Projected mode recomputes the same 50% Needs then 30% Wants rollover cascade from projected income and category totals.
- Local browser verification confirmed July's `$35.56` Needs and `$1,660.04` Wants slices, plus a simulated `$500.00` Needs overspend reducing Wants to `$1,160.04` with zero chart-bound violations.
- Manual verification: after deployment, switch Category Mix between Needs and Wants, then test a category overspend and confirm the selected rollover slice/bar and cross-category impact match the Budget sheet.
- Category-rollover verification: `401 passed`, Pyright reported zero errors, frontend typecheck/build passed, and browser checks covered positive, overspent, impacted, and projected states.
- Category Mix now applies a source-aware three-bucket cascade from the Budget sheet's raw Needs, Wants, and Savings margins instead of relying on the sheet's fixed cumulative rollover order.
- Needs overspend draws from Wants then Savings; Wants overspend draws from Savings then Needs; over-saving draws from Wants then Needs. A remaining deficit after all donors reach zero becomes whole-budget overspend.
- Added a Savings Category Mix tab with Saved and Income left slices, plus red source-overspend alerts, amber donor-impact alerts, and an All-tab budget-overspend alert.
- Local browser verification confirmed live July balances of `$35.56` Needs, `$1,624.48` Wants, and `$1,539.64` Savings; simulated Wants overspend reduced Savings to `$1,064.12` without touching Needs, and over-saving consumed Wants before Needs.
- Manual verification: switch Category Mix through Needs, Wants, and Savings, test each source category over its allocation, and confirm the donor-impact amounts follow the category-specific priority before All reports total overspending.
- Three-bucket cascade verification: `404 passed, 1 skipped`, Pyright reported zero errors, frontend typecheck/build passed, and browser checks covered every donor order, projected mode, total overspend, and chart containment.
- Chart carousel switches now put any open Recharts tooltip into its existing 180 ms fade, cancel its five-second hold timer, and suppress cached payloads from the newly selected graph until the user deliberately moves or presses inside that graph.
- Local browser verification opened a Burn Rate tooltip, switched to Category Mix, confirmed no stale or arbitrary tooltip remained after the transition, then switched back and confirmed a fresh Burn Rate hover rendered the correct data.
- Carousel-tooltip verification: `404 passed, 1 skipped`, Pyright reported zero errors, focused report tests passed, and frontend typecheck/build passed.
- Extended the shared tooltip-dismissal provider across the full report and connected every data-view selector: Projected mode, Category Mix, Calendar, Daily Spending, and Expense Highlights.
- Local browser verification confirmed Daily Spending All-to-Needs hides the open tooltip and reactivates with only the filtered Needs value; Category Mix All-to-Needs increments the same dismissal lifecycle and leaves no stale tooltip behind.
- Toggle-tooltip verification: `404 passed, 1 skipped`, Pyright reported zero errors, frontend typecheck/build passed, all five dismissal triggers are embedded in generated reports, and the browser console remained clean.
- Calendar All/Subs switching now preserves the mounted month shell and day cells, animates only event markers whose visibility changes, and crossfades the outflow total/count without reanimating the month or Current/Projected labels.
- Calendar transition verification: `404 passed, 1 skipped`, Pyright reported zero errors, frontend typecheck/build passed, and a local browser fixture confirmed one stable calendar node, collapsed non-subscription markers, updated `$2,451.32` to `$126.32`, unchanged July/Current labels, and a clean console.
- Category Mix now carries the prior fitted pie center into each All/Needs/Wants/Savings view and glides the stable Recharts pie group to the new fitted center over the same 520 ms window as the slice morph, instead of snapping positions.
- Category Mix motion verification: `404 passed, 1 skipped`, Pyright reported zero errors, frontend typecheck/build passed, and a full browser fixture confirmed bounded 7 px, 25 px, and 124 px layout travel plus clean rapid-toggle settlement and console output.
- Removed the Category Mix transition hiccup by isolating wrapper motion state from the memoized Recharts pie surface and setting the sector animation delay to zero, so center travel and slice interpolation begin together without mid-morph reconciliation.
- Added an 80 ms post-animation settle window before releasing the wrapper phase; browser frame sampling showed 17 consecutive changed sector frames followed by one stable tail with no freeze-and-resume, and the full `404 passed, 1 skipped` suite plus Pyright and frontend checks pass.
- Manual verification: switch Category Mix between All, Needs, Wants, and Savings and confirm the pie glides and reshapes as one continuous motion, with no delayed start, pause, or second burst of slice resizing.
- Daily Spending All, Needs, and Wants now render solid foreground-colored top/bottom boundaries and matching X-axis labels, while Y-axis labels and every interior gridline retain the theme's muted grey.
- Interior lines now explicitly share identical `1px` width, `3 3` dash spacing, and butt caps; browser-computed SVG checks confirmed the color and pattern split in all three filters with a clean console, while `404 passed, 1 skipped`, Pyright, frontend typecheck/build, focused report tests, and `git diff --check` pass.
- Manual verification: switch Daily Spending through All, Needs, and Wants in both themes and confirm the top/bottom boundaries plus X labels use the foreground tone, while Y labels and consistently sized dotted interior lines remain grey.
- Unified blue Needs and purple Wants bars on the blue bar's `2px` four-corner radius in stacked and filtered Daily Spending views; a focused source regression prevents any of the three bar definitions from drifting to a separate radius again.
- Radius verification: browser SVG paths confirmed identical `A 2,2` corner arcs for both colors across All, Needs, and Wants with a clean console; `405 passed, 1 skipped`, Pyright, frontend typecheck/build, focused report tests, and `git diff --check` pass.
- Manual verification: compare blue and purple Daily Spending bars in All, then switch through Needs and Wants and confirm every visible bar has the same subtle corner rounding.

## Completed 2026-07-16

- Replaced personal-budget Need row insertion with normal shared-expense logging in the monthly Needs section (`AD:AH`).
- Need logging now separates item, location, person, and amount while applying the automatic shared-expense date.
- New Need rows now use standard expense lineages and support item/amount/location/person updates, moves into or out of Needs, delete compaction, undo, and reconciliation-link reopening.
- Added Needs to move buttons, direct text routing, and bank reconciliation expense categories.
- Included Needs in category totals, highest-category, largest-expense, and top-expense queries.
- Added regression coverage for storage location, legacy description compatibility, editable fields/capabilities, move/delete/undo behavior, category routing/selectors, parser instructions, and Needs query inclusion.
- Shifted the Brian Budget 2026 Template Income table from `A:C` to `B:D`, repaired the monthly-income total and budget-banner formula lineage, and preserved the adjacent biweekly-income configuration.
- Made income logging discover Date, Source/Employer, and Amount from visible headers so existing legacy month tabs and newly copied dated Template tabs both work during rollout.
- Added bot-side Pacific-date stamping, reconciliation transaction-date propagation, recent-action/update compatibility, and header-driven Apps Script date stamping for manual Income entries.
- Migrated the May, June, and July tabs in both Brian and Hannah Budget 2026, plus Hannah's Template, to the `B:D` Date/Source/Amount layout without changing the existing source/amount data or monthly totals.
- Backfilled Income dates only where a matching BookieBot action timestamp provided reliable history, preserved Brian July's xAI biweekly configuration, and migrated action-log column metadata/row references for the new locations.
- Updated the expense breakdown parser to read the Income table from its visible headers, including income rows that share a sheet row with biweekly configuration labels.
- Income actions remain editable after an update and can now be deleted with row compaction; undo reinserts the row and restores the full active lineage and affected action-row references.
- Discord typing-indicator API failures are now non-fatal, so a transient Discord `5xx` cannot abort intent parsing or prevent an otherwise valid transaction from being logged.
- Added regression coverage for failed typing-context entry and for preserving real parser/handler exceptions through the typing wrapper.
- Reduced the live Brian Budget 2026 Template Income section to one `Date / Source / Amount` placeholder row while preserving its formatting, validation, notes, total formula, and budget-banner reference.
- Income logging now fills the Template seed in place and inserts later rows with inherited formatting only when a new event is logged; the summary formula is repaired after each append and no permanent trailing placeholder remains.
- The Apps Script stamps manual Income dates and repairs the summary formula for source-first or amount-first entry order without creating an extra blank row.
- Reduced the live Hannah Budget 2026 Template Income section to one `<Enter Source>` row while preserving its style, validation, notes, Monthly Income formula, budget-banner reference, and adjacent biweekly configuration.
- BookieBot now reapplies the seed row's explicit formatting, validation, notes, borders, and row height after Google Sheets inserts a new Income row, covering properties that `inheritFromBefore` omits.
- Live Hannah integration verification logged two sequential dated Income entries on a temporary Template copy, verified inherited row properties and the `$191.34` total, and removed the temporary QA tab afterward.
- Income delete and immediate undo now snapshot and restore anchored biweekly configuration cells, explicit row properties, and the Monthly Income summary formula while compacting whole rows.
- Live Brian July verification on a temporary copy covered first-row delete/undo, later-row delete/undo, and immediate undo; every path preserved the `E:F` configuration, repaired the `D` summary formula, and restored the original sheet values/formulas exactly before the QA tab was removed.
- Replaced Hannah's live two-block Subscriptions tab with Brian's native four-block Needs/Wants Monthly/Yearly layout, preserving all eight Needs and three Wants entries as monthly data plus the `$180.20` and `$23.97` subtotals.
- Extended Brian's Needs Monthly body styling through Hannah's eighth row, repaired Template/May/July references to the new Monthly+Yearly subtotal cells, retained the old tab as a hidden backup, and kept unknown pull dates blank instead of inventing them.
- Live Google Sheets and PDF-render verification confirmed matching reference styles, correct formulas/totals, parser-ready block structure, hidden infrastructure tabs, no broken cell formulas, and no remaining staging sheet.
- Subscription schedule sync now retains rows with valid cadence/name/amount but unknown pull dates as normalized drafts; reminder readers continue to exclude those drafts until `pull_day` is populated.
- After Hannah removed Amazon Prime, repopulated her live `_BookieBot Subscription Schedule` with all ten current monthly rows, blank date fields, source ranges, and timestamps; current visible subtotals are `$163.94` Needs and `$23.97` Wants.
- Replaced Hannah's visible subscription roster from the final dated list: seven monthly Needs, one yearly Need, five monthly Wants, and one yearly Want; visible subtotals are `$521.07`, `$32.99`, `$47.95`, and `$59.99` respectively.
- Synced all fourteen dated entries into `_BookieBot Subscription Schedule` with cadence, amount, pull day/month, source range, and timestamp metadata; every row is reminder-eligible and a repeat sync produced no warnings.
- Restored Internet as a `$0.00` Needs Monthly placeholder with a blank pull day; the normalized schedule retains it as an undated draft while the fourteen dated subscriptions remain reminder-eligible.
- Removed the standalone `Student Loan Payment` budget row from Hannah's Template, May, June, and July tabs; each tab compacted cleanly, retained its subscription-backed Needs row, and automatically shifted subtotal, rollover, margins, savings, and net formulas to the new locations.
- Retired the dedicated student-loan log/check intents, handlers, sheet helpers, intent-explorer entries, fixtures, and legacy default bill-schedule row; pre-existing student-loan bill rows are ignored so the payment is represented only by subscription autopay, while historical report categorization remains available.
- Manual verification: deploy the updated Apps Script, run `setupBudgetSystemAutomation()` once, enter an amount in a new dated Income table, then confirm manual and BookieBot income dates plus update/delete/undo behavior.

## Completed 2026-07-09

- Added `app_conversion_blueprint/` as a standalone iOS app conversion handoff package that can be copied into a new repository without touching the current Discord bot runtime.
- Captured the local-first app architecture, assistant tool framework, database-first data model, Plaid bridge boundary, Google Sheets export direction, BookieBot porting map, roadmap/backlog, risks, and source references.
- Added a copy-ready `repo-template/` with starter agent instructions, backlog, ADR template, and placeholders for `ios/`, `server/`, and `shared/contracts/`.
- Updated the app-conversion AI strategy so the primary assistant target is a downloadable Qwen 4B-class local model pack offered during onboarding, with Apple Foundation Models retained as fallback/lightweight mode.

## Completed 2026-07-08

- Reconciliation `View Inbox` now includes recent persisted automatic matches when a forced inbox refresh no longer has those matches in the fresh preview.
- Auto-match-only reconciliation inbox reports no longer show `Reconcile Now` / `Ignore All` actions, avoiding a misleading action view when there are no unresolved rows.
- Expense breakdown Discord replies keep signed report tokens but render them behind a short `Open full report` markdown link.
- Expense report top charts now use a carousel instead of the four-chart tab bar; mobile can swipe between charts and desktop has previous/next controls with active indicators.
- The `Subs` chart now uses an inline All/Needs/Wants filter, highlights the current day, animates calendar switches, shows hit-so-far subscription totals with a projected monthly total, and keeps subscription detail tables collapsed behind `Details`.
- Current/future-month subscription category totals now use scheduled hit-so-far subscription amounts from the Subscriptions sheet, while completed months keep using the Budget sheet totals.
- The Income card now has a temporary `2x` paycheck forecast toggle that updates income-dependent top-card values client-side.
- Expense Highlights now places its Largest/Most Frequent toggle in the card header, and table expanders append remaining rows with the collapse control at the bottom.
- Rebuilt the embedded React expense report assets and added regression coverage for the short report link, reconciliation auto-match inbox behavior, and the new report UI hooks.

## Completed 2026-07-07

- Expense report pages now support system-aware dark mode with a header toggle that persists manual light/dark choices.
- Rebuilt the embedded React expense report assets and added regression coverage for the dark-mode toggle, persisted theme key, and system preference CSS.
- Expense report tabs now size to their labels instead of stretching, Amount Saved only uses the positive accent when it is near the savings goal, loose personal-budget NEED rows appear as `Need Expenses`, and the old bottom Rent and Income Entries tables have been removed.
- Bills & Utilities now renders a historical comparison chart from prior budget month tabs, and the largest-expenses chart truncates long item labels on the axis.
- The top `Budget Charts` card now replaces the old `Needs vs Wants` tab with `Subscriptions` and `Bills & Utilities` tabs, removing the duplicate lower Subscriptions and Bills & Utilities cards.
- Expense report display copy now shortens subscription labels to `Subs` in Budget Charts and category breakdown labels while preserving the original spreadsheet labels for parsing.
- Expense report top metrics now remove the Fixed Commitments and Burn Rate cards; Budget Charts panels now place their primary totals/status above each graph with right-aligned pills for Burn Rate, Subs, and Bills & Utilities.
- Expense report links now serve the saved HTML snapshot before attempting a live Google Sheets rerender, optional historical workbook reads no longer block reports after the month tabs are resolved, and the Discord handler reports sheet access errors cleanly.
- Expense report dashboard now uses four top cards (`Income`, `Spent`, `Left`, `Saved`), defaults Budget Charts to Burn Rate when available, and moves secondary chart stats and long tables behind `Details` / `View all`.
- Discord startup now logs each login attempt, respects retry-after hints on login rate limits, emits periodic backoff progress logs, and preserves retry metadata in JSON logs with real microsecond timestamps.
- Expense report pages no longer render the top burn-rate signal strip; loose personal-budget NEED rows are included in daily activity, merchant totals, and largest-expense highlights as undated Need Expenses; expanded highlight tables now reveal only the remaining rows instead of duplicating the first five.

## Completed 2026-07-06

- Expense report top metrics now replace the redundant `Personal Outflows` card with `Fixed Commitments`, calculated from rent, bills/utilities, subscriptions needs, and subscriptions wants.
- Expense report pages now combine `Largest Expenses` and `Frequent Merchants` into one `Expense Highlights` toggle card, with a chart and itemized list for each view.
- The `Largest Expenses` itemized list now uses only Item, Category, and Amount columns.
- Expense report subscription tables now include all active subscriptions from the Subscriptions sheet, including yearly items outside the selected report month such as Amazon Prime and MacroFactor, while fallback monthly bucket totals remain selected-month scoped.
- Rebuilt the embedded React expense report assets and added regression coverage for fixed commitments, subscription table completeness, and the combined expense highlights card labels.
- Expense report subscriptions now render as one tabbed Needs/Wants card with a selected-month calendar visual above each source-of-truth itemized list; monthly subscriptions appear in the selected month, while yearly subscriptions only appear on the calendar for their pull month.
- Pyright is now installed through `requirements.txt` with a source-focused `basic` config, and the source modules touched to satisfy the initial gate now pass `python -m pyright`.
- Expense report copy is more compact, generated time moved into the header pill, Expense Highlights now uses `Largest` and `Most Frequent` tab labels, Daily Spending bar hover uses a clearer highlighted cursor, and the Subscriptions card now defaults to an `All` calendar tab alongside Needs and Wants.
- Expense report Subscriptions `All` mode now shows compact side-by-side Needs and Wants itemized tables on desktop, stacks them on mobile, and calendar markers use visible hover/focus tooltips instead of unreliable native title text.
- Expense report subscription tables now omit the `Kind` column, All-mode compact tables include `Pull Date`, subscription tab switches use a subtle fade/slide animation, and the side-by-side All tables stay top-aligned even when one table is shorter.

## Completed 2026-07-05

- Daily Spending transaction category labels now use the same category colors as the expense breakdown pie chart.
- Expense report top metrics now render in the requested order: Monthly Income, Monthly Expenses, Personal Outflows, Burn Rate, Remaining Needs Budget, Remaining Wants Budget, Amount Saved, and Income After Expenses.
- Remaining Wants Budget is pulled from the second money value on the Budget sheet margins row, and Amount Saved sums the column `E` values on the `Enter 1st Paycheck Deposit` and `Enter 2nd Paycheck Deposit` rows while ignoring the separate savings total row.
- Daily Spending chart average now divides shared spending by elapsed days for the selected month, using the full calendar month only for completed months.
- Google Apps Script monthly rollover now snapshots previous-month personal budget Burn Rate and subscription total formula outputs into static cell values before creating/relinking the new month.
- Monthly tab creation no longer fails when a copied template is missing the exact `Month` placeholder; it falls back to a top-left existing month label and logs instead of aborting if no label can be found.
- Expense breakdown report pages now include a `Burn Rate` tab in the Budget Charts toggle, with a comparison chart for actual food plus shopping spend, expected spend, and the selected month's remaining-wants-budget-derived target.
- Rebuilt the embedded React expense report assets and added regression coverage for the burn-rate payload math.
- Spreadsheet access errors now include the active service account email when available, making deployed Google Sheets permission or credential mismatches easier to diagnose.
- Daily Spending chart now appears at the top of the Daily Spending transaction card instead of inside the Budget Charts toggle.
- Burn Rate now renders as a full-month daily variance line chart with a zero baseline, red over-pace values above zero, and green under-pace values below zero.
- Burn Rate chart rendering now uses continuous day-to-day colored segments so the mobile line does not visually disconnect when switching between over-pace and under-pace days.
- Burn Rate tooltips now render one active-day variance row and shared chart tooltips filter duplicate payload rows, preventing duplicate values from accumulating while tapping nodes on mobile.
- Burn Rate tooltips now explain each selected day with day spent, cumulative spent, and expected-by-day values, while the static side stats no longer duplicate expected spend against the monthly wants target.
- Burn Rate tab now removes the redundant title/description side copy and uses a smoothed animated line chart so first-open behavior matches the other Recharts views more closely.
- Category Mix pie slices now label category plus dollar amount directly, and the burn-rate line uses a smooth baseline-aware gradient so over-zero sections render red and under-zero sections render green.
- Burn Rate hover dots now match the hovered point's over/under baseline color, report chart tooltips disable wrapper position animation, and Category Mix pie labels plus connector lines fade in smoothly with matching slice colors and text/stem spacing.
- Category Mix hides pie labels and connector stems on phone widths while keeping the full-size donut, and Burn Rate only plots elapsed days for the selected current month while keeping the `$0` baseline inside the chart domain.
- Merchant analysis shows the top 10 merchants and no longer appears as a Budget Charts tab or side-stat panel.
- The Spending By Person / Card panel has been removed, and zero-dollar paycheck savings deposits now render Amount Saved as `$0.00` instead of `N/A`.

## Completed 2026-07-03

- Expense breakdown report pages now define a browser-safe `window.process.env.NODE_ENV` shim before loading the embedded React bundle.
- The expense report Vite build now replaces `process.env.NODE_ENV` with `"production"`, preventing Node-style dependency checks from crashing report pages in Chrome.
- Rebuilt the committed React expense report asset and added regression coverage for the process shim in rendered report HTML.
- Expense breakdown report mobile styling now uses a shared responsive page gutter for the header and content cards.
- Report cards, grids, tabs, charts, and table wrappers now shrink within the viewport on narrow phones, with dense tables scrolling inside their cards instead of pushing the page sideways.
- Expense report metric cards now render two per row on narrow mobile, producing three compact rows without overflowing 320px-wide viewports.

## Completed 2026-06-20

- User-entered date updates are no longer accepted in the recent transaction update flow; the date field is reserved for reconciliation-origin automation that can use the bank transaction date.
- Recent-action update, move, delete, and undo paths now reopen linked reconciliation items by action-log ID so confirmed/matched bank items do not stay stale after the sheet row changes.
- Reconciliation action-link reopening supports grouped match IDs such as `id1+id2`.
- Normal unresolved reconciliation inbox/digest/session views now use a 60-day max transaction age through `BOOKIEBOT_RECONCILIATION_MAX_AGE_DAYS`.
- Old unresolved reconciliation records remain in storage, but they are excluded from normal unresolved review views unless lower-level/admin code asks without an age cutoff.
- Added regression tests for date rejection, reconciliation reopen hooks after recent-action mutations, grouped action-link reopening, and the 60-day unresolved-item cutoff.
- Existing-row reconciliation amount mismatches are resolved by the user's match confirmation: once the user chooses the matching row, BookieBot updates the sheet amount to the bank transaction amount and confirms the reconciliation item.
- Added regression coverage proving single-row mismatch confirmation updates the matched sheet/action row to the bank amount after the user selects the match.
- Recent-action move prompts now explain when an item name is needed because the destination category requires it.
- Pending move-item replies can now be canceled without using `cancel` as the item name.
- Recent-action move no longer asks users to supply missing dates manually; missing source-row dates produce a system/source-row correction message.
- Move category buttons now omit the transaction's current category and use source-category-aware prompt copy.
- Grouped reconciliation amount mismatches now offer a normal button-based adjustment path: choose one selected row to absorb the delta, update it to the bank-total-compatible amount, and confirm the group.
- Added regression coverage for grouped match adjustment, adjustment buttons, and updated mismatch guidance.
- One-word `recent` now routes directly to recent transactions instead of falling through to LLM parsing.
- Expense sheet access now retries once before failing, which protects normal expense logging from a transient Google Sheets access miss.
- Updated income recent-action rows now display as income and keep the amount/source in the correct fields after source-only updates.
- Large recent-action DM lists are now split into Discord-safe chunks by complete transaction blocks, with controls attached to the final chunk and a generic channel acknowledgement after successful DM delivery.

## Completed 2026-06-18

- Updated expenses can now be moved to another expense category.
- Already moved expenses can now be moved again.
- Deleting an updated expense now deletes the active action lineage, so the original expense does not reappear in recent actions after deletion.
- Deleting a moved expense now deletes the active moved lineage without reactivating stale source actions.
- Undoing those deletes restores the expected sheet rows and action visibility.
- Added regression tests for updated-action move, moved-action move, updated-action delete, and moved-action delete.
- Added explicit recent-action capabilities for update, move, delete, undo, and editable fields.
- Recent-action decision buttons now only show supported operations for the selected transaction.
- Unsupported delete/move/update paths now return clearer reasons for Need expense, payment, savings, and other unsupported cases.
- Income rows can now be updated for source/amount and deleted from recent transactions.
- Added regression tests for capability computation, button visibility, income update, and income deletion.
- Added 300-second TTLs for pending recent-action selections, pending update-field replies, and pending move-item replies.
- Expired pending replies now return a clear "selection expired" message instead of falling through to unrelated commands or current recent-action indexes.
- Added regression tests for expired pending delete selection, expired update-field replies, expired move-item replies, and router numeric replies.
- Recent-action lists, candidate prompts, mutation prompts, and mutation results now send privately to the requesting user when Discord DMs are available.
- Recent-action component responses are now ephemeral, and controls reject interactions from users other than the original actor.
- Added regression tests for private recent-action delivery and non-owner interaction rejection.
- DM replies to recent-action update prompts are now accepted even when BookieBot is restricted to a configured public channel.
- Recent-action component view timeouts now match the 300-second pending-state TTL.
- Added regression tests for DM update-field replies and five-minute component view timeouts.
- Reconciliation digest channel messages now show only a generic count/summary and instruct the target user to review privately.
- Daily reconciliation digest eligibility is now limited to the configured morning send window instead of any time after the send hour.
- Added regression tests proving after-window Plaid/new-item availability does not post a daily digest later in the day.
- Reconciliation digests now send by DM with `Reconcile Now` and `View Inbox` controls.
- Reconciliation `Ignore All` now lives only on the inbox list view, not on each individual transaction review.
- Bills and subscriptions digests now send by DM instead of posting cash-pull details to the shared channel.

## Current Notes

- The broader backlog now lives in `.agent/WORKSTREAM_FINANCE_OPS.md`.
- The task execution/update process lives in `.Agents`.
- Reconciliation freshness and digest lifecycle remain important, but they are not the immediate implementation focus.
- Structured event logging is deferred. Railway/app logs are enough for now unless future debugging gaps prove otherwise.
- We decided not to add a stale status right now; normal unresolved review uses the 60-day freshness filter only.
- The current recent-action tests pass for existing happy paths:
  - listing and paging
  - updating normal expense fields
  - deleting normal expenses with compaction
  - moving normal expenses with compaction
  - undoing update/delete/move

## Manual Test Checklist

Use a test row or low-risk real row in Discord:

1. Log a food expense, then update its amount, then move it to shopping.
   - Expected: food cells clear, shopping receives the updated amount, recent actions show the moved transaction.
2. Log a grocery expense, move it to food, then move it again to shopping.
   - Expected: grocery and food cells clear, shopping contains the transaction once.
3. Log two food expenses, update the older one, then delete the updated one.
   - Expected: the other food expense shifts up, the deleted/updated one does not reappear in recent actions.
4. Immediately run `undo last transaction` after that delete.
   - Expected: the updated deleted row is restored and appears as the current recent action again.
5. Log a grocery expense, move it to food, then delete the moved expense.
   - Expected: the food row clears and the old grocery source does not reappear.
6. Run `undo last transaction`.
   - Expected: the moved food row is restored.
7. Log income, then select it from recent actions.
   - Expected: `Update`, `Delete`, and `Cancel` are offered; `Move` is not shown.
8. Update a recent income row's source and amount, then undo it.
   - Expected: the income sheet source and amount change, then undo restores the original values.
9. Delete a recent income row by index, then undo it if needed.
   - Expected: the logged income row is removed from the income sheet.
10. Select a recent payment or savings deposit.
   - Expected: `Update` and `Cancel` are offered, while move/delete controls are not shown.
11. Ask to delete a matching transaction, wait more than 5 minutes, then type `1`.
   - Expected: the bot says the recent transaction selection expired and does not delete anything.
12. Start an update from the controls, wait more than 5 minutes at the "Reply with the new ..." prompt, then reply.
   - Expected: the bot says the recent transaction selection expired and does not update the row.
13. Move a grocery/gas transaction to food without an item, wait more than 5 minutes, then reply with an item name.
   - Expected: the bot says the recent transaction selection expired and does not move the row.
14. Run `recent actions` from Discord.
   - Expected: the transaction list appears in your DM, while the channel only receives a generic acknowledgement.
15. Click a recent-action control from the DM workflow.
   - Expected: follow-up prompts/results are only visible to you.
16. Select `Update`, choose `Item`, `Amount`, or `Location`, then reply in the DM with the new value.
   - Expected: the selected transaction updates and the reply is not ignored or routed to unrelated intent parsing.
17. Have another user try to operate on a recent-action component from your workflow if a stale/public component exists.
   - Expected: the bot says the workflow belongs to another user and does not mutate anything.
18. Let the scheduled reconciliation digest post in the morning window.
   - Expected: the digest appears in the target user's DM with `Reconcile Now` and `View Inbox`.
19. Click `View Inbox` on the reconciliation digest.
   - Expected: the DM/private inbox list shows unresolved transactions with `Reconcile Now` and `Ignore All`; if the digest only has automatic matches, the inbox shows the confirmed match report without unresolved action buttons.
20. Run the expense breakdown command for the current month and for a completed prior month.
   - Expected: the report link appears as a short `Open full report` link and opens a page whose top chart card title changes with the active carousel chart (`Category Mix`, `Burn Rate`, `Calendar`, or `Bills & Utilities`); mobile can swipe between charts and desktop can use previous/next controls plus active indicators; the Burn Rate chart keeps the red/green variance behavior and cursor-stable tooltip; Category Mix labels show category plus amount on desktop and hide labels on phone widths; the Projected toggle immediately updates income-dependent top-card values; Calendar has an inline All/Subs filter, shows the month name instead of an outflow total, uses a spaced `# total` pill, highlights the current day, and keeps itemized subscription tables collapsed behind `Details`; Expense Highlights keeps its Largest/Most Frequent toggle in the card header; table expanders append remaining rows and place Collapse at the bottom; Daily Spending has no subtitle copy and its bar hover has a subtle highlighted background.
21. If the expense breakdown command reports that a spreadsheet cannot be opened.
   - Expected: the error includes the active Google service account email so the spreadsheet share settings or deployment credential can be checked directly.
22. Click `Reconcile Now` from either the digest or inbox view.
   - Expected: the one-at-a-time transaction review appears, and individual transaction cards do not include `Ignore All`.
23. Let the scheduled bills/subscriptions digest run.
   - Expected: cash-pull details appear in the target user's DM, not the shared channel.
24. Trigger or wait for a Plaid sync after the morning window.
   - Expected: new unresolved items do not cause a daily digest to appear in the channel later that day.
25. Try to update a recent transaction's date through text or parsed entities.
   - Expected: BookieBot rejects `date` as an editable field and the sheet date cell does not change.
26. Reconcile a bank transaction to an existing recent action, then update that recent action's amount/item/location.
   - Expected: the linked reconciliation item is reopened for review instead of staying silently confirmed.
27. Reconcile a bank transaction to an existing recent action, then move, delete, or undo that recent action.
   - Expected: the linked reconciliation item returns to the inbox/review state so the user can confirm what should happen next.
28. Add or leave an unresolved posted bank transaction older than 60 days, then open the normal reconciliation digest or inbox.
   - Expected: the old transaction does not appear in the normal unresolved list; recent unresolved transactions still appear.
29. Confirm an existing sheet/action row whose amount does not match the bank transaction.
   - Expected: BookieBot treats your match selection as confirmation, updates the sheet amount to the bank transaction amount, and confirms the reconciliation item.
30. Move a grocery or gas transaction into food without providing an item name.
   - Expected: BookieBot asks for the item name and explains it is needed for the destination category.
31. Reply `cancel` to a pending move item-name prompt.
   - Expected: BookieBot cancels the move and does not write `cancel` as the item name.
32. Try moving a source row that is missing its date.
   - Expected: BookieBot refuses the move with a source-row/date correction message instead of asking you to type a date.
33. Start a move from a grocery transaction using the move controls.
   - Expected: the destination category buttons do not include `Grocery`.
34. Try a grouped reconciliation match whose selected rows do not exactly total the bank transaction.
   - Expected: BookieBot shows the mismatch and offers buttons for which selected row should absorb the difference.
35. Click the row that should absorb the difference.
   - Expected: BookieBot updates that row amount to make the group total match, then confirms the grouped reconciliation item.
36. Type `recent`.
   - Expected: BookieBot shows recent transactions directly and does not attempt to log or access the expense sheet.
37. If Google Sheets has a one-time access hiccup while logging an expense.
   - Expected: BookieBot retries once before reporting a sheet access failure.
38. Update only the source/name on a recent income row, then run `recent`.
   - Expected: the row displays as `Updated: Income` and still shows the original amount with the updated source.
39. Run `show 15 recent transactions`, `show 20 recent transactions`, or `show 25 recent transactions`.
   - Expected: BookieBot sends the list privately across multiple DM messages, each transaction stays within a single DM message, code blocks render cleanly, controls appear on the final DM, and the public channel gets a generic sent-to-DMs acknowledgement.
40. Run the expense breakdown command for a recent month and open the generated report link in Chrome.
   - Expected: the React expense dashboard renders instead of a blank page, and the console does not show `process is not defined`.
41. Open the expense breakdown report on a narrow mobile viewport, such as 320px or 390px wide.
   - Expected: the title card and content cards have matching left/right gutters, the eight metric cards render as four two-card rows, and the page has no document-level horizontal scroll.
42. Open the Daily Spending table in the expense breakdown report.
   - Expected: the Daily Spending chart appears above the itemized day-by-day transaction table, and each bold category label uses the same color as that category in the breakdown pie chart and legend.
43. Open the Daily Spending chart in a report for a known month.
   - Expected: Average day equals shared spending divided by elapsed days for the selected month, while completed months use every calendar day in that month.
44. Run `budgetSystemRollover` from Apps Script on a test copy or after making a safe template backup.
   - Expected: the previous personal budget month has static values in Burn Rate, Static Bills & Subscriptions (Needs), and Subscriptions (Wants) formula output cells; the current month tab exists even if the copied template did not contain an exact `Month` placeholder.
45. If Discord login hits a global `429` rate limit during startup.
   - Expected: Railway logs show the login attempt number, retry delay, retry-at timestamp, and periodic backoff progress until the next login attempt. Avoid repeated redeploys while Discord is still rate-limiting the bot.
46. Copy `app_conversion_blueprint/` to a scratch directory or new repo and open `README.md`.
   - Expected: the read order, repo template, architecture docs, backlog, and source references are present without requiring any current BookieBot runtime files.
47. Log `Need expense $40 for a doctor copay at Kaiser` from Hannah's Discord account, then inspect the current month in Shared Expenses and both personal budget sheets.
   - Expected: one Needs row appears in Shared Expenses with an automatic date, item `doctor copay`, location `Kaiser`, person `Hannah`, and `$40.00`; no individual transaction row is inserted into Hannah's personal budget sheet, whose Needs bucket receives only the aggregate.
48. From `recent`, update that Need transaction's item, location, amount, and person/card one field at a time.
   - Expected: all four fields update in the Shared Expenses Needs row, the date remains unchanged, and the recent action remains editable/movable/deletable.
49. Move the Need transaction to Shopping, then move it back to Needs using both the Discord buttons and a text command such as `move it to Needs`.
   - Expected: the source category cells clear/compact, the destination receives the complete transaction exactly once, and Needs is offered as a move destination unless it is already the current category.
50. Place two test transactions in Needs, delete the older one from recent actions, then immediately undo.
    - Expected: the newer Needs row compacts upward after delete; undo restores both rows in order with all date/item/amount/location/person values intact.
51. On a migrated May, June, or July personal budget tab, log an Income entry, update its source or amount, delete it from recent actions, and immediately undo.
    - Expected: Date/Source/Amount populate in `B:D`, the report includes the dated entry, delete compacts the Income rows, and undo restores the row and its editable lineage without changing the monthly total beyond the expected transaction amount.
52. Retry `Brian (BofA) purchased celebration dinner at Jackson's bar and grill for $140` after deployment.
    - Expected: the expense reaches intent parsing and logs normally; if Discord's typing endpoint returns another transient error, logs show a warning that processing continued instead of `Failed to parse intent` from `send_typing`.
53. After deploying the Apps Script, enter a real Source and Amount in the sole Income placeholder on a safe month tab, then log a second Income entry through BookieBot.
    - Expected: the first entry replaces the seed row and receives a date without creating another blank; the BookieBot entry inserts a matching formatted row immediately above Monthly Income, and the total includes both completed rows.
54. Copy Hannah's Template to a safe test month and log two Income entries through Hannah's BookieBot account.
    - Expected: the entries occupy consecutive `B:D` rows with dates, every generated row retains the seed's formatting/validation/notes/height, no `<Enter Source>` row remains after completion, and the Monthly Income formula includes both entries.
55. In Brian July, delete and undo the first Income entry, then repeat with the later entry and with an immediate undo after logging test Income.
    - Expected: the `Biweekly Income Start` configuration remains anchored in `E:F`, Monthly Income always sums the current `D` rows, the Budget section retains its total reference, and undo restores the deleted row's values and formatting.
56. Run `/debug_subscriptions` after deployment and inspect Hannah's visible and normalized subscription sheets.
    - Expected: fourteen dated entries are reminder-eligible; Internet is retained as a `$0.00` monthly draft with one expected missing-pull-date warning; the four visible subtotals remain `$521.07`, `$32.99`, `$47.95`, and `$59.99`.
57. Open Hannah Budget 2026 Template, May, June, and July and inspect the Needs section.
    - Expected: no standalone `Student Loan Payment` row remains; `Subscriptions (Needs)` and `Various Need Transactions` remain intact; May's net is `-$606.05`, July's Needs subtotal is `$688.12 (84.98%)`, and July's net is `$618.53`.
58. After deployment, send `student loan paid?` and `log student loan payment 242.29`, then run `/debug_subscriptions`.
    - Expected: neither message invokes a dedicated student-loan payment command or mutates a budget row; the Student Loan subscription/autopay remains present and reminder-eligible in Hannah's normalized subscription schedule.
59. Let a scheduled reconciliation digest arrive, then click `View Inbox`.
    - Expected: Discord shows `BookieBot is typing...` at the channel level without creating a temporary thinking message, then returns the actor's private unresolved inbox or confirmed automatic-match report.
60. After deployment, send `set monthly savings to 1539.64`, then `how much have I saved this month?`; undo the test write if it replaced a different real amount.
    - Expected: only the single `Enter Monthly Savings Contribution` Actual cell is overwritten; the query reports Actual `$1,539.64`, Ideal `$2,167.14`, and Minimum `$1,083.57` for Brian July; undo restores the prior monthly value.
61. Open current-month reports for Brian and Hannah and switch Projected off and on while viewing the Saved card and Savings Category Mix tab.
    - Expected: Saved does not change with Projected; Ideal always equals 20% and Minimum 10% of the selected mode's income, independent of paycheck count. At July month-end, Brian remains `$2,167.14` Saved with `$2,167.14` Ideal and `$1,083.57` Minimum in both modes.
62. After deploying the July 24 reconciliation fix, tap `View Inbox` on a digest containing an automatic match and on one containing unresolved items.
    - Expected: channel typing is followed by the persisted private match/inbox report; automatic matches include the `Unmatch` selector, unresolved reports include `Reconcile Now` and `Ignore All`, and a backend failure produces a private retry message within 15 seconds.
63. After deploying the July 25 Discord response-lifecycle fix, dismiss any old stuck thinking message and tap `View Inbox` again.
    - Expected: no new temporary thinking message is created; `BookieBot is typing...` appears until the first private inbox, caught-up, or bounded retry response is sent.
64. Tap `View Inbox` on a digest with unresolved items and existing automatic-match history.
    - Expected: Bank cache totals match persisted current-month transactions; the first response includes the unresolved transaction rows plus `Reconcile Now` and `Ignore All`; confirmed-match history may continue in later messages without delaying or hiding the review inbox.
65. Tap `View Inbox`, then separately tap `Reconcile Now` from both the digest and inbox.
    - Expected: each tap shows the channel-level `BookieBot is typing...` UI, creates no `BookieBot is thinking` temporary message, and ends with a private Discord response. Recent-action button/select prompts and outcomes continue to show `Only you can see this · Dismiss message`.
66. Send `recent` directly in BookieBot's DM, then open the launcher and complete a selection plus an update that requires a typed reply.
    - Expected: no `I sent your recent transactions list to your DMs.` tail appears; the short-lived launcher deletes when tapped; the list, prompts, typed-reply result, pagination, and action outcomes all show Discord's `Only you can see this · Dismiss message` footer.
67. Open current-month expense reports for Brian and Hannah, inspect Current and Projected, then view Calendar, Burn Rate, Category Mix, and Largest.
    - Expected: Spent excludes Saved, Left equals the three active category balances after coverage, and Category Mix uses the same Current or Projected breakdown shown elsewhere. Saved stays actual when Projected is toggled while projected category budgets and the progress bar's monthly Ideal/Minimum targets change; Calendar shows the month name and a spaced count such as `17 total`; Largest is descending, excludes Rent, and retains all other actual shared expenses, entered bills/utilities, and elapsed subscriptions; Burn Rate's Wants limit and donor/recipient impact note reflect category-cascade transfers, with the pace badge anchored beside its summary. Daily Spending details start open on desktop and closed on mobile, and the timestamp/Projected/theme controls follow the updated header order.
68. Open Brian July's Calendar and switch All/Subs, then toggle Projected.
    - Expected: `July` remains the heading; at month-end the animated dollar subtitle shows `$2,675.88` for All and `$269.32` for Subs in both modes; the event-count pill changes independently and no Current/Projected subtitle appears beneath the month.
69. Open Hannah Budget 2026 July and Template, then generate Hannah's July expense report.
    - Expected: each tab has one `Enter Monthly Savings Contribution` row; July shows Actual `$0.00`, Ideal `$323.89`, Minimum `$161.95`, Savings subtotal `$0.00`, and Net Total `$618.53`. The Saved card uses the same `$161.95` current Minimum while Projected remains based on projected income.
70. Open Brian July's Daily Spending card in All, Needs, and Wants at desktop and phone widths.
    - Expected: All/Needs include Rent `$2,100.00` on day 1, Water `$141.43` on day 18, and PG&E `$165.13` on day 22; Wants excludes those Needs bills. All and Needs show an `Axis compressed above $450.00` note, keep the next-highest day close to the top of the graph, and still show exact amounts in tooltips, Highest day, totals, and table rows. Wants returns to the normal axis, mobile has no horizontal overflow, and Details remains closed by default on mobile.
71. Open Brian July's report, compare Current and Projected, and inspect Needs, Wants, Calendar subscription details, Daily Spending, Burn Rate, and Left.
    - Expected: every view is limited to transactions scheduled for July. At month-end, Spent is `$5,620.89`, Needs is `$4,064.56`, Wants is `$1,556.33`, Saved is `$2,167.14`, and Left is `$3,047.68`; subscription totals are `$229.36` Needs and `$39.96` Wants. The July yearly `brianjames.dev` item is included, while October's Amazon Prime and February's MacroFactor appear nowhere in either mode.
72. Open Brian July's Burn Rate details and compare it with Wants Category Mix and Wants Daily Spending.
    - Expected: all three Spent totals are `$1,556.33`. Burn Rate shows Limit `$3,250.71`, Left `$1,694.38`, Allowed/day `$104.86`, and Actual/day `$50.20`; its explanation names Wants subscriptions, and the line includes Slate Digital, YouTube Premium, iCloud Storage, and Discovery+ on their actual pull days.
73. After deployment, open Brian's August expense report before logging an August paycheck and toggle Projected; repeat after the first real August paycheck is logged.
    - Expected: Current keeps August Income at `$0.00` before the first paycheck and does not show July 31 as an August event. Projected shows `$6,274.98` from two `$3,137.49` paychecks on August 14 and 28, and all income-dependent cards/charts follow that projected total. After an August `xAI` paycheck is logged, its actual amount/date supersede the July reference and the next projection lands exactly fourteen days later.

## Verification Baseline

Recommended targeted tests for the active workstream:

```bash
python -m pytest unit_tests/banking/test_reconciliation.py unit_tests/banking/test_store.py unit_tests/core/test_bank_reconciliation.py
python -m pytest unit_tests/intents/test_handlers.py unit_tests/core/test_message_router.py
```

Latest verification:

```bash
Live Brian August report-model verification
# passed: July 31 xAI $3,137.49 used only as projection reference; Current $0.00; Projected $6,274.98; August 14 and 28 projected events

Current-month signed-link browser verification against a deliberately stale snapshot
# passed: normal URL rebuilt live; Projected Income $6,274.98; Left $2,339.42; Minimum $627.50; Ideal $1,255.00; no browser errors

python -m pytest unit_tests/reports/test_expense_breakdown.py
# passed: 44 passed

python -m pytest unit_tests
# passed: 432 passed, 1 skipped

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

cd web/expense-report && npm run typecheck && npm run build
# passed

git diff --check
# passed

Live Brian July Burn Rate browser verification
# passed: Burn Rate, Wants Category Mix, and Wants Daily Spending all $1,556.33; Limit $3,250.71; Wants subscriptions included on pull days

PYTHONPATH=src venv/bin/python -m pytest unit_tests
# passed: 425 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

cd web/expense-report && npm run typecheck && npm run build
# passed

git diff --check
# passed

Live Brian July selected-month subscription browser verification
# passed: Current/Projected exclude Amazon Prime and MacroFactor; Needs $4,064.56; Wants $1,556.33; Left $3,047.68; month subscription totals $229.36/$39.96

python -m pytest unit_tests/reports/test_expense_breakdown.py
# passed: 36 passed

cd web/expense-report && npm run typecheck && npm run build
# passed

Live Brian July Daily Spending desktop/mobile browser verification
# passed: Rent, Water, and PG&E included; All $5,620.89; Needs $4,064.56; Wants $1,556.33; outlier ratio 87.4%; no overflow or browser errors

python -m pytest unit_tests
# passed: 424 passed, 1 skipped

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

python -m pytest unit_tests/reports/test_expense_breakdown.py
# passed: 35 passed

python -m pytest unit_tests
# passed: 423 passed, 1 skipped

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

python -m pytest unit_tests/intents/test_handlers.py unit_tests/core/test_message_router.py
# passed: 134 passed

python -m pytest unit_tests/sheets/test_utils.py unit_tests/intents/test_handlers.py unit_tests/intents/test_outputs.py unit_tests/reports/test_expense_breakdown.py
# passed: 178 passed

python -m pytest unit_tests
# passed: 422 passed, 1 skipped

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

cd web/expense-report && npm run typecheck && npm run build
# passed

git diff --check
# passed

Live Brian July Google Sheets and expense-report browser verification
# passed: one monthly savings row; Saved $1,539.64; Ideal $2,167.14; Minimum $1,083.57 in Current and Projected

Live Brian July expense-report desktop/mobile browser verification
# passed: Current Left $794.00; exact Needs/Wants/Savings budgets, usage, and percentages; Projected Left $4,568.11 and Ideal $2,294.47; responsive layouts remain valid

Live Brian July Calendar desktop/mobile browser verification
# passed: outflow subtitle beneath July; Current All $2,669.89; Current Subs $263.33; Projected Subs $269.32; filter/count transitions settled cleanly

python -m pytest unit_tests/core/test_bank_reconciliation.py unit_tests/banking/test_reconciliation.py
# passed: 66 passed

python -m pytest unit_tests
# passed: 412 passed, 1 skipped

python -m pyright
# passed: 0 errors, 0 warnings, 0 informations

git diff --check
# passed

python -m pytest unit_tests
# passed: 410 passed, 1 skipped

python -m pyright
# passed: 0 errors, 0 warnings, 0 informations

cd web/expense-report && npm run typecheck && npm run build
# passed

git diff --check
# passed

python -m pytest unit_tests
# passed: 404 passed, 1 skipped

python -m pyright
# passed: 0 errors, 0 warnings, 0 informations

cd web/expense-report && npm run typecheck && npm run build
# passed

python -m pytest unit_tests/reports/test_expense_breakdown.py
# passed: 27 passed

PYTHONPATH=src venv/bin/python -m pytest unit_tests
# passed: 393 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

PYTHONPATH=src venv/bin/python -m pytest unit_tests/intents/test_parser.py unit_tests/intents/test_handlers.py unit_tests/intents/test_outputs.py unit_tests/sheets/test_bills.py unit_tests/sheets/test_utils.py unit_tests/core/test_subscription_reminder_schedule.py unit_tests/reports/test_expense_breakdown.py
# passed: 190 passed, 1 warning

Live Hannah Student Loan Payment row removal and formula/visual audit
# passed: no matching row in Template/May/June/July; formula ranges shifted cleanly; no QA tabs remain; final PDF renders clean

PYTHONPATH=src venv/bin/python -m pytest unit_tests/reports/test_expense_breakdown.py unit_tests/sheets/test_utils.py
# passed: 57 passed

Live Hannah Internet subscription placeholder sync
# passed: Internet persisted at Subscriptions!B14:D14 and in the normalized schedule; 14 eligible rows plus 1 expected missing-date warning

PYTHONPATH=src venv/bin/python -m pytest unit_tests/sheets/test_subscription_reminders.py unit_tests/core/test_subscription_reminder_schedule.py
# passed: 28 passed

Live Hannah subscription roster and normalized schedule sync
# passed: 14 dated rows, 0 parse warnings; repeat sync stable

Live Hannah subscription formula and visual audit
# passed: visible subtotals $521.07/$32.99/$47.95/$59.99; Template/May/July Needs $554.06 and Wants $107.94; final PDF render clean

PYTHONPATH=src venv/bin/python -m pytest unit_tests/sheets/test_subscription_reminders.py
# passed: 10 passed

venv/bin/python -m pytest unit_tests
# passed: 392 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

node --check < scripts/google-apps-script/budget-system-automation.gs
# passed

git diff --check
# passed

Live Hannah subscription draft sync
# passed: 10 monthly rows persisted with blank dates; 0 reminder-eligible until dates are supplied

Live Google Sheets API style/formula audit plus PDF render of Hannah Budget 2026 / Subscriptions
# passed: Brian reference style match, $180.20 Needs, $23.97 Wants, formula links repaired, parser-ready layout, hidden backup

venv/bin/python -m pytest unit_tests
# passed: 391 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

node --check < scripts/google-apps-script/budget-system-automation.gs
# passed

git diff --check
# passed

venv/bin/python -m pytest unit_tests
# passed: 389 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

node --check --input-type=commonjs < scripts/google-apps-script/budget-system-automation.gs
# passed

git diff --check
# passed

venv/bin/python -m pytest unit_tests
# passed: 387 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

git diff --check
# passed

venv/bin/python -m pytest unit_tests
# passed: 385 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

node --check --input-type=commonjs < scripts/google-apps-script/budget-system-automation.gs
# passed

git diff --check
# passed

venv/bin/python -m pytest unit_tests
# passed: 378 passed, 1 warning

python -m pyright --pythonpath venv/bin/python --pythonversion 3.12
# passed: 0 errors, 0 warnings, 0 informations

git diff --check
# passed

find app_conversion_blueprint -maxdepth 4 -type f | sort
# passed

rg -n "app_conversion_blueprint|Plaid|Foundation Models|Google Sheets" app_conversion_blueprint
# passed

rg -n "Preferred first path|Apple's Foundation Models framework on supported devices for local|bundled Core ML or other local model" app_conversion_blueprint
# passed: no matches

cd web/expense-report && npm run build
# passed

python -m pytest unit_tests/reports/test_expense_breakdown.py
# passed: 11 passed

python -m pyright
# passed

python -m pytest unit_tests
# passed: 363 passed, 1 skipped

git diff --check
# passed
```

Previous supporting checks:

```bash
python -m py_compile src/bookiebot/reports/expense_breakdown.py
# passed

node --check --input-type=commonjs < scripts/google-apps-script/budget-system-automation.gs
# passed

python -m pytest unit_tests/reports/test_expense_breakdown.py
# 5 passed

Headless Chrome mobile emulation for generated report HTML at 320px and 390px
# document scrollWidth matched viewport width; metric cards rendered as two equal columns with no metric value overflow.

Headless Chrome mobile emulation for generated report HTML at 390px
# top metric card labels/values matched requested order; Daily Spending category colors matched breakdown legend colors.

Headless Chrome mobile emulation for generated June report HTML
# Daily Spending tab showed Average day $10.00 for $300 shared spending across 30 calendar days.

python -m pytest unit_tests
# 348 passed, 1 skipped

git diff --check
# passed

python -m pyright
# Failed: pyright is not installed in the current Python environment.
```
