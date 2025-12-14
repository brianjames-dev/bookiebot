import os
from dotenv import load_dotenv
from typing import Optional

# Disable discord voice/audio stack to avoid loading audioop (deprecated in Python 3.13)
os.environ.setdefault("DISCORD_AUDIO_DISABLE", "1")

load_dotenv()

TOKEN: Optional[str] = os.getenv("DISCORD_TOKEN")
CHANNEL_NAME = os.getenv("CHANNEL_NAME", "babys-books")
CHANNEL_ID = int(os.getenv("CHANNEL_ID", "0")) or None
DEBUG_ALLOWLIST = {u.strip() for u in os.getenv("DEBUG_ADMINS", "").split(",") if u.strip()}
AGENT_ENDPOINT = os.getenv("DEBUG_AGENT_ENDPOINT", "").strip()
AGENT_API_KEY = os.getenv("DEBUG_AGENT_API_KEY", "").strip()
GITHUB_DISPATCH_TOKEN = os.getenv("GITHUB_DISPATCH_TOKEN", "").strip()
GITHUB_REPO = os.getenv("GITHUB_REPO", "").strip()
GITHUB_DISPATCH_EVENT = os.getenv("GITHUB_DISPATCH_EVENT", "codex_autofix").strip()
GITHUB_API_BASE = "https://api.github.com"

def require_token() -> str:
    if not TOKEN:
        raise RuntimeError("❌ DISCORD_TOKEN is not set in the environment!")
    return TOKEN
