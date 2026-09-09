const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { createRequire, Module } = require('node:module')
const frontend = path.join(__dirname, '../../web/expense-report'), req = createRequire(path.join(frontend, 'package.json'))
const React = req('react'), Renderer = req('react-test-renderer'), ts = req('typescript'), { act } = Renderer
const h = React.createElement
global.IS_REACT_ACT_ENVIRONMENT = true
const timers = new Map(), intervals = new Map(), listeners = { window: new Map(), document: new Map(), viewport: new Map() }, storage = new Map()
let timerId = 0, commandId = 0, reloads = 0, signouts = 0, reportMounts = 0, request
const events = name => ({
  addEventListener(type, cb) { const callbacks = listeners[name].get(type) || new Set(); callbacks.add(cb); listeners[name].set(type, callbacks) },
  removeEventListener(type, cb) { listeners[name].get(type)?.delete(cb) },
  dispatchEvent(event) { listeners[name].get(event.type)?.forEach(cb => cb(event)) },
})
class Element { focus() {} closest() { return this } matches() { return false } }
let sharedFocuses = 0, sharedScrolls = 0
const sharedTarget = { focus() { sharedFocuses++ }, scrollIntoView() { sharedScrolls++ } }
const win = { ...events('window'), scrollY: 0, innerHeight: 800, navigator: { onLine: true },
  scrollTo({ top }) { this.scrollY = top }, location: { reload() { reloads++ } },
  visualViewport: { ...events('viewport'), height: 800 }, matchMedia: () => ({ matches: false }),
  localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  setTimeout(cb, delay) { const id = ++timerId; timers.set(id, { cb, delay }); return id }, clearTimeout(id) { timers.delete(id) },
  setInterval(cb, delay) { const id = ++timerId; intervals.set(id, { cb, delay }); return id }, clearInterval(id) { intervals.delete(id) },
}
const doc = { ...events('document'), visibilityState: 'visible', activeElement: new Element(),
  documentElement: { dataset: {}, style: {}, scrollHeight: 6000 },
  querySelector: selector => selector === '.bb-shell-shared .bb-reimbursement-section' ? sharedTarget : null,
}
const konsta = new Module(path.join(frontend, '__shell_konsta.cjs'), module)
konsta.filename = path.join(frontend, '__shell_konsta.cjs'); konsta.require = req
konsta._compile(req('esbuild').buildSync({ stdin: { contents: 'export * from "konsta/react"', resolveDir: frontend }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom'], logLevel: 'silent' }).outputFiles[0].text, konsta.filename)
const cache = new Map(), mocks = new Map()
function load(file) {
  if (mocks.has(file)) return mocks.get(file)
  if (cache.has(file)) return cache.get(file)
  const exports = {}; cache.set(file, exports)
  const requireModule = name => {
    if (name.endsWith('.css')) return {}
    if (name === 'konsta/react') return konsta.exports
    if (!name.startsWith('.')) return req(name)
    const base = path.resolve(path.dirname(file), name)
    return load([base + '.tsx', base + '.ts'].find(fs.existsSync))
  }
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  vm.runInNewContext(code, { exports, require: requireModule, AbortController, Error, Event, CustomEvent: Event,
    window: win, document: doc, HTMLElement: Element, Element, Node: Element,
    fetch: (...args) => request(...args), crypto: { randomUUID: () => `shell-command-${++commandId}` },
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
    requestAnimationFrame: cb => win.setTimeout(cb, 16), cancelAnimationFrame: win.clearTimeout,
  })
  return exports
}
const src = file => path.join(frontend, 'src', file)
const { AppWorkGuardProvider, useAppWorkGuard } = load(src('app-work-guard.tsx'))
const navigation = load(src('app-navigation.tsx'))
const realSession = load(src('expense-app-session.ts'))
let nav, ask
function ReportLeaf({ report, appControls, appMonthControl, appComparison }) {
  nav = navigation.useAppNavigation()
  const [instance] = React.useState(() => ++reportMounts)
  return h('div', { 'data-report-instance': instance, 'data-report-month': report.month },
    h(navigation.ReportScreen, { name: 'overview' }, appControls, appMonthControl, appComparison, h('p', null, 'Report overview')),
    h(navigation.ReportScreen, { name: 'spending' }, h('p', null, 'Daily spending')))
}
function useTheme() { const [theme, setTheme] = React.useState('dark'); return { theme, toggleTheme() { setTheme(value => value === 'dark' ? 'light' : 'dark') } } }
function AskLeaf(props) { ask = props; const [draft, setDraft] = React.useState(''); return h('aside', { hidden: !props.open }, h('input', { 'aria-label': 'Question fixture', value: draft, onChange: e => setDraft(e.target.value) })) }
function NotificationsLeaf() { const [value, setValue] = React.useState(false); return h('button', { 'aria-label': 'Notification fixture', 'aria-pressed': value, onClick: () => setValue(!value) }, 'Fixture preference') }
mocks.set(src('report-app.tsx'), { ExpenseReportApp: ReportLeaf, useExpenseReportTheme: useTheme })
mocks.set(src('ask-bookiebot-panel.tsx'), { AskBookieBotPanel: AskLeaf })
mocks.set(src('phone-notifications.tsx'), { PhoneNotifications: NotificationsLeaf })
mocks.set(src('shared-reimbursements.tsx'), { SharedReimbursementsCard: () => h('p', null, 'Legacy fallback') })
const { ExpenseAppShell } = load(src('expense-app-shell.tsx'))
let guard
function Observe() { guard = useAppWorkGuard(); return null }
const report = { ownerName: 'Brian', year: 2026, month: 9, monthLabel: 'September 2026', generatedAt: 'first', burnRate: {} }
const props = data => ({ report: data, controls: h('p', null, 'Refresh fixture'), monthControl: h('p', null, 'Month fixture'), comparison: h('p', null, 'Comparison fixture'), avatarUrl: '/synthetic-avatar.png', initialVersion: 'shell-version-1', signingOut: false, signOut() { signouts++ } })
const shell = data => h(AppWorkGuardProvider, null, h(Observe), h(ExpenseAppShell, props(data)))
const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve() }
const run = async fn => act(async () => { fn(); await flush() })
const response = (data, status = 200) => ({ status, ok: status < 400, json: async () => data })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const visible = node => { for (let current = node; current; current = current.parent) if (current.props.hidden || current.props['aria-hidden'] === true || current.props.inert === true || current.props.inert === '') return false; return true }
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node.children.map(text).join('')
const button = (tree, label) => tree.root.findAllByType('button').filter(visible).find(node => node.props['aria-label'] === label || text(node) === label)
const tap = (tree, label) => run(() => { const node = button(tree, label); assert.ok(node, `Missing ${label}`); assert.ok(!node.props.disabled, `${label} is disabled`); node.props.onClick({ currentTarget: { blur() {}, focus() {} }, preventDefault() {} }) })
const input = (tree, label) => tree.root.findAllByType('label').filter(visible).find(node => text(node).startsWith(label)).findByType('input')
const fill = (tree, label, value) => run(() => input(tree, label).props.onChange({ target: { value } }))
const form = tree => tree.root.findAllByType('form').find(visible)
const screen = tree => tree.root.findAll(node => node.type === 'div' && node.props['data-screen'])[0].props['data-screen']
const rawReport = tree => tree.root.findAll(node => node.type === 'div' && node.props['data-report-instance'])[0]
const dialogs = []
const create = content => Renderer.create(content, { createNodeMock: el => el.type === 'dialog' ? (() => { const dialog = { dataset: {}, open: false, showModal() { this.open = true }, close() { this.open = false } }; dialogs.push(dialog); return dialog })() : null })
const allocation = { id: 'power', payerOwner: 'brian', partnerOwner: 'hannah', payerPerson: 'Brian', item: 'Power', location: '', expenseDate: '2026-09-03', category: 'need', grossCents: 20000, payerShareCents: 10000, partnerShareCents: 10000, settledCents: 0, outstandingCents: 10000, method: 'equal', version: 1, projectedVersion: 1, accounting: 'cash_v1', status: 'outstanding' }
let owner = 'brian', pending, writes = [], reads = { goals: 0, reimbursements: 0 }
request = async (url, options = {}) => {
  if (url === '/app/version') return response({ version: 'shell-version-2' })
  if (url === '/app/widgets/settings') return response({ connections: [], scriptUrl: '/app/widgets/script', setupInstructionsUrl: '/app/widgets/help' })
  if (options.body) { writes.push({ url, body: JSON.parse(options.body) }); return pending.promise }
  if (url === '/app/goals') { reads.goals++; return response({ goals: [] }) }
  if (url === '/app/reimbursements') { reads.reimbursements++; return response({ enabled: true, ownerKey: owner, currency: 'USD', allocations: [allocation], events: [] }) }
  throw Error(`Unexpected fixture URL ${url}`)
}
async function main() {
  let tree
  await run(() => { tree = create(shell(report)) })
  assert.equal(screen(tree), 'overview'); assert.equal(reads.goals, 1); assert.equal(reads.reimbursements, 1)
  const initialReportInstance = rawReport(tree).props['data-report-instance']
  for (const label of ['Overview', 'Spending', 'Shared', 'Savings']) {
    const node = button(tree, label)
    assert.ok(node && node.props.role !== 'link', 'Screen navigation uses button semantics, including Konsta-rendered controls')
  }
  win.scrollY = 320; await tap(tree, 'Savings'); assert.equal(win.scrollY, 0)
  win.scrollY = 210; await tap(tree, 'Overview'); assert.equal(win.scrollY, 320)
  await tap(tree, 'Savings'); assert.equal(win.scrollY, 210, 'Each screen restores its own scroll position')
  await tap(tree, 'Savings'); await tap(tree, '＋ Goal'); await fill(tree, 'Goal name', 'Trip draft'); await fill(tree, 'Target ($)', '1000')
  assert.equal(guard.dirty, true)
  await tap(tree, 'Shared'); await tap(tree, 'View 1 expense')
  const disclosure = tree.root.findAllByType('button').filter(visible).find(node => node.props.className === 'bb-reimbursement-toggle')
  await run(() => disclosure.props.onClick()); await tap(tree, 'Record received'); await fill(tree, 'Amount ($)', '37.25'); await fill(tree, 'Note', 'Payment draft')
  await tap(tree, 'Settings'); await tap(tree, 'Notification fixture')
  for (const name of ['Overview', 'Spending', 'Shared', 'Savings', 'Settings']) await tap(tree, name)
  assert.equal(reads.goals, 1); assert.equal(reads.reimbursements, 1, 'Navigating all screens never recreates financial controllers')
  assert.equal(rawReport(tree).props['data-report-instance'], initialReportInstance)
  assert.equal(button(tree, 'Notification fixture').props['aria-pressed'], true)
  assert.equal(tree.root.findAll(node => node.type === 'main' && !node.props.hidden).length, 1)
  await tap(tree, 'Back'); assert.equal(screen(tree), 'savings', 'Settings returns to the last financial screen')
  assert.equal(input(tree, 'Goal name').props.value, 'Trip draft')

  await run(() => tree.update(shell({ ...report, month: 8, monthLabel: 'August 2026', generatedAt: 'second' })))
  assert.equal(screen(tree), 'savings'); assert.equal(input(tree, 'Goal name').props.value, 'Trip draft')
  assert.notEqual(rawReport(tree).props['data-report-instance'], initialReportInstance, 'Only month-scoped report content resets')
  assert.equal(reads.goals, 1); assert.equal(reads.reimbursements, 2, 'Ledger refreshes new report data without remounting its draft')
  await tap(tree, 'Shared'); assert.equal(input(tree, 'Amount ($)').props.value, '37.25'); assert.equal(input(tree, 'Note').props.value, 'Payment draft')
  await tap(tree, 'Ask BookieBot'); assert.equal(ask.open, true); assert.equal(ask.month, '2026-08')
  await run(() => nav.preferences.setMode('projected')); assert.equal(ask.mode, 'projected')
  for (const [source, expected] of [['activity', 'spending'], ['reimbursements', 'shared'], ['burn-rate', 'overview']]) {
    await run(() => ask.onShowSource(source)); assert.equal(screen(tree), expected); assert.equal(ask.open, false); assert.equal(nav.sourceRequest.section, source)
    if (source === 'reimbursements') {
      await run(() => { for (const [id, timer] of [...timers]) if (timer.delay === 280) { timers.delete(id); timer.cb() } })
      assert.equal(nav.sourceRequest, null, 'A source request is consumed once it has focused the section')
    }
  }
  assert.equal(sharedFocuses, 1); assert.equal(sharedScrolls, 1)
  await run(() => tree.update(shell({ ...report, month: 7, monthLabel: 'July 2026', generatedAt: 'third' })))
  assert.equal(nav.sourceRequest, null, 'A previous answer cannot focus a source in another month')
  assert.equal(nav.preferences.mode, 'projected', 'Presentation choices survive month replacement')
  await run(() => ask.onShowSource('reimbursements'))
  const focusBeforeMonthChange = sharedFocuses
  await run(() => tree.update(shell({ ...report, month: 6, monthLabel: 'June 2026', generatedAt: 'fourth' })))
  await run(() => { for (const [id, timer] of [...timers]) if (timer.delay === 280) { timers.delete(id); timer.cb() } })
  assert.equal(sharedFocuses, focusBeforeMonthChange, 'A source focus scheduled for the previous month is cancelled on month replacement')
  await run(() => ask.onShowSource('reimbursements')); await tap(tree, 'Savings')
  await run(() => { for (const [id, timer] of [...timers]) if (timer.delay === 280) { timers.delete(id); timer.cb() } })
  assert.equal(sharedFocuses, focusBeforeMonthChange, 'Switching screens cancels an obsolete delayed source focus')

  // Hidden financial drafts still guard Settings. Dismissed update availability remains actionable here.
  await tap(tree, 'Dismiss update notice for now'); await tap(tree, 'Settings')
  await tap(tree, 'Update available · Update now'); assert.equal(reloads, 0); assert.ok(button(tree, 'Discard and update'))
  await tap(tree, 'Keep editing'); assert.equal(guard.dirty, true)
  await tap(tree, 'Sign out'); assert.equal(signouts, 0); assert.ok(button(tree, 'Discard and sign out'))
  await tap(tree, 'Keep editing'); await tap(tree, 'Shared')
  pending = deferred(); await run(() => form(tree).props.onSubmit({ preventDefault() {} })); assert.equal(guard.pending, true)
  await tap(tree, 'Settings'); assert.equal(button(tree, 'Update available · Update now').props.disabled, true)
  await tap(tree, 'Sign out'); assert.equal(signouts, 0); assert.equal(button(tree, 'Discard and sign out'), undefined)
  await tap(tree, 'Keep editing'); await run(() => pending.reject(Error('Response lost')))
  assert.equal(guard.uncertain, true); assert.equal(button(tree, 'Update available · Update now').props.disabled, true)
  await tap(tree, 'Savings'); assert.equal(input(tree, 'Goal name').props.value, 'Trip draft')
  await tap(tree, 'Shared'); pending = deferred(); await tap(tree, 'Retry this record'); assert.deepEqual(writes[0], writes[1])
  await run(() => pending.resolve(response({ enabled: true, ownerKey: owner, currency: 'USD', allocations: [allocation], events: [] })))
  assert.equal(guard.uncertain, false)
  await tap(tree, 'Settings'); await tap(tree, 'Update available · Update now'); await tap(tree, 'Discard and update')
  assert.equal(reloads, 1); assert.equal(guard.dirty, false)
  await tap(tree, 'Savings'); assert.equal(form(tree), undefined, 'Explicit discard closes the retained new-goal form')
  await tap(tree, 'Settings'); await tap(tree, 'Sign out'); assert.equal(signouts, 1)
  await run(() => tree.unmount())

  // Exercise the real FreshExpenseApp ownership boundary, with only its network/catalog transport replaced.
  let session
  class FixtureSession {
    constructor() { session = this; this.listeners = new Set() }
    subscribe(fn) { this.listeners.add(fn); fn({ ...realSession.initialExpenseAppState, phase: 'ready', report }); return () => this.listeners.delete(fn) }
    emitState(next) { this.listeners.forEach(fn => fn({ ...realSession.initialExpenseAppState, ...next })) }
    emit(next) { this.emitState({ phase: 'ready', report: next }) }
    async refresh() {} dispose() {} async signOut() {} async selectMonth() {} expire() {}
  }
  mocks.set(src('expense-app-session.ts'), { ...realSession, ExpenseAppSession: FixtureSession, watchExpenseAppLifecycle: () => () => {} })
  mocks.set(src('app-refresh-control.tsx'), { AppRefreshControl: ({ state }) => h('p', { 'data-refresh-phase': state.phase }, state.message || state.phase) })
  mocks.set(src('expense-app-reconnect.tsx'), { ExpenseAppReconnect: () => null })
  mocks.set(src('report-history.tsx'), { MonthHistoryControl: () => null, ReportComparison: () => null, reportMonthLabel: () => 'September 2026', useReportMonthCatalog: () => ({ catalog: null, loading: false, error: false, refresh() {} }) })
  const { FreshExpenseApp } = load(src('fresh-expense-app.tsx'))
  const config = { reportUrl: '/synthetic-report', logoutUrl: '/synthetic-logout', ownerName: 'Brian', version: 'shell-version-1' }
  await run(() => { tree = create(h(FreshExpenseApp, { config })) })
  await tap(tree, 'Savings'); await tap(tree, '＋ Goal'); await fill(tree, 'Goal name', 'Private Brian draft')
  await fill(tree, 'Target ($)', '1000')
  await tap(tree, 'Shared'); await tap(tree, 'View 1 expense')
  const freshDisclosure = tree.root.findAllByType('button').filter(visible).find(node => node.props.className === 'bb-reimbursement-toggle')
  await run(() => freshDisclosure.props.onClick()); await tap(tree, 'Record received')
  await fill(tree, 'Amount ($)', '16.25'); await fill(tree, 'Note', 'Private receipt draft')
  const beforePendingReads = { ...reads }, beforePendingReportInstance = rawReport(tree).props['data-report-instance']
  await run(() => ask.onShowSource('reimbursements'))
  const beforePendingFocus = sharedFocuses
  // This is the intermediate state published by ExpenseAppSession.selectMonth,
  // not a direct replacement with an already-loaded report.
  await run(() => session.emitState({ report: null, selectedMonth: '2026-08', phase: 'loading', message: 'Loading August' }))
  await run(() => { for (const [id, timer] of [...timers]) if (timer.delay === 280) { timers.delete(id); timer.cb() } })
  assert.equal(sharedFocuses, beforePendingFocus, 'Starting a pending month cancels previously scheduled source focus')
  assert.equal(nav.sourceRequest, null)
  assert.equal(screen(tree), 'shared'); assert.equal(input(tree, 'Amount ($)').props.value, '16.25')
  assert.equal(input(tree, 'Note').props.value, 'Private receipt draft')
  assert.equal(rawReport(tree).props['data-report-instance'], beforePendingReportInstance, 'The owner shell and old report remain mounted during loading')
  assert.equal(ask.month, '2026-08'); assert.equal(ask.open, false)
  await tap(tree, 'Overview')
  assert.equal(visible(rawReport(tree)), false, 'The retained previous month is never shown as the pending month')
  assert.ok(tree.root.findAll(node => node.type === 'main' && node.props.className === 'bb-shell-report-loading bb-main').some(visible))
  assert.ok(tree.root.findAll(node => node.type === 'p' && node.props['data-refresh-phase'] === 'loading').some(visible))
  assert.equal(button(tree, 'Ask BookieBot').props.disabled, true)
  for (const label of ['Overview', 'Spending', 'Shared', 'Savings']) assert.ok(!button(tree, label).props.disabled)
  await tap(tree, 'Savings'); assert.equal(input(tree, 'Goal name').props.value, 'Private Brian draft'); assert.equal(input(tree, 'Target ($)').props.value, '1000')
  await run(() => session.emitState({ report: null, selectedMonth: '2026-08', phase: 'error', message: 'Could not load August' }))
  assert.equal(screen(tree), 'savings'); assert.equal(input(tree, 'Goal name').props.value, 'Private Brian draft')
  await tap(tree, 'Shared'); assert.equal(input(tree, 'Amount ($)').props.value, '16.25'); assert.equal(input(tree, 'Note').props.value, 'Private receipt draft')
  await tap(tree, 'Overview'); assert.equal(visible(rawReport(tree)), false)
  assert.ok(tree.root.findAll(node => node.type === 'p' && node.props['data-refresh-phase'] === 'error').some(visible), 'A failed month retains a visible refresh/error state')
  assert.equal(button(tree, 'Ask BookieBot').props.disabled, true)
  assert.deepEqual(reads, beforePendingReads, 'Intermediate loading and failure do not remount the financial controllers')
  await run(() => session.emit({ ...report, month: 8, monthLabel: 'August 2026', generatedAt: 'after-pending-month' }))
  assert.equal(visible(rawReport(tree)), true); assert.notEqual(rawReport(tree).props['data-report-instance'], beforePendingReportInstance)
  assert.equal(button(tree, 'Ask BookieBot').props.disabled, false)
  await tap(tree, 'Savings'); assert.equal(input(tree, 'Goal name').props.value, 'Private Brian draft')
  await tap(tree, 'Shared'); assert.equal(input(tree, 'Amount ($)').props.value, '16.25'); assert.equal(input(tree, 'Note').props.value, 'Private receipt draft')
  const beforeOwnerReads = reads.goals
  owner = 'hannah'; await run(() => session.emit({ ...report, ownerName: 'Hannah', generatedAt: 'owner-changed' }))
  assert.equal(screen(tree), 'overview'); assert.equal(reads.goals, beforeOwnerReads + 1)
  await tap(tree, 'Savings'); assert.equal(form(tree), undefined, 'Owner-keyed real shell disposes previous financial forms')
  await tap(tree, '＋ Goal'); assert.equal(input(tree, 'Goal name').props.value, '')
  await fill(tree, 'Goal name', 'Private Hannah draft')
  await run(() => session.emitState({ report: null, selectedMonth: '2026-07', phase: 'expired' }))
  assert.equal(tree.root.findAllByType(ExpenseAppShell).length, 0, 'Expiration clears the retained owner shell and its financial drafts')
  assert.equal(tree.root.findAllByType('form').length, 0)
  assert.equal(tree.root.findAllByType('nav').length, 0)
  assert.ok(text(tree.root).includes('Reconnect to BookieBot'))
  await run(() => tree.unmount())
  assert.equal(intervals.size, 0)
  assert.ok([...listeners.window.values(), ...listeners.document.values(), ...listeners.viewport.values()].every(set => !set.size), 'Shell, guard, version, and controllers clean up every listener')
  assert.ok([...storage.values()].every(value => !value.includes('draft') && !value.includes('37.25')), 'Financial draft fields never enter persistent storage')
  console.log('Real app shell lifecycle: all screens, monthly state retention, financial drafts/retry, source routing, Settings guards, and owner reset passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
