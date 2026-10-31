from pathlib import Path
import subprocess

import pytest


def test_burn_rate_balances_tooltip_placement_and_presentation():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to execute presentation checks")
    subprocess.run(
        ["node", "unit_tests/reports/burn_rate_presentation_test.cjs"],
        cwd=root, check=True, capture_output=True, text=True,
    )
