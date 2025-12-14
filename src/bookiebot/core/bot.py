import logging

from bookiebot.core import config
from bookiebot.core.discord_client import create_client
from bookiebot.core.commands import register_commands
from bookiebot.core.message_router import register_events
from bookiebot.logging_config import init_logging

init_logging()
logger = logging.getLogger(__name__)

logger.info("🚀 Starting bot...")

# Ensure token exists
token = config.require_token()

client, tree = create_client()
register_commands(tree)
register_events(client, tree)

try:
    client.run(token)
except Exception as e:
    logger.exception("Bot failed to start", extra={"exception": str(e)})
