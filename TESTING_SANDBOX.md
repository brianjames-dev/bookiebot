# BookieBot Testing Sandbox

This document explains how to run and extend the new local harness that exercises BookieBot without touching Discord, Google Sheets, or the OpenAI API. Treat it as the single source of truth for testing workflows and fixture formats.

---

## 1. Purpose
- **Safety net** – run Discord → parser → handler → Sheets flows deterministically before shipping changes.
- **Offline/CI friendly** – tests use fixture payloads and in-memory Sheets, so no external network calls.
- **Easy drift detection** – optional cassette runs capture real OpenAI responses to compare against fixtures.

---

## 2. Key Components
| File | Purpose | Notes |
|------|---------|-------|
| `src/bookiebot/llm_client.py` | Defines the `LLMClient` protocol plus `OpenAIClient`, `FixtureLLMClient`, and `CassetteLLMClient`. | Production uses `OpenAIClient`; tests build fixture/cassette clients. |
| `src/bookiebot/sheets_repo.py` | Repository abstraction returned by `get_sheets_repo()`. | Production repo talks to Google Sheets; tests override it with `SheetsRepoStub`. |
| `unit_tests/support/sheets_repo_stub.py` | In-memory worksheet + repo stub. | `repo.patched()` temporarily replaces the live repo so handlers use fixture data. |
| `unit_tests/support/fixture_loader.py` | Loads sheet fixtures (`unit_tests/fixtures/sheets/*.json`) and expands placeholders like `__TODAY__`. | `build_repo_from_fixture("base_month")` returns a ready-to-use `SheetsRepoStub`. |
| `unit_tests/support/scenario_runner.py` | Fake Discord runner that feeds fixture LLM responses into the parser/handlers and captures replies. | Accepts either an LLM fixture path or a custom `LLMClient`. |
| `unit_tests/conftest.py` | Pytest plumbing. Adds `--llm-live`, stubs optional deps (`gspread`, `openai`), and exposes `llm_client_factory`; prepends `src/` to `sys.path`. |
| `unit_tests/fixtures/llm/*.json` | LLM outputs for deterministic tests. | Each file mirrors the JSON the parser expects (`intent` + `entities`). |
| `unit_tests/fixtures/sheets/*.json` | Workbook snapshots for the Sheets stub. | You can define rows either as arrays or `{ "A": value }` column maps. |
| `unit_tests/test_*` | Coverage: parser contracts, scenario flows, sheet helpers, and handler-level intent tests. | Add new files here as you expand coverage. |

---

## 3. Fixture Formats

### 3.1 LLM Fixtures (`unit_tests/fixtures/llm/*.json`)
```json
{
  "intent": "log_expense",
  "entities": {
    "type": "expense",
    "amount": 18.5,
    "item": "coffee",
    "location": "Blue Bottle",
    "category": "food"
  }
}
```
*Use these when the parser should return a known payload. Scenario tests inject them via `llm_client_factory("unit_tests/fixtures/llm/log_expense.json")`.*

### 3.2 Sheet Fixtures (`unit_tests/fixtures/sheets/*.json`)
```json
{
  "expense": {
    "columns": "Z",
    "rows": [
      {},
      {},
      {"N": "__TODAY__", "O": "Coffee", "P": "18.50", "Q": "Blue Bottle", "R": "Hannah"},
      {"A": "__TODAY__-1", "B": "120.00", "C": "Trader Joe's", "D": "Hannah"}
    ]
  }
}
```
- `columns` ensures every row has at least that many columns (A→Z in this example).
- `__TODAY__` plus optional offsets (`__TODAY__-1`) expand to real dates at load time.
- Use `{ "A": "value" }` objects for sparsely populated rows or literal arrays for verbatim data.

Load fixtures via:
```python
from unit_tests.support.fixture_loader import build_repo_from_fixture
repo = build_repo_from_fixture("base_month")
with repo.patched():
    ...
```

---

## 4. Running the Sandbox

### 4.1 Local deterministic run
```bash
pytest unit_tests/test_scenario_runner.py
```
This executes:
1. `run_scenario()` → feeds a fake Discord message.
2. Parser uses `FixtureLLMClient`.
3. Handlers run against `SheetsRepoStub`.
4. Assertions check Discord replies and sheet mutations.

### 4.2 Parser contract tests
```bash
pytest unit_tests/test_intent_parser.py
```
Confirms `parse_message_llm` respects fixture payloads and JSON parsing rules.

### 4.3 Standalone utilities
```bash
pytest unit_tests/test_sheets_repo_stub.py
```
Guards the in-memory worksheet behavior and the repo override context manager.

---

## 5. Example Workflow
1. **Install deps** – in your terminal run `pip install -r requirements.txt`. Activate your venv if needed.
2. **Pick fixtures** – choose or add entries under `unit_tests/fixtures/sheets/` and `unit_tests/fixtures/llm/` that match the conversation you want to test.
3. **Run a deterministic scenario** – e.g., `pytest unit_tests/test_intent_outputs.py -k log_expense`. The runner loads your fixtures, injects them through `run_scenario()`, and asserts replies plus sheet mutations.
4. **Check parser contracts** – `pytest unit_tests/test_intent_parser.py` ensures prompt changes still parse fixture payloads.
5. **Inspect sheet state** – add temporary assertions or prints inside the scenario test (e.g., `repo.expense.get_all_values()`) to see the in-memory workbook after the handler runs.
6. **Optional live refresh** – set `OPENAI_API_KEY` and run `pytest --llm-live unit_tests/test_scenario_runner.py -k query_rent` to regenerate OpenAI responses and store the cassette under `unit_tests/cassettes/`.
7. **Git workflow** – `git status`, `git diff`, then `git commit` / `git push` (e.g., `feature/testing-sandbox`) once fixtures or tests are updated.

### Testing Options
- `pytest unit_tests/test_scenario_runner.py -k <pattern>` – targeted scenario(s)
- `pytest unit_tests/test_intent_handlers.py -k <pattern>` – handler-only intent checks (mocks helpers, asserts replies)
- `pytest unit_tests/test_*` – full sandbox + parser/stub/handler suites
- `pytest unit_tests/test_intent_parser.py` – parser-only
- `pytest unit_tests/test_sheets_repo_stub.py` – sheet stub utilities
- add `--llm-live` to any command when you need real OpenAI responses
- combine with `-vv` / `-s` for verbose logs

#### Running with the live LLM (records/replays cassettes)
- `pytest --llm-live unit_tests/test_intent_outputs.py -k query_rent_paid`
  - Uses the real LLM once, saves to `unit_tests/cassettes/query_rent_paid__natural.yaml`, then replays on future runs.
  - Test location: `unit_tests/test_intent_outputs.py::test_intent_scenarios` (scenario named `query_rent_paid__natural`).
- `pytest --llm-live unit_tests/test_intent_outputs.py -k log_expense`
  - Runs the log-expense flow end to end with live LLM output; cassette saved under `unit_tests/cassettes/log_expense__*.yaml`.
- `pytest --llm-live unit_tests/test_intent_parser.py -k parse_message_llm`
  - Calls the parser directly with live LLM to refresh fixture expectations.

Notes:
- You need `OPENAI_API_KEY` set and `vcrpy` installed (`pip install -r requirements.txt`).
- Cassettes are stored in `unit_tests/cassettes/*.yaml`; commit them for deterministic CI runs or gitignore if you prefer to re-record locally.

---

## 6. Refreshing Real OpenAI Responses
Use this when you change prompts or want to verify model drift.

**Prereqs**
- `OPENAI_API_KEY` set.
- Optional: install `openai`, `vcrpy` (already included by default when you run `pip install -r requirements.txt`).

**Command**
```bash
pytest --llm-live unit_tests/test_intent_outputs.py -k rent
```
- The fixture factory switches to `CassetteLLMClient`.
- HTTP traffic is stored in `unit_tests/cassettes/<fixture-stem>.yaml` (one per LLM fixture).
- Subsequent test runs replay from the cassette without hitting the network.
- Command breakdown:
  - `pytest` — run the test runner
  - `--llm-live` — call the live OpenAI API and record/replay via cassette
  - `unit_tests/test_intent_outputs.py` — target the intent scenario table
  - `-k rent` — keyword filter to run only rent-related scenarios (skip others)

---

## 7. Extending Coverage
1. **Add sheet data**: update `unit_tests/fixtures/sheets/*.json` or create a new file describing the relevant tabs.
2. **Add an LLM fixture**: drop a JSON file in `unit_tests/fixtures/llm/` describing the parser output for your utterance.
3. **Wire the scenario**: add an entry to `SCENARIOS` in `unit_tests/test_intent_outputs.py` that points at your new fixture paths and optional sheet fixture.
4. **(Optional) Live refresh**: run the scenario with `--llm-live` to regenerate the cassette and commit it.

---

## 8. CI & Workflow Recommendations
- Tag sandbox tests with `@pytest.mark.sandbox` (pending) and run `pytest -m "sandbox and not llm_live"` on every PR.
- Add a nightly/weekly job that runs `pytest --llm-live -m sandbox` to refresh cassettes and surface prompt drift.
- Consider a helper script or Make target:
  ```bash
  make sandbox          # runs all sandbox tests
  make sandbox-live k=rent  # refreshes rent scenarios against OpenAI
  ```

---

## 9. Next Steps to Strengthen the Harness
1. **More fixtures** for all remaining intents (need expenses, SMUD/student loan, transfers, analytics queries).
2. **Caching/context testing hooks** once those features land – expose dependency injection points so the sandbox can validate them.
3. **Documentation samples** – add troubleshooting tips (e.g., where replies are stored, how to inspect sheet state) and template files for adding new fixtures.
4. **CI integration** – implement the recommendations above so every PR runs the sandbox before merging.

With these pieces in place, BookieBot’s sandbox provides reliable, fast feedback for every conversational change. Use it as the default workflow before touching Discord or production Sheets.
