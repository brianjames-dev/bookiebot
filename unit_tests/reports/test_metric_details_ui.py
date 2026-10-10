from pathlib import Path
import subprocess

import pytest


def test_metric_details_totals_allocations_and_savings_progress():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run metric detail UI checks")
    subprocess.run(["node", "unit_tests/reports/metric_details_ui_test.cjs"],
                   cwd=root, check=True, capture_output=True, text=True)
