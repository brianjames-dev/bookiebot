from pathlib import Path
import subprocess

import pytest


@pytest.mark.parametrize("runner", ["widget_settings_ui_test.cjs", "widget_setup_guide_test.cjs"])
def test_widget_settings_lifecycle(runner):
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run widget settings checks")
    subprocess.run(
        ["node", f"unit_tests/reports/{runner}"],
        cwd=root, check=True, capture_output=True, text=True,
    )
