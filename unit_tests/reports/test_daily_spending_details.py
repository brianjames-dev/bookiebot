from pathlib import Path
import subprocess

import pytest


def test_daily_spending_details_and_type_filter_runtime():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to execute presentation checks")
    subprocess.run(
        ["node", "unit_tests/reports/daily_spending_details_test.cjs"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
