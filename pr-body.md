Automated changes from Codex.

Summary (from incident): Smoke test: Add one line to README.md to signify Codex auto PR pipeline works.

Incident payload (JSON):
```json
{
  "build": "c74adf940591f1dde369799c0d07652ea49d1147",
  "channel": "babys-books",
  "entities": {},
  "env": "prod",
  "intent": null,
  "logs": [
    "{\"ts\": \"2025-11-29T19:59:45.%fZ\", \"level\": \"INFO\", \"msg\": \"🚀 Starting bot...\"}",
    "{\"ts\": \"2025-11-29T19:59:45.%fZ\", \"level\": \"WARNING\", \"msg\": \"PyNaCl is not installed, voice will NOT be supported\"}",
    "{\"ts\": \"2025-11-29T19:59:45.%fZ\", \"level\": \"INFO\", \"msg\": \"logging in using static token\"}",
    "{\"ts\": \"2025-11-29T19:59:46.%fZ\", \"level\": \"INFO\", \"msg\": \"Shard ID None has connected to Gateway (Session ID: 58946d57505d2e0d1e10cb351c0cad99).\"}",
    "{\"ts\": \"2025-11-29T19:59:48.%fZ\", \"level\": \"INFO\", \"msg\": \"✅ Logged in as bot\", \"user\": \"BookieBot#0717\"}",
    "{\"ts\": \"2025-11-29T19:59:48.%fZ\", \"level\": \"INFO\", \"msg\": \"✅ Synced application commands\"}"
  ],
  "summary": "Smoke test: Add one line to README.md to signify Codex auto PR pipeline works.",
  "uptime_seconds": 54.3016097545624,
  "user": ".deebers",
  "user_id": "676638528590970917"
}
```

AI-generated PR summary (from Codex):
```
Added a short confirmation line in `README.md:6` so the repo clearly signals that the Codex auto‑PR smoke test succeeded. No further changes required.```
