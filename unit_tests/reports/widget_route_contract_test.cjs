// Exercise the downloaded script against Python's actual routes and grant store.
// Only native presentation/storage and the HTTPS-to-local-test transport are stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
  const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const source = fs.readFileSync(input.scriptPath, 'utf8');
  const keychain = new Map();
  const cache = new Map();
  const requests = [];
  const alerts = [];
  let offline = false;
  class Request {
    constructor(url) { this.url = url; this._headers = {}; }
    // Scriptable's native dictionary property returns a copy, not a live JS object.
    get headers() { return { ...this._headers }; }
    set headers(value) { this._headers = { ...value }; }
    async loadJSON() {
      if (offline) throw new Error('Synthetic offline phone');
      assert(this.url.startsWith(input.origin + '/app/widgets/'));
      assert.equal(this.allowInsecureRequest, false);
      assert.equal(this.onRedirect({ url: 'https://untrusted.test/' }), null);
      const pathname = this.url.slice(input.origin.length);
      const response = await fetch(input.localOrigin + pathname, {
        method: this.method || 'GET', headers: this.headers, body: this.body,
        redirect: 'manual', signal: AbortSignal.timeout(10000),
      });
      this.response = { url: this.url, statusCode: response.status };
      requests.push({ pathname, status: response.status, headers: this.headers });
      return response.json();
    }
  }
  class Alert {
    constructor() { alerts.push(this); }
    addSecureTextField() {}
    addAction() {}
    addCancelAction() {}
    textFieldValue() { return input.setupCode; }
    async presentAlert() { return 0; }
  }
  const local = {
    cacheDirectory: () => '/local/cache', joinPath: (...parts) => parts.join('/'),
    createDirectory: () => {},
    listContents: key => [...cache.keys()].filter(path => path.startsWith(key + '/')).map(path => path.slice(key.length + 1)),
    fileExists: (key) => cache.has(key) || [...cache.keys()].some(path => path.startsWith(key + '/')),
    remove: (key) => { for (const path of cache.keys()) if (path === key || path.startsWith(key + '/')) cache.delete(path); },
    readString: key => { if (!cache.has(key)) throw Error('Missing cache'); return cache.get(key); },
    writeString: (key, value) => cache.set(key, value),
  };
  function scriptContext() {
    return vm.runInNewContext(source.replace(/await main\(\);\s*$/, '({ pair, profile, snapshot });'), {
      Color: class {}, Request, Alert,
      FileManager: { local: () => local },
      Script: { name: () => 'BookieBot' },
      Keychain: {
        contains: key => keychain.has(key),
        get: key => { if (!keychain.has(key)) throw Error('Missing key'); return keychain.get(key); },
        set: (key, value) => keychain.set(key, value),
        remove: key => keychain.delete(key),
      },
    });
  }

  const app = scriptContext();
  const paired = await app.pair();
  assert.equal(paired.ownerName, input.ownerName);
  assert.equal(paired.mode, input.mode);
  assert.equal(keychain.size, 1, 'interactive pairing must save its credential');
  const first = await app.snapshot(paired);
  assert.equal(first.state, 'loaded', 'the actual /data route must accept the native request authorization');
  assert.equal(first.data.budgetRemaining, input.budgetRemaining);
  assert.equal(first.data.availableToday, input.availableToday);
  assert.equal(keychain.size, 1, 'first refresh must not accidentally discard the valid grant');

  // A fresh JS execution represents the Home Screen extension reading saved state.
  const home = scriptContext();
  const recovered = home.profile();
  assert(recovered, 'a later Home Screen execution must recover its paired profile');
  assert.equal(recovered.connectionId, paired.connectionId);
  const next = await home.snapshot(recovered);
  assert.equal(next.state, 'loaded');
  assert.equal(next.data.ownerName, input.ownerName);
  assert.equal(next.data.mode, input.mode);
  assert.equal(next.data.updatedAt, first.data.updatedAt, 'server cache reuse must retain the source timestamp');
  const cachedSelections = [{ selection: { type: 'budget', goalId: null }, data: next.data }];
  const plain = value => JSON.parse(JSON.stringify(value));
  async function typedSnapshot(type, goalId = null) {
    const selection = { type, goalId };
    const result = await home.snapshot(recovered, selection);
    assert.equal(result.state, 'loaded', type + ' must accept the real Python response');
    assert.equal(result.data.schemaVersion, 2);
    assert.equal(result.data.type, type);
    assert.equal(result.data.ownerName, input.ownerName);
    assert.equal(result.data.mode, input.mode);
    assert.equal(result.data.connectionId, paired.connectionId);
    assert.equal(result.data.appUrl, input.origin + '/app/expenses');
    const repeated = await scriptContext().snapshot(paired, selection);
    assert.equal(repeated.state, 'loaded');
    assert.equal(repeated.data.updatedAt, result.data.updatedAt, 'typed cache reuse must retain the source time');
    assert.deepEqual(plain(repeated.data.content), plain(result.data.content));
    cachedSelections.push({ selection, data: result.data });
    return result.data.content;
  }

  const categories = await typedSnapshot('categories');
  assert.deepEqual(plain(categories), input.typed.categories, 'preserve original budgets and post-cascade remaining values');
  const upcoming = await typedSnapshot('upcoming');
  assert.equal(upcoming.totalCount, input.typed.upcoming.totalCount);
  assert.equal(upcoming.windowEnd, input.typed.upcoming.windowEnd);
  assert.equal(upcoming.payments.length, 2);
  for (const entry of upcoming.payments) {
    assert(input.typed.upcoming.labels.includes(entry.label), 'past payments and income must stay out of Upcoming');
    assert(['bill', 'subscription'].includes(entry.kind));
    assert.equal(entry.date, input.typed.upcoming.today);
  }
  const shared = await typedSnapshot('shared');
  assert.deepEqual(plain(shared), input.typed.shared, 'unconfirmed sender payments must not reduce either outstanding balance');
  const automaticSavings = await typedSnapshot('savings');
  assert.deepEqual(plain(automaticSavings.goal), input.typed.goals.find(goal => goal.id === automaticSavings.goal.id));
  for (const expected of input.typed.goals) {
    const savings = await typedSnapshot('savings', expected.id);
    assert.deepEqual(plain(savings.goal), expected);
    assert.equal(savings.emptyReason, null);
    assert.deepEqual(plain(savings.goals).map(goal => goal.id).sort(), input.typed.goals.map(goal => goal.id).sort());
    assert(!JSON.stringify(savings).includes('Private partner goal'));
    assert(!JSON.stringify(savings).includes('Archived goal'));
  }
  for (const unavailableId of input.typed.unavailableGoals) {
    const savings = await typedSnapshot('savings', unavailableId);
    assert.equal(savings.goal, null);
    assert.equal(savings.emptyReason, 'goal_unavailable');
    assert.equal(keychain.size, 1, 'an unavailable selection must not discard the shared pairing');
    assert(!JSON.stringify(savings).includes('Private partner goal'));
  }

  // Each type and chosen goal must retain its own snapshot when the phone is offline.
  offline = true;
  for (const { selection, data } of cachedSelections) {
    const saved = await scriptContext().snapshot(paired, selection);
    assert.equal(saved.state, 'stale');
    assert.deepEqual(plain(saved.data), plain(data), 'offline fallback must never borrow a different type or goal');
  }
  assert(requests.every(request => request.status === 200));
  assert.equal(requests[0].headers['Content-Type'], 'application/json');
  assert.equal(requests[0].headers.Authorization, undefined);
  assert(requests.slice(1).every(request => request.headers.Authorization === 'Bearer ' + paired.token));
  assert(![...cache.values()].some(value => value.includes(paired.token)), 'financial cache must never contain the read credential');
  console.log('Actual route/script pairing, five widget types, owner scope, native authorization and isolated offline caches passed.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
