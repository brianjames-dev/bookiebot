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


def test_compact_calendar_markers_keep_exact_event_information_accessible():
    source = (FRONTEND / "report-app.tsx").read_text()
    calendar = source.split("function FinancialCalendar", 1)[1].split("function calendarEventKey", 1)[0]

    assert "aria-label={calendarEventLabel(item)}" in calendar
    assert 'filteredEvents.map(calendarEventLabel).join("; ")' in calendar
    assert "<CalendarEventTooltip event={item} />" in calendar
    assert "<CalendarOverflowTooltip events={filteredEvents} day={day} />" in calendar


def test_daily_today_color_and_weight_override_the_button_reset():
    styles = (FRONTEND / "styles.css").read_text()
    base = styles.split(".bb-daily-day {", 1)[1].split("}", 1)[0]
    today = styles.split(".bb-daily-day-today {", 1)[1].split("}", 1)[0]

    # A later same-specificity reset previously replaced the contrasting date
    # color with inherited pale text, and also undid its bold weight.
    assert styles.count(".bb-daily-day {") == 1
    assert styles.index(".bb-daily-day {") < styles.index(".bb-daily-day-today {")
    assert "color: inherit;" in base and "font: inherit;" in base
    assert "background: hsl(var(--primary));" in today
    assert "color: hsl(var(--primary-foreground));" in today
    assert "font-weight: 750;" in today
