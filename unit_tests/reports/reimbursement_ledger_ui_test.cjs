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
const Renderer = frontendRequire("react-test-renderer")
global.IS_REACT_ACT_ENVIRONMENT = true
const { act } = Renderer
const timers = new Map(), listeners = { window: new Map(), document: new Map() }, dispatched = []
let timerId = 0, requestId = 0
const events = scope => ({
  addEventListener(name, callback) { const set = listeners[scope].get(name) || new Set(); set.add(callback); listeners[scope].set(name, set) },
  removeEventListener(name, callback) { listeners[scope].get(name)?.delete(callback) },
})
const browserWindow = { ...events("window"),
  setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
  clearTimeout(id) { timers.delete(id) },
  dispatchEvent(event) { dispatched.push(event.type) },
}
const browserDocument = { ...events("document"), visibilityState: "visible" }
class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : ["2026-10-01T06:30:00Z"])) }
}
let fetchRequest = () => { throw Error("No HTTP fixture") }
const modules = new Map()
function load(file) {
  if (modules.has(file)) return modules.get(file)
  const exports = {}; modules.set(file, exports)
  const localRequire = name => {
    if (name.endsWith(".css")) return {}
    if (!name.startsWith(".")) return frontendRequire(name)
    const base = path.resolve(path.dirname(file), name)
    return load([base + ".tsx", base + ".ts"].find(fs.existsSync))
  }
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } })
  vm.runInNewContext(outputText, { exports, require: localRequire, AbortController, Error, Date: FixtureDate,
    window: browserWindow, document: browserDocument, fetch: (...args) => fetchRequest(...args),
    crypto: { randomUUID: () => `record-${++requestId}` }, CustomEvent: class { constructor(type) { this.type = type } },
  })
  return exports
}
const { ReimbursementLedger, reimbursementAmountCents, ledgerTotals, defaultOffsetEntries, canReverseLedgerEvent } = load(path.join(frontend, "src/reimbursement-ledger.tsx"))
const fallback = React.createElement("p", null, "Legacy reimbursement overview")
const markup = renderToStaticMarkup(React.createElement(ReimbursementLedger, { fallback }))
assert.ok(markup.includes("Loading reimbursements"))
assert.ok(!markup.includes("$0") && !markup.includes("Legacy reimbursement overview"))
assert.ok(!markup.includes("currently owes") && !markup.includes("currently owe"), "Loading is not a confirmed zero-debt state")
for (const [amount, expected] of [["0.29", 29], [" 10.5 ", 1050], ["0", 0]]) assert.equal(reimbursementAmountCents(amount), expected)
for (const amount of ["-1", "1.001", "1e3", "Infinity", "1,000", "$10", ""]) assert.equal(reimbursementAmountCents(amount), null)
const clone = value => JSON.parse(JSON.stringify(value))
const allocation = changes => ({ id: "a", payerOwner: "brian", partnerOwner: "hannah", payerPerson: "Brian (BofA)",
  item: "PG&E", location: "", expenseDate: "2026-09-03", category: "need", grossCents: 20000, payerShareCents: 10000,
  partnerShareCents: 10000, settledCents: 2000, outstandingCents: 8000, method: "equal", version: 3,
  projectedVersion: 3, accounting: "cash_v1", status: "outstanding", ...changes })
const receipt = changes => ({ id: "receipt-a", operationId: "opaque-receipt-operation", allocationId: "a", kind: "receive", actorOwner: "brian", payeeOwner: "brian", debtorOwner: "hannah",
  amountCents: 2000, date: "2026-09-04", note: "First payment", status: "confirmed", createdAt: "2026-09-04T12:00:00Z", confirmedAt: "2026-09-04T12:00:00Z", confirmedBy: "brian", reversedAt: "", reversedBy: "", ...changes })
const sample = { enabled: true, ownerKey: "brian", currency: "USD", allocations: [
  allocation(),
  allocation({ id: "b", item: "August groceries", expenseDate: "2026-08-09", grossCents: 5000, payerShareCents: 2500, partnerShareCents: 2500, settledCents: 0, outstandingCents: 2500, version: 1, projectedVersion: 1 }),
  allocation({ id: "c", item: "Hannah groceries", payerOwner: "hannah", partnerOwner: "brian", payerPerson: "Hannah", grossCents: 12000, payerShareCents: 6000, partnerShareCents: 6000, settledCents: 0, outstandingCents: 6000, version: 1, projectedVersion: 1 }),
  allocation({ id: "old", item: "Historical rent", accounting: "legacy_net", grossCents: 10000, payerShareCents: 8000, partnerShareCents: 2000, settledCents: 2000, outstandingCents: 0, status: "settled" }),
], events: [receipt()], resets: [], resetState: "review-state-one" }
assert.deepEqual(clone(ledgerTotals(sample.allocations, "brian")), { to: 10500, from: 6000, net: 4500 })
assert.deepEqual(clone(ledgerTotals(sample.allocations, "hannah")), { to: 6000, from: 10500, net: -4500 })
assert.deepEqual(clone(defaultOffsetEntries(sample.allocations, "brian")), [
  { allocationId: "b", version: 1, amountCents: 2500 }, { allocationId: "a", version: 3, amountCents: 3500 }, { allocationId: "c", version: 1, amountCents: 6000 },
], "Offset uses oldest eligible balances first and equal totals in both directions")
assert.deepEqual(clone(defaultOffsetEntries(sample.allocations, "brian", [receipt({ status: "pending" })])), [
  { allocationId: "b", version: 1, amountCents: 2500 }, { allocationId: "c", version: 1, amountCents: 2500 },
], "Pending allocations are excluded, while other matching balances remain available")
assert.equal(canReverseLedgerEvent(receipt(), "brian", sample.allocations, sample.events), true)
assert.equal(canReverseLedgerEvent(receipt(), "hannah", sample.allocations, sample.events), false)
assert.equal(canReverseLedgerEvent(receipt(), "brian", sample.allocations, [receipt(), receipt({ id: "legacy-entry", allocationId: "old" })]), false, "A mixed legacy offset group cannot be reversed through a writable sibling")
assert.equal(canReverseLedgerEvent(receipt(), "brian", [allocation({ clearedCents:8000,outstandingCents:0 })], sample.events), false, "Undo reset before reversing a receipt for a cleared expense")
assert.equal(canReverseLedgerEvent(receipt(), "brian", [allocation(), allocation({id:"sibling",clearedCents:8000,outstandingCents:0})], [receipt(),receipt({id:"offset-sibling",allocationId:"sibling"})]), false, "An entire offset reversal is blocked when one member has a reset")

const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve() }
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const visible = node => {
  for (let parent = node; parent; parent = parent.parent) if ([true, "true"].includes(parent.props["aria-hidden"]) || parent.props.inert === true || parent.props.inert === "") return false
  return true
}
const text = node => typeof node === "string" || typeof node === "number" ? String(node) : visible(node) ? node.children.map(text).join("") : ""
const rawText = node => typeof node === "string" || typeof node === "number" ? String(node) : node.children.map(rawText).join("")
const buttons = scope => scope.findAllByType("button").filter(visible)
const button = (scope, label, prefix = false) => buttons(scope).find(node => node.props["aria-label"] === label || (prefix ? text(node).startsWith(label) : text(node) === label))
const hasClass = (node, name) => typeof node.type === "string" && node.props.className?.split(" ").includes(name)
const row = (tree, name) => tree.root.findAll(node => hasClass(node, "bb-reimbursement-entry")).filter(visible).find(node => text(buttons(node)[0]).startsWith(name))
const rowToggle = row => buttons(row).find(node => hasClass(node, "bb-reimbursement-toggle"))
const form = tree => tree.root.findAllByType("form").find(visible)
async function tap(node) {
  assert.ok(node, "Expected visible button")
  assert.ok(!node.props.disabled, `Expected enabled button: ${text(node)}`)
  await act(async () => { node.props.onClick(); await flush() })
}
async function fill(tree, label, value) {
  const target = form(tree).findAllByType("label").find(node => text(node).startsWith(label)).findByType("input")
  await act(async () => { target.props.onChange({ target: { value } }); await flush() })
}
async function submit(tree) { await act(async () => { form(tree).props.onSubmit({ preventDefault() {} }); await flush() }) }
async function expand(tree, name) {
  const list = button(tree.root, "View ", true)
  if (!list.props["aria-expanded"]) await tap(list)
  const target = rowToggle(row(tree, name))
  if (!target.props["aria-expanded"]) await tap(target)
}
function fixture({ get, post } = {}) {
  timers.clear(); dispatched.length = 0
  for (const scope of Object.values(listeners)) scope.clear()
  const state = { snapshot: clone(sample), calls: [] }
  fetchRequest = async (url, options) => {
    assert.equal(url, "/app/reimbursements")
    for (const [key, value] of Object.entries({ credentials: "same-origin", mode: "same-origin", referrerPolicy: "same-origin", cache: "no-store", redirect: "error" })) assert.equal(options[key], value)
    const body = options.body ? JSON.parse(options.body) : undefined
    state.calls.push({ body, options })
    if (!body) return get ? get(state) : response(clone(state.snapshot))
    assert.equal(options.headers["X-BookieBot-App"], "1")
    assert.ok(body.requestId)
    return post ? post(body, state) : response(clone(state.snapshot))
  }
  return state
}
const writes = state => state.calls.filter(call => call.body)
async function mount() { let tree; await act(async () => { tree = Renderer.create(React.createElement(ReimbursementLedger, { fallback, refreshKey: "one" })); await flush() }); return tree }
async function unmount(tree) {
  await act(async () => { tree.unmount(); await flush() })
  assert.ok([...listeners.window.values(), ...listeners.document.values()].every(set => !set.size), "Unmount cleans up refresh listeners")
}

async function monthPaginationContracts() {
  const state = fixture()
  state.snapshot.events = []
  state.snapshot.allocations = [
    ...Array.from({ length: 12 }, (_, index) => allocation({ id: `sept-${index + 1}`, item: `September expense ${index + 1}`, expenseDate: `2026-09-${String(index + 1).padStart(2, "0")}` })),
    ...Array.from({ length: 11 }, (_, index) => allocation({ id: `past-${index}`, item: `Older expense ${index}`, expenseDate: new Date(Date.UTC(2026, 7 - index, 4)).toISOString().slice(0, 10) })),
    allocation({ id: "undated", item: "Undated expense", expenseDate: "" }),
  ]
  const tree = await mount()
  await tap(button(tree.root, "View 24 expenses"))
  const monthGroups = () => tree.root.findAll(node => hasClass(node, "bb-reimbursement-group")).filter(visible)
  const monthToggle = group => group.find(node => hasClass(node, "bb-reimbursement-month-toggle"))
  const displayed = group => group.findAll(node => hasClass(node, "bb-reimbursement-entry")).filter(visible)
  assert.deepEqual(monthGroups().map(group => group.props["aria-label"]), ["September 2026", "August 2026", "July 2026", "June 2026", "May 2026"])
  assert.deepEqual(monthGroups().map(group => monthToggle(group).props["aria-expanded"]), [true, false, false, false, false], "Only the actual Pacific current month starts expanded, even when UTC has rolled over")
  let september = monthGroups()[0]
  assert.deepEqual(displayed(september).map(entry => text(rowToggle(entry)).match(/September expense \d+/)[0]), [12, 11, 10, 9, 8].map(number => `September expense ${number}`))
  assert.equal(tree.root.findAll(node => hasClass(node, "bb-reimbursement-entry")).length, 5, "Collapsed months do not mount their expense histories")
  assert.ok(text(tree.root).includes("Owed to you$1,920.00"), "Pagination never limits the complete balance")
  await tap(button(september, "Load more expenses"))
  assert.equal(displayed(september).length, 10)
  await tap(button(september, "Load more expenses"))
  assert.equal(displayed(september).length, 12)
  assert.equal(button(september, "Load more expenses"), undefined)
  await tap(rowToggle(displayed(september)[0]))
  await tap(button(september, "Record received"))
  await fill(tree, "Amount", "12.34")
  await tap(monthToggle(september))
  assert.equal(displayed(september).length, 0)
  assert.equal(form(tree), undefined, "Collapsed month controls are inaccessible")
  await tap(monthToggle(september))
  assert.equal(displayed(september).length, 12, "Reopening keeps previously loaded expenses")
  assert.equal(form(tree).findAllByType("input")[0].props.value, "12.34", "Month collapse retains payment drafts")
  await tap(button(tree.root, "Load more months"))
  assert.equal(monthGroups().length, 10)
  assert.ok(monthGroups().slice(5).every(group => !monthToggle(group).props["aria-expanded"]))
  await tap(button(tree.root, "Load more months"))
  assert.equal(monthGroups().length, 13)
  assert.equal(button(tree.root, "Load more months"), undefined)
  assert.equal(monthGroups().at(-1).props["aria-label"], "Undated")
  const august = monthGroups()[1]
  await tap(monthToggle(august))
  assert.equal(displayed(august).length, 1)
  assert.equal(button(august, "Load more expenses"), undefined)
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.equal(monthGroups().length, 13, "Refreshing data preserves loaded month pages")
  assert.equal(displayed(september).length, 12)
  assert.equal(monthToggle(august).props["aria-expanded"], true)
  await tap(button(tree.root, "You owe", true))
  await tap(button(tree.root, "Owed to you", true))
  assert.equal(monthGroups().length, 13, "Switching directions preserves each direction's pagination")
  assert.equal(displayed(september).length, 12)
  assert.equal(form(tree).findAllByType("input")[0].props.value, "12.34", "Switching directions preserves loaded month and payment draft state")
  assert.equal(writes(state).length, 0, "Disclosures and pagination never write financial data")
  await unmount(tree)
}

async function refreshedPageRetentionContracts() {
  const state = fixture()
  state.snapshot.events = []
  state.snapshot.allocations = [
    ...Array.from({ length: 12 }, (_, index) => allocation({ id: `sept-${index + 1}`, item: `September expense ${index + 1}`, expenseDate: `2026-09-${String(index + 1).padStart(2, "0")}` })),
    ...Array.from({ length: 6 }, (_, index) => allocation({ id: `past-${index}`, item: `Older expense ${index}`, expenseDate: `2026-${String(8 - index).padStart(2, "0")}-04` })),
  ]
  const tree = await mount()
  await expand(tree, "September expense 8")
  await tap(button(tree.root, "Record received")); await fill(tree, "Amount", "12.34")
  const refresh = async () => act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  state.snapshot.allocations.push(allocation({ id: "new-row", item: "Newest expense", expenseDate: "2026-09-30" }))
  state.snapshot.allocations.push(...Array.from({ length: 5 }, (_, index) => allocation({ id: `new-august-${index}`, item: `New August expense ${index}`, expenseDate: `2026-08-${15 + index}` })))
  await refresh()
  assert.equal(form(tree).findAllByType("input")[0].props.value, "12.34", "A newly arriving expense cannot evict the fifth visible row and its draft")
  const september = tree.root.find(node => hasClass(node, "bb-reimbursement-group") && node.props["aria-label"] === "September 2026")
  assert.equal(september.findAll(node => hasClass(node, "bb-reimbursement-entry")).length, 6)
  await tap(button(september, "Load more expenses"))
  assert.equal(september.findAll(node => hasClass(node, "bb-reimbursement-entry")).length, 11, "Load more still appends five after a retained cutoff expands")
  await tap(button(tree.root, "September 2026", true))
  await tap(button(tree.root, "August 2026"))
  const august = tree.root.find(node => hasClass(node, "bb-reimbursement-group") && node.props["aria-label"] === "August 2026")
  assert.equal(august.findAll(node => hasClass(node, "bb-reimbursement-entry")).length, 5, "First opening an untouched historical month still shows only five after background updates")
  await tap(button(tree.root, "August 2026"))
  await tap(button(tree.root, "May 2026")); await expand(tree, "Older expense 3")
  await tap(button(tree.root, "Record received")); await fill(tree, "Amount", "23.45")
  state.snapshot.allocations.push(allocation({ id: "new-month", item: "Newer month expense", expenseDate: "2026-10-01" }))
  await refresh()
  assert.equal(form(tree).findAllByType("input")[0].props.value, "23.45", "A newer month cannot unmount the fifth visible month and its draft")
  assert.equal(tree.root.findAll(node => hasClass(node, "bb-reimbursement-group")).filter(visible).length, 6)
  assert.equal(button(tree.root, "October 2026").props["aria-expanded"], false, "New noncurrent months stay collapsed")
  assert.equal(writes(state).length, 0)
  await unmount(tree)
}

async function unseenMonthPageContracts() {
  const state = fixture()
  state.snapshot.events = []
  state.snapshot.allocations = ["brian", "hannah"].flatMap((payer, side) => Array.from({ length: 6 }, (_, index) => allocation({
    id: `${payer}-${index}`, item: `${payer} historical expense ${index}`, payerOwner: payer, partnerOwner: side ? "brian" : "hannah",
    expenseDate: `2026-${String(8 - index).padStart(2, "0")}-04`,
  })))
  const tree = await mount()
  const refresh = async () => act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  state.snapshot.allocations.push(...["brian", "hannah"].map((payer, side) => allocation({ id: `${payer}-new-month`, payerOwner: payer, partnerOwner: side ? "brian" : "hannah", expenseDate: "2026-09-30" })))
  await refresh()
  await tap(button(tree.root, "View 7 expenses"))
  const shownMonths = () => tree.root.findAll(node => hasClass(node, "bb-reimbursement-group")).filter(visible)
  assert.equal(shownMonths().length, 5, "First opening history stays at five months after a refresh inserted a newer month")
  await tap(button(tree.root, "You owe", true))
  assert.equal(shownMonths().length, 5, "The untouched direction also starts with five months")
  await tap(button(tree.root, "Load more months"))
  await tap(button(tree.root, "Owed to you", true))
  state.snapshot.allocations.push(allocation({ id: "hannah-newest-month", payerOwner: "hannah", partnerOwner: "brian", expenseDate: "2026-10-01" }))
  await refresh()
  await tap(button(tree.root, "You owe", true))
  assert.equal(shownMonths().length, 8, "Previously revealed months remain retained while their direction is hidden")
  await unmount(tree)

  const currentState = fixture()
  currentState.snapshot.events = []
  currentState.snapshot.allocations = Array.from({ length: 12 }, (_, index) => allocation({ id: `current-${index}`, item: `Current ${index}`, expenseDate: `2026-09-${String(index + 1).padStart(2, "0")}` }))
  const currentTree = await mount()
  currentState.snapshot.allocations.push(allocation({ id: "new-current", item: "New current expense", expenseDate: "2026-09-30" }))
  await refresh()
  await tap(button(currentTree.root, "View 13 expenses"))
  assert.equal(currentTree.root.findAll(node => hasClass(node, "bb-reimbursement-entry")).filter(visible).length, 5, "First revealing the default-expanded current month still starts with five after a hidden refresh")
  assert.ok(row(currentTree, "New current expense"))
  await unmount(currentTree)
}

async function compactAndSentContracts() {
  const state = fixture({ post: (body, state) => {
    assert.equal(body.operation, "report_payment")
    state.snapshot.events.push(receipt({ id: "sent-c", allocationId: "c", kind: "report_payment", actorOwner: "brian", payeeOwner: "hannah", debtorOwner: "brian", amountCents: body.amountCents, date: body.date, note: body.note, status: "pending" }))
    return response(clone(state.snapshot))
  } })
  const tree = await mount()
  assert.ok(text(tree.root).includes("Owed to you$105.00") && text(tree.root).includes("You owe$60.00") && text(tree.root).includes("Net owed to you$45.00"))
  assert.equal(writes(state).length, 0)
  await expand(tree, "PG&E")
  assert.ok(rawText(row(tree, "PG&E")).includes("Brian (BofA) paid · $200.00"))
  const bar = row(tree, "PG&E").find(node => node.props.role === "img")
  assert.ok(bar.props["aria-label"].includes("$100.00") && bar.props["aria-label"].includes("$20.00 settled") && bar.props["aria-label"].includes("$80.00 still owed"))
  await tap(rowToggle(row(tree, "Historical rent")))
  assert.equal(rowToggle(row(tree, "PG&E")).props["aria-expanded"], false)
  assert.ok(text(row(tree, "Historical rent")).includes("Historical split · read only"))
  assert.equal(button(row(tree, "Historical rent"), "Record received"), undefined)
  await tap(button(tree.root, "August 2026"))
  await tap(rowToggle(row(tree, "August groceries")))
  assert.equal(rowToggle(row(tree, "Historical rent")).props["aria-expanded"], true, "Different expense months retain independent expansion")
  await tap(button(tree.root, "You owe", true))
  await expand(tree, "Hannah groceries")
  await tap(button(tree.root, "Record sent payment"))
  await fill(tree, "Amount", "10.25"); await fill(tree, "Date", "2026-09-08"); await fill(tree, "Note", "Transfer already sent")
  await submit(tree)
  assert.deepEqual({ ...writes(state)[0].body, requestId: undefined }, { operation: "report_payment", allocationId: "c", version: 1, amountCents: 1025, date: "2026-09-08", note: "Transfer already sent", requestId: undefined })
  assert.ok(text(tree.root).includes("You owe$60.00"), "Reporting a sent payment does not reduce debt before recipient confirmation")
  assert.ok(text(tree.root).includes("awaiting confirmation"))
  assert.deepEqual(dispatched, ["bookiebot:reimbursements-changed"])
  await unmount(tree)
}

async function emptyDirectionsAndMarkerContracts() {
  let state = fixture({ post: (body, state) => {
    assert.equal(body.operation, "confirm_payment")
    state.snapshot.events.find(event => event.id === body.eventId).status = "confirmed"
    const item = state.snapshot.allocations.find(item => item.id === body.allocationId)
    item.settledCents += 1000; item.outstandingCents -= 1000; item.version++
    return response(clone(state.snapshot))
  } })
  state.snapshot.allocations = state.snapshot.allocations.filter(item => item.payerOwner === "brian")
  state.snapshot.events.push(receipt({ id: "pending-a", kind: "report_payment", actorOwner: "hannah", amountCents: 1000, status: "pending" }))
  state.snapshot.projectionPending = true
  state.snapshot.error = "The worksheet view needs another sync."
  let tree = await mount()
  const list = button(tree.root, "View ", true)
  const marker = list.find(node => hasClass(node, "bb-disclosure-mark"))
  assert.equal(marker.props["aria-hidden"], "true")
  assert.deepEqual(marker.children, [], "The disclosure mark is made of CSS strokes rather than swapping text glyphs")
  for (const expanded of [true, false, true, false]) {
    await tap(list)
    assert.equal(list.props["aria-expanded"], expanded)
    assert.equal(list.find(node => hasClass(node, "bb-disclosure-mark")), marker, "Rapid toggles preserve the same animating stroke element")
    assert.equal(tree.root.find(node => typeof node.type === "string" && node.props.id === list.props["aria-controls"]).props["aria-hidden"], !expanded)
  }
  await tap(button(tree.root, "You owe", true))
  assert.ok(text(tree.root).includes("You don’t currently owe any money."))
  assert.equal(tree.root.findAll(node => hasClass(node, "bb-ledger-net")).length, 0, "An empty direction does not show the opposite direction's net balance")
  assert.equal(button(tree.root, "View ", true), undefined, "No records means no empty expandable list")
  assert.ok(text(tree.root).includes("Recorded. Expense sheets are still syncing."))
  assert.ok(text(tree.root).includes("The worksheet view needs another sync."))
  assert.ok(text(tree.root).includes("Awaiting your confirmation"), "Necessary incoming payment review remains available from an empty direction")
  await tap(button(tree.root, "Review")); await tap(button(tree.root, "Confirm received"))
  assert.equal(writes(state).length, 1)
  assert.ok(!text(tree.root).includes("Awaiting your confirmation"))
  assert.ok(text(tree.root).includes("You don’t currently owe any money."))
  await tap(button(tree.root, "Owed to you", true))
  assert.ok(button(tree.root, "View 3 expenses"))
  assert.ok(text(tree.root).includes("Net owed to you$95.00"))
  await expand(tree, "PG&E")
  assert.ok(text(tree.root).includes("Payment recorded; budget and reimbursement sheets still need to update."), "A recorded payment cannot appear fully synced while its sheet projection is pending")
  await unmount(tree)

  state = fixture()
  state.snapshot.allocations = [clone(sample.allocations[2])]
  state.snapshot.events = []
  tree = await mount()
  assert.ok(text(tree.root).includes("No one currently owes you money."))
  assert.equal(button(tree.root, "View ", true), undefined)
  assert.equal(tree.root.findAll(node => hasClass(node, "bb-ledger-net")).length, 0)
  await tap(button(tree.root, "You owe", true)); await expand(tree, "Hannah groceries")
  assert.ok(button(tree.root, "Record sent payment"), "The populated direction keeps its legitimate actions")
  state.snapshot.allocations[0].settledCents = 6000; state.snapshot.allocations[0].outstandingCents = 0
  state.snapshot.allocations[0].status = "settled"; state.snapshot.allocations[0].version++
  state.snapshot.events = [receipt({ allocationId: "c", payeeOwner: "hannah", debtorOwner: "brian", actorOwner: "hannah", amountCents: 6000 })]
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.ok(text(tree.root).includes("You don’t currently owe any money."))
  assert.equal(tree.root.findAll(node => hasClass(node, "bb-ledger-net")).length, 0)
  assert.ok(button(tree.root, "View 1 expense"), "A paid record remains accessible after its outstanding balance reaches zero")
  await tap(button(tree.root, "History (1)"))
  assert.ok(text(tree.root).includes("$60.00"))
  assert.equal(button(tree.root, "Record sent payment"), undefined)
  await unmount(tree)

  state = fixture({ post: () => { throw Error("Response lost") } })
  state.snapshot.allocations = state.snapshot.allocations.filter(item => item.payerOwner === "brian")
  tree = await mount(); await expand(tree, "PG&E"); await tap(button(tree.root, "Record received")); await fill(tree, "Amount", "1.00"); await submit(tree)
  await tap(button(tree.root, "You owe", true))
  assert.ok(text(tree.root).includes("You don’t currently owe any money."))
  assert.ok(text(tree.root).includes("This record may have saved."))
  assert.ok(button(tree.root, "Retry this record"), "Changing to an empty direction does not discard uncertain-write recovery")
  assert.equal(writes(state).length, 1)
  await unmount(tree)
}

async function receiptAndReversalContracts() {
  const state = fixture({ post: (body, state) => {
    const item = state.snapshot.allocations[0]
    if (body.operation === "receive") {
      item.settledCents = 3055; item.outstandingCents = 6945; item.version = 4
      state.snapshot.events.push(receipt({ id: "receipt-new", operationId: "new-operation", amountCents: 1055, createdAt: "2026-09-08T12:00:00Z", note: "Partial receipt" }))
    } else {
      assert.equal(body.operation, "reverse"); assert.equal(body.eventId, "receipt-new")
      item.settledCents = 2000; item.outstandingCents = 8000; item.version = 5
      state.snapshot.events[1].status = "reversed"
    }
    return response(clone(state.snapshot))
  } })
  const tree = await mount(); await expand(tree, "PG&E")
  await tap(button(tree.root, "Record received"))
  await fill(tree, "Amount", "80.001"); await submit(tree)
  assert.equal(writes(state).length, 0, "Fractional cents never submit")
  await fill(tree, "Amount", "80.01"); await submit(tree)
  assert.equal(writes(state).length, 0, "A receipt cannot exceed the outstanding amount")
  await fill(tree, "Amount", "10.55"); await fill(tree, "Date", "2026-09-08"); await fill(tree, "Note", "Partial receipt"); await submit(tree)
  assert.equal(writes(state)[0].body.amountCents, 1055); assert.equal(writes(state)[0].body.version, 3)
  assert.ok(text(tree.root).includes("Owed to you$94.45"))
  await tap(button(tree.root, "History (2)")); await tap(button(tree.root, "Reverse"))
  assert.equal(writes(state).length, 1, "Reverse first shows a review, not an immediate write")
  const confirm = button(tree.root, "Confirm reversal")
  assert.ok(confirm); await tap(confirm)
  assert.equal(writes(state).length, 2); assert.ok(text(tree.root).includes("Owed to you$105.00"))
  assert.ok(text(tree.root).includes("Reversed"))
  await unmount(tree)
}

async function confirmationAndOffsetContracts() {
  let state = fixture({ post: (body, state) => {
    assert.equal(body.operation, "confirm_payment"); assert.equal(body.version, 3); assert.equal(body.eventId, "pending-a")
    state.snapshot.allocations[0].settledCents = 3000; state.snapshot.allocations[0].outstandingCents = 7000; state.snapshot.allocations[0].version = 4
    state.snapshot.events[1].status = "confirmed"
    return response(clone(state.snapshot))
  } })
  state.snapshot.events.push(receipt({ id: "pending-a", kind: "report_payment", actorOwner: "hannah", amountCents: 1000, status: "pending" }))
  let tree = await mount()
  assert.ok(text(tree.root).includes("Awaiting your confirmation"))
  await tap(button(tree.root, "Review")); assert.equal(writes(state).length, 0)
  await tap(button(tree.root, "Confirm received")); assert.equal(writes(state).length, 1)
  assert.ok(!text(tree.root).includes("Awaiting your confirmation"))
  await unmount(tree)

  state = fixture({ post: (body, state) => {
    assert.equal(body.operation, "offset")
    for (const entry of body.entries) { const item = state.snapshot.allocations.find(item => item.id === entry.allocationId); item.settledCents += entry.amountCents; item.outstandingCents -= entry.amountCents; item.version++ }
    state.snapshot.projectionPending = true
    return response(clone(state.snapshot))
  } })
  tree = await mount(); await tap(button(tree.root, "Offset balances"))
  assert.ok(text(form(tree)).includes("No money is transferred"))
  assert.match(text(form(tree)), /Owed to you\s*\$60\.00/)
  assert.match(text(form(tree)), /You owe\s*\$60\.00/)
  const offsetInput = form(tree).findAllByType("input").find(node => node.props["aria-label"]?.startsWith("Offset PG&E"))
  await act(async () => { offsetInput.props.onChange({ target: { value: "34.99" } }); await flush() })
  await submit(tree); assert.equal(writes(state).length, 0, "Unbalanced offsets are rejected before posting")
  await act(async () => { offsetInput.props.onChange({ target: { value: "35.00" } }); await flush() })
  await fill(tree, "Date", "2026-09-08"); await submit(tree)
  const body = writes(state)[0].body
  assert.deepEqual(body.entries.sort((a, b) => a.allocationId.localeCompare(b.allocationId)), [
    { allocationId: "a", version: 3, amountCents: 3500 }, { allocationId: "b", version: 1, amountCents: 2500 }, { allocationId: "c", version: 1, amountCents: 6000 },
  ])
  assert.equal(body.date, "2026-09-08")
  assert.ok(text(tree.root).includes("Net owed to you$45.00"), "An equal-sided offset preserves the net balance")
  assert.ok(text(tree.root).includes("Recorded. Expense sheets are still syncing."))
  state.snapshot.projectionPending = false
  await tap(button(tree.root, "Refresh"))
  assert.equal(writes(state).length, 1, "Refreshing projection state does not repeat the saved offset")
  await unmount(tree)
}

async function pendingAndDateContracts() {
  let state = fixture()
  state.snapshot.events.push(receipt({ id: "pending-a", kind: "report_payment", status: "pending" }))
  let tree = await mount(); await expand(tree, "PG&E")
  assert.equal(button(tree.root, "Record received").props.disabled, true)
  assert.ok(text(tree.root).includes("Review the pending payment above"))
  assert.ok(text(tree.root).includes("Confirm pending payments before offsetting those expenses."))
  await tap(button(tree.root, "Offset balances"))
  assert.ok(!form(tree).findAllByType("input").some(node => node.props["aria-label"]?.startsWith("Offset PG&E")))
  assert.match(text(form(tree)), /Owed to you\s*\$25\.00/)
  assert.match(text(form(tree)), /You owe\s*\$25\.00/)
  await unmount(tree)

  state = fixture(); tree = await mount(); await expand(tree, "PG&E")
  await tap(button(tree.root, "Record received"))
  assert.equal(form(tree).findAllByType("input").find(node => node.props.type === "date").props.min, "2026-09-03")
  await fill(tree, "Date", "2026-09-02"); await submit(tree)
  assert.equal(writes(state).length, 0, "Receipts cannot predate their expense, even without browser validation")
  await fill(tree, "Date", "2026-09-08")
  state.snapshot.events.push(receipt({ id: "late-pending", kind: "report_payment", status: "pending" }))
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.equal(form(tree).findByType("fieldset").props.disabled, true, "An already-open receipt editor disables when a pending payment arrives")
  await submit(tree); assert.equal(writes(state).length, 0)
  await unmount(tree)

  state = fixture(); tree = await mount(); await tap(button(tree.root, "Offset balances"))
  const dateInput = () => form(tree).findAllByType("input").find(node => node.props.type === "date")
  assert.equal(dateInput().props.min, "2026-09-03")
  await fill(tree, "Date", "2026-09-02"); await submit(tree)
  assert.equal(writes(state).length, 0, "Offsets cannot predate any selected expense")
  await fill(tree, "Date", "2026-09-08")
  state.snapshot.events.push(receipt({ id: "late-pending-b", allocationId: "b", kind: "report_payment", status: "pending" }))
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.ok(!form(tree).findAllByType("input").some(node => node.props["aria-label"]?.startsWith("Offset August groceries")))
  await submit(tree); assert.equal(writes(state).length, 0, "Late pending entries are removed and unbalanced selections cannot submit")
  const amount = form(tree).findAllByType("input").find(node => node.props["aria-label"]?.startsWith("Offset PG&E"))
  await act(async () => { amount.props.onChange({ target: { value: "60.00" } }); await flush() })
  await submit(tree)
  assert.deepEqual(writes(state)[0].body.entries.map(entry => entry.allocationId).sort(), ["a", "c"], "The remaining balances can still offset without the pending expense")
  await unmount(tree)

  state = fixture(); state.snapshot.allocations[2].expenseDate = "2026-08-01"
  tree = await mount(); await tap(button(tree.root, "Offset balances"))
  const selectAmount = async (prefix, value) => {
    const input = form(tree).findAllByType("input").find(node => node.props["aria-label"]?.startsWith(prefix))
    await act(async () => { input.props.onChange({ target: { value } }); await flush() })
  }
  assert.equal(dateInput().props.min, "2026-09-03")
  await selectAmount("Offset PG&E", "0"); await selectAmount("Offset Hannah groceries", "25.00")
  assert.equal(dateInput().props.min, "2026-08-09", "Clearing a later expense moves the minimum to the latest remaining selection")
  await fill(tree, "Date", "2026-08-08"); await submit(tree); assert.equal(writes(state).length, 0)
  await fill(tree, "Date", "2026-08-09"); await submit(tree); assert.equal(writes(state).length, 1)
  await unmount(tree)

  state = fixture()
  state.snapshot.allocations = [allocation({ outstandingCents: 6000, settledCents: 4000 }), clone(sample.allocations[2])]
  tree = await mount()
  assert.ok(text(tree.root).includes("Net balance$0.00"))
  assert.ok(!text(tree.root).includes("Even after offset"), "Equal debts do not imply that an offset already happened")
  await unmount(tree)
}

async function recoveryContracts() {
  let committed = false
  let state = fixture({
    get: state => committed ? response({ error: "Read unavailable" }, 503) : response(clone(state.snapshot)),
    post: (_body, state) => {
      committed = true
      state.snapshot.allocations[0].settledCents += 101; state.snapshot.allocations[0].outstandingCents -= 101
      state.snapshot.allocations[0].version++; state.snapshot.projectionPending = true
      return response(clone(state.snapshot))
    },
  })
  let tree = await mount(); await expand(tree, "PG&E"); await tap(button(tree.root, "Record received")); await fill(tree, "Amount", "1.01"); await submit(tree)
  assert.ok(text(tree.root).includes("Owed to you$103.99"), "A confirmed POST snapshot remains visible if the follow-up GET fails")
  assert.ok(text(tree.root).includes("Recorded. Expense sheets are still syncing."))
  assert.equal(button(tree.root, "Retry this record"), undefined, "A confirmed command does not become uncertain because its follow-up read fails")
  assert.equal(writes(state).length, 1)
  await unmount(tree)

  let attempt = 0
  state = fixture({ post: (_body, state) => { if (++attempt === 1) throw Error("Response lost"); return response(clone(state.snapshot)) } })
  tree = await mount(); await expand(tree, "PG&E"); await tap(button(tree.root, "Record received")); await fill(tree, "Amount", "1.01"); await submit(tree)
  assert.ok(button(tree.root, "Retry this record")); assert.ok(form(tree).findByType("fieldset").props.disabled)
  const callsBeforeFocus = state.calls.length
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.equal(state.calls.length, callsBeforeFocus, "A background GET cannot resolve an unknown write outcome")
  await tap(button(tree.root, "Retry this record"))
  assert.deepEqual(writes(state)[0].body, writes(state)[1].body, "Retry uses the exact body, version, and requestId")
  assert.deepEqual(dispatched, ["bookiebot:reimbursements-changed"])
  await unmount(tree)

  state = fixture({ post: (_body, state) => {
    state.snapshot.allocations[0].version = 4
    state.snapshot.allocations[0].settledCents = 2500; state.snapshot.allocations[0].outstandingCents = 7500
    return response({ error: "This balance changed. Review it again." }, 409)
  } })
  tree = await mount(); await expand(tree, "PG&E"); await tap(button(tree.root, "Record received")); await submit(tree)
  assert.equal(form(tree), undefined); assert.ok(text(tree.root).includes("Owed to you$100.00")); assert.equal(button(tree.root, "Retry this record"), undefined)
  assert.equal(dispatched.length, 0)
  await unmount(tree)

  state = fixture({ get: () => response({ enabled: false }) }); tree = await mount()
  assert.equal(text(tree.root), "Legacy reimbursement overview"); await unmount(tree)
  for (const status of [401, 403]) {
    state = fixture({ get: () => response({ error: "Access unavailable" }, status) }); tree = await mount()
    assert.ok(text(tree.root).includes("Access unavailable")); assert.ok(!text(tree.root).includes("$0") && !text(tree.root).includes("Legacy reimbursement overview"))
    await unmount(tree)
  }
}

async function inFlightContracts() {
  const pendingRead = deferred()
  let state = fixture({ get: () => pendingRead.promise })
  let tree = await mount(); const readSignal = state.calls[0].options.signal
  await unmount(tree); assert.equal(readSignal.aborted, true)
  await act(async () => { pendingRead.resolve(response(sample)); await flush() }); assert.equal(dispatched.length, 0)

  const pendingWrite = deferred()
  state = fixture({ post: () => pendingWrite.promise }); tree = await mount(); await expand(tree, "PG&E"); await tap(button(tree.root, "Record received"))
  await submit(tree); await submit(tree)
  assert.equal(writes(state).length, 1, "Duplicate submissions cannot enqueue a second mutation")
  const signal = writes(state)[0].options.signal
  await unmount(tree); assert.equal(signal.aborted, true)
  await act(async () => { pendingWrite.resolve(response({})); await flush() }); assert.equal(dispatched.length, 0)

  const hangingWrite = deferred()
  state = fixture({ post: () => hangingWrite.promise }); tree = await mount(); await expand(tree, "PG&E"); await tap(button(tree.root, "Record received")); await submit(tree)
  await act(async () => { for (const { callback, delay } of [...timers.values()]) if (delay === 20000) callback(); await flush() })
  assert.ok(button(tree.root, "Retry this record")); assert.ok(!button(tree.root, "Retry this record").props.disabled, "A hung request releases busy state while retaining its idempotency key")
  await unmount(tree)
}

function applyReset(body, state) {
  let reset
  if (body.operation === "reset") {
    assert.equal(body.expectedState, state.snapshot.resetState)
    reset = { id: "reset-one", version: 1, status: "active", actorOwner: state.snapshot.ownerKey,
      createdAt: "2026-09-30T18:00:00Z", updatedAt: "2026-09-30T18:00:00Z", note: body.note, canUndo: true, canRedo: false,
      entries: state.snapshot.allocations.filter(item => item.outstandingCents > 0).map(item => ({ allocationId: item.id,
        amountCents: item.outstandingCents, payerOwner: item.payerOwner, partnerOwner: item.partnerOwner })) }
    state.snapshot.resets.push(reset)
  } else {
    reset = state.snapshot.resets.find(item => item.id === body.resetId)
    assert.equal(body.version, reset.version)
    reset.version++
    reset.status = body.operation === "undo_reset" ? "undone" : "active"
    reset.canUndo = reset.status === "active"; reset.canRedo = !reset.canUndo
  }
  for (const entry of reset.entries) {
    const item = state.snapshot.allocations.find(item => item.id === entry.allocationId)
    const change = body.operation === "undo_reset" ? -entry.amountCents : entry.amountCents
    item.clearedCents = (item.clearedCents || 0) + change; item.outstandingCents -= change
    item.status = item.outstandingCents ? "outstanding" : "cleared"; item.version++; item.projectedVersion = item.version
  }
  state.snapshot.resetState += "-changed"
  return response(clone(state.snapshot))
}

async function resetLifecycleContracts() {
  const state = fixture({ post: applyReset })
  const tree = await mount()
  await tap(button(tree.root, "Reset balances"))
  assert.equal(writes(state).length, 0, "Reset opens an explicit review before writing")
  assert.ok(text(form(tree)).includes("Owed to you $105.00"))
  assert.ok(text(form(tree)).includes("You owe $60.00"))
  assert.ok(text(form(tree)).includes("3 shared expenses across all months"))
  assert.ok(text(form(tree)).includes("Both directions will be $0.00"))
  assert.ok(text(form(tree)).includes("Recorded expenses and receipts stay unchanged"))
  assert.ok(text(form(tree)).includes("No payment or transfer is recorded"))
  await fill(tree, "Note", "Settled separately with Hannah")
  await submit(tree)
  assert.deepEqual({ ...writes(state)[0].body, requestId: undefined }, {
    operation: "reset", expectedState: "review-state-one", note: "Settled separately with Hannah", requestId: undefined,
  })
  assert.ok(text(tree.root).includes("Owed to you$0.00") && text(tree.root).includes("You owe$0.00"))
  assert.equal(button(tree.root, "Reset balances"), undefined)
  assert.ok(button(tree.root, "Reset history (1)"), "Reset recovery survives the zero-balance screen")
  assert.deepEqual(state.snapshot.events, sample.events, "Reset does not invent a receipt")
  await expand(tree, "PG&E")
  const cleared = row(tree, "PG&E")
  assert.ok(text(rowToggle(cleared)).includes("Cleared"))
  assert.ok(!text(rowToggle(cleared)).includes("Received"))
  assert.ok(text(cleared).includes("Hannah paid$20.00"))
  assert.ok(text(cleared).includes("Cleared without payment$80.00"))
  assert.ok(cleared.find(node => node.props.role === "img").props["aria-label"].includes("$80.00 cleared without payment"))
  const portions = cleared.findAll(node => typeof node.type === "string" && node.props["data-portion"] && node.props.style)
  assert.deepEqual(portions.map(node => node.props.style.width), ["50%", "10%", "40%", "0%"])
  assert.equal(button(cleared, "Record received"), undefined)
  await tap(button(tree.root, "Reset history (1)"))
  assert.ok(text(tree.root).includes("Brian · Sep 30, 2026"))
  assert.ok(text(tree.root).includes("Settled separately with Hannah"))
  await tap(button(tree.root, "Undo reset"))
  assert.equal(writes(state).length, 1, "Undo also requires review")
  await tap(button(tree.root, "Confirm undo reset"))
  assert.equal(writes(state)[1].body.operation, "undo_reset")
  assert.equal(writes(state)[1].body.version, 1)
  assert.ok(text(tree.root).includes("Owed to you$105.00") && text(tree.root).includes("You owe$60.00"))
  assert.ok(text(tree.root).includes("Reset undone"))
  // Later expenses accrue normally and redo affects only the reviewed reset.
  state.snapshot.allocations.push(allocation({ id: "new", item: "New dinner", grossCents: 1000, payerShareCents: 500,
    partnerShareCents: 500, settledCents: 0, outstandingCents: 500, expenseDate: "2026-09-30" }))
  state.snapshot.resetState += "-new-expense"
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  await tap(button(tree.root, "Redo reset"))
  assert.ok(text(tree.root).includes("Shared expenses added after the reset keep their balances"))
  assert.equal(writes(state).length, 2)
  await tap(button(tree.root, "Confirm redo reset"))
  assert.equal(writes(state)[2].body.operation, "redo_reset")
  assert.equal(writes(state)[2].body.version, 2)
  assert.ok(text(tree.root).includes("Owed to you$5.00") && text(tree.root).includes("You owe$0.00"))
  assert.equal(state.snapshot.allocations.find(item => item.id === "new").clearedCents, undefined)
  assert.deepEqual(dispatched, Array(3).fill("bookiebot:reimbursements-changed"))
  await tap(button(tree.root, "You owe", true)); await expand(tree, "Hannah groceries")
  assert.ok(text(rowToggle(row(tree, "Hannah groceries"))).includes("Cleared"), "Both owner directions distinguish cleared from paid")
  await unmount(tree)
}

async function resetSafetyAndRecoveryContracts() {
  for (const blocker of ["payment", "projection"]) {
    const state = fixture()
    if (blocker === "payment") state.snapshot.events.push(receipt({ status: "pending", kind: "report_payment" }))
    else state.snapshot.projectionPending = true
    const tree = await mount()
    assert.ok(button(tree.root, "Reset balances").props.disabled)
    assert.ok(text(tree.root).includes(blocker === "payment" ? "Confirm or reverse pending payment reports" : "Wait for expense sheets to finish syncing"))
    assert.equal(writes(state).length, 0)
    await unmount(tree)
  }
  for (const blocker of ["unrelated payment", "unrelated projection"]) {
    const state = fixture({post:applyReset})
    applyReset({operation:"reset",expectedState:state.snapshot.resetState,note:"Earlier reset"},state)
    state.snapshot.allocations.push(allocation({id:"later",item:"Later shared expense"}))
    if (blocker === "unrelated payment") state.snapshot.events.push(receipt({id:"later-report",allocationId:"later",status:"pending",kind:"report_payment"}))
    else state.snapshot.projectionPending = true
    const tree = await mount()
    assert.ok(button(tree.root,"Reset balances").props.disabled,"New resets wait for the household's pending work")
    await tap(button(tree.root,"Reset history (1)"))
    await tap(button(tree.root,"Undo reset"))
    await tap(button(tree.root,"Confirm undo reset"))
    assert.equal(writes(state)[0].body.operation,"undo_reset","Server readiness permits undo despite unrelated later pending work")
    await unmount(tree)
  }
  let state = fixture(), tree = await mount()
  await tap(button(tree.root, "Reset balances"))
  await fill(tree, "Note", "Keep this draft")
  state.snapshot.resetState = "changed-on-another-device"
  state.snapshot.allocations[0].settledCents += 100; state.snapshot.allocations[0].outstandingCents -= 100
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.ok(button(tree.root, "Confirm reset to $0.00").props.disabled)
  assert.ok(text(form(tree)).includes("Owed to you $105.00"), "The reviewed values do not silently change under a confirmation")
  assert.ok(text(form(tree)).includes("Reimbursements changed while this review was open"))
  assert.equal(form(tree).findByType("input").props.value, "Keep this draft")
  await submit(tree); assert.equal(writes(state).length, 0)
  await tap(button(tree.root, "Cancel")); await tap(button(tree.root, "Reset balances"))
  assert.ok(text(form(tree)).includes("Owed to you $104.00"))
  assert.ok(!button(tree.root, "Confirm reset to $0.00").props.disabled)
  state.snapshot.events.push(receipt({ status: "pending", kind: "report_payment" }))
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.ok(form(tree).findByType("fieldset").props.disabled, "Late pending reports disable an already open reset review")
  await submit(tree); assert.equal(writes(state).length, 0)
  await unmount(tree)

  state = fixture({ post: (_body, state) => {
    state.snapshot.resetState = "new-state"
    state.snapshot.allocations[0].outstandingCents -= 100; state.snapshot.allocations[0].settledCents += 100
    return response({ error: "Reimbursements changed. Review the new balances." }, 409)
  } })
  tree = await mount(); await tap(button(tree.root, "Reset balances")); await submit(tree)
  assert.equal(form(tree), undefined)
  assert.ok(text(tree.root).includes("Reimbursements changed. Review the new balances."))
  assert.ok(text(tree.root).includes("Owed to you$104.00"))
  assert.equal(button(tree.root, "Retry this record"), undefined)
  await unmount(tree)

  let attempts = 0
  state = fixture({ post: (body, state) => {
    if (++attempts === 1) { applyReset(body, state); throw Error("Response lost after reset") }
    return response(clone(state.snapshot))
  } })
  tree = await mount(); await tap(button(tree.root, "Reset balances")); await submit(tree)
  assert.ok(text(tree.root).includes("This record may have saved"))
  assert.ok(form(tree).findByType("fieldset").props.disabled)
  const beforeFocus = state.calls.length
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.equal(state.calls.length, beforeFocus)
  await tap(button(tree.root, "Retry this record"))
  assert.deepEqual(writes(state)[0].body, writes(state)[1].body, "Uncertain reset retries keep exactly the same request and reviewed state")
  assert.equal(state.snapshot.resets.length, 1)
  assert.ok(text(tree.root).includes("Owed to you$0.00"))
  await tap(button(tree.root, "Reset history (1)")); await tap(button(tree.root, "Undo reset"))
  state.snapshot.resets[0].version++
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.ok(button(tree.root, "Confirm undo reset").props.disabled)
  assert.ok(text(tree.root).includes("This reset changed"))
  await tap(button(tree.root, "Cancel"))
  state.snapshot.resets[0].status = "undone"; state.snapshot.resets[0].canUndo = false; state.snapshot.resets[0].canRedo = false
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.equal(button(tree.root, "Redo reset"), undefined)
  assert.ok(text(tree.root).includes("Redo is unavailable for the current expenses"))
  await unmount(tree)

  state = fixture(); state.snapshot.ownerKey = "hannah"
  tree = await mount(); await tap(button(tree.root, "Reset balances"))
  assert.ok(text(form(tree)).includes("Owed to you $60.00") && text(form(tree)).includes("You owe $105.00"))
  await unmount(tree)
  state = fixture(); state.snapshot.allocations[0].clearedCents = 100
  tree = await mount()
  assert.ok(text(tree.root).includes("Couldn’t refresh reimbursements"), "Cleared plus paid plus due must equal the partner share")
  assert.equal(button(tree.root, "Reset balances"), undefined)
  await unmount(tree)
}

;(async () => {
  await monthPaginationContracts()
  await refreshedPageRetentionContracts()
  await unseenMonthPageContracts()
  await compactAndSentContracts()
  await emptyDirectionsAndMarkerContracts()
  await receiptAndReversalContracts()
  await confirmationAndOffsetContracts()
  await pendingAndDateContracts()
  await recoveryContracts()
  await inFlightContracts()
  await resetLifecycleContracts()
  await resetSafetyAndRecoveryContracts()
  console.log("Canonical reimbursements: directions, receipts, confirmations, offsets, reset/undo/redo, cleared amounts and safe retry lifecycle passed")
})().catch(error => { console.error(error); process.exitCode = 1 })
