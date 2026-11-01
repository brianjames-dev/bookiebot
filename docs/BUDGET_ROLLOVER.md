# Monthly budget readiness

The app selects its current month at midnight in `America/Los_Angeles`. Google
Apps Script clock triggers run within a window, so availability must not depend
on a job starting at exactly midnight.

## Preparation and closing

`prepareBudgetMonths` prepares the current month if missing. During the final
seven calendar days it also prepares the upcoming month, including January in
the next annual workbooks. The evening trigger runs between 8–9 PM Pacific.
`budgetSystemRollover` retries preparation between 1–2 AM and separately closes
the previous calendar month. Advance preparation never snapshots the active month.
The existing app date selection and read-only report endpoints need no change.

Copies come from each workbook's internal Template, not the preceding month's
transactions. Personal tabs receive the effective income/ESPP configuration and
month-specific imports/formulas. Income settings retain their existing references
to the latest configured prior month; replacing a reference is a monthly override.
ESPP enrollment is the plan effective when the tab is prepared; explicit future
changes should be entered in that month's enrollment table. Already-published
tabs, transactions, overrides, formatting and row coordinates are never rewritten
by the automatic preparation path. Manual relinking/migration helpers remain
separate operations.

## Failure and overlap protection

- A script lock serializes preparation, closing and clock installation. It does
  not claim to lock human edits or BookieBot's separate transaction writer.
- Each copy uses a deterministic `_BookieBot Preparing YYYY-MM` name and is hidden.
  Script Properties pin its workbook/month/owner and sheet ID. Configuration,
  flush and validation finish before its canonical month name is published.
  Shared ledgers are validated by their category/date/amount/person column
  headers; only personal budgets require a visible month heading.
  Failed imports stay staged rather than appearing as zero spending.
- Lost insert or rename responses resume the same copy. Missing/replaced pinned
  tabs and unclaimed staging tabs require review rather than being overwritten.
- Closing is tracked independently per owner and previous month. Static values
  are not frozen twice; a partial close resumes remaining formulas. Empty/error
  results are not frozen. Completion is recorded only after a successful flush.
- Annual copies checkpoint each file ID and template initialization. A lost copy
  response is recovered only from a claimed exact filename in the exact year
  folder. Unclaimed/duplicate files stop the run. Year configuration is published
  after initialization, January preparation and edit-trigger installation succeed.

Script Properties use `BUDGET_MONTH_PREP_V1_*`, `BUDGET_MONTH_CLOSED_V1_*` and
`BUDGET_YEAR_PREP_V1_*`; these contain identities/phases, not transaction copies.
Do not delete them or rename/delete a pending tab to “retry.” Inspect the failure
and rerun the entry point after correcting its cause. Previous completed work is
preserved. An interrupted trigger installation retains the old clock; reinstalling
deduplicates the managed clocks and leaves unrelated edit triggers alone.

## Deployment and verification

1. Back up the live Apps Script source and inspect any differences from Git.
   Preserve the formula-inheritance validation workaround: temporarily remove
   validators, flush inherited formulas, then restore the original validators.
2. Deploy `scripts/google-apps-script/budget-system-automation.gs` to the existing
   Budget Automation Script project. Run `installBudgetRolloverTriggers` once.
3. Run `budgetSystemRollover` once to recover a missing current month and close the
   prior month. Do not use setup/migration helpers as a deployment shortcut.
4. Verify both Pacific clocks, successful execution, all three canonical month
   tabs, no abandoned staging tabs, inherited settings, imports and report load.
   Compare old month transaction/settings cells with the pre-run snapshot; only
   the intended three summary formula outputs per owner may become static.
5. Rerun once: no duplicate tabs or changes to published month entries/settings.

New annual workbooks still require the existing operational handoff: share them
with the bot's service account, register their three IDs in the application's
year-specific configuration, and authorize their IMPORTRANGE connections. Do this
when December's advance preparation creates January, before January 1. Verify
the separately maintained annual master templates include current bill, income
and ESPP layouts; this automation does not silently rewrite those masters.

Automated checks execute real entry points with isolated service doubles, plus
the actual income/ESPP layout writers. They cover Pacific midnight, leap February,
both DST transitions, December/January, partial writes, lost responses, identity
drift, duplicate runs, closing errors and interrupted clock/year installation.
No synthetic financial transaction is needed on production.
