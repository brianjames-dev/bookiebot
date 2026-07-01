from unittest.mock import MagicMock

import pytest

from bookiebot.charts.render import (
    ChartRenderError,
    figure_to_discord_file,
    figure_to_png_bytes,
    figure_to_png_bytes_sync,
)


def test_figure_to_png_bytes_sync_returns_bytes(monkeypatch):
    fig = MagicMock()
    fig.to_image.return_value = b"\x89PNG fake"

    result = figure_to_png_bytes_sync(fig, width=100, height=80, scale=1)

    assert result == b"\x89PNG fake"
    fig.to_image.assert_called_once_with(format="png", width=100, height=80, scale=1)


def test_figure_to_png_bytes_sync_wraps_errors(monkeypatch):
    fig = MagicMock()
    fig.to_image.side_effect = RuntimeError("boom")

    with pytest.raises(ChartRenderError, match="Failed to render chart image"):
        figure_to_png_bytes_sync(fig)


def test_figure_to_png_bytes_sync_rejects_empty_output():
    fig = MagicMock()
    fig.to_image.return_value = b""

    with pytest.raises(ChartRenderError, match="empty output"):
        figure_to_png_bytes_sync(fig)


@pytest.mark.asyncio
async def test_figure_to_discord_file_uses_export_helper(monkeypatch):
    fig = object()
    monkeypatch.setattr(
        "bookiebot.charts.render.figure_to_png_bytes",
        MagicMock(side_effect=None),
    )

    async def _fake_png(*_args, **_kwargs):
        return b"\x89PNG data"

    monkeypatch.setattr("bookiebot.charts.render.figure_to_png_bytes", _fake_png)

    discord_file = await figure_to_discord_file(fig, "expense_breakdown.png")

    assert discord_file.filename == "expense_breakdown.png"
    assert discord_file.fp.read() == b"\x89PNG data"


@pytest.mark.asyncio
async def test_figure_to_png_bytes_runs_in_thread(monkeypatch):
    fig = object()
    called = {}

    def _sync(fig_arg, *, width, height, scale):
        called["args"] = (fig_arg, width, height, scale)
        return b"\x89PNG threaded"

    monkeypatch.setattr("bookiebot.charts.render.figure_to_png_bytes_sync", _sync)

    result = await figure_to_png_bytes(fig, width=10, height=20, scale=3)

    assert result == b"\x89PNG threaded"
    assert called["args"] == (fig, 10, 20, 3)


@pytest.mark.integration
def test_kaleido_export_smoke():
    pytest.importorskip("kaleido")
    import plotly.graph_objects as go

    from bookiebot.charts.daily_spending import build_daily_spending_figure
    from bookiebot.charts.expense_breakdown import build_expense_breakdown_figure
    from bookiebot.charts.render import figure_to_png_bytes_sync

    breakdown = build_expense_breakdown_figure(
        {
            "food": {"amount": 60.0, "percentage": 60.0},
            "gas": {"amount": 40.0, "percentage": 40.0},
        },
        grand_total=100.0,
    )
    daily = build_daily_spending_figure([1, 2, 3], [0.0, 12.0, 5.5], "May 2025")

    for fig in (breakdown, daily):
        png = figure_to_png_bytes_sync(fig, width=400, height=300, scale=1)
        assert png.startswith(b"\x89PNG")
        assert len(png) > 1000
