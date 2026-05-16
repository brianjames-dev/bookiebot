# Portable BookieBot Roadmap

This roadmap is for turning BookieBot from a personal finance bot into a portable app that another household can install, configure, and run without editing source code.

The guiding constraint: keep the existing Brian/Hannah bot working while gradually moving personal assumptions into configuration and setup tooling.

## Product Goal

A new user should be able to:

1. Create or connect Google credentials.
2. Create a Discord bot and invite it to their server.
3. Run BookieBot in Docker.
4. Enter household members, cards, categories, bills, and subscriptions.
5. Let BookieBot create or update the required Google Sheets.
6. Use Google Sheets as the readable/editable financial ledger.
7. Use Discord as the natural-language interface.

## Safe Work We Can Do Now

These items are low-risk because they can be added alongside the existing app without changing current behavior.

### 1. Add Container Scaffolding

Create:

- `Dockerfile`
- `.dockerignore`
- `docker-compose.yml`
- documented volume/env handling

The first container should only run the existing bot. It should not change how config works yet.

### 2. Improve Environment Validation

Add a startup validation module that checks required environment variables and prints actionable errors.

Examples:

- `DISCORD_TOKEN`
- `OPENAI_API_KEY`
- `GOOGLE_SERVICE_ACCOUNT_JSON`
- channel config
- yearly spreadsheet IDs

This can start as a read-only validator that reports issues without changing runtime behavior.

### 3. Create a Setup/Doctor Command

Add a local CLI command such as:

```bash
python -m bookiebot.setup doctor
```

It should verify:

- Python dependencies import
- Discord token exists
- OpenAI key exists
- Google credentials parse
- configured sheets are reachable
- current month worksheets exist
- known Discord users are configured

This is useful immediately for your own deployments and later becomes the setup wizard foundation.

### 4. Document the Current Manual Setup

Create a dedicated setup guide that captures the current process before automating it.

Include:

- Discord bot creation
- Discord invite permissions
- Railway or Docker deployment
- Google service account setup
- Google Sheet sharing
- required environment variables
- monthly tab assumptions
- user ID mapping

This prevents knowledge from staying trapped in the code.

### 5. Extract Personal Assumptions Behind Config Helpers

Start moving hardcoded assumptions into centralized config structures without changing defaults.

Current assumptions to isolate:

- Brian and Hannah user IDs
- budget owner keys
- expense person names
- default yearly spreadsheet IDs
- category list and column layout
- shortcut relay mappings

The first pass should preserve all current defaults so behavior does not change.

## Major Workstreams

### 1. Containerization

Goal: run BookieBot consistently on any machine or host.

Deliverables:

- Dockerfile
- docker-compose file
- healthcheck command
- logs routed to stdout/stderr
- documented env setup
- optional local `.env` loading

Risks:

- Google credentials may be awkward as JSON in env vars.
- Avatar assets and other local files need predictable paths.
- Discord networking is simple, but startup failures need clear logs.

### 2. Configuration System

Goal: make BookieBot household-configurable without source edits.

Configuration should cover:

- household members
- Discord user mappings
- cards/accounts
- categories
- bill names
- subscription names
- yearly spreadsheet IDs
- channel/server settings
- timezone

Possible formats:

- environment variables for secrets and deployment-specific values
- YAML or JSON for household profile config
- Google Sheet `Config` tab for user-editable non-secret settings

Recommended direction:

- Secrets stay in env vars.
- Household profile starts as YAML/JSON.
- Later, setup can write that profile into a Google Sheet config tab.

### 3. Google Sheets Bootstrapper

Goal: create the spreadsheet structure automatically.

The bootstrapper should be able to:

- create a new budget spreadsheet
- create monthly worksheets
- create income, expense, subscription, config, and action-log areas
- apply headers and formulas
- validate existing sheets
- repair missing tabs or headers
- version the schema

Important design point:

The sheet schema should have a version marker. Future changes can then run migrations instead of relying on fragile manual updates.

### 4. First-Run Setup Wizard

Goal: guide a new user through setup.

Possible phases:

1. Check environment variables.
2. Validate Google credentials.
3. Ask for household members.
4. Ask for cards/accounts.
5. Ask for categories.
6. Ask for recurring bills and subscriptions.
7. Create Google Sheets.
8. Print Discord invite URL.
9. Run final health check.

Initial version can be CLI-based. A web setup UI can come later if needed.

### 5. Discord Admin Setup Commands

Goal: allow configuration and validation from Discord.

Useful commands:

- `/setup_status`
- `/setup_member_add`
- `/setup_card_add`
- `/setup_subscription_add`
- `/setup_bill_add`
- `/setup_validate`
- `/setup_resync_sheets`

These should be admin-only and should avoid exposing secrets in Discord.

### 6. Multi-Household Support

Goal: allow one deployed BookieBot service to support more than one Discord server or household.

This is not needed for the first portable version.

Required later:

- per-guild config
- per-guild sheets
- per-guild users
- secure tenant separation
- migration tooling

Recommendation:

Do not start here. First make one household configurable and portable.

## Suggested Implementation Phases

### Phase 0: Preserve Current Bot

Outcome: no behavior changes.

Tasks:

- Keep current Brian/Hannah defaults.
- Add tests around config defaults before moving them.
- Document current assumptions.

### Phase 1: Docker-Ready App

Outcome: current bot can run in Docker.

Tasks:

- Add Dockerfile.
- Add `.dockerignore`.
- Add docker-compose example.
- Ensure logs go to stdout.
- Add setup documentation.

### Phase 2: Doctor Command

Outcome: deployment problems are easier to diagnose.

Tasks:

- Add `bookiebot.setup` module.
- Implement `doctor` checks.
- Validate env vars.
- Validate Google credentials.
- Validate spreadsheet access.
- Validate current month tabs.

### Phase 3: Config Extraction

Outcome: personal assumptions are centralized and overrideable.

Tasks:

- Move user mappings into a config object.
- Move category definitions behind a config loader.
- Preserve existing defaults.
- Add tests for default config and env overrides.

### Phase 4: Sheet Templates and Bootstrap

Outcome: BookieBot can create the minimum required sheet structure.

Tasks:

- Define schema version.
- Generate worksheets.
- Generate headers.
- Generate action-log sheet.
- Generate subscriptions/config tabs.
- Add validation and repair mode.

### Phase 5: Setup Wizard

Outcome: a new user can configure BookieBot without reading the source.

Tasks:

- CLI setup wizard.
- Household profile file generation.
- Google Sheet creation.
- Discord invite URL generation.
- Final doctor check.

### Phase 6: Polished Portable App

Outcome: BookieBot can be handed to another household confidently.

Tasks:

- Better docs.
- Backup/export guidance.
- Upgrade/migration guidance.
- Admin Discord setup commands.
- Optional web setup UI.

## Things To Avoid Early

- Multi-household SaaS architecture
- Automatic bank integration during setup
- Rewriting the sheet model before documenting it
- Replacing Google Sheets with a database
- Adding a web UI before the CLI/setup path is clear
- Removing Brian/Hannah defaults before tests cover the current behavior

## Recommended Next Task

Start with Phase 1 and Phase 2 together:

1. Add Docker scaffolding.
2. Add a non-invasive `doctor` command.
3. Document the current setup process.

This gives immediate value, makes the app easier to deploy, and creates the foundation for self-serve setup without risking the existing bot.
