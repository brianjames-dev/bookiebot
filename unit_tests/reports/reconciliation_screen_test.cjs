const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { createRequire } = require('node:module'), req = createRequire(path.resolve('web/expense-report/package.json'))
const React = req('react'), Renderer = req('react-test-renderer'), ts = req('typescript'), { act } = Renderer
global.IS_REACT_ACT_ENVIRONMENT = true
const requests = [], timers = new Map(), listeners = new Map()
let serial = 0, work, controller, tree, owner = 'Brian'
const win = {
  setTimeout(fn, ms) { timers.set(++serial, { fn, ms }); return serial }, clearTimeout(id) { timers.delete(id) },
  addEventListener(type, fn) { const set = listeners.get(type) || new Set(); set.add(fn); listeners.set(type, set) },
  removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
}
const cache = new Map()
function load(file) {
  if (cache.has(file)) return cache.get(file)
  const exports = {}; cache.set(file, exports)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { exports, AbortController, Error, Intl, Date, Set,
    window: win, document: { visibilityState: 'visible' },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    require: name => name.endsWith('.css') ? {} : name === './app-work-guard' ? {
      useAppWorkStatus(value) { work = value; return React.useCallback(value => { work = value }, []) },
    } : name.startsWith('.') ? load(path.resolve(path.dirname(file), name) + '.tsx') : req(name),
  })
  return exports
}
const { useReconciliation, ReconciliationScreen } = load(path.resolve('web/expense-report/src/reconciliation-screen.tsx'))
function App() { controller = useReconciliation(); return controller.snapshot?.enabled ? React.createElement(ReconciliationScreen, { controller }) : React.createElement('p', null, 'Bank review unavailable') }
const fixture = () => React.createElement(App, { key: owner })
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve() }
const run = async fn => act(async () => { fn(); await flush() })
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node?.children ? node.children.map(text).join('') : ''
const visible = node => { for (let current = node; current; current = current.parent) if (current.props.hidden || current.props['aria-hidden'] === true || current.props.inert) return false; return true }
const rendered = () => text(tree.toJSON())
const buttons = () => tree.root.findAllByType('button').filter(visible)
const button = label => buttons().find(node => text(node) === label || node.props['aria-label'] === label)
const click = async label => run(() => { const node = button(label); assert.ok(node, `Missing ${label}`); assert.ok(!node.props.disabled, `Disabled ${label}`); node.props.onClick() })
const filter = async label => run(() => buttons().find(node => node.props['aria-pressed'] !== undefined && text(node).startsWith(label)).props.onClick())
const expand = async merchant => run(() => tree.root.findAllByType('button').filter(visible).find(node => node.props.className === 'bb-reconcile-row-toggle' && text(node).startsWith(merchant)).props.onClick())
const latest = () => requests.at(-1)
const respond = async (data, status = 200, target = latest()) => run(() => target.resolve({ ok: status < 400, status, json: async () => data }))
const reject = async (target = latest()) => run(() => target.reject(Error('Offline')))
const body = () => JSON.parse(latest().options.body)
const item = (id, merchant, extra = {}) => ({ id, merchant, version: 'list-version', status: 'needs_review', date: '2026-09-09', amountCents: 1599, currency: 'USD', accountLabel: 'Checking · 1234', suggestions: [], matchLabel: null, matchedSuggestionId: null, readOnly: false, needsCheck: false, ...extra })
const suggestion = extra => ({ id: 'expense-a', item: 'Coffee', date: '2026-09-09', amountCents: 1599, category: 'Food', amountMismatch: false, kind: 'recorded', recorded: true, confirmable: true, ...extra })
const detail = (row, suggestions = [suggestion()]) => ({ item: { ...row, version: 'detail-version-' + row.id, suggestions } })
const rows = [item(1, 'Coffee'), item(2, 'Restaurant'), item(-3, 'Pending charge', { status: 'pending' }), item(4, 'Upcoming bill'), item(5, 'Recover import', { readOnly: true, matchLabel: 'Import needs recovery in BookieBot' }), item(6, 'Paycheck', { amountCents: -1599 }), item(-7, 'New posted', { needsCheck: true })]
const snapshot = (items = rows, enabled = true) => ({ enabled, checkedAt: '2026-09-09T15:00:00Z', items })
;(async () => {
  await run(() => { tree = Renderer.create(fixture()) })
  assert.equal(requests.length, 1); assert.equal(latest().url, '/app/reconciliation'); assert.equal(latest().options.method, 'GET')
  for (const [key, value] of Object.entries({ credentials: 'same-origin', mode: 'same-origin', referrerPolicy: 'same-origin', cache: 'no-store', redirect: 'error' })) assert.equal(latest().options[key], value)
  assert.equal(latest().options.headers['X-BookieBot-App'], '1')
  await respond(snapshot([], false)); assert.match(rendered(), /unavailable/)
  await run(() => listeners.get('focus').forEach(fn => fn())); await respond(snapshot())
  assert.match(rendered(), /Coffee/); assert.equal(work.pending, false)
  const beforeDetail = requests.length
  await expand('Coffee'); assert.equal(requests.length, beforeDetail + 1); assert.equal(latest().url, '/app/reconciliation/1')
  await respond(detail(rows[0])); assert.ok(button('Confirm match'))
  assert.equal(requests.length, beforeDetail + 1, 'Showing a candidate never automatically confirms it')
  await click('Confirm match')
  assert.deepEqual(body(), { operation: 'confirm', id: 1, version: 'detail-version-1', suggestionId: 'expense-a' })
  assert.equal(work.pending, true); assert.equal(latest().options.method, 'POST')
  const lost = latest(); await reject(lost)
  assert.equal(work.uncertain, true); assert.ok(button('Check').props.disabled)
  assert.ok(button('Confirm match').props.disabled, 'Uncertain response cannot be blindly retried')
  await click('Check status'); assert.equal(latest().options.method, 'GET')
  const matchedRows = rows.map(row => row.id === 1 ? { ...row, status: 'checked', matchLabel: 'Matches logged expense' } : row)
  await respond(snapshot(matchedRows)); assert.equal(work.uncertain, false)
  await filter('Checked'); await expand('Coffee'); await respond(detail(matchedRows[0], []))
  await click('Reopen review'); assert.deepEqual(body(), { operation: 'reopen', id: 1, version: 'detail-version-1' })
  await respond(snapshot()); await filter('Needs review')
  await expand('Restaurant'); await respond(detail(rows[1], [suggestion({ amountCents: 1800, amountMismatch: true })]))
  assert.match(rendered(), /\$18\.00/); assert.match(rendered(), /\$15\.99/); assert.match(rendered(), /Update the logged amount in BookieBot/)
  assert.equal(button('Confirm match'), undefined)
  await filter('Pending'); await expand('Pending charge'); await respond(detail(rows[2]))
  assert.match(rendered(), /Tentative match/); assert.equal(button('Confirm match'), undefined); assert.equal(button('Ignore transaction'), undefined); assert.equal(button('Check for matches'), undefined)
  await expand('Pending charge'); await expand('Pending charge'); await respond(detail(rows[2], [suggestion({ amountCents: 1700, amountMismatch: true })]))
  assert.match(rendered(), /Wait for the payment to post/); assert.doesNotMatch(rendered(), /Update the logged amount in BookieBot/)
  await filter('Needs review'); await expand('Upcoming bill'); await respond(detail(rows[3], [suggestion({ kind: 'schedule', recorded: false, confirmable: false })]))
  assert.match(rendered(), /Not logged yet/); assert.equal(button('Confirm match'), undefined)
  await expand('Upcoming bill'); await expand('Upcoming bill'); await respond(detail(rows[3], [suggestion({ kind: 'schedule', recorded: true, confirmable: true })]))
  assert.match(rendered(), /Scheduled payment/); assert.ok(button('Confirm match'))
  await expand('Recover import'); await respond(detail(rows[4], []))
  assert.match(rendered(), /Finish this transaction in BookieBot/); assert.equal(button('Ignore transaction'), undefined); assert.equal(button('Reopen review'), undefined)
  await expand('Paycheck'); await respond(detail(rows[5]))
  assert.match(rendered(), /\+\$15\.99/); assert.ok(button('Confirm match'), 'Exact income compares absolute bank cents, while displaying money-in direction')
  await expand('New posted'); await respond(detail(rows[6], [])); assert.equal(button('Ignore transaction'), undefined)
  assert.match(rendered(), /Log it in BookieBot, then check again/); await click('Check for matches')
  assert.deepEqual(body(), { operation: 'check' }); assert.ok([...timers.values()].some(timer => timer.ms === 60000))
  await respond(snapshot()); await expand('Coffee'); await respond(detail(rows[0]))
  await click('Ignore transaction'); assert.deepEqual(body(), { operation: 'ignore', id: 1, version: 'detail-version-1' })
  await respond({ error: 'This transaction changed. Check again.' }, 409)
  assert.equal(work.uncertain, true); await click('Check status'); await respond(snapshot())
  const conflictedDetail = latest()
  await respond({ error: 'This transaction changed. Check again.' }, 409, conflictedDetail)
  assert.equal(latest().url, '/app/reconciliation'); assert.equal(latest().options.method, 'GET', 'A stale detail reloads the owner list instead of retrying an obsolete ID forever')
  const afterConflict = requests.length
  await respond(snapshot())
  assert.equal(requests.length, afterConflict, 'Recovery waits for an explicit row expansion, preventing a list/detail retry loop')
  await expand('Coffee')
  // A previous detail request cannot replace a newly expanded row.
  const oldDetail = latest(); await expand('Restaurant'); const newDetail = latest()
  assert.equal(oldDetail.options.signal.aborted, true)
  await respond(detail(rows[0]), 200, oldDetail); await reject(newDetail)
  assert.ok(button('Try suggestions again')); assert.equal(button('Confirm match'), undefined)
  await click('Try suggestions again'); await respond(detail(rows[1], []))
  await expand('Coffee'); const timed = latest()
  await run(() => [...timers.values()].find(timer => timer.ms === 20000).fn())
  assert.equal(timed.options.signal.aborted, true); assert.ok(button('Try suggestions again'))
  await respond(detail(rows[0]), 200, timed); assert.equal(button('Confirm match'), undefined, 'Late data after deadline stays ignored')
  // Detail authorization failure clears the whole private review, not just its message.
  await click('Try suggestions again'); await respond({ error: 'Expired' }, 401)
  assert.equal(controller.snapshot, null); assert.doesNotMatch(rendered(), /Coffee|Checking · 1234/)
  // Malformed payload does not replace a good snapshot; owner change disposes all reads/state.
  await run(() => controller.load()); await respond(snapshot())
  await run(() => controller.load()); await respond({ ...snapshot(), items: [{ ...rows[0], amountCents: 1.25 }] })
  assert.match(rendered(), /Coffee/); assert.match(rendered(), /Couldn’t read/)
  await expand('Coffee'); const brianDetail = latest()
  owner = 'Hannah'; await run(() => tree.update(fixture()))
  assert.equal(brianDetail.options.signal.aborted, true); assert.doesNotMatch(rendered(), /Coffee/)
  await respond(snapshot([], false)); await respond(detail(rows[0]), 200, brianDetail)
  assert.doesNotMatch(rendered(), /Coffee/)
  await run(() => tree.unmount()); assert.equal(timers.size, 0)
  assert.ok([...listeners.values()].every(set => !set.size))
  assert.ok(requests.filter(row => row.options.body).every(row => ['check', 'confirm', 'ignore', 'reopen'].includes(JSON.parse(row.options.body).operation)), 'No import or amount-adjustment request exists')
  console.log('Reconciliation optional access, lazy detail, exact confirmation, pending/mismatch safety, CAS recovery, deadlines and owner isolation passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
