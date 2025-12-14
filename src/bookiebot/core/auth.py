import discord
from bookiebot.core import config


def is_debug_allowed(user: discord.abc.User) -> bool:
    if not config.DEBUG_ALLOWLIST:
        return False
    return str(user.id) in config.DEBUG_ALLOWLIST
