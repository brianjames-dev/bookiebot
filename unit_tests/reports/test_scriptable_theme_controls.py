from pathlib import Path
import shutil
import subprocess

import pytest


def test_scriptable_theme_selection_contracts():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is required for the Scriptable API harness")
    root = Path(__file__).resolve().parents[2]
    subprocess.run(
        [node, "unit_tests/reports/scriptable_theme_controls_test.cjs"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
