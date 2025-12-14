import pytest
from unittest.mock import MagicMock, patch, AsyncMock
from datetime import datetime

from bookiebot.sheets import utils as su


# ---------------------------------------------------------------------------
# Fixtures & helpers
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _freeze_today(monkeypatch):
    monkeypatch.setattr(su, "get_local_today", lambda: datetime(2025, 5, 15))
    yield


@pytest.fixture
def persons():
    return ["Hannah", "Brian (BofA)"]


def _food_row(date_str, amount, person):
    row = [""] * 26  # enough columns through Z
    row[su.column_index_from_string("N") - 1] = date_str
    row[su.column_index_from_string("P") - 1] = str(amount)
    row[su.column_index_from_string("R") - 1] = person
    return row


def _shopping_row(date_str, amount, person):
    row = [""] * 26
    row[su.column_index_from_string("V") - 1] = date_str
    row[su.column_index_from_string("X") - 1] = str(amount)
    row[su.column_index_from_string("Z") - 1] = person
    return row


def test_resolve_query_persons_prefers_username_over_colliding_id():
    # user_id maps to Brian but username belongs to Hannah; should prefer Hannah
    result = su.resolve_query_persons("hannerish#0000", None, "1395120954589315303")
    assert result == ["Hannah"]


@pytest.fixture
def mock_ws():
    ws = MagicMock()
    ws.get_all_values.return_value = [
        ["Date", "Amount", "Category"],  # header
        ["05/01/2025", "50", "grocery"],
        ["05/02/2025", "100", "shopping"],
        ["05/03/2025", "0", "grocery"],
        ["05/05/2025", "200", "food"],
        ["05/06/2025", "75", "gas"],
        ["05/11/2025", "25", "shopping"]
    ]
    return ws


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_calculate_burn_rate(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws

    # Simulate finding the "🔥 Burn rate:" cell
    cell_mock = MagicMock()
    cell_mock.row = 1
    cell_mock.col = 1
    cell_mock.value = "🔥 Burn rate: $2.63/day"
    mock_ws.find.return_value = cell_mock

    # Simulate fetching description 2 cells to the right
    mock_ws.cell.return_value.value = "⚠️ Over by $764 (+$58.79/day)"

    burn_rate, desc = await su.calculate_burn_rate()

    assert burn_rate == "$2.63/day"
    assert desc == "⚠️ Over by $764 (+$58.79/day)"


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_check_rent_paid(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws
    mock_ws.find.return_value.row = 1
    mock_ws.find.return_value.col = 1
    mock_ws.cell.return_value.value = '1200'
    paid, amount = await su.check_rent_paid()
    assert paid is True
    assert amount == 1200.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_check_smud_paid(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws
    mock_ws.find.return_value.row = 2
    mock_ws.find.return_value.col = 2
    mock_ws.cell.return_value.value = "$85"

    paid, amount = await su.check_smud_paid()

    assert paid is True
    assert amount == 85.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_check_student_loan_paid(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws
    mock_ws.find.return_value.row = 3
    mock_ws.find.return_value.col = 3
    mock_ws.cell.return_value.value = "250.00"

    paid, amount = await su.check_student_loan_paid()

    assert paid is True
    assert amount == 250.0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("store", "expected_total"),
    [
        ("Starbucks", 35),
        ("Subway", 15),
    ],
)
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_total_spent_at_store(mock_get_expense_worksheet, store, expected_total):
    mock_ws = MagicMock()
    mock_get_expense_worksheet.return_value = mock_ws

    # Mock data simulating rows starting at row 3 (skipping header)
    mock_ws.get_all_values.return_value = [
        ['header1', 'header2', 'header3'],
        ['header4', 'header5', 'header6'],
        # Food section — cols P/Q (indices 15/16)
        [''] * 15 + ['10', 'Starbucks'] + [''] * 8,   # Food, Starbucks, $10
        [''] * 15 + ['5', 'Starbucks'] + [''] * 8,    # Food, Starbucks, $5
        # Shopping section — cols X/Y (indices 23/24)
        [''] * 23 + ['20', 'Starbucks'] + [''] * 1,   # Shopping, Starbucks, $20
        [''] * 23 + ['15', 'Subway'] + [''] * 1       # Shopping, not Starbucks
    ]

    total = await su.total_spent_at_store(store)
    assert total == expected_total


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_total_spent_on_item(mock_get_expense_worksheet, persons):
    mock_ws = MagicMock()
    mock_get_expense_worksheet.return_value = mock_ws
    rows = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/05/2025", 5, "Hannah"),
        _food_row("05/06/2025", 7, "Brian (BofA)"),
    ]
    rows[2][su.column_index_from_string("O") - 1] = "Latte"
    rows[3][su.column_index_from_string("O") - 1] = "latte"
    mock_ws.get_all_values.return_value = rows

    total, matches = await su.total_spent_on_item("Latte", persons)
    assert total == 12.0
    assert len(matches) == 2


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.column_index_from_string")
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_highest_expense_category(mock_get_expense_worksheet, mock_col_idx):
    mock_ws = MagicMock()
    mock_get_expense_worksheet.return_value = mock_ws

    # ensure column indices match what your col_values mock returns
    mock_col_idx.side_effect = lambda col: {
        'B': 2,
        'I': 9,
        'P': 16,
        'X': 24
    }[col]

    # mock the col_values per column index
    mock_ws.col_values.side_effect = lambda col: {
        2: ['header', 'header', '10', '20'],      # grocery → 30
        9: ['header', 'header', '5'],            # gas → 5
        16: ['header', 'header', '15', '25'],   # food → 40
        24: ['header', 'header', '50']          # shopping → 50
    }[col]

    category, amount = await su.highest_expense_category()

    assert category == 'shopping'
    assert amount == 50.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_remaining_budget(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws
    mock_ws.find.return_value.row = 1
    mock_ws.find.return_value.col = 1
    mock_ws.cell.return_value.value = '1000'
    remaining = await su.remaining_budget()
    assert remaining == 1000.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_total_income_valid(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws

    # mock finding the Monthly Income cell
    cell_mock = MagicMock()
    cell_mock.row = 1
    cell_mock.col = 1
    mock_ws.find.return_value = cell_mock

    # mock the adjacent cell value
    mock_ws.cell.return_value.value = "  $5,000 "

    result = await su.total_income()
    assert result == 5000.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_total_income_invalid_value(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws

    cell_mock = MagicMock()
    cell_mock.row = 1
    cell_mock.col = 1
    mock_ws.find.return_value = cell_mock

    mock_ws.cell.return_value.value = "N/A"

    result = await su.total_income()
    assert result == 0.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_total_income_missing_cell(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws

    # Simulate .find() throwing an exception
    mock_ws.find.side_effect = Exception("Cell not found")

    result = await su.total_income()
    assert result == 0.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_expense_breakdown_percentages(mock_ws_func, mock_ws):
    mock_ws_func.return_value = mock_ws
    # prepare totals for Brian (BofA) and Hannah
    totals = {
        "AE28": "50",   # Brian total
        "AE31": "100",  # Hannah total
    }

    def _acell(cell_ref):
        return type("Cell", (), {"value": totals.get(cell_ref, "0")})

    def _cell(r, c):
        # map row/col to values for grocery/gas/food/shopping
        mapping = {
            # Brian (row 4)
            (4, su.column_index_from_string("F")): "25",   # grocery
            (4, su.column_index_from_string("L")): "10",   # gas
            (4, su.column_index_from_string("T")): "15",   # food
            (4, su.column_index_from_string("AB")): "0",   # shopping
            # Hannah (row 5)
            (5, su.column_index_from_string("F")): "50",
            (5, su.column_index_from_string("L")): "0",
            (5, su.column_index_from_string("T")): "25",
            (5, su.column_index_from_string("AB")): "25",
        }
        return type("Cell", (), {"value": mapping.get((r, c), "0")})

    mock_ws.acell.side_effect = _acell
    mock_ws.cell.side_effect = _cell

    result = await su.expense_breakdown_percentages(["Brian (BofA)", "Hannah"])
    cats = result["categories"]
    assert cats["grocery"]["amount"] == 75.0
    assert cats["food"]["percentage"] == pytest.approx(26.67, rel=1e-2)


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_total_for_category(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 4,
        ["hdr"] * 4,
        ["05/01/2025", "10", "", "Hannah"],
        ["05/02/2025", "5", "", "SomeoneElse"],
        ["05/03/2025", "15", "", "Brian (BofA)"],
    ]
    result = await su.total_for_category("grocery", persons)
    assert result == 25.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_average_daily_spend(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/05/2025", 20, "Hannah"),    # food
        _shopping_row("05/06/2025", 40, "Brian (BofA)"),  # shopping
    ]
    result = await su.average_daily_spend(persons)
    # total 60 over 15 days in month so far -> 4.0/day
    assert result == 4.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_largest_single_expense(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/12/2025", 30, "Hannah"),
        _shopping_row("05/14/2025", 50, "Brian (BofA)"),
    ]
    result = await su.largest_single_expense(persons)
    assert isinstance(result, dict)
    assert result["amount"] == 50.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_top_n_expenses_all_categories(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/12/2025", 30, "Hannah"),            # food amount
        _shopping_row("05/14/2025", 50, "Brian (BofA)"),  # shopping amount
    ]

    results = await su.top_n_expenses_all_categories(persons, n=2)
    assert len(results) == 2
    assert results[0]["amount"] == 50.0
    assert results[0]["category"] == "shopping"
    assert results[1]["amount"] == 30.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_top_n_expenses(mock_ws_func, mock_ws):
    mock_ws_func.return_value = mock_ws
    top_n = await su.top_n_expenses(3)
    assert isinstance(top_n, list)
    assert all(isinstance(item, tuple) for item in top_n)


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_spent_this_week(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/12/2025", 20, "Hannah"),
    ]
    result = await su.spent_this_week(persons)
    assert result == 20.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_projected_spending(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/01/2025", 30, "Hannah"),
    ]
    result = await su.projected_spending(persons)
    # May 2025: 31 days; spending so far $30 on day 15 -> ~62 projected
    assert result == pytest.approx((30 / 15) * 31, rel=1e-3)


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_daily_spending_calendar(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/05/2025", 12, "Hannah"),
    ]
    summary, chart_file = await su.daily_spending_calendar(persons)
    assert "05: $12.00" in summary
    assert getattr(chart_file, "filename", "") == "daily_spending_calendar.png"


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_best_worst_day_of_week(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/10/2025", 50, "Hannah"),  # Saturday
        _food_row("05/11/2025", 20, "Hannah"),  # Sunday
        _food_row("05/12/2025", 30, "Hannah"),  # Monday
        _food_row("05/13/2025", 40, "Hannah"),  # Tuesday
        _food_row("05/14/2025", 10, "Hannah"),  # Wednesday
        _food_row("05/15/2025", 35, "Hannah"),  # Thursday
        _food_row("05/16/2025", 45, "Hannah"),  # Friday
    ]
    result = await su.best_worst_day_of_week(persons)
    assert result["best"][0] == "Wednesday"
    assert result["worst"][0] == "Saturday"


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_longest_no_spend_streak(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/02/2025", 10, "Hannah"),
        _food_row("05/05/2025", 5, "Hannah"),
    ]
    streak = await su.longest_no_spend_streak(persons)
    assert streak == (10, 6, 15)


@pytest.mark.asyncio
async def test_days_budget_lasts(monkeypatch):
    monkeypatch.setattr(su, "remaining_budget", AsyncMock(return_value=300))
    monkeypatch.setattr(su, "average_daily_spend", AsyncMock(return_value=30))
    result = await su.days_budget_lasts()
    assert result == 10.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_most_frequent_purchases(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/05/2025", 5, "Hannah"),
        _food_row("05/06/2025", 7, "Brian (BofA)"),
        _food_row("05/07/2025", 3, "Hannah"),
    ]
    for idx, item in [(2, "coffee"), (3, "coffee"), (4, "sandwich")]:
        mock_ws.get_all_values.return_value[idx][su.column_index_from_string("O") - 1] = item

    result = await su.most_frequent_purchases(persons, n=2)
    assert result[0]["item"] == "coffee"
    assert result[0]["count"] == 2


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_expenses_on_day(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    rows = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/10/2025", 12, "Hannah"),
    ]
    rows[2][su.column_index_from_string("O") - 1] = "Pizza"
    rows[2][su.column_index_from_string("Q") - 1] = "Dominos"
    mock_ws.get_all_values.return_value = rows

    entries, total = await su.expenses_on_day("05/10/2025", persons)
    assert total == 12.0
    assert entries is not None and entries[0]["item"] == "Pizza"


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_subscriptions_worksheet")
async def test_list_subscriptions(mock_subs_ws):
    rows = [[""] * 6 for _ in range(6)]
    # Needs row (index 6 -> seventh row)
    rows.append(["", "Need A", "15", "", "Want A", "20"])
    rows.append(["", "Need B", "5", "", "", ""])
    mock_subs_ws.return_value.get_all_values.return_value = rows

    needs, needs_total, wants, wants_total = await su.list_subscriptions()
    assert needs == [("Need A", 15.0), ("Need B", 5.0)]
    assert wants == [("Want A", 20.0)]


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_weekend_vs_weekday(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/10/2025", 50, "Hannah"),  # Sat
        _food_row("05/12/2025", 30, "Hannah"),  # Mon
    ]
    weekend, weekday = await su.weekend_vs_weekday(persons)
    assert weekend == 50.0
    assert weekday == 30.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_no_spend_days(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/01/2025", 10, "Hannah"),
        _food_row("05/03/2025", 5, "Hannah"),
    ]
    count, days = await su.no_spend_days(persons)
    assert count == 13  # days 2..15 excluding 1 and 3 up to frozen day 15
    assert 2 in days and 4 in days
