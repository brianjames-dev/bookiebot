import os
from pathlib import Path
import subprocess

import pytest
from bookiebot.reports import phone_app
from bookiebot.reports.expense_breakdown import _theme_bootstrap_script


@pytest.mark.asyncio
async def test_first_paint_uses_the_native_spinner_before_javascript():
    html=(await phone_app._expense_app(None)).text
    assert html and 'id="bookiebot-startup-splash"' in html
    assert 'bb-pull-spinner bb-report-loading-spinner' in html
    assert '<div id="bookiebot-expense-report-root" inert aria-hidden="true">' in html
    assert '<h1>Opening' not in html
    assert '<h1>BookieBot</h1>' in html
    assert 'class="bb-startup-logo" src="/app/icon.png"' in html
    assert '<link rel="preload" as="image" href="/app/icon.png">' in html
    assert '<p>Your budget, together.</p>' in html
    assert html.index('bookiebot-startup-splash')<html.index('bookiebot-expense-report-root')
    if target:=os.getenv('BOOKIEBOT_SPLASH_HTML'):
        Path(target).write_text(html)
        Path(target+'.theme.js').write_text(_theme_bootstrap_script())


def test_splash_owns_one_smooth_readiness_handoff():
    subprocess.run(['node','unit_tests/reports/startup_splash_test.cjs'],cwd=Path(__file__).resolve().parents[2],check=True,capture_output=True,text=True)
