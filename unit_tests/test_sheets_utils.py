import pytest
from unittest.mock import MagicMock, patch
from datetime import datetime

import sheets_utils as su


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
@patch("sheets_utils.get_income_worksheet")
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
@patch("sheets_utils.get_income_worksheet")
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
@pytest.mark.parametrize(
    ("store", "expected_total"),
    [
        ("Starbucks", 35),
        ("Subway", 15),
    ],
)
@patch("sheets_utils.get_expense_worksheet")
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
@patch("sheets_utils.column_index_from_string")
@patch("sheets_utils.get_expense_worksheet")
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
@patch("sheets_utils.get_income_worksheet")
async def test_remaining_budget(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws
    mock_ws.find.return_value.row = 1
    mock_ws.find.return_value.col = 1
    mock_ws.cell.return_value.value = '1000'
    remaining = await su.remaining_budget()
    assert remaining == 1000.0


@pytest.mark.asyncio
@patch("sheets_utils.get_income_worksheet")
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
@patch("sheets_utils.get_income_worksheet")
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
@patch("sheets_utils.get_income_worksheet")
async def test_total_income_missing_cell(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws

    # Simulate .find() throwing an exception
    mock_ws.find.side_effect = Exception("Cell not found")

    result = await su.total_income()
    assert result == 0.0


@pytest.mark.asyncio
@patch("sheets_utils.get_expense_worksheet")
async def test_expense_breakdown_percentages(mock_ws_func, mock_ws):
    mock_ws_func.return_value = mock_ws
    result = await su.expense_breakdown_percentages()
    assert isinstance(result, dict)
    assert all(isinstance(v, float) for v in result.values())


@pytest.mark.asyncio
@patch("sheets_utils.get_expense_worksheet")
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
@patch("sheets_utils.get_expense_worksheet")
async def test_largest_single_expense(mock_ws_func, mock_ws):
    mock_ws_func.return_value = mock_ws
    amt, row = await su.largest_single_expense()
    assert isinstance(amt, float)
    assert isinstance(row, list) or row is None


@pytest.mark.asyncio
@patch("sheets_utils.get_expense_worksheet")
async def test_top_n_expenses(mock_ws_func, mock_ws):
    mock_ws_func.return_value = mock_ws
    top_n = await su.top_n_expenses(3)
    assert isinstance(top_n, list)
    assert all(isinstance(item, tuple) for item in top_n)


@pytest.mark.asyncio
@patch("sheets_utils.get_expense_worksheet")
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
@patch("sheets_utils.get_expense_worksheet")
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
@patch("sheets_utils.get_expense_worksheet")
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
@patch("sheets_utils.get_expense_worksheet")
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
