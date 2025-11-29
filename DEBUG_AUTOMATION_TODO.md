# Debug & Self-Healing Automation To-Do

Goal: surface runtime logs inside Discord, and enable a “create-fix-PR” loop driven by LLM assistance (with human approval), plus optional auto-redeploy on merge.

## 1) Logging plumbing

- ✅ Switch to structured logging (JSON formatter) and include fields: `ts`, `level`, `user`, `channel`, `intent`, `entities`, `exception`, `msg`.
- ✅ Add a process-local ring buffer (e.g., `deque(maxlen=2000)`) that ingests every log line (formatted string).
- ✅ Redact secrets before storing lines (basic patterns: tokens, API keys).

## 2) Discord debug commands (slash)

- ✅ Add `/debug logs [lines:int=200] [level:str] [contains:str]` (restricted to admins/allowlist). Returns recent log lines as a text attachment.
- ✅ Add `/debug status` (uptime, build SHA, env name, LLM reachability, sheet reachability).
- ✅ Ensure commands are rate-limited and permission-gated.

## 3) Incident capture for LLM agent

- ✅ Define an “incident payload” schema (JSON) that includes: recent log slice, request context (intent/entities/user/channel), stack trace, build SHA, and env.
- ✅ Implement `/debug open-issue <summary>`:
  - Collect incident payload (log slice + context).
  - Send to LLM ops agent endpoint with prompt: diagnose + propose fix + patch + branch name + PR title/body.
  - Return a short status message + link (or ticket id) to Discord.
- ✅ Add a confirmation step `/debug confirm-fix <token>` before pushing any branch/PR (human in the loop).

### How to test the debug commands (current stubbed flow)

- Ensure env vars: `DEBUG_ADMINS` (comma-separated user IDs), `CHANNEL_ID` (optional), `BOT_ENV` (optional label).
- Re-invite bot with scopes `bot` + `applications.commands`; deploy and wait for slash commands to sync.
- In Discord (as an admin user):
  - `/debug_status` → should return uptime, Build (from `RAILWAY_GIT_COMMIT_SHA` or `GIT_SHA`), Env, LLM/Sheets flags.
  - `/debug_logs` (adjust `lines`, `level`, `contains` as needed) → should return recent log lines (attachment if long).
  - `/debug_open_issue <summary>` → captures a payload (stub only, no upstream call yet).
  - `/debug_confirm_fix <token>` → stub acknowledgment (no upstream call yet).
- Expected: commands reply ephemerally; logs/status reflect current runtime; open/confirm are stub messages until wired to an agent.

## 4) CI/CD hooks

- ✅ Wire `/debug open-issue` + `/debug confirm-fix` to an agent endpoint so the agent can propose a fix, open a branch/PR, and return the PR link to Discord.
- [ ] If the agent cannot open PRs directly, add a tiny job/script to take the agent patch/branch and open the PR, then post the PR URL back in Discord.
- ✅ After PR merge, Railway already auto-deploys main; optionally expose `/deploy latest` (admin-only) if you want a manual redeploy trigger.

### Codex Cloud / Autofix CI wiring (recommended path)
1) Set up the Codex GitHub Action (https://github.com/openai/codex-action) following https://developers.openai.com/codex/autofix-ci:
   - Added workflow: `.github/workflows/codex-autofix.yml` (repository_dispatch trigger `codex_autofix`).
   - Configure repo Actions: Settings → Actions → enable Actions; set Workflow permissions to “Read and write” (or use a PAT).
   - Add secrets in GitHub: `OPENAI_API_KEY` and `GITHUB_TOKEN` (must allow PR creation).
2) Provide an agent endpoint that `/debug_open_issue` can call:
   - Accept payload: `{ "action": "open_issue", "payload": { ...incident... } }`
   - Trigger GitHub `repository_dispatch` with `event_type: codex_autofix` and `client_payload.incident` (optional).
   - Return: `{ "incident_id": "...", "status": "submitted", "pr_url": "https://github.com/.../pull/123" }`
   - Set env vars in Railway: `DEBUG_AGENT_ENDPOINT=https://<agent-endpoint>` and `DEBUG_AGENT_API_KEY=<token-if-needed>`.
3) Flow:
   - `/debug_open_issue "<summary>"` → bot posts incident to the agent → agent triggers Codex Action → PR opens → bot replies in Discord with the PR link.
   - `/debug_confirm_fix <incident_id>` → optional approval step; agent may re-run or finalize.
4) Deployment: merge PR to `main` → Railway auto-deploys the new code automatically.

### Direct GitHub dispatch plan (no external agent)
- Goal: have `/debug_open_issue` call GitHub `repository_dispatch` directly to trigger `codex-autofix.yml`, which runs `openai/codex-action@v1`, opens a PR, and the bot replies with a workflow/PR link.
- Env vars to set (e.g., in Railway):
  - `GITHUB_DISPATCH_TOKEN` — PAT/service token with repo/PR scope.
  - `GITHUB_REPO` — `owner/repo` (e.g., `brianjames-dev/bookiebot`).
  - `GITHUB_DISPATCH_EVENT` — `codex_autofix` (must match workflow).
- Bot changes (pending implementation):
  - Add helper `trigger_codex_autofix(incident_payload)` that POSTs to `https://api.github.com/repos/${GITHUB_REPO}/dispatches` with headers:
    - `Authorization: token ${GITHUB_DISPATCH_TOKEN}`
    - `Accept: application/vnd.github+json`
    - `User-Agent: codex-autofix-dispatch-bot`
  - Body:
    ```json
    {
      "event_type": "<GITHUB_DISPATCH_EVENT>",
      "client_payload": {
        "incident": { ...incident_payload... }
      }
    }
    ```
  - On HTTP 204, reply in Discord: ✅ dispatched + link to workflow (`https://github.com/<GITHUB_REPO>/actions/workflows/codex-autofix.yml`). On error, reply ❌ with status/text.
  - Optional: best-effort fetch latest open PR (`GET /repos/{owner}/{repo}/pulls?state=open&sort=created&direction=desc&per_page=1`) and include link if found.
  - `/debug_confirm_fix` can remain a simple acknowledgment.
- Workflow expectations (already added):
  - `.github/workflows/codex-autofix.yml` with:
    ```yaml
    on:
      repository_dispatch:
        types: [codex_autofix]
    permissions:
      contents: write
      pull-requests: write
    ```
  - Uses `openai/codex-action@v1` with `OPENAI_API_KEY` and `GITHUB_TOKEN` secrets (set in GitHub Actions).
- Docs/config to update during implementation:
  - `.env.example`: add `GITHUB_DISPATCH_TOKEN`, `GITHUB_REPO`, `GITHUB_DISPATCH_EVENT`.
  - README: short “Codex Autofix via /debug_open_issue” section: required env vars, workflow trigger, and how to test.

## 5) Bot UX/guardrails

- [ ] Keep Discord replies concise; ship full logs as attachments.
- [ ] Ensure debug commands fail closed (no logs if permissions fail; no secrets ever echoed).
- [ ] Add retries around log capture and agent calls; never let logging crash the bot.

## 6) Nice-to-haves

- [ ] Add alerts in central log sink for specific errors (e.g., interaction 404s, sheet access failures).
- [ ] Add structured “incident id” to each error path, echo it in Discord replies for easy lookup in logs.
- [ ] Add a “dry-run” mode for `/debug open-issue` to only stage the payload without calling the agent.
