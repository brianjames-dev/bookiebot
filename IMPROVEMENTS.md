# BookieBot Improvement Plan

This document consolidates targeted recommendations to improve BookieBot across architecture, performance, reliability, security, and developer experience. It’s organized for pragmatic execution with “Quick Wins” first, followed by deeper refactors.


## Quick Wins (Do First)

- Make the Discord channel configurable via env.
  - In `bot.py`, replace the hard‑coded `CHANNEL_NAME` with an env var (e.g., `DISCORD_CHANNELS` or `DISCORD_CHANNEL_NAME`). Support ID(s) for stronger security.
- Ensure headless rendering for charts.
  - At top of modules that import `matplotlib` (e.g., `intent_handlers.py`, `sheets_utils.py`), set `matplotlib.use("Agg")` before importing `pyplot`.
- Avoid blocking the async loop on external I/O.
  - Wrap `gspread` and OpenAI calls with `asyncio.to_thread(...)` as a stopgap. See “Async I/O” section.
- Rename `sheets_config.get_category_columns` to `CATEGORY_COLUMNS` and import consistently to reduce confusion.
- Unify timezone handling using `zoneinfo` and a `TZ` env variable.
- Add a `.env.example` and expand README with setup and run instructions.


## Architecture

- Layered design:
  - Discord I/O: minimal event handling and message dispatch.
  - Intent parsing: LLM or rule‑based extraction returning validated models.
  - Domain logic: pure functions for calculations and decisions.
  - Sheets repository: the only module that talks to Google Sheets; small, testable surface.
- Why: It reduces coupling in `sheets_utils.py` (currently very large and mixed concerns) and makes logic easy to unit test without Sheets.


## Async I/O and Event Loop Health

- Problem: Handlers call synchronous `gspread` and `openai` (0.28) in `async` functions, blocking the loop.
- Minimal fix: Offload blocking calls:

```python
import asyncio

rows = await asyncio.to_thread(ws.get_all_values)
cell_val = await asyncio.to_thread(lambda: ws.cell(r, c).value)
resp = await asyncio.to_thread(openai.ChatCompletion.create, **kwargs)
```

- Stronger fix:
  - Use `gspread_asyncio` for Sheets.
  - Create an `OpenAIClient` wrapper that executes HTTP calls in a thread pool with retries.
  - Batch read with a single `get_all_values()` per sheet per request and pass the rows around to lower API calls.


## Intent Parsing (LLM + Rules)

- Extract the prompt into a dedicated module and remove non‑ASCII control chars for reliability.
- Add rule‑based fast paths for deterministic intents (e.g., "paid rent $1200", "paid SMUD", "student loan"). Use LLM only when ambiguous.
- Validate LLM outputs with a schema to prevent runtime key errors. Example using pydantic:

```python
from pydantic import BaseModel, Field
from typing import Optional, Literal

class Entities(BaseModel):
    type: Optional[Literal["expense","income"]]
    amount: Optional[float]
    date: Optional[str]
    item: Optional[str]
    location: Optional[str]
    category: Optional[Literal["grocery","gas","food","shopping"]]
    person: Optional[str]

class IntentResult(BaseModel):
    intent: str
    entities: Entities = Field(default_factory=Entities)
```

- With the modern OpenAI SDK (see Dependencies), request strict JSON and parse into the model.


## Data Modeling (Money Safety)

- Use `Decimal` for currency instead of float in all calculations and parsing (`sheets_utils.py`, `sheets_writer.py`).
- Convert at the edges (when reading/writing to Sheets), but keep the core logic in `Decimal`.


## Reliability and Resilience

- Centralize retries and backoff for Sheets and LLM calls (HTTP 5xx, rate limits, timeouts).
- Defensive parsing for Sheets values (gracefully handle blanks, N/A, commas, leading/trailing spaces).
- Defer environment validation to startup or first use, and surface actionable errors in Discord (without leaking secrets).


## Security

- Channel restriction:
  - Use channel IDs from env (`DISCORD_CHANNEL_IDS=123,456`). Compare against `message.channel.id` instead of names.
- Identity mapping:
  - In `sheets_utils.resolve_query_persons`, resolve by Discord user IDs rather than names to avoid impersonation/casing issues.
- Secrets:
  - Keep service account credentials in a secret store or file path referenced by env; avoid logging; ensure deployment masks secrets.


## Performance

- Reduce repeated full‑sheet scans: call `get_all_values()` once per sheet per request and re‑use in helpers.
- Extract common column navigation using the category config (single source of truth) to avoid duplicated lookups.
- Memoize “this month” filters for the request lifecycle.


## Discord UX

- Use ephemeral responses for selection UIs to keep channels clean (card selector). Include timeouts and a friendly retry path.
- Standardize response phrasing and emoji; keep outputs short and scannable.
- Provide small "help" and "list" commands as slash commands for discoverability.


## Config and Environment

- Add `.env.example` that documents required variables:

```ini
# Discord
DISCORD_TOKEN=...
DISCORD_CHANNEL_IDS=123456789012345678,234567890123456789

# OpenAI
OPENAI_API_KEY=...

# Google Sheets
# Prefer a file path or secret manager; env string is also supported
GOOGLE_SERVICE_ACCOUNT_JSON=... 
EXPENSE_SHEET_KEY=...
INCOME_SHEET_KEY=...

# Timezone
TZ=America/Los_Angeles
```

- Unify timezone: prefer `zoneinfo.ZoneInfo(TZ)` across the codebase; avoid mixing `pytz` and `zoneinfo`.


## Dependencies

- Upgrade to modern OpenAI SDK (1.x) and update calls:
  - Old: `openai.ChatCompletion.create(...)`
  - New: `from openai import OpenAI`; `client.chat.completions.create(...)` with `response_format={"type":"json_object"}`.
- Remove `oauth2client` (deprecated) from `requirements.txt` since you already use `google.oauth2.service_account`.
- Add `python-dateutil` (used in `sheets_utils.py`).
- Pin versions and consider `pip-tools`/`uv`/`poetry` for lockfiles.


## Logging and Observability

- Replace `print` statements with the `logging` module (per‑module logger, levels, structured context such as user id, intent, message id).
- Consider adding Sentry (or equivalent) for exception capture and breadcrumbs.


## Testing

- Current tests (`unit_tests/test_sheets_utils.py`) don’t match function signatures and will fail. Align tests after refactor:
  - Push all Google Sheets I/O behind a repository interface and mock it.
  - Unit test pure transforms (parsing, category totals, date filters) with in‑memory data.
  - Add contract tests for LLM parsing: given example utterances, assert schema output.
  - Add a smoke test for Discord flow with mocked Sheets and LLM.


## Suggested Refactor Plan

1) Quick Wins
   - Configurable channel IDs
   - Headless matplotlib
   - `asyncio.to_thread` around I/O hot paths
   - Rename `get_category_columns` → `CATEGORY_COLUMNS`
   - `.env.example` and README updates

2) Extract Sheets Repository
   - Create `sheets_repo.py` with read/write methods (fetch month rows, update cells, insert expense/income).
   - Migrate `sheets_utils.py` functions to pure logic using injected repo.

3) LLM Parser Hardening
   - Move prompt and parsing into `intent_parser/` with schema validation.
   - Add rule‑based fast paths for rent/SMUD/loan/need expense.

4) Async + Reliability
   - Introduce retry/backoff utilities.
   - Optional: switch to `gspread_asyncio`.

5) Testing + Observability
   - Rewrite unit tests against pure logic.
   - Add logging and error reporting.


## Code Change Sketches

- Configurable channels in `bot.py`:

```python
import os

CHANNEL_IDS = {int(x) for x in os.getenv("DISCORD_CHANNEL_IDS", "").split(",") if x.strip().isdigit()}

@client.event
async def on_message(message):
    if message.author == client.user:
        return
    if CHANNEL_IDS and message.channel.id not in CHANNEL_IDS:
        return
    # ...
```

- Set headless backend:

```python
import matplotlib
matplotlib.use("Agg")
from matplotlib import pyplot as plt
```

- Use `asyncio.to_thread` for blocking calls:

```python
import asyncio

rows = await asyncio.to_thread(ws.get_all_values)
value = await asyncio.to_thread(lambda: ws.cell(r, c).value)
```

- Rename and use category config (`sheets_config.py`):

```python
# sheets_config.py
CATEGORY_COLUMNS = {
    # ... same structure as current get_category_columns ...
}

# usage
from sheets_config import CATEGORY_COLUMNS
cfg = CATEGORY_COLUMNS[category]
```


## Noted Inconsistencies To Address

- Mixed timezone usage (`zoneinfo` vs `pytz`).
- Float currency handling; switch to `Decimal`.
- Tests refer to older function signatures and will break; rework after repo split.
- `sheets_auth.py` raises at import time if env is missing; defer to runtime/startup checks.


## README Additions (suggested)

- Quickstart: create `.env` from `.env.example`, install deps, run locally.
- Notes on Google Sheets structure and required tabs/columns.
- Slash command list and examples of intents with sample utterances.


---

If you want, this plan can be executed incrementally starting with the Quick Wins and a small PR that only touches `bot.py`, `requirements.txt`, `sheets_config.py`, and a couple of `matplotlib` imports. Subsequent PRs can refactor `sheets_utils.py` into a repository + pure logic without changing behavior.

