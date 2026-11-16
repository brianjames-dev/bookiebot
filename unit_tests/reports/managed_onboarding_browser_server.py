"""Disposable native test server. Google tokens are stubbed; SQL/HTTP/UI are real.

Only launched explicitly by managed_onboarding_browser_test.cjs; never imported
or registered by the production server. No real workbooks or provider calls.
"""
import asyncio
from datetime import date
import os
from pathlib import Path
import tempfile

from aiohttp import web
from bookiebot.reports import phone_app, phone_accounts, managed_budget
from bookiebot.reports.app_access import AppAccessStore


async def main():
    with tempfile.TemporaryDirectory(prefix='bookiebot-onboarding-') as folder:
        access = AppAccessStore(Path(folder) / 'access.sqlite3')
        access.initialize()
        phone_app.build_app_access_store = lambda: access
        managed_budget._today = lambda: date(2026, 11, 15)
        os.environ['GOOGLE_OAUTH_CLIENT_ID'] = 'fixture.apps.googleusercontent.com'
        os.environ['GOOGLE_OAUTH_CLIENT_SECRET'] = 'fixture-secret'
        async def exchange(code, *_):
            return code
        phone_accounts._exchange = exchange
        phone_accounts._verify = lambda token, *_: {'subject': token, 'email': token + '@example.test', 'name': token.title()}
        app = web.Application()
        phone_app.register_phone_app_routes(app)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        port = runner.addresses[0][1]
        os.environ['BOOKIEBOT_PUBLIC_BASE_URL'] = f'http://127.0.0.1:{port}'
        print(f'READY {port}', flush=True)
        try:
            await asyncio.Event().wait()
        finally:
            await runner.cleanup()


if __name__ == '__main__':
    asyncio.run(main())
