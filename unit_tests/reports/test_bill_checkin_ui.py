from pathlib import Path
import subprocess

import pytest


def test_daily_bill_checkin_respects_native_work_and_visibility():
    root = Path(__file__).resolve().parents[2]
    if not (root / 'web/expense-report/node_modules/typescript').exists():
        pytest.skip('Install frontend dependencies')
    subprocess.run(['node', 'unit_tests/reports/bill_checkin_ui_test.cjs'], cwd=root,
                   check=True, capture_output=True, text=True)
