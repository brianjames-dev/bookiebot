import json
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reports import accounts, phone_accounts, phone_app
from bookiebot.reports.app_access import AppAccessStore

BRIAN = '676638528590970917'
HANNAH = '830984827904851969'
HEADERS = {'X-BookieBot-App':'1', 'Origin':'http://127.0.0.1'}


@pytest_asyncio.fixture
async def phone(tmp_path, monkeypatch):
    monkeypatch.setenv('BOOKIEBOT_PUBLIC_BASE_URL','http://127.0.0.1')
    monkeypatch.setenv('GOOGLE_OAUTH_CLIENT_ID','fixture.apps.googleusercontent.com')
    monkeypatch.setenv('GOOGLE_OAUTH_CLIENT_SECRET','fixture-secret')
    access = AppAccessStore(tmp_path / 'access.sqlite3')
    access.initialize()
    monkeypatch.setattr(phone_app, 'build_app_access_store', lambda:access)
    calls=[]
    async def exchange(code, verifier, redirect, client, secret):
        calls.append({'code':code,'verifier':verifier,'redirect':redirect,'client':client})
        assert secret == 'fixture-secret'
        return 'private-id-token'
    claims = {'subject':'google-sub-1','email':'person@example.test'}
    monkeypatch.setattr(phone_accounts,'_exchange',exchange)
    monkeypatch.setattr(phone_accounts,'_verify',lambda token,client,nonce:dict(claims))
    app=web.Application()
    phone_accounts.register_phone_account_routes(app)
    app.router.add_post('/app/connect',phone_app._connect_phone)
    app.router.add_post('/app/logout',phone_app._logout)
    async with TestClient(TestServer(app),cookie_jar=CookieJar(unsafe=True)) as client:
        yield SimpleNamespace(client=client, access=access, claims=claims, calls=calls)


async def connect(phone, actor=BRIAN, owner='brian'):
    token=phone.access.issue_pairing(actor,owner)
    response=await phone.client.post('/app/connect',json={'token':token},headers=HEADERS)
    assert response.status == 200
    return response.cookies['bb_phone_local'].value


async def start(phone, action='link'):
    response=await phone.client.post('/app/auth/google/start',json={'action':action},headers=HEADERS)
    assert response.status == 200
    url=(await response.json())['url']
    query=parse_qs(urlsplit(url).query)
    assert urlsplit(url).netloc == 'accounts.google.com'
    assert query['scope']==['openid email profile']
    assert query['redirect_uri']==['http://127.0.0.1/app/auth/google/callback']
    assert query['code_challenge_method']==['S256']
    assert 'secret' not in url and 'access_type' not in query
    cookie=response.cookies['bb_google_local']
    assert cookie['httponly'] and cookie['samesite']=='Lax'
    return query


async def callback(phone, query, **changes):
    return await phone.client.get('/app/auth/google/callback',params={'state':query['state'][0],'code':'private-code',**changes},allow_redirects=False)


@pytest.mark.asyncio
async def test_profile_is_private_and_keeps_legacy_access_while_google_unconfigured(phone, monkeypatch):
    assert (await phone.client.get('/app/account')).status==401
    monkeypatch.delenv('GOOGLE_OAUTH_CLIENT_SECRET')
    options=await phone.client.get('/app/auth/options')
    assert await options.json()=={'googleEnabled':False}
    token=await connect(phone)
    response=await phone.client.get('/app/account?owner=hannah')
    profile=await response.json()
    assert response.headers['Cache-Control']=='private, no-store'
    assert profile['name']=='Brian' and profile['google']['connected'] is False
    assert not profile['googleEnabled'] and BRIAN not in json.dumps(profile)
    assert phone.access.get_session(token).owner_key=='brian'
    assert (await phone.client.post('/app/auth/google/start',json={'action':'link'},headers=HEADERS)).status==503


@pytest.mark.asyncio
async def test_link_then_google_login_uses_own_adapter_and_rotates_session(phone):
    previous=await connect(phone)
    profile=await (await phone.client.get('/app/account')).json()
    query=await start(phone)
    result=await callback(phone,query)
    assert result.status==303 and result.headers['Location']=='/app/expenses?auth=linked'
    assert 'private-' not in str(result.headers) and 'private-' not in await result.text()
    token=result.cookies['bb_phone_local'].value
    assert phone.access.get_session(previous) is None
    assert phone.access.get_session(token).owner_key=='brian'
    assert (await (await phone.client.get('/app/account')).json())['id']==profile['id']
    assert phone.calls[0]['redirect']=='http://127.0.0.1/app/auth/google/callback'
    # A callback cannot be replayed and failure does not discard current access.
    assert (await callback(phone,query)).headers['Location'].endswith('auth=failed')
    assert len(phone.calls)==1 and phone.access.get_session(token) is not None
    await phone.client.post('/app/logout',headers=HEADERS)
    query=await start(phone,'login')
    result=await callback(phone,query)
    assert result.headers['Location'].endswith('auth=signed-in')
    assert phone.access.get_session(result.cookies['bb_phone_local'].value).actor_key==BRIAN


@pytest.mark.asyncio
async def test_unlinked_google_subject_with_same_email_cannot_select_workbook(phone):
    assert (await phone.client.post('/app/auth/google/start',json={'action':'link'},headers=HEADERS)).status==401
    query=await start(phone,'login')
    result=await callback(phone,query)
    assert result.headers['Location'].endswith('auth=signed-in')
    session=phone.access.get_session(result.cookies['bb_phone_local'].value)
    assert session.owner_key.startswith('managed:') and session.actor_key.startswith('app:')
    assert await phone_app._session(SimpleNamespace(cookies={'bb_phone_local':result.cookies['bb_phone_local'].value})) is None
    assert (await phone.client.get('/app/account')).status==200


@pytest.mark.asyncio
@pytest.mark.parametrize('change',['logout','switch','reset','expired','bad-nonce'])
async def test_link_callback_rechecks_session_and_identity(phone,monkeypatch,change):
    await connect(phone)
    query=await start(phone)
    if change=='logout': await phone.client.post('/app/logout',headers=HEADERS)
    if change=='switch': await connect(phone,HANNAH,'hannah')
    if change=='reset': phone.access.revoke_owner('brian')
    if change=='expired':
        now=accounts._now()
        monkeypatch.setattr(accounts,'_now',lambda:now+601)
    if change=='bad-nonce':
        def reject(*_): raise ValueError('private-id-token must not be echoed')
        monkeypatch.setattr(phone_accounts,'_verify',reject)
    result=await callback(phone,query)
    assert not result.headers['Location'].endswith('auth=linked')
    with phone.access.connect() as db:
        assert db.execute('SELECT COUNT(*) AS n FROM app_user_identities').fetchone()['n']==0


@pytest.mark.asyncio
async def test_callback_requires_browser_binding_and_cancel_consumes_flow(phone):
    await connect(phone)
    query=await start(phone)
    phone.client.session.cookie_jar.clear(lambda c:c.key=='bb_google_local')
    result=await callback(phone,query)
    assert result.headers['Location'].endswith('auth=failed') and not phone.calls
    query=await start(phone)
    assert (await callback(phone,query,error='access_denied')).headers['Location'].endswith('auth=failed')
    assert (await callback(phone,query)).headers['Location'].endswith('auth=failed')
    assert not phone.calls


@pytest.mark.asyncio
@pytest.mark.parametrize('headers',[{}, {'X-BookieBot-App':'1','Origin':'null'},
    {'X-BookieBot-App':'1','Origin':'https://evil.example'},
    {**HEADERS,'Sec-Fetch-Site':'cross-site'}])
async def test_signin_start_does_not_accept_cross_site_requests(phone,headers):
    assert (await phone.client.post('/app/auth/google/start',json={'action':'login'},headers=headers)).status==403


def test_google_library_validates_signature_audience_then_nonce_and_authorized_party(monkeypatch):
    from google.oauth2 import id_token
    expected={'sub':'verified-sub','email':'p@example.test','email_verified':True,'nonce':'nonce','azp':'client'}
    calls=[]
    def verify(token, transport, **kwargs):
        calls.append((token,kwargs))
        return dict(expected)
    monkeypatch.setattr(id_token,'verify_oauth2_token',verify)
    assert phone_accounts._verify('jwt','client','nonce')['subject']=='verified-sub'
    assert calls==[('jwt',{'audience':'client','clock_skew_in_seconds':30})]
    for key,value in [('nonce','wrong'),('azp','wrong'),('email_verified',False),('sub','')]:
        saved=expected[key];expected[key]=value
        with pytest.raises(ValueError): phone_accounts._verify('jwt','client','nonce')
        expected[key]=saved


def test_app_access_logs_exclude_callback_query_and_credentials():
    from bookiebot.core.web_server import PrivateAccessLogger
    from unittest.mock import Mock
    logger=Mock()
    PrivateAccessLogger(logger,'').log(SimpleNamespace(method='GET',path='/app/auth/google/callback',query_string='code=private-code&state=private-state'),SimpleNamespace(status=303),.1)
    output=str(logger.mock_calls)
    assert '/app/auth/google/callback' in output and 'private-' not in output


@pytest.mark.asyncio
async def test_google_token_exchange_handles_chunked_json_without_logging_or_storing_credentials(monkeypatch):
    class Response:
        status=200
        async def __aenter__(self):return self
        async def __aexit__(self,*_):pass
        @property
        def content(self):return self
        async def iter_chunked(self,_):
            for chunk in [b'{"id_',b'token":"fixture-jwt","access_token":"discard-me"}']:
                yield chunk
    class Client:
        def __init__(self,**kwargs):assert kwargs['timeout'].total==12
        async def __aenter__(self):return self
        async def __aexit__(self,*_):pass
        def post(self,url,**kwargs):
            assert url=='https://oauth2.googleapis.com/token' and kwargs['allow_redirects'] is False
            assert kwargs['data']['code_verifier']=='verifier'
            return Response()
    monkeypatch.setattr(phone_accounts,'ClientSession',Client)
    assert await phone_accounts._exchange('code','verifier','https://app.example/callback','client','secret')=='fixture-jwt'
