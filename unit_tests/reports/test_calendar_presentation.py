from pathlib import Path
import subprocess

import pytest


FRONTEND = Path(__file__).resolve().parents[2] / "web/expense-report/src"


def test_calendar_colors_and_today_highlight_runtime():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to execute presentation checks")
    subprocess.run(
        ["node", "unit_tests/reports/calendar_presentation_test.cjs"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )


def test_native_chart_scrolling_has_one_position_owner():
    styles = (FRONTEND / "styles.css").read_text()
    viewport = "\n".join(part.split("}", 1)[0] for part in styles.split(".bb-chart-carousel {")[1:])
    track = styles.split(".bb-chart-carousel-track {", 1)[1].split("}", 1)[0]
    # Native scrollLeft now owns both panning and focus scrolling. Combining it
    # with a transformed track caused Calendar's historical double offset.
    assert "overflow-x: auto;" in viewport
    assert "scroll-snap-type: x mandatory;" in viewport
    assert "touch-action: auto;" in viewport
    assert "transform" not in track


def test_calendar_markers_constrain_amounts_and_size_counts_to_the_day_cell():
    styles = (FRONTEND / "styles.css").read_text()
    marker = styles.split(".bb-subscription-marker {", 1)[1].split("}", 1)[0]
    amount = styles.split(".bb-subscription-marker-amount {", 2)[2].split("}", 1)[0]
    mobile = styles.split("@media (max-width: 520px)", 1)[1]

    # A long amount must be allowed to shrink inside its pill. Busy mobile days
    # must not squeeze a dot and count into the old fixed 20px maximum.
    assert "max-width: 100%;" in marker
    assert "min-width: 0;" in amount
    assert "flex: 0 1 auto;" in amount
    assert "max-width: 20px;" not in mobile
    assert "container: calendar-day / inline-size;" in styles
    assert "@container calendar-day (max-width: 92px)" in styles
    compact = styles.split("@container calendar-day (max-width: 92px)", 1)[1]
    assert "display: none;" in compact.split(".bb-subscription-marker-amount {", 1)[1].split("}", 1)[0]
    assert "display: inline-flex;" in compact.split(".bb-calendar-marker-count {", 1)[1].split("}", 1)[0]
    assert "@container calendar-day (max-width: 32px)" in styles


def test_calendar_uses_day_dialog_instead_of_hover_only_details():
    source = (FRONTEND / "report-app.tsx").read_text()
    panel = source.split("function CalendarAnalyticsPanel", 1)[1].split("function BillsUtilitiesPanel", 1)[0]
    assert '<ModalDetails summary="Calendar day"' in panel
    assert 'collapseKey={collapseKey}' in panel
    assert '<CalendarDayDetails selection={selection}' in panel
    assert 'CalendarFilterControl' not in source


def test_two_week_calendar_model_and_logo_matching():
    root = FRONTEND.parents[2]
    subprocess.run(["node", "unit_tests/reports/cashflow_calendar_test.cjs"], cwd=root,
                   check=True, capture_output=True, text=True)


def test_daily_today_marker_overrides_the_button_reset_without_layout_changes():
    styles = (FRONTEND / "styles.css").read_text()
    base = styles.split("\n.bb-daily-day {", 1)[1].split("}", 1)[0]
    today = styles.split('.bb-daily-day-date[data-today="true"] .bb-daily-day {', 1)[1].split("}", 1)[0]
    circle = styles.split('.bb-daily-day-date[data-today="true"] .bb-daily-day::before {', 1)[1].split("}", 1)[0]

    # The more specific current-date selector survives the later button reset.
    # Its soft circle is outside layout, preserving the approved row height.
    assert styles.count("\n.bb-daily-day {") == 1
    assert "color: inherit;" in base and "font: inherit;" in base
    assert "color: hsl(var(--primary));" in today
    assert "position: absolute;" in circle
    assert "background: hsl(var(--primary) / .16);" in circle
    assert "width: 34px; height: 34px;" in circle
