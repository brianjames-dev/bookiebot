from pathlib import Path
import subprocess

import pytest


def test_duo_geometry_preserves_closed_view_and_native_strip():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run Duo layout checks")
    subprocess.run(["node", "unit_tests/reports/duo_layout_test.cjs"], cwd=root,
                   check=True, capture_output=True, text=True)
