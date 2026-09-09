const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")
const frontend = path.join(__dirname, "../../web/expense-report")
const frontendRequire = createRequire(path.join(frontend, "package.json"))
const ts = frontendRequire("typescript")
const React = frontendRequire("react")
const { renderToStaticMarkup } = frontendRequire("react-dom/server")
const TestRenderer = frontendRequire("react-test-renderer")
global.IS_REACT_ACT_ENVIRONMENT = true
const { act } = TestRenderer
const timers = new Map()
let nextTimer = 0
let nextRequest = 0
const listeners = { window: new Map(), document: new Map() }
const eventTarget = (scope) => ({
  addEventListener(name, callback) {
    const entries = listeners[scope].get(name) || new Set()
    entries.add(callback); listeners[scope].set(name, entries)
  },
  removeEventListener(name, callback) { listeners[scope].get(name)?.delete(callback) },
})
const browserWindow = {
  ...eventTarget("window"),
  setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
  clearTimeout(id) { timers.delete(id) },
}
const browserDocument = { ...eventTarget("document"), visibilityState: "visible" }
let fetchRequest = () => { throw Error("Unexpected request before a fixture is mounted") }
class BrowserNode {}
class BrowserElement extends BrowserNode { closest() { return this } }
const modules = new Map()
function load(file) {
  if (modules.has(file)) return modules.get(file)
  const exports = {}; modules.set(file, exports)
  const localRequire = (name) => {
    if (name.endsWith(".css")) return {}
    if (!name.startsWith(".")) return frontendRequire(name)
    const base = path.resolve(path.dirname(file), name)
    return load([base + ".tsx", base + ".ts"].find(fs.existsSync))
  }
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  const inspectionExports = file.endsWith("savings-goals.tsx") ? "\nexports.GoalEntry = GoalEntry; exports.ContributionHistoryRow = ContributionHistoryRow;" : ""
  vm.runInNewContext(outputText + inspectionExports, { exports, require: localRequire, AbortController, Error,
    window: browserWindow, document: browserDocument, fetch: (...args) => fetchRequest(...args),
    crypto: { randomUUID: () => `test-request-${++nextRequest}` },
    Node: BrowserNode, Element: BrowserElement,
    requestAnimationFrame: callback => browserWindow.setTimeout(callback, 16),
    cancelAnimationFrame: id => browserWindow.clearTimeout(id) })
  return exports
}
const { SavingsGoals, GoalEntry, ContributionHistoryRow, goalAmountCents, goalProgress } = load(path.join(frontend, "src/savings-goals.tsx"))
assert.equal(goalAmountCents("1.01"), 101)
assert.equal(goalAmountCents("0.29"), 29, "Fractional dollar input must not lose a cent to floating point")
assert.equal(goalAmountCents(" 0002.3 "), 230)
assert.equal(goalAmountCents("0"), 0)
for (const invalid of ["", "-1", "1e3", "1.001", "Infinity", "1,000", "$3", "100000000.01"]) {
  assert.equal(goalAmountCents(invalid), null)
}
const goal = { targetCents: 10000, balanceCents: 3000 }
assert.equal(goalProgress(goal).percent, 30)
assert.equal(goalProgress(goal).remainingCents, 7000)
assert.equal(goalProgress({ ...goal, balanceCents: 12000 }).percent, 100)
assert.equal(goalProgress({ ...goal, balanceCents: 12000 }).remainingCents, 0)
const markup = renderToStaticMarkup(React.createElement(SavingsGoals))
assert.ok(!markup.includes("Personal plans across months"), "The goal list does not lead with the explanatory paragraph")
assert.ok(!markup.includes("don’t move money or change monthly Saved"))
assert.ok(markup.includes("Loading your goals"))
assert.ok(!markup.includes("$0.00"), "Unloaded balance must not look like a confirmed zero")
assert.ok(!/class="bb-savings-total(?:\s|")/.test(markup), "The running total appears only after savings have loaded")
assert.match(markup, /<button[^>]*disabled=""[^>]*>＋ Goal<\/button>/)
const createButton = /<button[^>]*>＋ Goal<\/button>/.exec(markup)[0]
assert.ok(createButton.includes('aria-expanded="false"'))
const createId = /aria-controls="([^"]+)"/.exec(createButton)[1]
assert.ok(markup.includes(`id="${createId}"`), "New goal disclosure identifies its actual content region")
const completeGoal = { id: "goal-1", name: "Trip", targetCents: 10000, startingCents: 0, balanceCents: 3000, contributionCents: 3000, contributionCount: 1, targetDate: "", archived: false, version: 1 }
const goalMarkup = renderToStaticMarkup(React.createElement(GoalEntry, { goal: completeGoal, view: "", onViewChange() {}, disabled: false, run() {} }))
const modeButtons = [...goalMarkup.matchAll(/<button[^>]*aria-controls="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)]
assert.equal(modeButtons.length, 2, "Only the compact goal disclosure and separate options trigger are exposed")
for (const [button, controlledId] of modeButtons) {
  assert.ok(button.includes('aria-expanded="false"'))
  assert.ok(goalMarkup.includes(`id="${controlledId}"`))
}
const entry = { id: "contribution-1", amountCents: 3000, date: "2026-09-07", note: "Trip allocation", reversedAt: "" }
const row = (changes = {}) => React.createElement(ContributionHistoryRow, { entry, goal: completeGoal, disabled: false, open: false, run() {}, onToggle() {}, onClose() {}, ...changes })
const closed = renderToStaticMarkup(row())
const open = renderToStaticMarkup(row({ open: true }))
assert.match(closed, /<button[^>]*aria-expanded="false"[^>]*>Reverse<\/button>/)
assert.match(open, /<button[^>]*aria-expanded="true"[^>]*>Reverse<\/button>/)
assert.ok(closed.includes("Confirm reversal"), "Closing retains the confirmation content so its height can animate")
assert.ok(closed.includes('data-state="closed"') && closed.includes('inert=""'), "Retained controls become inaccessible immediately on close")
assert.ok(open.includes('data-state="open"') && !open.includes('inert=""'))
const reverseId = /aria-controls="([^"]+)"/.exec(open)[1]
assert.ok(open.includes(`id="${reverseId}"`))
const both = renderToStaticMarkup(React.createElement(React.Fragment, null, row(), row({ entry: { ...entry, id: "contribution-2" } })))
const rowIds = [...both.matchAll(/aria-controls="([^"]+)"/g)].map(match => match[1])
assert.equal(new Set(rowIds).size, 2, "Each contribution has a distinct confirmation region")
assert.ok(!renderToStaticMarkup(row({ entry: { ...entry, reversedAt: "2026-09-07" }, open: true })).includes('aria-expanded="true"'))
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const respond = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
const clone = value => JSON.parse(JSON.stringify(value))
const textOf = node => typeof node === "string" || typeof node === "number" ? String(node) : node.children.map(textOf).join("")
const visible = node => {
  for (let current = node; current; current = current.parent) {
    if (current.props["aria-hidden"] === true || current.props["aria-hidden"] === "true" || current.props.inert === true || current.props.inert === "") return false
  }
  return true
}
const visibleText = node => typeof node === "string" || typeof node === "number" ? String(node)
  : visible(node) ? node.children.map(visibleText).join("") : ""
const buttons = scope => scope.findAllByType("button").filter(visible)
const button = (scope, label) => buttons(scope).find(node => textOf(node) === label || node.props["aria-label"] === label)
const goalRow = (tree, name) => tree.root.findAllByType("article").find(node => node.props["aria-label"] === name)
const options = row => buttons(row).find(node => node.props["aria-label"] === `${row.props["aria-label"]} options`)
const disclosure = row => buttons(row).find(node => node.props["aria-expanded"] !== undefined && node !== options(row))
const optionPanel = row => row.findAll(node => node.props.id === options(row).props["aria-controls"])[0]
const savingsTotal = tree => tree.root.findAll(node => typeof node.type === "string"
  && node.props.className?.split(" ").includes("bb-savings-total")).filter(visible)[0]
const assertSavingsTotal = (tree, expected, explanation) => {
  assert.ok(savingsTotal(tree), "A loaded savings section has a running total")
  assert.equal(visibleText(savingsTotal(tree)), expected, explanation)
}
async function tap(node) {
  assert.ok(node, "Expected an accessible visible control")
  assert.ok(!node.props.disabled, `Expected an enabled control: ${textOf(node)}`)
  await act(async () => {
    const ancestors = []
    for (let current = node; current; current = current.parent) if (typeof current.type === "string") ancestors.push(current)
    let stopped = false
    const event = { preventDefault() {}, stopPropagation() { stopped = true }, target: new BrowserElement() }
    for (const current of ancestors.slice().reverse()) {
      current.props.onClickCapture?.(event)
      if (stopped) break
    }
    if (!stopped) for (const current of ancestors) {
      current.props.onClick?.(event)
      if (stopped) break
    }
    await flush()
  })
}
async function settleClosing() {
  await act(async () => {
    for (const [id, timer] of [...timers]) if (timer.delay <= 400) { timers.delete(id); timer.callback() }
    await flush()
  })
}
async function choose(tree, goalName, label) {
  const trigger = options(goalRow(tree, goalName))
  if (!trigger.props["aria-expanded"]) await tap(trigger)
  const choice = buttons(optionPanel(goalRow(tree, goalName))).find(node => textOf(node).startsWith(label))
  await tap(choice)
}
const form = tree => tree.root.findAllByType("form").find(visible)
async function fill(tree, label, value) {
  const field = form(tree).findAllByType("label").find(node => textOf(node).startsWith(label)).findByType("input")
  await act(async () => { field.props.onChange({ target: { value } }); await flush() })
}
async function submit(tree) {
  await act(async () => { form(tree).props.onSubmit({ preventDefault() {} }); await flush() })
}
const sampleGoals = [
  { id: "emergency", name: "Emergency fund", targetCents: 100000, startingCents: 15000, balanceCents: 35000,
    contributionCents: 20000, contributionCount: 2, targetDate: "2026-12-31", archived: false, version: 4 },
  { id: "trip", name: "Trip", targetCents: 10000, startingCents: 3000, balanceCents: 12000,
    contributionCents: 9000, contributionCount: 1, targetDate: "", archived: false, version: 2 },
  { id: "old", name: "Old plan", targetCents: 50000, startingCents: 5000, balanceCents: 5000,
    contributionCents: 0, contributionCount: 0, targetDate: "", archived: true, version: 3 },
]
const historyEntries = [
  { id: "allocation-a", amountCents: 12000, date: "2026-09-01", note: "September allocation", reversedAt: "" },
  { id: "allocation-b", amountCents: 8000, date: "2026-08-01", note: "August allocation", reversedAt: "" },
]
function fixture({ post } = {}) {
  timers.clear()
  for (const scope of Object.values(listeners)) scope.clear()
  const state = { goals: clone(sampleGoals), calls: [], history: clone(historyEntries) }
  fetchRequest = async (url, config = {}) => {
    const body = config.body ? JSON.parse(config.body) : undefined
    state.calls.push({ url, config, body })
    assert.equal(config.credentials, "same-origin")
    assert.equal(config.cache, "no-store")
    assert.equal(config.redirect, "error")
    if (body) {
      assert.equal(config.method, "POST")
      assert.equal(config.headers["X-BookieBot-App"], "1")
      assert.ok(body.requestId, "Every mutation has an idempotency key")
      return post ? post(body, state) : respond({})
    }
    if (url === "/app/goals") return respond({ goals: clone(state.goals) })
    const match = /\/app\/goals\/([^/]+)\/contributions\?offset=(\d+)$/.exec(url)
    assert.ok(match, `Unexpected request: ${url}`)
    if (match[1] !== "emergency") return respond({ contributions: [], nextOffset: null })
    const offset = Number(match[2])
    return respond({ contributions: clone(state.history.slice(offset, offset + 1)), nextOffset: offset + 1 < state.history.length ? offset + 1 : null })
  }
  return state
}
async function mount() {
  let tree
  await act(async () => { tree = TestRenderer.create(React.createElement(SavingsGoals)); await flush() })
  return tree
}
async function unmount(tree) {
  await act(async () => { tree.unmount(); await flush() })
  assert.ok([...listeners.window.values(), ...listeners.document.values()].every(entries => entries.size === 0), "Unmount removes browser refresh and menu listeners")
}
const mutations = state => state.calls.filter(call => call.body)

async function compactLifecycleContracts() {
  let state = fixture()
  let tree = await mount()
  assert.equal(textOf(tree.root.findByType("h2")), "Savings")
  assert.ok(tree.root.findAllByType("h3").some(node => textOf(node) === "Goals"))
  assertSavingsTotal(tree, "$520", "Total includes all recorded goal balances, including archived and over-target amounts")
  assert.ok(visibleText(tree.root).includes("Recorded across goals"), "The caption identifies allocation scope rather than bank cash")
  assert.ok(visibleText(tree.root).includes("includes archived"), "The scope explicitly explains why hidden archived goals still count")
  assert.equal(mutations(state).length, 0, "Rendering goals is read-only")
  for (const name of ["Emergency fund", "Trip"]) {
    const row = goalRow(tree, name)
    const exactBalance = name === "Emergency fund" ? "$350.00" : "$120.00"
    assert.equal(disclosure(row).props["aria-label"], `${name}: ${exactBalance} set aside`, "Compact visual formatting keeps the exact balance available to assistive technology")
    assert.equal(disclosure(row).props["aria-expanded"], false, "Each active goal starts collapsed")
    assert.equal(options(row).props["aria-expanded"], false)
    assert.equal(buttons(row).length, 2, "The collapsed row exposes just its disclosure and separate options button")
    const region = row.findAll(node => node.props.id === disclosure(row).props["aria-controls"])[0]
    assert.ok(region.findAll(node => node.props["data-state"] === "closed").every(node => node.props.inert === true), "Collapsed details cannot receive focus")
    const progress = row.findAll(node => node.props.role === "progressbar").filter(visible)
    assert.equal(progress.length, 1, "The collapsed goal has one accessible progress indicator")
    assert.equal(progress[0].props["aria-valuenow"], name === "Emergency fund" ? 35 : 100)
    assert.ok(progress[0].props["aria-valuetext"].includes(exactBalance), "A completed bar still describes the actual over-target balance")
  }
  assert.ok(!visibleText(tree.root).includes("Personal plans across months"))
  assert.ok(!visibleText(tree.root).includes("starting balance"))
  assert.ok(!visibleText(tree.root).includes("Target reached"), "Completion does not add a status/checkmark beside the collapsed amount")
  assert.equal(state.calls.filter(call => call.url.includes("contributions?")).length, 0, "History is lazy")
  await tap(disclosure(goalRow(tree, "Emergency fund")))
  const openRow = goalRow(tree, "Emergency fund")
  assert.equal(disclosure(openRow).props["aria-expanded"], true)
  assert.ok(visibleText(openRow).includes("$650"), "Expanded overview keeps the exact remaining amount")
  assert.ok(visibleText(openRow).includes("$1,000"), "Expanded overview keeps the exact target")
  assert.ok(!visibleText(openRow).includes("$150.00"), "Starting balance is not part of the concise overview")
  assert.ok(!visibleText(openRow).includes("$200.00"), "Contribution subtotal is not part of the concise overview")
  await tap(disclosure(goalRow(tree, "Trip")))
  assert.equal(disclosure(goalRow(tree, "Emergency fund")).props["aria-expanded"], false, "Opening another goal closes its sibling")
  assert.equal(disclosure(goalRow(tree, "Trip")).props["aria-expanded"], true)
  await tap(options(goalRow(tree, "Emergency fund")))
  assert.equal(disclosure(goalRow(tree, "Emergency fund")).props["aria-expanded"], false, "Opening options does not also expand the goal")
  assert.equal(options(goalRow(tree, "Emergency fund")).props["aria-expanded"], true)
  assert.deepEqual(buttons(optionPanel(goalRow(tree, "Emergency fund"))).map(textOf),
    ["Record contribution", "History (2)", "Edit goal", "Archive goal"], "Actions move into one concise menu")
  await choose(tree, "Emergency fund", "History")
  assert.equal(disclosure(goalRow(tree, "Emergency fund")).props["aria-expanded"], true)
  assert.equal(disclosure(goalRow(tree, "Trip")).props["aria-expanded"], false)
  assert.equal(options(goalRow(tree, "Emergency fund")).props["aria-expanded"], false)
  assert.ok(visibleText(goalRow(tree, "Emergency fund")).includes("$150.00"), "History retains the initial balance")
  assert.ok(visibleText(goalRow(tree, "Emergency fund")).includes("$120.00"), "History retains the actual recorded additions")
  assert.ok(visibleText(tree.root).includes("September allocation"))
  assert.ok(!visibleText(tree.root).includes("August allocation"))
  await tap(button(tree.root, "Load more"))
  assert.ok(visibleText(tree.root).includes("September allocation") && visibleText(tree.root).includes("August allocation"), "Paging appends rather than replaces contribution history")
  assert.equal(button(tree.root, "Load more"), undefined)
  await tap(button(tree.root, "Reverse"))
  assert.ok(button(tree.root, "Confirm reversal"), "Reversal still requires confirmation")
  assert.equal(mutations(state).length, 0)
  await tap(button(tree.root, "Cancel"))
  assert.equal(button(tree.root, "Confirm reversal"), undefined, "Closing reversal immediately makes retained confirmation inaccessible")
  await settleClosing()
  await unmount(tree)
}

async function mutationLifecycleContracts() {
  const state = fixture({ post: (body, current) => {
    const goal = current.goals.find(item => item.id === body.goalId)
    if (body.operation === "contribute") {
      goal.balanceCents = 35029; goal.contributionCents = 20029; goal.contributionCount = 3; goal.version = 5
    } else if (body.operation === "archive") { goal.archived = true; goal.version = 6 }
    else if (body.operation === "restore") { goal.archived = false; goal.version = 7 }
    else if (body.operation === "reverse") {
      goal.balanceCents = 23029; goal.contributionCents = 8029; goal.version = 8
      current.history[0].reversedAt = "2026-09-08"
    }
    return respond({})
  } })
  const tree = await mount()
  await choose(tree, "Emergency fund", "Record contribution")
  assert.equal(disclosure(goalRow(tree, "Emergency fund")).props["aria-expanded"], true)
  assert.ok(visibleText(tree.root).includes("no transfer or change to monthly Saved"), "Allocation safety context stays at the action that needs it")
  await fill(tree, "Amount", "0.001")
  await submit(tree)
  assert.equal(mutations(state).length, 0, "Invalid fractional cents never submit")
  await fill(tree, "Amount", "0.29")
  const contributionDate = form(tree).findAllByType("input").find(node => node.props.type === "date")
  assert.equal(contributionDate.props.required, true, "Contribution date keeps native required-date validation")
  assert.match(contributionDate.props.max, /^\d{4}-\d{2}-\d{2}$/)
  await fill(tree, "Date", "2026-09-07")
  await fill(tree, "Note", "Small allocation")
  await submit(tree)
  const contribution = mutations(state)[0].body
  assert.deepEqual({ ...contribution, requestId: undefined }, { operation: "contribute", goalId: "emergency", version: 4,
    amountCents: 29, date: "2026-09-07", note: "Small allocation", requestId: undefined })
  assert.ok(visibleText(goalRow(tree, "Emergency fund")).includes("$350.29"), "Successful changes reload the saved balance")
  assertSavingsTotal(tree, "$520.29", "Confirmed contribution updates the running total with exact cents")
  assert.equal(form(tree), undefined, "Successful contribution closes the editor")
  await choose(tree, "Emergency fund", "Archive")
  assert.equal(mutations(state).length, 1, "Choosing archive only opens its confirmation")
  await tap(button(tree.root, "Cancel"))
  assert.equal(mutations(state).length, 1)
  await choose(tree, "Emergency fund", "Archive")
  await tap(button(tree.root, "Archive goal"))
  assert.equal(mutations(state)[1].body.version, 5, "Archive uses the refreshed version")
  assertSavingsTotal(tree, "$520.29", "Archiving retains recorded savings in the total")
  await tap(button(tree.root, "Archived goals (2)"))
  await tap(options(goalRow(tree, "Emergency fund")))
  assert.deepEqual(buttons(optionPanel(goalRow(tree, "Emergency fund"))).map(textOf), ["History (3)", "Restore goal"], "Archived goals expose history and restore, without editable actions")
  await choose(tree, "Emergency fund", "Restore")
  assert.equal(mutations(state)[2].body.operation, "restore")
  assert.equal(mutations(state)[2].body.version, 6)
  assertSavingsTotal(tree, "$520.29", "Restoring does not count the same savings twice")
  assert.equal(disclosure(goalRow(tree, "Emergency fund")).props["aria-expanded"], false, "A restored goal returns as a compact row")
  await choose(tree, "Emergency fund", "History")
  await tap(button(tree.root, "Reverse"))
  await tap(button(tree.root, "Confirm reversal"))
  assert.deepEqual({ ...mutations(state)[3].body, requestId: undefined }, { operation: "reverse", goalId: "emergency", version: 7,
    contributionId: "allocation-a", requestId: undefined })
  assert.ok(visibleText(goalRow(tree, "Emergency fund")).includes("$230.29"))
  assertSavingsTotal(tree, "$400.29", "Confirmed reversal subtracts its recorded contribution from the total")
  await unmount(tree)
}

async function recoveryLifecycleContracts() {
  let fail = true
  let state = fixture({ post: (_body, current) => {
    if (fail) throw Error("Response lost after saving")
    current.goals[0].balanceCents = 35101; current.goals[0].version = 5
    return respond({})
  } })
  let tree = await mount()
  await choose(tree, "Emergency fund", "Record contribution")
  await fill(tree, "Amount", "1.01")
  await submit(tree)
  assert.ok(button(tree.root, "Retry this change"))
  assert.ok(form(tree).findByType("fieldset").props.disabled, "Unknown mutation outcome locks editing")
  assert.ok(options(goalRow(tree, "Trip")).props.disabled, "Unknown outcome also blocks a new goal mutation")
  const initialBody = mutations(state)[0].body
  fail = false
  await tap(button(tree.root, "Retry this change"))
  assert.deepEqual(mutations(state)[1].body, initialBody, "Retry resends the exact body and idempotency key")
  assert.equal(button(tree.root, "Retry this change"), undefined)
  assert.ok(visibleText(goalRow(tree, "Emergency fund")).includes("$351.01"))
  await unmount(tree)

  state = fixture({ post: () => { throw Error("Unknown server outcome") } })
  tree = await mount()
  await choose(tree, "Emergency fund", "Record contribution")
  await fill(tree, "Amount", "2.01")
  await submit(tree)
  state.goals[0].balanceCents = 35201
  state.goals[0].version = 5
  await tap(button(tree.root, "Check latest"))
  assert.equal(mutations(state).length, 1, "Checking latest does not replay the uncertain change")
  assert.equal(button(tree.root, "Retry this change"), undefined)
  assert.equal(form(tree), undefined)
  assert.ok(!options(goalRow(tree, "Emergency fund")).props.disabled)
  assert.ok(visibleText(goalRow(tree, "Emergency fund")).includes("$352.01"))
  await unmount(tree)

  state = fixture({ post: (_body, current) => {
    current.goals[0].version = 9
    current.goals[0].name = "Emergency reserve"
    return respond({ error: "This goal changed. Review its latest values." }, 409)
  } })
  tree = await mount()
  await choose(tree, "Emergency fund", "Edit goal")
  await fill(tree, "Goal name", "An obsolete edit")
  await submit(tree)
  assert.equal(mutations(state)[0].body.operation, "edit")
  assert.equal(mutations(state)[0].body.version, 4)
  assert.ok(visibleText(tree.root).includes("Emergency reserve"), "Conflict reloads the latest goal before further changes")
  assert.equal(form(tree), undefined, "A conflict closes the stale editor")
  assert.equal(button(tree.root, "Retry this change"), undefined, "Known conflicts do not retry an obsolete mutation")
  await unmount(tree)
}

async function historyFailureAndCleanupContracts() {
  const state = fixture()
  const originalRequest = fetchRequest
  let fail = true
  fetchRequest = (url, config) => url.includes("contributions?") && fail
    ? Promise.reject(Error("History unavailable")) : originalRequest(url, config)
  let tree = await mount()
  await choose(tree, "Emergency fund", "History")
  assert.ok(button(tree.root, "Try again"), "History errors offer a local retry")
  assert.equal(mutations(state).length, 0)
  fail = false
  await tap(button(tree.root, "Try again"))
  assert.ok(visibleText(tree.root).includes("September allocation"))
  await tap(button(tree.root, "Close"))
  assert.equal(disclosure(goalRow(tree, "Emergency fund")).props["aria-expanded"], false)
  assert.ok(!visibleText(tree.root).includes("September allocation"), "Closing immediately removes history from the accessible view")
  await settleClosing()
  await unmount(tree)

  fixture()
  let requestSignal
  let resolveHistory
  const waiting = new Promise(resolve => { resolveHistory = resolve })
  const readGoals = fetchRequest
  fetchRequest = (url, config) => {
    if (!url.includes("contributions?")) return readGoals(url, config)
    requestSignal = config.signal
    return waiting
  }
  tree = await mount()
  await choose(tree, "Emergency fund", "History")
  await tap(button(tree.root, "Close"))
  assert.equal(requestSignal.aborted, false, "The request remains attached to retained closing content")
  await settleClosing()
  assert.equal(requestSignal.aborted, true, "Releasing closed history aborts its pending request")
  await unmount(tree)
  await act(async () => { resolveHistory(respond({ contributions: historyEntries, nextOffset: null })); await flush() })
}

async function archivedCompletionContract() {
  const state = fixture()
  Object.assign(state.goals[2], { balanceCents: 55000, contributionCents: 50000, contributionCount: 1, targetDate: "2026-12-31" })
  const tree = await mount()
  await tap(button(tree.root, "Archived goals (1)"))
  await tap(disclosure(goalRow(tree, "Old plan")))
  const row = goalRow(tree, "Old plan")
  const date = row.findAllByType("time").find(visible)
  assert.ok(date, "A completed archived goal retains its visible deadline")
  assert.equal(date.props.dateTime, "2026-12-31")
  assert.ok(textOf(date).includes("Dec 31"))
  assert.ok(visibleText(row).includes("Target reached"), "Completion is shown alongside the goal date")
  await tap(options(row))
  assert.deepEqual(buttons(optionPanel(row)).map(textOf), ["History (1)", "Restore goal"], "Completed archived goals remain read-only until restored")
  assert.equal(mutations(state).length, 0)
  await unmount(tree)
}

async function runningTotalContracts() {
  let state = fixture()
  Object.assign(state.goals[0], { balanceCents: 35001, startingCents: 99999999, contributionCents: 12345678 })
  let tree = await mount()
  assertSavingsTotal(tree, "$520.01", "Only canonical balanceCents are summed; starting amounts and contributions are not counted again")
  await unmount(tree)

  state = fixture()
  state.goals = []
  tree = await mount()
  assertSavingsTotal(tree, "$0", "A successfully loaded empty list confirms a zero recorded balance")
  assert.ok(!visibleText(tree.root).includes("includes archived"), "No archived scope note appears when there are no archived goals")
  await unmount(tree)

  state = fixture()
  state.goals = [{ ...sampleGoals[2], balanceCents: 5050 }]
  tree = await mount()
  assertSavingsTotal(tree, "$50.50", "Savings remain visible when every goal is archived")
  await unmount(tree)

  state = fixture({ post: (body, current) => {
    assert.equal(body.operation, "edit")
    Object.assign(current.goals[0], { startingCents: 15507, balanceCents: 35507, targetDate: body.targetDate, version: 5 })
    return respond({})
  } })
  tree = await mount()
  await choose(tree, "Emergency fund", "Edit goal")
  const goalDate = form(tree).findAllByType("input").find(node => node.props.type === "date")
  assert.equal(goalDate.props.value, "2026-12-31")
  assert.equal(goalDate.props.min, "1900-01-01")
  assert.equal(goalDate.props.max, "2200-12-31")
  assert.ok(!goalDate.props.required, "Goal deadline remains an optional native date field")
  await fill(tree, "Starting balance", "155.07")
  await fill(tree, "Target date", "2027-03-18")
  await submit(tree)
  assert.equal(mutations(state)[0].body.startingCents, 15507)
  assert.equal(mutations(state)[0].body.targetDate, "2027-03-18", "The wrapped native input still submits the selected ISO date")
  assertSavingsTotal(tree, "$525.07", "A confirmed balance edit refreshes the running total")
  await unmount(tree)
}

async function runningTotalReadRecoveryContracts() {
  fixture()
  const originalRequest = fetchRequest
  let failure = "offline"
  fetchRequest = (url, config) => failure === "offline" ? Promise.reject(Error("Offline"))
    : failure === "unauthorized" ? Promise.resolve(respond({ error: "Sign in again." }, 401))
    : originalRequest(url, config)
  const tree = await mount()
  assert.equal(savingsTotal(tree), undefined, "Failed initial loading never invents a zero savings balance")
  assert.ok(button(tree.root, "Refresh goals"))
  failure = ""
  await tap(button(tree.root, "Refresh goals"))
  assertSavingsTotal(tree, "$520", "A successful retry reveals the recorded balance")
  failure = "offline"
  await act(async () => {
    for (const refresh of listeners.window.get("focus") || []) refresh()
    await flush()
  })
  assertSavingsTotal(tree, "$520", "A temporary refresh failure preserves the last known savings total")
  failure = "unauthorized"
  await tap(button(tree.root, "Refresh goals"))
  assert.equal(savingsTotal(tree), undefined, "Authentication expiry removes the previously loaded savings balance")
  await unmount(tree)
}

;(async () => {
  await compactLifecycleContracts()
  await mutationLifecycleContracts()
  await recoveryLifecycleContracts()
  await historyFailureAndCleanupContracts()
  await archivedCompletionContract()
  await runningTotalContracts()
  await runningTotalReadRecoveryContracts()
  console.log("Savings goals compact disclosures, menu actions, history, versioned mutations and safe recovery checks passed")
})().catch(error => { console.error(error); process.exitCode = 1 })
