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


def test_chart_tooltip_retains_content_for_its_full_fade_and_handles_reopening():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to execute tooltip lifecycle checks")
    subprocess.run(
        ["node", "unit_tests/reports/chart_tooltip_lifecycle_test.cjs"],
        cwd=root, check=True, capture_output=True, text=True,
    )
