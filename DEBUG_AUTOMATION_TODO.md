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
- [ ] Add a small CI job or script that, given a patch/branch from the agent, opens a PR (if agent can’t do it directly).
- [ ] After PR merge, trigger Railway redeploy (webhook or CI step). Expose `/deploy latest` (admin-only) that kicks this off.

## 5) Bot UX/guardrails
- [ ] Keep Discord replies concise; ship full logs as attachments.
- [ ] Ensure debug commands fail closed (no logs if permissions fail; no secrets ever echoed).
- [ ] Add retries around log capture and agent calls; never let logging crash the bot.

## 6) Nice-to-haves
- [ ] Add alerts in central log sink for specific errors (e.g., interaction 404s, sheet access failures).
- [ ] Add structured “incident id” to each error path, echo it in Discord replies for easy lookup in logs.
- [ ] Add a “dry-run” mode for `/debug open-issue` to only stage the payload without calling the agent.
