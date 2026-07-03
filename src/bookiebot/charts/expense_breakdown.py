"""Expense category breakdown chart builder."""

from __future__ import annotations

from typing import Any, Mapping

import plotly.graph_objects as go

from bookiebot.charts.theme import COLORWAY, DEFAULT_HEIGHT, DEFAULT_WIDTH, apply_theme


def build_expense_breakdown_figure(
    categories: Mapping[str, Mapping[str, Any]],
    grand_total: float,
    title: str | None = None,
) -> go.Figure:
    """Build a donut chart for non-zero expense categories."""
    labels: list[str] = []
    values: list[float] = []
    customdata: list[list[float]] = []

    for category, info in categories.items():
        amount = float(info.get("amount") or 0.0)
        if amount <= 0:
            continue
        percentage = float(info.get("percentage") or 0.0)
        label = (
            str(info["label"]).strip()
            if info.get("label")
            else str(category).replace("_", " ").strip().title()
        )
        labels.append(label)
        values.append(amount)
        customdata.append([amount, percentage])

    if not values:
        raise ValueError("No non-zero categories available for expense breakdown chart")

    pull = [0.08 if amount == max(values) else 0.0 for amount in values]
    colors = [COLORWAY[i % len(COLORWAY)] for i in range(len(values))]

    fig = go.Figure(
        data=[
            go.Pie(
                labels=labels,
                values=values,
                domain=dict(x=[0.08, 0.92], y=[0.04, 0.96]),
                hole=0.42,
                pull=pull,
                marker=dict(colors=colors, line=dict(color="#FFFFFF", width=2)),
                textinfo="label+percent",
                textposition="outside",
                texttemplate="%{label}<br>%{percent}<br>$%{customdata[0]:.2f}",
                hovertemplate=(
                    "<b>%{label}</b><br>"
                    "Amount: $%{customdata[0]:.2f}<br>"
                    "Share: %{customdata[1]:.2f}%"
                    "<extra></extra>"
                ),
                customdata=customdata,
                sort=False,
            )
        ]
    )
    apply_theme(fig, width=DEFAULT_WIDTH, height=DEFAULT_HEIGHT)
    fig.update_layout(
        title=dict(text=""),
        showlegend=False,
        annotations=[
            dict(
                text=f"<b>${grand_total:,.2f}</b><br>total",
                x=0.5,
                y=0.5,
                font=dict(size=16),
                showarrow=False,
            )
        ],
        margin=dict(l=110, r=110, t=48, b=48),
    )
    return fig
