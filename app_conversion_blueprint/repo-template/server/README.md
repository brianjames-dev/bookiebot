# Plaid Bridge Placeholder

Create the minimal Plaid bridge here.

Recommended first implementation: Python FastAPI, because the current BookieBot Plaid integration is Python and the existing logic can be referenced while building tests.

Required endpoints:

- `GET /health`
- `POST /plaid/link-token`
- `POST /plaid/exchange-public-token`
- `POST /plaid/sync`
- `POST /plaid/webhook`
- `POST /plaid/disconnect`

Storage:

- encrypted Plaid access token
- Plaid item ID
- sync cursor
- account metadata
- webhook events
- last sync status

The bridge should not run assistant inference or own the user's budget ledger.
