# Intent Test Expansion To-Do

Goal: Move scenario tests to `unit_tests/test_intent_outputs.py`, organize fixtures per intent group, and add 3–5 realistic variants per intent (with LLM fixtures and sheet fixtures where needed).

## 1) File/Folder Renames

- ✅ Rename `unit_tests/test_scenario_runner.py` → `unit_tests/test_intent_outputs.py`.
- ✅ Update any references (docs, commands) to point to the new filename.

## 2) Fixture Organization

- ✅ Under `unit_tests/fixtures/llm/`, create subfolders per `INTENT_GROUPS` from `intent_explorer.py`:
  - `logging_actions/`
  - `checking_payments/`
  - `spending_budget_overview/`
  - `category_item_totals/`
  - `largest_most_frequent/`
  - `time_based_analysis/`
- ✅ Name LLM fixtures as `<intent>__<variant>.json` (e.g., `query_rent_paid__short.json`).
- ⏳ For sheet fixtures (if needed), mirror the same structure under `unit_tests/fixtures/sheets/<group>/`.
- ✅ Within each intent-group folder, nest a subfolder per intent (e.g., `category_item_totals/query_total_for_store/` containing all `query_total_for_store__*.json`).

- ✅ Refactor the test file to be table-driven per intent (starter cases added):
  - One test per intent, parametrized with `(variant, prompt, llm_fixture, sheet_fixture_optional)`.
  - Build cassette names from the fixture stem automatically when `--llm-live` is used.
- ✅ Keep helper imports (`run_scenario`, `build_repo_from_fixture`, `llm_client_factory`).

## 3) Seed with Existing Fixtures

- ✅ Log expense: added natural variant using current fixture (new path).
- ✅ Add additional variants (short, typo).
- ✅ Query rent paid: added natural variant.
- ✅ Add additional variants (short, typo).
- ✅ Query total for store: added natural variant.
- ✅ Add additional variants (short, typo).
- ✅ Harness sanity test → folded into new structure.

## 4) Add New Fixtures Intents (incremental batches)

- ✅ For each intent in `INTENT_GROUPS`, add 2–3 variants (normal/short/typo) to start; expand to 4–5 later if needed.
- ✅ Create corresponding LLM fixtures in the right folder; add sheet fixtures only when needed (logging/query flows that mutate/read sheets).
- ✅ Grow to 4–5 variants per intent as time allows.
  - ✅ Added variants for: `log_expense`, `query_rent_paid`, `query_total_for_store`, `query_smud_paid`, `query_student_loans_paid`, `query_subscriptions`, `query_total_for_category`, `query_total_for_item`, `query_highest_expense_category`, `query_top_n_expenses`, `query_spent_this_week`, `query_no_spend_days`, `log_need_expense`, `log_income`, `log_rent_paid`, `log_smud_paid`, `log_student_loan_paid`, `log_1st_savings`, `log_2nd_savings`, `query_1st_savings`, `query_2nd_savings`, `query_burn_rate`, `query_remaining_budget`, `query_projected_spending`, `query_total_income`, `query_average_daily_spend`, `query_expense_breakdown_percentages`, `query_most_frequent_purchases`, `query_largest_single_expense`, `query_longest_no_spend_streak`, `query_days_budget_lasts`, `query_expenses_on_day`, `query_daily_spending_calendar`, `query_weekend_vs_weekday`, `query_best_worst_day_of_week`.

## 5) Wire Fixtures Into Tests

- ✅ For each intent (start per group), add scenario cases to `test_intent_outputs.py` using the new fixtures (at least the natural variant).
- ✅ For parameterized queries (store/category/item/date/n), ensure fixtures include needed entities and assertions check meaningful replies.
- ✅ Add sheet fixtures where required for new scenarios.

## 6) Record Cassettes Selectively

- ✅ Run `pytest --llm-live unit_tests/test_intent_outputs.py -k <intent>` per intent/group to record cassettes once cases exist.
- ✅ Commit cassettes under `unit_tests/cassettes/<fixture-stem>.yaml` for deterministic replays.

## 7) CI/Docs Cleanup

- ✅ Update `TESTING_SANDBOX.md` examples to reference `test_intent_outputs.py` and the new fixture layout.
- ⏳ If desired, add markers (e.g., `@pytest.mark.intent_live`) to run only live-recording tests in CI with `--llm-live`.

## 8) Stretch / Nice-to-Have

- ⏳ Add a helper script to scaffold a new intent variant (creates LLM fixture stub + optional sheet fixture + test table entry).
- ⏳ Consider snapshotting handler replies in tests for extra drift detection.
- ⏳ Add a `Makefile` target to run a group with `--llm-live` (e.g., `make intents-live group=time_based_analysis`).
