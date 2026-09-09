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
  class Request {
    constructor(url) { this.url = url; this._headers = {}; }
    // Scriptable's native dictionary property returns a copy, not a live JS object.
    get headers() { return { ...this._headers }; }
    set headers(value) { this._headers = { ...value }; }
    async loadJSON() {
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
  assert.equal(requests.length, 3);
  assert(requests.every(request => request.status === 200));
  assert.equal(requests[0].headers['Content-Type'], 'application/json');
  assert.equal(requests[0].headers.Authorization, undefined);
  assert(requests.slice(1).every(request => request.headers.Authorization === 'Bearer ' + paired.token));
  assert(![...cache.values()].some(value => value.includes(paired.token)), 'financial cache must never contain the read credential');
  console.log('Actual route/script pairing, authorization, financial response, and subsequent profile recovery passed.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
