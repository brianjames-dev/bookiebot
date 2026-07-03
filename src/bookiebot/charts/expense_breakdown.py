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
    chart_title = title or "Expense Breakdown"

    fig = go.Figure(
        data=[
            go.Pie(
                labels=labels,
                values=values,
                domain=dict(x=[0.02, 0.72], y=[0.02, 0.92]),
                hole=0.42,
                pull=pull,
                marker=dict(colors=colors, line=dict(color="#FFFFFF", width=2)),
                textinfo="percent",
                textposition="inside",
                texttemplate="%{percent}",
                insidetextorientation="radial",
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
        title=dict(text=chart_title),
        showlegend=True,
        legend=dict(
            orientation="v",
            yanchor="middle",
            y=0.5,
            xanchor="left",
            x=0.8,
            bgcolor="rgba(0,0,0,0)",
        ),
        uniformtext=dict(minsize=11, mode="hide"),
        annotations=[
            dict(
                text=f"<b>${grand_total:,.2f}</b><br>total",
                x=0.37,
                y=0.47,
                font=dict(size=16),
                showarrow=False,
            )
        ],
        margin=dict(l=40, r=260, t=70, b=40),
    )
    return fig
