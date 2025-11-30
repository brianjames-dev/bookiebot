# CI/CD Autopilot: Enhancement Ideas

This doc captures potential improvements to the Codex-driven PR pipeline and Discord status flow.

## Smarter PRs

- Apply labels automatically (e.g., `codex-autofix`, `needs-review`, `docs`, `tests`) based on incident summary or file touches.
- Add a “Change summary” section in the PR body with concise bullet points parsed from Codex output.
- Include a “Risk/Confidence” line in the PR body; prompt Codex to emit one.
- Add an “Incident” section in the PR body with summary + timestamp for traceability.

## Safety and Scope

- Guardrails: “If uncertain, do nothing” + ignore certain paths (workflows, assets) via prompt or `.codexignore` (if supported).
- Dynamically set `effort` by incident type (docs/tests → low; code fixes → medium/high).
- Keep log slices small/focused when dispatching to Codex to reduce tokens.

## Checks and Review

- Add lightweight lint/test steps and surface pass/fail in the PR body.
- Auto-add a review bot comment summarizing changes, or use Codex output as a summary comment.

## Discord UX

- Include elapsed time in the final Discord message.
- Surface failure reasons from the workflow in the final message.
- Keep single-message spinner; optionally add step names or coarse states (queued/running/completed) from the Actions API.

## Housekeeping

- Auto-close/prune stale `codex/autofix-*` branches (scheduled workflow).
- Ensure Codex ignores workflow files unless explicitly requested.

## Reliability

- Retry PR polling on transient GitHub errors.
- If Codex fails, surface a short error + workflow link in Discord.

## Tokens & Cost

- Set explicit `effort` per incident type (lower for docs/tests).
- Trim logs aggressively before dispatch; allow `lines` override per command.
