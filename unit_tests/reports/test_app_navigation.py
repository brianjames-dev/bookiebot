from pathlib import Path
import subprocess

import pytest


def test_app_navigation_preserves_panels_and_scroll_behavior():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run navigation checks")
    subprocess.run(["node", "unit_tests/reports/app_navigation_test.cjs"],
                   cwd=root, check=True, capture_output=True, text=True)
