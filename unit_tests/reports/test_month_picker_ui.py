from pathlib import Path
import subprocess

import pytest


def test_month_picker_interactions():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install the expense-report frontend dependencies to run month picker checks")
    subprocess.run(
        ["node", "unit_tests/reports/month_picker_ui_test.cjs"],
        cwd=root, check=True, capture_output=True, text=True,
    )
