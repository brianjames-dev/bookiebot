import logging
import math
import os
import random
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Callable

import discord

from bookiebot.core import config
from bookiebot.core.discord_client import create_client
from bookiebot.core.commands import register_commands
from bookiebot.core.message_router import register_events
from bookiebot.logging_config import init_logging

init_logging()
logger = logging.getLogger(__name__)

MIN_LOGIN_RETRY_SECONDS = 60
DEFAULT_LOGIN_RETRY_SECONDS = 300
DEFAULT_LOGIN_RETRY_MAX_SECONDS = 1800
LOGIN_RETRY_PROGRESS_INTERVAL_SECONDS = 60


def _env_int(name: str, default: int, minimum: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        return max(int(raw), minimum)
    except ValueError:
        return default


def _login_retry_max_seconds() -> int:
    return _env_int(
        "BOOKIEBOT_DISCORD_LOGIN_RETRY_MAX_SECONDS",
        DEFAULT_LOGIN_RETRY_MAX_SECONDS,
        MIN_LOGIN_RETRY_SECONDS,
    )


def _login_retry_seconds(attempt: int = 1, retry_after_seconds: int | None = None) -> int:
    max_delay = _login_retry_max_seconds()
    if retry_after_seconds is not None:
        return min(max(retry_after_seconds, MIN_LOGIN_RETRY_SECONDS), max_delay)

    base_delay = _env_int(
        "BOOKIEBOT_DISCORD_LOGIN_RETRY_SECONDS",
        DEFAULT_LOGIN_RETRY_SECONDS,
        MIN_LOGIN_RETRY_SECONDS,
    )
    return min(base_delay * max(attempt, 1), max_delay)


def _login_retry_delay(attempt: int, retry_after_seconds: int | None = None) -> int:
    delay = _login_retry_seconds(attempt, retry_after_seconds)
    if retry_after_seconds is not None:
        return delay
    return min(delay + random.randint(0, min(60, delay)), _login_retry_max_seconds())


def _retry_header_value(exc: Exception, header_name: str) -> str | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if not headers or not hasattr(headers, "get"):
        return None
    value = headers.get(header_name)
    if value is not None:
        return str(value)
    return headers.get(header_name.lower())


def _seconds_from_text(value: str | None) -> int | None:
    if not value:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    if seconds <= 0:
        return None
    return int(math.ceil(seconds))


def _discord_retry_after_seconds(exc: Exception) -> int | None:
    for header_name in ("Retry-After", "X-RateLimit-Reset-After"):
        retry_after = _seconds_from_text(_retry_header_value(exc, header_name))
        if retry_after is not None:
            return retry_after

    match = re.search(r"retry[_\s-]?after['\"]?\s*[:=]\s*([0-9.]+)", str(exc), re.IGNORECASE)
    if match:
        return _seconds_from_text(match.group(1))
    return None


def _is_discord_login_rate_limit(exc: Exception) -> bool:
    if isinstance(exc, discord.HTTPException) and getattr(exc, "status", None) == 429:
        return True
    text = f"{type(exc).__name__}: {exc}".lower()
    return "429" in text and ("rate limit" in text or "too many requests" in text or "1015" in text)


def _sleep_before_login_retry(
    delay_seconds: int,
    *,
    sleep_fn: Callable[[float], None] = time.sleep,
    monotonic_fn: Callable[[], float] = time.monotonic,
) -> None:
    deadline = monotonic_fn() + delay_seconds
    while True:
        remaining = math.ceil(deadline - monotonic_fn())
        if remaining <= 0:
            return
        sleep_for = min(LOGIN_RETRY_PROGRESS_INTERVAL_SECONDS, remaining)
        sleep_fn(sleep_for)
        remaining = math.ceil(deadline - monotonic_fn())
        if remaining > 0:
            logger.info(
                "Discord login retry backoff in progress",
                extra={"retry_in_seconds": remaining},
            )


def main() -> None:
    logger.info("🚀 Starting bot...")
    token = config.require_token()

    login_attempt = 1
    while True:
        client, tree = create_client()
        register_commands(tree)
        register_events(client, tree)
        logger.info("Attempting Discord login", extra={"login_attempt": login_attempt})
        try:
            client.run(token)
            break
        except Exception as e:
            if not _is_discord_login_rate_limit(e):
                logger.exception("Bot failed to start", extra={"exception": str(e)})
                raise
            retry_after_seconds = _discord_retry_after_seconds(e)
            delay = _login_retry_delay(login_attempt, retry_after_seconds)
            retry_at = datetime.now(timezone.utc) + timedelta(seconds=delay)
            logger.warning(
                "Discord login was rate limited; retrying after backoff",
                extra={
                    "exception": str(e),
                    "login_attempt": login_attempt,
                    "retry_after_seconds": retry_after_seconds,
                    "retry_seconds": delay,
                    "retry_at": retry_at.isoformat(),
                    "max_retry_seconds": _login_retry_max_seconds(),
                },
            )
            _sleep_before_login_retry(delay)
            login_attempt += 1


if __name__ == "__main__":
    main()
