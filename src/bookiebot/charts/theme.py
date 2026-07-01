"""Shared Plotly visual theme for BookieBot charts."""

from __future__ import annotations

from typing import Any

# Soft product palette (readable on Discord dark and light clients).
COLORWAY: tuple[str, ...] = (
    "#6366F1",  # indigo
    "#22C55E",  # green
    "#F59E0B",  # amber
    "#EC4899",  # pink
    "#06B6D4",  # cyan
    "#8B5CF6",  # violet
    "#F97316",  # orange
    "#14B8A6",  # teal
)

BAR_COLOR = "#6366F1"
BAR_COLOR_ZERO = "#CBD5E1"
PAPER_BG = "#FFFFFF"
PLOT_BG = "#FAFAFA"
FONT_FAMILY = "Inter, Segoe UI, Helvetica, Arial, sans-serif"
FONT_COLOR = "#0F172A"
MUTED_COLOR = "#64748B"
GRID_COLOR = "#E2E8F0"
DEFAULT_WIDTH = 1100
DEFAULT_HEIGHT = 620
DEFAULT_SCALE = 2


def apply_theme(fig: Any, *, width: int = DEFAULT_WIDTH, height: int = DEFAULT_HEIGHT) -> Any:
    """Apply consistent layout styling to a Plotly figure."""
    fig.update_layout(
        width=width,
        height=height,
        paper_bgcolor=PAPER_BG,
        plot_bgcolor=PLOT_BG,
        font=dict(family=FONT_FAMILY, color=FONT_COLOR, size=14),
        title=dict(font=dict(size=20, color=FONT_COLOR), x=0.5, xanchor="center"),
        colorway=list(COLORWAY),
        margin=dict(l=56, r=40, t=72, b=56),
        legend=dict(
            orientation="h",
            yanchor="bottom",
            y=1.02,
            xanchor="center",
            x=0.5,
            bgcolor="rgba(0,0,0,0)",
        ),
        hoverlabel=dict(bgcolor="#0F172A", font_size=13, font_family=FONT_FAMILY),
    )
    fig.update_xaxes(
        showgrid=False,
        zeroline=False,
        linecolor=GRID_COLOR,
        tickfont=dict(color=MUTED_COLOR, size=12),
        title_font=dict(color=MUTED_COLOR, size=13),
    )
    fig.update_yaxes(
        showgrid=True,
        gridcolor=GRID_COLOR,
        zeroline=False,
        linecolor=GRID_COLOR,
        tickfont=dict(color=MUTED_COLOR, size=12),
        title_font=dict(color=MUTED_COLOR, size=13),
    )
    return fig
