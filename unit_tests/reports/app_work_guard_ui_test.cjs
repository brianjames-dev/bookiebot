const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { createRequire, Module } = require('node:module')
const frontend = path.join(__dirname, '../../web/expense-report')
const localRequire = createRequire(path.join(frontend, 'package.json'))
const React = localRequire('react'), Renderer = localRequire('react-test-renderer'), { act } = Renderer
const ts = localRequire('typescript')
global.IS_REACT_ACT_ENVIRONMENT = true
const timers = new Map(), intervals = new Map(), events = { window: new Map(), document: new Map() }
let nextTimer = 0, nextRequest = 0, reloads = 0, request = () => { throw Error('Unexpected request') }
const target = scope => ({
  addEventListener(name, cb) { const entries = events[scope].get(name) || new Set(); entries.add(cb); events[scope].set(name, entries) },
  removeEventListener(name, cb) { events[scope].get(name)?.delete(cb) },
  dispatchEvent(event) { events[scope].get(event.type)?.forEach(cb => cb(event)) },
})
class BrowserElement { focus() {} closest() { return this } }
const browserWindow = { ...target('window'), navigator: { onLine: true }, location: { reload() { reloads++ } },
  matchMedia: () => ({ matches: false }),
  setTimeout(cb, delay) { const id = ++nextTimer; timers.set(id, { cb, delay }); return id }, clearTimeout(id) { timers.delete(id) },
  setInterval(cb, delay) { const id = ++nextTimer; intervals.set(id, { cb, delay }); return id }, clearInterval(id) { intervals.delete(id) },
}
const browserDocument = { ...target('document'), visibilityState: 'visible', activeElement: new BrowserElement() }
const konsta = new Module(path.join(frontend, '__guard_konsta.cjs'), module)
konsta.filename = path.join(frontend, '__guard_konsta.cjs'); konsta.require = localRequire
konsta._compile(localRequire('esbuild').buildSync({ stdin: { contents: 'export * from "konsta/react"', resolveDir: frontend }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom'], logLevel: 'silent' }).outputFiles[0].text, konsta.filename)
const cache = new Map()
function load(file) {
  if (cache.has(file)) return cache.get(file)
  const exports = {}; cache.set(file, exports)
  const requireModule = name => {
    if (name.endsWith('.css')) return {}
    if (name === 'konsta/react') return konsta.exports
    if (!name.startsWith('.')) return localRequire(name)
    const base = path.resolve(path.dirname(file), name)
    return load([base + '.tsx', base + '.ts'].find(fs.existsSync))
  }
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  const inspect = file.endsWith('savings-goals.tsx') ? '\nexports.GoalEditor = GoalEditor; exports.ContributionEditor = ContributionEditor;'
    : file.endsWith('reimbursement-ledger.tsx') ? '\nexports.PaymentEditor = PaymentEditor; exports.OffsetEditor = OffsetEditor;' : ''
  vm.runInNewContext(code + inspect, { exports, require: requireModule, AbortController, Error, Event, CustomEvent: Event,
    window: browserWindow, document: browserDocument, HTMLElement: BrowserElement, Element: BrowserElement, Node: BrowserElement,
    fetch: (...args) => request(...args), crypto: { randomUUID: () => `request-${++nextRequest}` },
    setTimeout: browserWindow.setTimeout, clearTimeout: browserWindow.clearTimeout,
    requestAnimationFrame: cb => browserWindow.setTimeout(cb, 16), cancelAnimationFrame: browserWindow.clearTimeout,
  })
  return exports
}
const guardModule = load(path.join(frontend, 'src/app-work-guard.tsx'))
const { AppWorkGuardProvider, AppWorkRegistry, useAppWorkGuard, useAppWorkStatus } = guardModule
const { AppUpdatePrompt } = load(path.join(frontend, 'src/app-update-prompt.tsx'))
const { requestAppUpdate } = load(path.join(frontend, 'src/app-update.ts'))
const { SavingsGoals, GoalEditor, ContributionEditor } = load(path.join(frontend, 'src/savings-goals.tsx'))
const { ReimbursementLedger, PaymentEditor, OffsetEditor } = load(path.join(frontend, 'src/reimbursement-ledger.tsx'))
let guard, updateStatus
function Observe() { guard = useAppWorkGuard(); return null }
function Status({ status }) { updateStatus = useAppWorkStatus(status); return null }
const flush = async () => { for (let i = 0; i < 28; i++) await Promise.resolve() }
const run = async fn => act(async () => { fn(); await flush() })
const respond = (data, status = 200) => ({ status, ok: status < 400, json: async () => data })
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const rawText = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node.children.map(rawText).join('')
const visible = node => { for (let cur = node; cur; cur = cur.parent) if ([true, 'true'].includes(cur.props['aria-hidden']) || cur.props.inert === true || cur.props.inert === '') return false; return true }
const button = (tree, label) => tree.root.findAllByType('button').filter(visible).find(node => rawText(node) === label || node.props['aria-label'] === label)
const tap = (tree, label) => run(() => { const node = button(tree, label); assert.ok(node, `Missing button ${label}`); assert.ok(!node.props.disabled); node.props.onClick() })
const fill = (tree, label, value) => run(() => { const node = tree.root.findAllByType('label').filter(visible).find(node => rawText(node).startsWith(label)).findByType('input'); node.props.onChange({ target: { value } }) })
const submit = tree => run(() => tree.root.findAllByType('form').find(visible).props.onSubmit({ preventDefault() {} }))
const withGuard = child => React.createElement(AppWorkGuardProvider, null, React.createElement(Observe), child)
let dialog
async function mount(child) {
  let tree
  await run(() => { tree = Renderer.create(withGuard(child), { createNodeMock: element => element.type === 'dialog' ? (dialog = { dataset: {}, open: false, showModal() { this.open = true }, close() { this.open = false } }) : null }) })
  return tree
}
const dispose = tree => run(() => tree.unmount())
function beforeUnloadBlocked() { let blocked = false; browserWindow.dispatchEvent({ type: 'beforeunload', preventDefault() { blocked = true } }); return blocked }
const allocation = { id: 'a', payerOwner: 'brian', partnerOwner: 'hannah', payerPerson: 'Brian', item: 'Power', location: '', expenseDate: '2026-09-03', category: 'need', grossCents: 20000, payerShareCents: 10000, partnerShareCents: 10000, settledCents: 0, outstandingCents: 10000, method: 'equal', version: 1, projectedVersion: 1, accounting: 'cash_v1', status: 'outstanding' }
const other = { ...allocation, id: 'b', payerOwner: 'hannah', partnerOwner: 'brian' }
const goal = { id: 'trip', name: 'Trip', targetCents: 10000, startingCents: 0, balanceCents: 0, contributionCents: 0, contributionCount: 0, targetDate: '', archived: false, version: 1 }
async function main() {
  // The registry closes the event-to-render gap, and never overwrites new busy state from a reset callback.
  const registry = new AppWorkRegistry()
  registry.set('draft', { label: 'Draft', dirty: true, onDiscard() { registry.set('request', { label: 'Request', pending: true }) } })
  assert.equal(registry.discard(), false); assert.equal(registry.getSnapshot().pending, true)
  registry.remove('draft'); registry.remove('request'); assert.equal(registry.getSnapshot().dirty, false)

  let calls = 0, discarded = 0
  let tree = await mount(React.createElement(Status, { status: { label: 'Request' } }))
  await run(() => {
    updateStatus({ label: 'Request', pending: true })
    guard.requestAction({ kind: 'update', onProceed() { calls++ } })
  })
  assert.equal(calls, 0, 'An action in the same event as starting a request is blocked before React commits')
  await dispose(tree)
  tree = await mount(React.createElement(Status, { status: { label: 'Draft', dirty: true, onDiscard() { discarded++ } } }))
  assert.equal(beforeUnloadBlocked(), true)
  await run(() => guard.requestAction({ kind: 'update', onProceed() { calls++ } }))
  assert.equal(dialog.open, true); assert.equal(calls, 0)
  await tap(tree, 'Keep editing'); assert.equal(calls, 0); assert.equal(discarded, 0)
  await run(() => guard.requestAction({ kind: 'update', onProceed() { calls++ } }))
  // A financial request starting while the confirmation is visible removes the destructive option immediately.
  await run(() => updateStatus({ label: 'Draft', dirty: true, pending: true, onDiscard() { discarded++ } }))
  assert.equal(button(tree, 'Discard and update'), undefined)
  await run(() => guard.requestAction({ kind: 'signout', onProceed() { calls++ } }))
  assert.equal(calls, 0)
  await run(() => updateStatus({ label: 'Draft', dirty: true, uncertain: true, onDiscard() { discarded++ } }))
  assert.equal(button(tree, 'Discard and sign out'), undefined); assert.equal(beforeUnloadBlocked(), true)
  await run(() => updateStatus({ label: 'Draft', dirty: true, onDiscard() { discarded++ } }))
  await tap(tree, 'Discard and sign out'); assert.equal(calls, 1); assert.equal(discarded, 1)
  assert.equal(beforeUnloadBlocked(), false)
  await dispose(tree)
  tree = await mount(React.createElement(Status, { status: { label: 'Unsupported draft', dirty: true } }))
  await run(() => guard.requestAction({ kind: 'update', onProceed() { calls++ } }))
  assert.equal(button(tree, 'Discard and update'), undefined, 'A draft without a reset callback cannot be silently discarded')
  await dispose(tree)

  // Every financial editor participates, including untouched prefilled forms and date-only changes.
  const cases = [
    [GoalEditor, { goal }, 'Goal name', 'Beach trip'],
    [ContributionEditor, { goal }, 'Amount ($)', '20'],
    [PaymentEditor, { allocation, isPayer: true }, 'Note', 'Part payment'],
    [OffsetEditor, { allocations: [allocation, other], events: [], owner: 'brian' }, 'Note', 'Matching balances'],
  ]
  for (const [Component, props, label, value] of cases) {
    let closed = 0
    tree = await mount(React.createElement(Component, { ...props, disabled: false, run() { throw Error('No write authorized in draft test') }, close() { closed++ } }))
    assert.equal(guard.dirty, false, 'Prefilled values are not unsaved edits')
    await fill(tree, label, value); assert.equal(guard.dirty, true)
    await run(() => guard.requestAction({ kind: 'update', onProceed() { calls++ } }))
    await tap(tree, 'Keep editing'); assert.equal(closed, 0)
    await run(() => guard.requestAction({ kind: 'update', onProceed() { calls++ } }))
    await tap(tree, 'Discard and update'); assert.equal(closed, 1); assert.equal(guard.dirty, false)
    await dispose(tree)
  }

  // Real controller request lifecycle: uncertain outcomes stay protected until the same request is resolved.
  let pending = defer(), posts = []
  request = async (_url, options) => options.body ? (posts.push(JSON.parse(options.body)), pending.promise) : respond({ goals: [] })
  tree = await mount(React.createElement(SavingsGoals))
  await tap(tree, '＋ Goal'); await fill(tree, 'Goal name', 'Emergency fund'); await fill(tree, 'Target ($)', '500')
  await submit(tree); assert.equal(guard.pending, true)
  await run(() => pending.reject(Error('Lost response'))); assert.equal(guard.pending, false); assert.equal(guard.uncertain, true)
  const before = calls
  await run(() => guard.requestAction({ kind: 'signout', onProceed() { calls++ } })); assert.equal(calls, before)
  await tap(tree, 'Keep editing'); pending = defer(); await tap(tree, 'Retry this change')
  assert.equal(guard.pending, true); assert.deepEqual(posts[0], posts[1], 'Retry retains the exact command and request id')
  await run(() => pending.resolve(respond({}))); assert.equal(guard.pending, false); assert.equal(guard.uncertain, false)
  await dispose(tree)

  pending = defer(); posts = []
  const snapshot = { enabled: true, ownerKey: 'brian', currency: 'USD', allocations: [allocation], events: [] }
  request = async (_url, options) => options.body ? (posts.push(JSON.parse(options.body)), pending.promise) : respond(snapshot)
  tree = await mount(React.createElement(ReimbursementLedger, { fallback: null }))
  await tap(tree, 'View 1 expense')
  const row = tree.root.findAllByType('button').find(node => node.props.className === 'bb-reimbursement-toggle')
  await run(() => row.props.onClick()); await tap(tree, 'Record received')
  await fill(tree, 'Amount ($)', '20'); await submit(tree); assert.equal(guard.pending, true)
  await run(() => pending.reject(Error('Lost response'))); assert.equal(guard.uncertain, true)
  pending = defer(); await tap(tree, 'Retry this record'); assert.deepEqual(posts[0], posts[1])
  await run(() => pending.resolve(respond(snapshot))); assert.equal(guard.uncertain, false); assert.equal(guard.pending, false)
  await dispose(tree)

  // The actual Toast has no auto-dismiss timer. Dismissal leaves Settings able to request a guarded update.
  let available = null
  request = async () => respond({ version: 'guard-version-2' })
  tree = await mount(React.createElement(React.Fragment, null, React.createElement(Status, { status: { label: 'Draft', dirty: true, onDiscard() {} } }), React.createElement(AppUpdatePrompt, { initialVersion: 'guard-version-1', onAvailabilityChange(value) { available = value } })))
  assert.equal(available, 'guard-version-2')
  assert.ok(button(tree, 'Update')); assert.equal(reloads, 0)
  await tap(tree, 'Dismiss update notice for now'); assert.equal(button(tree, 'Update'), undefined); assert.equal(available, 'guard-version-2')
  await run(() => requestAppUpdate()); assert.equal(dialog.open, true); assert.equal(reloads, 0)
  await tap(tree, 'Keep editing'); assert.equal(reloads, 0)
  await run(() => requestAppUpdate()); await tap(tree, 'Discard and update'); assert.equal(reloads, 1)
  await dispose(tree)
  assert.equal(intervals.size, 0)
  assert.ok([...events.window.values(), ...events.document.values()].every(set => !set.size), 'All subscriptions clean up on owner unmount')
  console.log('App work guard, four financial editor drafts, financial retries, and persistent update Toast lifecycle checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
