"""Daily spending calendar chart builder."""

from __future__ import annotations

from typing import Sequence

import plotly.graph_objects as go

from bookiebot.charts.theme import (
    BAR_COLOR,
    BAR_COLOR_ZERO,
    DEFAULT_HEIGHT,
    DEFAULT_WIDTH,
    MUTED_COLOR,
    apply_theme,
)


def build_daily_spending_figure(
    days: Sequence[int],
    amounts: Sequence[float],
    month_label: str,
) -> go.Figure:
    """Build a bar chart of spending by day of month."""
    if len(days) != len(amounts):
        raise ValueError("days and amounts must be the same length")
    if not days:
        raise ValueError("No daily spending points available for chart")

    day_list = [int(day) for day in days]
    amount_list = [float(amount) for amount in amounts]
    colors = [BAR_COLOR if amount > 0 else BAR_COLOR_ZERO for amount in amount_list]
    tick_dtick = 1 if len(day_list) <= 16 else 2

    fig = go.Figure(
        data=[
            go.Bar(
                x=day_list,
                y=amount_list,
                marker=dict(color=colors, line=dict(width=0), cornerradius=6),
                hovertemplate="Day %{x}<br>Spent: $%{y:.2f}<extra></extra>",
                text=[f"${amount:.0f}" if amount >= 1 else "" for amount in amount_list],
                textposition="outside",
                cliponaxis=False,
            )
        ]
    )
    apply_theme(fig, width=DEFAULT_WIDTH, height=DEFAULT_HEIGHT)
    fig.update_layout(
        title=dict(text=f"Daily Spending — {month_label}"),
        bargap=0.25,
        yaxis_tickprefix="$",
        yaxis_tickformat=",.2f",
        showlegend=False,
        margin=dict(l=64, r=32, t=72, b=64),
    )
    fig.update_xaxes(
        title_text="Day of Month",
        tickmode="linear",
        tick0=day_list[0],
        dtick=tick_dtick,
        tickfont=dict(color=MUTED_COLOR, size=12),
    )
    fig.update_yaxes(title_text="Amount Spent ($)")
    return fig
