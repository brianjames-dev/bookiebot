from pathlib import Path
import subprocess

import pytest


def test_expense_app_session_runtime():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install the expense-report frontend dependencies to run app session checks")
    subprocess.run(
        ["node", "unit_tests/reports/expense_app_session_test.cjs"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
