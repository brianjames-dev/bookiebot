# Codex Autofix & Discord Progress Updates (Planned Wiring)

This document outlines how to wire the `/debug_open_issue` flow to post accurate, step-by-step status updates back into Discord while the GitHub Action runs. Two approaches are described: a **webhook-from-workflow** (recommended for accuracy) and a **bot-polling** approach (simpler but less precise).

---

## Current State (baseline)

- `/debug_open_issue` dispatches `repository_dispatch` → `codex-autofix` workflow.
- Workflow runs Codex, builds PR body, and opens a PR.
- Bot posts workflow link immediately, then polls for the PR and posts it when found (suppressed embeds).

---

## Goal: “Loading” Updates in Discord

We want an in-Discord message that shows progress through the workflow steps (e.g., “5/12 Run Codex Autofix”) and is updated dynamically as the workflow advances.

### Workflow → Discord Webhook (most accurate, recommended)

1. **Create a Discord webhook**

   - In your target channel: Integrations → Webhooks → New Webhook → Copy URL.
   - Add it to GitHub Secrets (e.g., `DISCORD_STATUS_WEBHOOK`).

2. **Instrument the workflow with tiny notify steps**

   - Before/after each major step (checkout, setup Python, install deps, run Codex, build PR, create PR), insert a `curl` to the webhook:
     ```bash
     curl -X POST -H "Content-Type: application/json" \
       -d '{"content":"[codex] Step 3/10: Run Codex Autofix (GitHub run #${{ github.run_id }})"}' \
       "$DISCORD_STATUS_WEBHOOK"
     ```
   - Keep payloads short; include `run_id` for traceability.

3. **Report completion**

   - On success: send PR link and workflow run URL.
   - On failure: include run URL and (optionally) last few lines of the log.

4. **No bot changes needed**
   - Webhook posts will show as separate messages in Discord. If you want them ephemeral, you’d need a bot endpoint instead; see Option B.

---

## Recommended Minimal Plan (to implement)

- Use **Option A (Webhook)** for accuracy and simplicity:
  1. Add `DISCORD_STATUS_WEBHOOK` secret in GitHub.
  2. Insert small `curl` notifications in `.github/workflows/codex-autofix.yml` around each major step (checkout, deps, Codex run, PR creation).
  3. Final notification: include PR link (from `create-pull-request` step) and workflow URL. On failure, include run URL and a short error hint.

If you prefer a single-threaded update (one message edited repeatedly), you’d need a small bot endpoint to receive step updates and edit a stored message. That adds hosting and bot-side state; the webhook approach avoids this.

---

## Rough Step Mapping for Status Messages (example)

1. Setup job
2. Check out repository
3. Set up Python
4. Install dependencies
5. Run Codex Autofix
6. Build PR title/body
7. Check for changes
8. Create PR
9. Cleanup steps (post runs)
10. Complete job

You can collapse or reorder as needed; aim for concise messages and no secrets in payloads.

---

## Notes & Safety

- Do not include secrets in webhook payloads.
- Keep messages short to avoid Discord rate limits; throttle if necessary.
- If using the webhook approach, there’s no need to expand polling further in the bot.
