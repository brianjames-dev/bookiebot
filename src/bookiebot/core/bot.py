import logging
import os
import random
import time

import discord

from bookiebot.core import config
from bookiebot.core.discord_client import create_client
from bookiebot.core.commands import register_commands
from bookiebot.core.message_router import register_events
from bookiebot.logging_config import init_logging

init_logging()
logger = logging.getLogger(__name__)


def _login_retry_seconds() -> int:
    raw = os.getenv("BOOKIEBOT_DISCORD_LOGIN_RETRY_SECONDS", "900").strip()
    try:
        return max(int(raw), 60)
    except ValueError:
        return 900


def _is_discord_login_rate_limit(exc: Exception) -> bool:
    if isinstance(exc, discord.HTTPException) and getattr(exc, "status", None) == 429:
        return True
    text = f"{type(exc).__name__}: {exc}".lower()
    return "429" in text and ("rate limited" in text or "1015" in text)


def main() -> None:
    logger.info("🚀 Starting bot...")
    token = config.require_token()

    while True:
        client, tree = create_client()
        register_commands(tree)
        register_events(client, tree)
        try:
            client.run(token)
            break
        except Exception as e:
            if not _is_discord_login_rate_limit(e):
                logger.exception("Bot failed to start", extra={"exception": str(e)})
                raise
            base_delay = _login_retry_seconds()
            delay = base_delay + random.randint(0, min(120, base_delay))
            logger.warning(
                "Discord login was rate limited; retrying after backoff",
                extra={"exception": str(e), "retry_seconds": delay},
            )
            time.sleep(delay)


if __name__ == "__main__":
    main()
