from pathlib import Path


FRONTEND = Path(__file__).resolve().parents[2] / "web/expense-report/src"


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
