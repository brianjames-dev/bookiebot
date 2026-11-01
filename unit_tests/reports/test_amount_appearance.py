from pathlib import Path
import subprocess

import pytest


def test_amount_appearance_defaults_preferences_and_controls():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to execute amount appearance checks")
    subprocess.run(["node", str(Path(__file__).with_name("amount_appearance_test.cjs"))], cwd=root, check=True, capture_output=True, text=True)
