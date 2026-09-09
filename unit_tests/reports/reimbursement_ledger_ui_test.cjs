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
  vm.runInNewContext(outputText, { exports, require: localRequire, AbortController, Error,
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
], events: [receipt()] }
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

const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve() }
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const visible = node => {
  for (let parent = node; parent; parent = parent.parent) if ([true, "true"].includes(parent.props["aria-hidden"]) || parent.props.inert !== undefined) return false
  return true
}
const text = node => typeof node === "string" || typeof node === "number" ? String(node) : visible(node) ? node.children.map(text).join("") : ""
const rawText = node => typeof node === "string" || typeof node === "number" ? String(node) : node.children.map(rawText).join("")
const buttons = scope => scope.findAllByType("button").filter(visible)
const button = (scope, label, prefix = false) => buttons(scope).find(node => node.props["aria-label"] === label || (prefix ? text(node).startsWith(label) : text(node) === label))
const hasClass = (node, name) => typeof node.type === "string" && node.props.className?.split(" ").includes(name)
const row = (tree, name) => tree.root.findAll(node => hasClass(node, "bb-reimbursement-entry")).find(node => text(buttons(node)[0]).startsWith(name))
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

;(async () => {
  await compactAndSentContracts()
  await receiptAndReversalContracts()
  await confirmationAndOffsetContracts()
  await pendingAndDateContracts()
  await recoveryContracts()
  await inFlightContracts()
  console.log("Canonical reimbursements: directions, compact receipts, partial/full commands, confirmations, offsets, read-only history and safe retry lifecycle passed")
})().catch(error => { console.error(error); process.exitCode = 1 })
