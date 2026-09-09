from pathlib import Path
import subprocess

import pytest


def test_ask_panel_preserves_interaction_and_dialog_lifecycle():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/esbuild").exists():
        pytest.skip("Install frontend dependencies for Ask panel checks")
    subprocess.run(["node", "unit_tests/reports/ask_bookiebot_panel_test.cjs"],
                   cwd=root, check=True, capture_output=True, text=True)
