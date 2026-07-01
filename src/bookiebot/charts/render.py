"""Render Plotly figures to PNG bytes and Discord file attachments."""

from __future__ import annotations

import asyncio
import io
import logging
import os
from typing import Any

from bookiebot.charts.theme import DEFAULT_HEIGHT, DEFAULT_SCALE, DEFAULT_WIDTH

logger = logging.getLogger(__name__)

os.environ.setdefault("DISCORD_AUDIO_DISABLE", "1")

try:
    import discord
except ImportError:  # pragma: no cover - fallback for tests without discord.py
    class _Discord:
        class File:
            def __init__(self, fp: Any, filename: str) -> None:
                self.fp = fp
                self.filename = filename

    discord = _Discord()  # type: ignore[assignment]


class ChartRenderError(RuntimeError):
    """Raised when a Plotly figure cannot be exported to an image."""


def figure_to_png_bytes_sync(
    fig: Any,
    *,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    scale: int = DEFAULT_SCALE,
) -> bytes:
    """Synchronously export a figure to PNG bytes via Kaleido."""
    try:
        image_bytes = fig.to_image(format="png", width=width, height=height, scale=scale)
    except Exception as exc:  # pragma: no cover - depends on kaleido runtime
        raise ChartRenderError(f"Failed to render chart image: {exc}") from exc
    if not image_bytes:
        raise ChartRenderError("Chart image export returned empty output")
    return bytes(image_bytes)


async def figure_to_png_bytes(
    fig: Any,
    *,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    scale: int = DEFAULT_SCALE,
) -> bytes:
    """Export a figure to PNG bytes without blocking the event loop."""
    return await asyncio.to_thread(
        figure_to_png_bytes_sync,
        fig,
        width=width,
        height=height,
        scale=scale,
    )


async def figure_to_discord_file(
    fig: Any,
    filename: str,
    *,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    scale: int = DEFAULT_SCALE,
) -> Any:
    """Render a figure and wrap it in a ``discord.File`` attachment."""
    png_bytes = await figure_to_png_bytes(fig, width=width, height=height, scale=scale)
    buf = io.BytesIO(png_bytes)
    buf.seek(0)
    return discord.File(fp=buf, filename=filename)
