import importlib.util
from datetime import date
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location('configure_espp_withholding', Path(__file__).resolve().parents[2] / 'scripts/configure_espp_withholding.py')
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def rows():
    return [[], [], [], ['', 'Main Income Source', 'Income Projection Mode', 'Expected Income Amount', 'Paycheck Anchor Date'],
            ['', 'xAI', 'biweekly', 3400, '10/9/2026'], [],
            ['', 'First eligible paycheck', 'Last eligible paycheck', 'Payroll source', 'ESPP rate'],
            ['', '10/23/2026', '', 'xAI', '5%'], [], ['', 'Date:', 'Source:', 'Amount:'],
            ['', '10/9/2026', 'xAI income', 4500.00], ['', '10/23/2026', 'xAI income', 3400.00],
            ['', 'Monthly Income:', '', 7900.00], ['', 'SpaceX ESPP this month', '', 178.95], [],
            ['', 'BUDGET: $7900.00', 0, 0, 0], ['', 'Name', 'Needs', 'Wants', 'Cash savings'],
            ['', 'Enter Monthly Savings Contribution', 'IDEAL = $0', 'MINIMUM = $0', 123]]


def test_upgrade_uses_existing_paycheck_and_preserves_coordinates():
    original = rows()
    assert module.paycheck_row(original, date(2026, 10, 23), '3400.00', '300.00') == 12
    requests = module.prepared_requests(original, year=2026, title='October')
    assert not any('insertDimension' in request or 'addSheet' in request for request in requests)
    assert original == rows()


def test_wrong_missing_duplicate_or_occupied_paycheck_never_gets_overwritten():
    for changed in (rows()[:11] + rows()[12:], rows()[:12] + [rows()[11]] + rows()[12:]):
        with pytest.raises(ValueError, match='one existing'):
            module.paycheck_row(changed, date(2026, 10, 23), '3400.00', '300.00')
    occupied = rows()
    occupied[11].append(200)
    with pytest.raises(ValueError, match='different ESPP'):
        module.paycheck_row(occupied, date(2026, 10, 23), '3400.00', '300.00')
    with pytest.raises(ValueError, match='one existing'):
        module.paycheck_row(rows(), date(2026, 10, 23), '3400.01', '300.00')
