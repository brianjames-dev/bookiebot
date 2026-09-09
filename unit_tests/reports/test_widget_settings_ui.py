from pathlib import Path
import subprocess

import pytest


def test_widget_settings_lifecycle():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run widget settings checks")
    subprocess.run(
        ["node", "unit_tests/reports/widget_settings_ui_test.cjs"],
        cwd=root, check=True, capture_output=True, text=True,
    )
