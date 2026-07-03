import pytest

from bookiebot.charts.expense_breakdown import build_expense_breakdown_figure


def test_build_expense_breakdown_figure_skips_zero_categories():
    fig = build_expense_breakdown_figure(
        {
            "food": {"amount": 60.0, "percentage": 60.0},
            "gas": {"amount": 40.0, "percentage": 40.0},
            "shopping": {"amount": 0.0, "percentage": 0.0},
        },
        grand_total=100.0,
    )

    pie = fig.data[0]
    assert pie.type == "pie"
    assert list(pie.labels) == ["Food", "Gas"]
    assert list(pie.values) == [60.0, 40.0]
    assert pie.hole == pytest.approx(0.42)
    assert pie.textinfo == "label+percent"
    assert pie.textposition == "outside"
    assert pie.texttemplate == "%{label}<br>%{percent}<br>$%{customdata[0]:.2f}"
    assert pie.domain.x == (0.08, 0.92)
    assert fig.layout.title.text == ""
    assert fig.layout.showlegend is False
    assert fig.layout.margin.r == 110


def test_build_expense_breakdown_figure_requires_non_zero_data():
    with pytest.raises(ValueError, match="No non-zero categories"):
        build_expense_breakdown_figure(
            {"food": {"amount": 0.0, "percentage": 0.0}},
            grand_total=0.0,
        )
