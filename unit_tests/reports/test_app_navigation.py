from pathlib import Path
import subprocess

import pytest


def test_app_navigation_preserves_panels_and_scroll_behavior():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run navigation checks")
    subprocess.run(["node", "unit_tests/reports/app_navigation_test.cjs"],
                   cwd=root, check=True, capture_output=True, text=True)


def test_navigation_lens_tracks_finger_without_rendering_and_cleans_up():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run navigation lens checks")
    subprocess.run(["node", "unit_tests/reports/navigation_lens_test.cjs"],
                   cwd=root, check=True, capture_output=True, text=True)


def test_duo_navigation_follows_visible_viewport_after_scrolled_folds():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run viewport checks")
    subprocess.run(["node", "unit_tests/reports/navigation_viewport_test.cjs"],
                   cwd=root, check=True, capture_output=True, text=True)
