import discord
import logging

logger = logging.getLogger(__name__)


async def safe_edit_followup(followup: discord.Webhook, message_id: int, content: str) -> None:
    try:
        await followup.edit_message(
            message_id=message_id,
            content=content,
        )
    except Exception as e:
        logger.exception("Failed to edit followup message", extra={"exception": str(e)})
        try:
            await followup.send(content, ephemeral=True)
        except Exception:
            logger.exception("Failed to send fallback followup", extra={"exception": str(e)})


async def safe_edit_original(interaction: discord.Interaction, content: str) -> None:
    try:
        await interaction.edit_original_response(content=content)
    except Exception as e:
        logger.exception("Failed to edit original response", extra={"exception": str(e)})
