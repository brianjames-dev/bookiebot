import pytest

from bookiebot.charts.daily_spending import build_daily_spending_figure


def test_build_daily_spending_figure():
    fig = build_daily_spending_figure([1, 2, 3], [0.0, 12.5, 4.0], "May 2025")

    bar = fig.data[0]
    assert bar.type == "bar"
    assert list(bar.x) == [1, 2, 3]
    assert list(bar.y) == [0.0, 12.5, 4.0]
    assert "May 2025" in fig.layout.title.text
    assert fig.layout.yaxis.tickprefix == "$"


def test_build_daily_spending_figure_validates_inputs():
    with pytest.raises(ValueError, match="same length"):
        build_daily_spending_figure([1, 2], [1.0], "May 2025")

    with pytest.raises(ValueError, match="No daily spending points"):
        build_daily_spending_figure([], [], "May 2025")
