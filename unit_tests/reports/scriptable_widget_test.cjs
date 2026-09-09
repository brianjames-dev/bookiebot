const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/bookiebot/reports/assets/bookiebot-widget.js'), 'utf8');
const origin = 'https://bookiebot.test';
const readToken = 'bbw_read_' + 'r'.repeat(43);
const pairingToken = 'bbw_pair_' + 'p'.repeat(43);
const now = Date.parse('2026-09-09T18:00:00Z');
const paired = { token: readToken, connectionId: 'connection-brian', ownerName: 'Brian', mode: 'projected', expiresAt: '2027-03-09T18:00:00Z' };
const payload = (extra = {}) => ({ schemaVersion: 1, connectionId: paired.connectionId, ownerName: 'Brian', mode: 'projected', month: '2026-09', asOfDate: '2026-09-09', timezone: 'America/Los_Angeles', budgetRemaining: 4321.09, availableToday: 25.75, todayState: 'under', updatedAt: '2026-09-09T17:55:00Z', staleAfterSeconds: 1800, refreshAfterSeconds: 900, avatarUrl: origin + '/app/avatar.png?day=2026-09-09', appUrl: origin + '/app/expenses', status: 'fresh', ...extra });
const keyFor = (scriptName = 'BookieBot', server = origin) => 'bookiebot.widget.v1.' + encodeURIComponent(server) + '.' + encodeURIComponent(scriptName);
const runUrl = (name = 'BookieBot') => 'scriptable:///run/' + encodeURIComponent(name);
function storage(profile = paired) {
  return { keychain: new Map(profile ? [[keyFor(), JSON.stringify({ ...profile, origin })]] : []), files: new Map() };
}
async function run(options = {}) {
  const state = options.state || storage();
  const requests = [], texts = [], dates = [], alerts = [], images = [], widgets = [];
  const choices = [...(options.choices || [])];
  let didWriteKeychain = false;
  const instant = options.now || now;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [instant])); } static now() { return instant; } }
  class Item { constructor(value) { this.value = value; } applyRelativeStyle() { this.relative = true; } }
  class Stack {
    constructor() { this.children = []; }
    addStack() { const stack = new Stack(); this.children.push(stack); return stack; }
    addText(value) { assert.equal(typeof value, 'string'); const item = new Item(value); texts.push(item); this.children.push(item); return item; }
    addDate(date) { const item = new Item(date); dates.push(item); this.children.push(item); return item; }
    addImage(image) { const item = new Item(image); images.push(item); this.children.push(item); return item; }
    addSpacer(length) { this.children.push({ spacer: true, length }); }
    centerAlignContent() { this.centered = true; }
    layoutVertically() { this.vertical = true; }
    setPadding(top, right, bottom, left) { this.padding = [top, right, bottom, left]; }
  }
  class Widget extends Stack { async presentSmall() { this.preview = 'small'; } async presentMedium() { this.preview = 'medium'; } }
  class Request {
    constructor(url) { this.url = url; requests.push(this); }
    // Native Scriptable properties bridge dictionaries through JavaScriptCore.
    // Reading headers returns a copy; only assigning the property updates the request.
    get headers() { return { ...(this._headers || {}) }; }
    set headers(value) { this._headers = { ...value }; }
    async loadJSON() {
      assert.equal(this.timeoutInterval, 10);
      assert.equal(this.allowInsecureRequest, false);
      assert.equal(this.onRedirect({ url: 'https://attacker.test' }), null);
      const isPair = this.url.endsWith('/pair');
      if (isPair) assert.equal(this.headers['Content-Type'], 'application/json', 'pairing must send its JSON content type through the native property setter');
      else assert.equal(this.headers.Authorization, 'Bearer ' + (options.pairReply?.token || readToken), 'data reads must send the paired bearer through the native property setter');
      const reply = isPair ? options.pairReply || paired : options.reply || payload();
      this.response = { statusCode: isPair ? options.pairStatus || 200 : options.status || 200, url: options.redirect || this.url };
      if (options.throw || (isPair && options.pairThrow)) throw new Error('Network error with sensitive internal URL');
      return reply;
    }
    async loadImage() {
      assert.equal(this.timeoutInterval, 3);
      assert.equal(this.onRedirect({ url: 'https://attacker.test' }), null);
      assert.equal(this.headers.Authorization, undefined, 'public avatar request must not carry a bearer');
      this.response = { statusCode: 200, url: this.url };
      if (options.avatarFailure) throw new Error('Offline image');
      return { kind: 'avatar' };
    }
  }
  class Alert {
    constructor() { this.actions = []; alerts.push(this); }
    addAction(label) { this.actions.push(label); }
    addDestructiveAction(label) { this.actions.push(label); }
    addCancelAction(label) { this.cancel = label; }
    addSecureTextField() { this.secure = true; }
    textFieldValue() { return options.setupLink || origin + '/app/widgets/connect#' + pairingToken; }
    async presentAlert() { return choices.length ? choices.shift() : 0; }
    async presentSheet() { return choices.length ? choices.shift() : 0; }
  }
  const local = {
    cacheDirectory: () => '/local/cache', joinPath: (...parts) => parts.join('/'),
    fileExists: (key) => state.files.has(key) || [...state.files.keys()].some((path) => path.startsWith(key + '/')),
    remove: (key) => { for (const path of state.files.keys()) if (path === key || path.startsWith(key + '/')) state.files.delete(path); },
    readString: (key) => { if (!state.files.has(key)) throw new Error('missing'); return state.files.get(key); },
    writeString: (key, value) => state.files.set(key, value),
    readImage: (key) => { if (!state.files.has(key)) throw new Error('missing'); return state.files.get(key); },
    writeImage: (key, value) => state.files.set(key, value), createDirectory: () => {},
  };
  const context = {
    Date: Clock, Intl, Number, JSON, encodeURIComponent,
    FileManager: { local: () => local },
    Keychain: {
      get: (key) => {
        if (options.keychainLocked || (didWriteKeychain && options.keychainReadbackFailure === 'throw') || !state.keychain.has(key)) throw new Error('Private Keychain error ' + readToken);
        if (didWriteKeychain && options.keychainReadbackFailure === 'mismatch') return '{malformed ' + readToken;
        return state.keychain.get(key);
      },
      contains: (key) => state.keychain.has(key),
      set: (key, value) => {
        if (options.keychainWriteFailure) throw new Error('Private Keychain write error ' + readToken);
        didWriteKeychain = true;
        state.keychain.set(key, value);
      },
      remove: (key) => state.keychain.delete(key),
    },
    Script: { name: () => options.scriptName || 'BookieBot', setWidget: (widget) => widgets.push(widget), complete: () => {} },
    URLScheme: { forRunningScript: () => runUrl(options.scriptName) },
    config: { runsInApp: Boolean(options.app), runsInWidget: !options.app, widgetFamily: options.family || 'small' },
    Color: class { constructor(value) { this.value = value; } }, Font: { semiboldSystemFont: (size) => size, systemFont: (size) => size }, Size: class { constructor(width, height) { this.width = width; this.height = height; } },
    SFSymbol: { named: () => ({ image: { kind: 'fallback' } }) },
    DateFormatter: class { string(date) { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date); } },
    Request, Alert, ListWidget: Widget,
  };
  await vm.runInNewContext('(async () => {' + source.replace('__BOOKIEBOT_ORIGIN__', options.origin || origin) + '})()', context);
  return { state, requests, textItems: texts, texts: texts.map((item) => item.value), dates, alerts, images, widgets };
}
async function contracts() {
  let check = await run({ state: storage(null) });
  assert.equal(check.requests.length, 0);
  assert.equal(check.alerts.length, 0, 'widget background must never prompt');
  assert(check.texts.includes('Pair this phone'));
  assert(check.texts.includes('Tap to pair in Scriptable'));
  assert.equal(check.widgets[0].url, runUrl(), 'an unpaired widget must open its own setup script, not the budget page');
  assert.equal(check.widgets[0].refreshAfterDate, undefined);

  check = await run({ app: true, state: storage(null) });
  assert.equal(check.alerts[0].secure, true);
  const pairRequest = check.requests.find((request) => request.url.endsWith('/pair'));
  assert.equal(pairRequest.headers['Content-Type'], 'application/json', 'pairing content type must survive the native dictionary copy');
  assert.equal(check.alerts[1].title, 'Paired with Brian');
  assert(check.alerts[1].message.includes('BookieBot'));
  assert(check.alerts[1].message.includes('Keep this script name'));
  assert.equal(pairRequest.method, 'POST');
  assert.deepEqual(JSON.parse(pairRequest.body), { pairingToken });
  assert.equal(pairRequest.headers.Authorization, undefined);
  assert(check.state.keychain.get(keyFor()).includes(readToken));
  assert(check.requests.every((request) => !request.url.includes('bbw_')));
  assert(check.texts.includes('Brian') && check.texts.includes('Projected'));
  assert(check.texts.includes('$4,321.09') && check.texts.includes('$25.75'));
  assert.equal(check.widgets[0].url, origin + '/app/expenses');
  assert.equal(check.widgets[0].refreshAfterDate.getTime(), now + 900000);
  assert.equal(check.dates[0].value.getTime(), Date.parse(payload().updatedAt));
  assert.equal(check.dates[0].relative, true, 'native WidgetDate must continue showing age while execution is delayed');
  assert(check.images.some((image) => image.value.kind === 'avatar'));
  assert([...check.state.files.values()].every((value) => !JSON.stringify(value).includes(readToken)), 'secret must never reach the snapshot cache');

  const newlyPaired = check.state;
  check = await run({ state: newlyPaired, family: 'medium' });
  assert.equal(check.alerts.length, 0, 'the Home Screen execution reuses the pairing without a prompt');
  assert.equal(check.requests.find((request) => request.url.endsWith('/data')).headers.Authorization, 'Bearer ' + readToken);
  assert(check.texts.includes('$4,321.09') && check.texts.includes('$25.75'));
  assert.equal(newlyPaired.keychain.size, 1, 'the first authorized Home Screen read preserves the paired credential');

  for (const failure of [{ keychainReadbackFailure: 'throw' }, { keychainReadbackFailure: 'mismatch' }, { keychainWriteFailure: true }]) {
    check = await run({ app: true, state: storage(null), ...failure });
    assert(check.alerts.at(-1).message.startsWith('Secure storage could not confirm this pairing.'));
    assert(!check.alerts.some((alert) => alert.title === 'Paired with Brian'), 'do not announce success before secure storage is verified');
    assert.equal(check.requests.length, 1, 'an unconfirmed credential cannot fetch financial data');
    assert.equal(check.widgets.length, 0, 'storage failures stop at their actionable message');
    assert.equal(check.state.files.size, 0, 'credentials cannot fall back to ordinary files');
    assert(!JSON.stringify(check.alerts).includes(readToken), 'never expose native Keychain errors or credential values');
    if (!failure.keychainWriteFailure) {
      check = await run({ state: check.state });
      assert(check.texts.includes('$4,321.09'), 'a temporary readback failure must preserve the safely stored credential for retry');
    }
  }

  check = await run({ app: true, state: storage(null), choices: [-1] });
  assert.equal(check.requests.length, 0);
  assert.equal(check.widgets.length, 0, 'canceling setup must not immediately show a misleading unpaired preview');
  assert.equal(check.state.keychain.size, 0);
  check = await run({ app: true, state: storage(null), status: 503 });
  assert.equal(check.alerts[1].title, 'Paired with Brian', 'a delayed financial refresh must not undo successful pairing');
  assert(check.state.keychain.get(keyFor()).includes(readToken));
  assert(check.texts.includes('Budget unavailable'));
  assert(check.texts.includes('Tap to retry in Scriptable'));
  assert.equal(check.widgets[0].url, runUrl());

  for (const link of [
    'https://attacker.test/app/widgets/connect#' + pairingToken,
    origin + '@attacker.test/app/widgets/connect#' + pairingToken,
    origin + '/app/widgets/connect?token=x#' + pairingToken,
    origin + '/app/widgets/connect#' + pairingToken + '&x=1',
    origin + '/app/widgets/connect#bbw_pair_short',
    origin + '/app/widgets/connect/#' + pairingToken,
  ]) {
    check = await run({ app: true, state: storage(null), setupLink: link });
    assert.equal(check.requests.length, 0, 'invalid setup URL must never make a request');
    assert.equal(check.state.keychain.size, 0);
    assert(check.alerts[1].message.startsWith('Use a new'));
    assert.equal(check.widgets.length, 0, 'failed setup should stop at its actionable error instead of an unpaired preview');
  }
  check = await run({ app: true, state: storage(null), pairStatus: 410 });
  assert.equal(check.state.keychain.size, 0);
  check = await run({ app: true, state: storage(null), redirect: 'https://attacker.test/' });
  assert.equal(check.state.keychain.size, 0);

  const cached = storage();
  await run({ state: cached });
  const original = [...cached.files.entries()].find(([name]) => name.endsWith('.json'));
  for (const failed of [{ throw: true }, { status: 429 }, { status: 503 }, { redirect: 'https://attacker.test/' }]) {
    check = await run({ state: cached, ...failed });
    assert(check.texts.some((line) => line.startsWith('Stale ·')));
    assert(check.texts.includes('$4,321.09'));
    assert.equal(cached.files.get(original[0]), original[1], 'failed refresh must not advance cached timestamps');
    assert.equal(check.dates[0].value.getTime(), Date.parse(payload().updatedAt));
  }
  check = await run({ state: storage(), throw: true });
  assert(check.texts.includes('Budget unavailable'));
  assert(!check.texts.some((value) => value.includes('$0')));
  for (const status of [401, 403]) {
    const revoked = storage(); await run({ state: revoked });
    check = await run({ state: revoked, status, throw: true });
    assert(check.texts.includes('Reconnect widget'));
    assert.equal(revoked.keychain.size, 0);
    assert.equal(revoked.files.size, 0);
    assert.equal(check.widgets[0].refreshAfterDate, undefined);
    assert.equal(check.widgets[0].url, runUrl());
    assert(check.texts.includes('Tap to pair again'));
    assert(!check.texts.some((value) => value.includes('$')));
  }
  const expired = storage({ ...paired, expiresAt: '2026-09-09T17:00:00Z' });
  check = await run({ state: expired });
  assert.equal(check.requests.length, 0);
  assert.equal(expired.keychain.size, 0);

  check = await run({ state: cached, scriptName: 'Other widget' });
  assert.equal(check.requests.length, 0, 'another script name cannot adopt this profile');
  assert.equal(check.widgets[0].url, runUrl('Other widget'), 'recovery must target the script selected on this widget');
  check = await run({ state: storage(null), scriptName: 'Brian & Hannah / Widget 🐷' });
  assert.equal(check.widgets[0].url, runUrl('Brian & Hannah / Widget 🐷'));
  assert(!check.widgets[0].url.includes('bbw_'), 'setup deep link must never embed a credential');
  check = await run({ state: cached, origin: 'https://another.test' });
  assert.equal(check.requests.length, 0, 'another origin cannot adopt this profile');
  for (const extra of [
    { ownerName: 'Hannah' }, { connectionId: 'someone-else' }, { budgetRemaining: '123' }, { availableToday: NaN },
    { updatedAt: '2027-09-09T17:55:00Z' }, { appUrl: 'https://attacker.test' },
    { avatarUrl: origin + '/app/avatar.png?day=2026-09-09&token=secret' },
    { schemaVersion: 2 }, { timezone: 'unknown' }, { refreshAfterSeconds: 0 }, { asOfDate: ['2026-09-09'] },
    { month: ['2026-09'] }, { asOfDate: '2026-09-31' },
  ]) {
    check = await run({ reply: payload(extra) });
    assert(check.texts.includes('Budget unavailable'), JSON.stringify(extra));
  }
  for (const extra of [
    { asOfDate: '2026-09-08' }, { month: '2026-08', asOfDate: '2026-08-31' }, { updatedAt: '2026-09-09T17:00:00Z' },
  ]) {
    check = await run({ reply: payload(extra) });
    assert(check.texts.some((value) => value.startsWith('Stale ·')), 'aged or prior-day report must be marked stale');
  }
  // Midnight rollover follows Pacific, not UTC or the phone's travel timezone.
  check = await run({ now: Date.parse('2026-09-10T01:00:00Z'), reply: payload({ updatedAt: '2026-09-10T00:55:00Z' }) });
  assert(check.texts.some((value) => value.startsWith('Updated ·')));
  check = await run({ family: 'medium', reply: payload({ mode: 'current', budgetRemaining: -145.01, availableToday: null, todayState: 'unavailable' }), avatarFailure: true });
  assert(check.texts.includes('Current') && check.texts.includes('−$145.01') && check.texts.includes('—'));
  assert(check.images.some((image) => image.value.kind === 'fallback'));
  assert(check.texts.includes('Available today'));
  assert.equal(check.widgets[0].url, origin + '/app/expenses');
  check = await run({ family: 'small', reply: payload({ budgetRemaining: -1e12, availableToday: 1e12 }) });
  assert(check.texts.includes('−$1,000,000,000,000.00'));
  assert(check.textItems.filter((item) => item.value.includes('$')).every((item) => item.minimumScaleFactor <= 0.4));
  check = await run({ state: storage({ ...paired, token: [readToken] }) });
  assert.equal(check.requests.length, 0, 'credential schema must reject coercible arrays');
  assert.equal(check.state.keychain.size, 0, 'malformed readable credentials are forgotten');
  const malformed = storage(); await run({ state: malformed });
  malformed.keychain.set(keyFor(), '{broken profile');
  malformed.files.set('/local/cache/unrelated.json', 'unrelated data');
  check = await run({ state: malformed });
  assert.deepEqual([...malformed.files.keys()], ['/local/cache/unrelated.json']);
  assert.equal(malformed.keychain.size, 0);
  const forgottenElsewhere = storage(); await run({ state: forgottenElsewhere });
  forgottenElsewhere.keychain.clear();
  check = await run({ state: forgottenElsewhere });
  assert.equal(forgottenElsewhere.files.size, 0, 'a widget execution removes its cache after another context forgets the shared credential');
  assert(!check.texts.some((value) => value.includes('$')));
  const locked = storage(); await run({ state: locked });
  const lockedFiles = [...locked.files.entries()];
  check = await run({ state: locked, keychainLocked: true });
  assert.equal(check.requests.length, 0);
  assert.equal(locked.keychain.size, 1, 'transient locked Keychain must not erase pairing');
  assert.deepEqual([...locked.files.entries()], lockedFiles);
  const poisoned = storage(); await run({ state: poisoned });
  const snapshotPath = [...poisoned.files.keys()].find((name) => name.endsWith('.json'));
  poisoned.files.set(snapshotPath, JSON.stringify(payload({ ownerName: 'Hannah' })));
  check = await run({ state: poisoned, throw: true });
  assert(check.texts.includes('Budget unavailable'), 'wrong-owner cached financial data must never appear');
  check = await run({ reply: payload({ extraSecret: 'must-not-be-cached' }) });
  assert(![...check.state.files.values()].some((value) => JSON.stringify(value).includes('must-not-be-cached')));

  const replace = storage(); await run({ state: replace });
  const beforeCanceledReplace = { profile: replace.keychain.get(keyFor()), files: [...replace.files.entries()] };
  for (const replacementAttempt of [{ choices: [1, -1] }, { choices: [1, 0], pairStatus: 410 }]) {
    check = await run({ app: true, state: replace, ...replacementAttempt });
    assert.equal(check.widgets.length, 0);
    assert.equal(replace.keychain.get(keyFor()), beforeCanceledReplace.profile);
    assert.deepEqual([...replace.files.entries()], beforeCanceledReplace.files, 'canceling or failing re-pair must retain the existing pairing/cache');
  }
  const hannah = { ...paired, connectionId: 'connection-hannah', ownerName: 'Hannah', token: 'bbw_read_' + 'h'.repeat(43) };
  check = await run({ app: true, state: replace, choices: [1, 0], pairReply: hannah, reply: payload({ connectionId: hannah.connectionId, ownerName: hannah.ownerName }) });
  assert(check.texts.includes('Hannah'));
  assert(![...replace.files.keys()].some((name) => name.includes('connection-brian')));
  assert(JSON.parse(replace.keychain.get(keyFor())).token === hannah.token);
  check = await run({ app: true, state: replace, choices: [2, 0] });
  assert.equal(replace.keychain.size, 0);
  assert.equal(replace.files.size, 0);
  assert.equal(check.requests.length, 0);
  check = await run({ app: true, origin: '__BOOKIEBOT_ORIGIN__', state: storage(null) });
  assert.equal(check.requests.length, 0);
  assert.equal(check.widgets[0].url, undefined);
  assert(check.alerts[0].title.includes('configured script'));
  console.log('Scriptable widget execution contracts passed: pairing, scoped cache, read-only requests, revocation, stale states, rendering and safe tap URL.');
}
if (require.main === module) contracts().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { run, payload, storage, paired };
