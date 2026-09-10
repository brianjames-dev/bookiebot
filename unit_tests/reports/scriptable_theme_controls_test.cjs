const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/bookiebot/reports/assets/bookiebot-widget.js'), 'utf8');
const origin = 'https://bookiebot.test';
const token = 'bbw_read_' + 'r'.repeat(43);
const paired = { origin, token, connectionId: 'brian-widget', ownerName: 'Brian', mode: 'projected', expiresAt: '2099-01-01T00:00:00Z' };
const keyFor = (kind, script = 'BookieBot', server = origin) => `bookiebot.widget.${kind}${encodeURIComponent(server)}.${encodeURIComponent(script)}`;
const profileKey = keyFor('v1.');
const themeKey = keyFor('theme.v1.');
const selectionKey = keyFor('selection.v1.');
const stored = () => new Map([[profileKey, JSON.stringify(paired)]]);

// Test the real menu, preference and request paths with a renderer boundary.
// The separate widget execution harness covers native rendering and cache states.
const renderingStart = source.indexOf('async function render(');
const mainStart = source.indexOf('\nasync function main()');
assert(renderingStart > 0 && mainStart > renderingStart);
const controlSource = source.slice(0, renderingStart) + `
async function render(current, result, theme, family, type) {
  const widget = { current, result, theme, family, type,
    async presentSmall() { this.preview = 'small'; },
    async presentMedium() { this.preview = 'medium'; } };
  return widget;
}
` + source.slice(mainStart);

async function run(options = {}) {
  const keychain = options.keychain || stored();
  const alerts = [], requests = [], widgets = [], writes = [], removes = [];
  const choices = [...(options.choices || [])];
  let completes = 0;
  class Alert {
    constructor() { this.actions = []; alerts.push(this); }
    addAction(label) { this.actions.push(label); }
    addDestructiveAction(label) { this.actions.push(label); }
    addCancelAction(label) { this.cancel = label; }
    addSecureTextField() { this.secure = true; }
    textFieldValue() { return origin + '/app/widgets/connect#bbw_pair_' + 'p'.repeat(43); }
    async presentSheet() { assert(choices.length, 'test must explicitly choose each menu'); return choices.shift(); }
    async presentAlert() { assert(choices.length, 'test must explicitly answer each alert'); return choices.shift(); }
  }
  class Request {
    constructor(url) { this.url = url; requests.push(this); }
    get headers() { return { ...this._headers }; }
    set headers(headers) { this._headers = { ...headers }; }
    async loadJSON() {
      this.response = { statusCode: 200, url: this.url };
      if (this.url.endsWith('/pair')) return paired;
      assert.equal(this.headers.Authorization, 'Bearer ' + token);
      // A failed snapshot is sufficient to verify the menu control path; it must
      // preserve credentials exactly as a real delayed refresh would.
      throw new Error('Data temporarily unavailable');
    }
  }
  const context = {
    args: { widgetParameter: options.parameter, queryParameters: options.query || {} },
    config: { runsInApp: Boolean(options.app), runsInWidget: !options.app, widgetFamily: options.family },
    Color: class {},
    FileManager: { local: () => ({
      cacheDirectory: () => '/cache', joinPath: (...parts) => parts.join('/'),
      fileExists: () => false, remove: () => {},
      readString: () => { throw new Error('No cached snapshot'); },
    }) },
    Keychain: {
      get(key) {
        if (options.lockTheme && key.includes('.theme.')) throw new Error('Private native details');
        if (!keychain.has(key)) throw new Error('Missing key');
        return keychain.get(key);
      },
      contains: (key) => keychain.has(key),
      set(key, value) {
        if (options.failThemeWrite && key.includes('.theme.')) throw new Error('Private native details ' + token);
        writes.push([key, value]); keychain.set(key, value);
      },
      remove(key) { removes.push(key); keychain.delete(key); },
    },
    Script: {
      name: () => options.name || 'BookieBot',
      setWidget: (widget) => widgets.push(widget), complete: () => completes++,
    },
    Alert, Request,
  };
  await vm.runInNewContext('(async () => {' + controlSource.replace('__BOOKIEBOT_ORIGIN__', options.origin || origin) + '})()', context);
  assert.equal(choices.length, 0, 'all intended menu choices should be consumed');
  assert.equal(completes, 1);
  return { keychain, alerts, requests, widgets, writes, removes };
}

async function contracts() {
  let check = await run();
  assert.equal(check.widgets[0].theme, 'editorial');
  assert.equal(check.widgets[0].family, 'medium', 'ordinary app previews default to medium');
  assert.equal(check.alerts.length, 0, 'widgets never open theme prompts');
  assert.equal(check.keychain.size, 1, 'a default does not write a preference or alter pairing');

  for (const [parameter, expected] of [['editorial', 'editorial'], [' A ', 'editorial'], ['two-tone', 'two-tone'], [' TWO-TONE ', 'two-tone'], ['Two Tone', 'two-tone'], ['c', 'two-tone']]) {
    check = await run({ parameter, family: 'small' });
    assert.equal(check.widgets[0].theme, expected);
    assert.equal(check.widgets[0].family, 'small');
    assert.equal(check.alerts.length, 0);
    assert.equal(check.writes.length, 0, 'instance overrides do not overwrite the shared preference');
    assert.equal(check.requests.length, 1, 'theme selection introduces no extra network calls');
    assert.equal(check.keychain.get(profileKey), JSON.stringify(paired));
  }

  for (const parameter of ['', 'unknown', 'https://attacker.test/two-tone', token, '{"theme":"two-tone"}', { theme: 'two-tone' }, ['two-tone'], 1, null]) {
    check = await run({ parameter, query: { theme: 'two-tone', token } });
    assert.equal(check.widgets[0].theme, 'editorial', 'only explicit enum strings select a theme');
    assert.equal(check.widgets[0].current.token, token);
    assert(check.requests.every((request) => request.url === origin + '/app/widgets/data'));
    assert.equal(check.writes.length, 0);
  }

  check = await run({ app: true, choices: [3, 0, 1, 0] });
  assert.deepEqual(check.alerts[0].actions, ['Refresh & preview', 'Pair again', 'Forget this phone', 'Widget & preview']);
  assert.equal(check.widgets[0].theme, 'two-tone');
  assert.equal(check.widgets[0].family, 'small');
  assert.equal(check.widgets[0].preview, 'small', 'small preview must use the small render layout too');
  assert.deepEqual(check.writes, [[selectionKey, JSON.stringify({connectionId:paired.connectionId,type:'budget',goalId:null,theme:'two-tone',family:'small'})], [themeKey, 'two-tone']]);
  assert.equal(check.widgets[0].type,'budget');
  const shared = check.keychain;
  assert.equal(shared.get(profileKey), JSON.stringify(paired), 'theme changes must leave the connection byte-for-byte intact');
  check = await run({ keychain: shared });
  assert.equal(check.widgets[0].theme, 'two-tone', 'a later run restores the selected default');
  check = await run({ keychain: shared, parameter: 'editorial' });
  assert.equal(check.widgets[0].theme, 'editorial');
  assert.equal(shared.get(themeKey), 'two-tone', 'one instance may differ without changing another');
  check = await run({ keychain: shared, app: true, parameter: 'two-tone', choices: [3, 0, 0, 1] });
  assert.equal(check.widgets[0].theme, 'editorial', 'an explicit theme preview wins over this run’s old widget parameter');
  assert.equal(check.widgets[0].family, 'medium');
  assert.equal(check.widgets[0].preview, 'medium');

  for (const choices of [[-1], [3, -1], [3, 0, -1], [3, 0, 1, -1]]) {
    check = await run({ app: true, choices });
    assert.equal(check.widgets.length, 0);
    assert.equal(check.writes.length, 0, 'canceling a chooser must not change the default');
    assert.equal(check.requests.length, 0, 'canceling does not refresh or re-pair');
    assert.equal(check.keychain.get(profileKey), JSON.stringify(paired));
  }

  for (const failure of [{ failThemeWrite: true }, { lockTheme: true }]) {
    check = await run({ app: true, choices: [3, 0, 1, 1, 0], ...failure });
    assert.equal(check.alerts.at(-1).title, 'Preview only');
    assert.equal(check.widgets[0].theme, 'two-tone', 'a nonsecret preference failure still allows a preview');
    assert.equal(check.keychain.get(profileKey), JSON.stringify(paired));
    assert.equal(check.removes.length, 0);
    assert(!JSON.stringify(check.alerts).includes(token), 'storage errors never expose credentials');
  }
  check = await run({ lockTheme: true });
  assert.equal(check.widgets[0].theme, 'editorial');

  const isolated = stored();
  isolated.set(themeKey, 'two-tone');
  isolated.set(keyFor('v1.', 'BookieBot Hannah'), JSON.stringify({ ...paired, ownerName: 'Hannah' }));
  check = await run({ keychain: isolated, name: 'BookieBot Hannah' });
  assert.equal(check.widgets[0].theme, 'editorial', 'another script has its own default');
  check = await run({ keychain: isolated, origin: 'https://another-bookiebot.test' });
  assert.equal(check.widgets[0].theme, 'editorial', 'another trusted origin has its own default');
  assert.equal(check.widgets[0].result.state, 'unpaired');
  isolated.set(themeKey, 'invalid');
  check = await run({ keychain: isolated });
  assert.equal(check.widgets[0].theme, 'editorial');
  assert.equal(isolated.get(profileKey), JSON.stringify(paired));

  check = await run({ app: true, choices: [0], family: 'small' });
  assert.equal(check.widgets[0].preview, 'small', 'refresh stays at menu index zero');
  check = await run({ app: true, choices: [1, -1] });
  assert.equal(check.alerts[1].title, 'Pair BookieBot', 'pairing stays at menu index one');
  assert.equal(check.widgets.length, 0);
  check = await run({ app: true, choices: [2, 0] });
  assert.equal(check.alerts[1].title, 'Forget widget access?', 'forget stays at menu index two');
  assert(!check.keychain.has(profileKey));
  assert.equal(check.widgets[0].result.state, 'unpaired');
  check=await run({app:true,choices:[3,4,0,1]});
  assert.equal(check.widgets[0].type,'shared');
  assert.equal(check.requests[0].url,origin+'/app/widgets/data/shared');
  const chosen=check.keychain;
  check=await run({keychain:chosen});
  assert.equal(check.widgets[0].type,'budget','blank Home Screen parameters keep their Budget meaning');
  check=await run({keychain:chosen,app:true,choices:[0]});
  assert.equal(check.widgets[0].type,'shared','in-app Refresh restores its separate last preview choice');
  check=await run({keychain:chosen,parameter:'categories;two-tone'});
  assert.equal(check.widgets[0].type,'categories');
  assert.equal(check.widgets[0].theme,'two-tone');
  console.log('Scriptable widget/type/theme selection contracts passed');
}
contracts().catch((error) => { console.error(error); process.exitCode = 1; });
