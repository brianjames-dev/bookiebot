# BookieBot LLM Testing Sandbox

## 1. Purpose & Scope
- Validate BookieBot’s prompts, parsing, and handler outputs locally before deploying to Discord/Railway.
- Exercise the full “Discord message → intent parser → handler output” loop with deterministic fixtures.
- Keep real OpenAI calls opt-in (cassette refresh) so day-to-day tests run offline and in CI.

## 2. Guiding Principles
1. Deterministic by default: pytest runs should not hit the network unless explicitly enabled.
2. Layer-aware: isolate the LLM prompt/response validation, handler logic, and sheet I/O separately.
3. Data-driven: tests load utterances plus expected intents/responses from fixtures to improve coverage.
4. Fast feedback: wire into `pytest -m llm` so CI can gate on conversational regressions.

## 3. Harness Architecture
| Layer | Responsibility | Notes |
|-------|----------------|-------|
| Discord facade | Feed canned Discord events into the bot | Use a simple factory returning `discord.Message`-like objects/dicts. |
| LLM Client Adapter | Unified interface for ChatGPT | `LLMClient` with `complete(prompt) -> Result`. Backed by OpenAI SDK, fixture stub, or cassette replay. |
| Sheets Repo Stub | In-memory sheet state | Mirrors production repo surface; enables assertions without Google API. |
| Scenario Runner | Glue that injects mocks and captures bot replies | `run_scenario(message, llm_fixture, sheets_state)` returns response payloads for assertions. |

## 4. Tooling Stack
- `pytest` + custom markers for `llm`, `intent`, `discord`.
- `vcrpy` (or `pytest-recording`) to capture/replay OpenAI HTTP exchanges.
- `pydantic` for schema validation of LLM outputs inside tests.
- `Faker` or YAML/JSON fixture files describing utterances and expected entities.

## 5. Test Workflows
### 5.1 Prompt Contract Tests
- Input: user utterance + gold-standard JSON entity payload.
- Flow: `LLMClientStub.load("fixtures/llm/rent.yaml")`; parser consumes stubbed response; assert parsed `IntentResult`.
- Detects schema drift whenever prompts change.

### 5.2 Scenario / End-to-End Tests
- Seed sheets repo stub with rows (e.g., current month expenses).
- Simulate Discord message (“Paid Safeway $82 groceries”), let handler update stub.
- Assert Discord reply text and sheet mutations.

### 5.3 Live Cassette Refresh
- Mark test with `@pytest.mark.llm_live`.
- Run with `pytest --record-mode=once` to perform a real OpenAI call, store cassette under `tests/cassettes/<name>.yaml`, and replay afterward.

## 6. Implementation Plan
1. **Extract LLM Client**
   - Create `llm_client.py` with a protocol (`class LLMClient(Protocol): async def complete(...) -> dict`).
   - Update `intent_parser.py` to accept an `LLMClient` instance.
2. **Add Test Doubles**
   - `StubLLMClient` returning deterministic payloads from fixture files.
   - `CassetteLLMClient` wrapping the OpenAI SDK plus vcrpy.
3. **Scenario Runner**
   - Utility under `unit_tests/support/scenario_runner.py`.
   - Provides helper `run_message(...)` returning `(discord_reply, sheets_state_snapshot)`.
4. **Fixtures & Data**
   - `fixtures/llm/*.yaml` for prompt-response pairs.
   - `fixtures/scenarios/*.yaml` for multi-step flows.
5. **Pytest Integration**
   - Custom marker registration (`llm`, `scenarios`).
   - CLI option `--llm-live` toggles real calls (default off).
6. **CI Hooks**
   - Add `pytest -m "not llm_live"` to default pipeline.
   - Optional nightly job to refresh key cassettes.

## 7. Example Snippets
```python
# llm_client.py
class LLMClient(Protocol):
    async def complete(self, prompt: str, *, temperature: float = 0.0) -> dict: ...


class OpenAIClient(LLMClient):
    async def complete(self, prompt, **kwargs):
        return await asyncio.to_thread(lambda: client.responses.create(**kwargs))


class FixtureLLMClient(LLMClient):
    def __init__(self, path: Path):
        self.payload = yaml.safe_load(path.read_text())

    async def complete(self, prompt, **_):
        return self.payload
```

```python
# unit_tests/support/scenario_runner.py
async def run_scenario(message_text, llm_fixture, sheet_state):
    llm = FixtureLLMClient(Path(llm_fixture))
    sheets = InMemorySheets(sheet_state)
    bot = BookieBot(llm_client=llm, sheets_repo=sheets)
    reply = await bot.handle_message(fake_discord_message(message_text))
    return reply, sheets.snapshot()
```

## 8. Validation Matrix
| Test | Layer | Deterministic? | Runs in CI? | Purpose |
|------|-------|----------------|-------------|---------|
| Prompt contract | Parser + schema | Yes | Always | Guard prompt/response schema. |
| Scenario | Parser + handlers + sheets stub | Yes | Always | Validate business logic. |
| Live cassette | Parser + handlers + OpenAI | No | Manual/nightly | Catch real-model drift. |

## 9. Next Steps
1. Implement `llm_client.py` and inject it through the bot and parser.
2. Build the first fixture-driven contract tests (≈10 utterances covering primary intents).
3. Add one scenario test per critical flow (rent, grocery, transfer).
4. Wire vcrpy + `pytest --record-mode` for optional OpenAI refresh and keep cassettes under version control.
