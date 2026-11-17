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
let fetchRequest = () => { throw Error("No HTTP fixture") }, latestPageRefresh
const modules = new Map()
function load(file) {
  if (modules.has(file)) return modules.get(file)
  const exports = {}; modules.set(file, exports)
  const localRequire = name => {
    if (name.endsWith(".css")) return {}
    // Browser suites exercise the native DOM animation/focus/countdown. This
    // renderer checks the controller contract without fabricating layout refs.
    if (name === './transaction-undo-popup') return {UndoPopup:({notice,detail,onUndo,onDismiss,undoAvailable})=>React.createElement('div',{'data-toast':true},notice.title,detail,undoAvailable&&React.createElement('button',{onClick:onUndo},'Undo'),React.createElement('button',{onClick:onDismiss},'Dismiss undo'))}
    if (name === "./page-refresh") { const hooks=load(path.join(frontend,"src/page-refresh.tsx"));return {...hooks,usePageRefresh:(screen,handler)=>{latestPageRefresh=handler;return hooks.usePageRefresh(screen,handler)}} }
    if (name === './transaction-step-motion') return {StepMotion:({review,edit,confirm})=>React.createElement('div',null,React.createElement('div',{'aria-hidden':review,inert:review},edit),React.createElement('div',{'aria-hidden':!review,inert:!review},confirm))}
    if (name === "./transaction-editor-workspace") return {
      EditorScenes: ({children}) => children,
      EditorExpansion: ({open,retain,children}) => React.createElement("div", {"aria-hidden":!open,inert:!open}, (retain||open) ? children : null),
    }
    if (!name.startsWith(".")) return frontendRequire(name)
    const base = path.resolve(path.dirname(file), name)
    if (name.endsWith(".json")) return JSON.parse(fs.readFileSync(base, "utf8"))
    return load([base + ".tsx", base + ".ts"].find(fs.existsSync))
  }
  const baseline = file.endsWith("/reimbursement-ledger.tsx") ? process.env.BOOKIEBOT_LEDGER_BASELINE : file.endsWith("/shared-balance-first.tsx") ? process.env.BOOKIEBOT_SHARED_BASELINE : undefined
  const source = fs.readFileSync(baseline || file, "utf8")
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } })
  vm.runInNewContext(outputText, { exports, require: localRequire, AbortController, Error, Date: FixtureDate,
    window: browserWindow, document: browserDocument, matchMedia: () => ({matches:true,addEventListener(){},removeEventListener(){}}), requestAnimationFrame: cb => browserWindow.setTimeout(cb,16), cancelAnimationFrame: id => browserWindow.clearTimeout(id), fetch: (...args) => fetchRequest(...args),
    crypto: { randomUUID: () => `record-${++requestId}` }, CustomEvent: class { constructor(type) { this.type = type } },
  })
  return exports
}
const { ReimbursementLedger, reimbursementAmountCents, ledgerTotals, defaultOffsetEntries, canReverseLedgerEvent } = load(path.join(frontend, "src/reimbursement-ledger.tsx"))
const { balanceFirstScope, sharedExpenseDate, reimbursementTransaction } = load(path.join(frontend, "src/shared-balance-first.tsx"))
const {reimbursementUndo,reimbursementReceipt,resolveReimbursementReceipt}=load(path.join(frontend,"src/reimbursement-undo.ts"))
const undoResult={enabled:true,ownerKey:"brian",currency:"USD",allocations:[],resetState:"after-save",operationId:"receipt-op",events:[
 {id:"old",operationId:"earlier-op",kind:"receive",status:"confirmed",amountCents:500},
 {id:"confirmed-report",operationId:"sender-op",confirmationOperationId:"receipt-op",kind:"report_payment",status:"confirmed",amountCents:1000},
 {id:"remainder",operationId:"receipt-op",confirmationOperationId:"receipt-op",kind:"receive",status:"confirmed",amountCents:2500}
]}
assert.deepEqual(JSON.parse(JSON.stringify(reimbursementUndo({operation:"receive_all"},undoResult))),{title:"$35.00 received",command:{operation:"reverse_operation",operationId:"receipt-op",expectedState:"after-save"}},"Receipt Undo includes its confirmed reports and remainder, excluding earlier cash")
assert.equal(reimbursementUndo({operation:"receive_all"},{...undoResult,projectionPending:true}),null,"Syncing commands cannot offer an unsafe inverse")
{
 const pending={...undoResult,projectionPending:true,undoState:'financial-revision'},receipt=reimbursementReceipt({operation:'receive_all'},pending)
 const resolution=resolveReimbursementReceipt(receipt,pending)
 assert.equal(resolution.phase,'syncing')
 assert.deepEqual(JSON.parse(JSON.stringify(resolution.undo.command)),{operation:'queue_undo',action:'reverse_operation',operationId:'receipt-op',expectedUndoState:'financial-revision'},'A pending Undo queues exact immutable intent, never a premature financial inverse')
 const ready=resolveReimbursementReceipt(receipt,{...pending,projectionPending:false,resetState:'projected-revision'})
 assert.equal(ready.phase,'ready');assert.equal(ready.undo.command.expectedState,'projected-revision','Projection progress may update the write preview')
 assert.equal(resolveReimbursementReceipt(receipt,{...pending,events:[...pending.events,{id:'new-report',operationId:'new',amountCents:1,status:'pending'}]}).phase,'changed','An intervening financial change cannot rebind Undo')
}
assert.equal(reimbursementUndo({operation:"reverse_operation"},undoResult),null,"An inverse does not recursively create another notice")
assert.equal(reimbursementUndo({operation:"receive_all"},{...undoResult,operationId:undefined}),null,"A notice requires canonical operation lineage")
for(const [operation,status,ready,inverse] of [["undo_reset","undone","canRedo","redo_reset"],["redo_reset","active","canUndo","undo_reset"],["reset","active","canUndo","undo_reset"]]){
 const reset={id:"reset-id",status,version:4,[ready]:true};const result={...undoResult,reset,resets:[reset]}
 assert.deepEqual(JSON.parse(JSON.stringify(reimbursementUndo({operation},result).command)),{operation:inverse,resetId:"reset-id",version:4})
 assert.equal(reimbursementUndo({operation},{...result,resets:[{...reset,[ready]:false}]}),null,"Unavailable old resets cannot be undone from a toast")
}
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
assert.deepEqual(clone(balanceFirstScope(sample.allocations, "2026-09").map(item => item.id)), ["a", "b", "c"], "Active scope spans months and both directions, excluding settled rows")
const settledSample = sample.allocations.map(item => ({ ...item, outstandingCents:0, status:"settled" }))
assert.deepEqual(clone(balanceFirstScope(settledSample, "2026-09").map(item => item.id)), ["a", "c", "old"], "Settled scope shows only actual current-month activity")
assert.equal(balanceFirstScope(settledSample, "2026-10").length, 0)
assert.equal(balanceFirstScope(settledSample, "2026-09", true).length, 4, "Earlier settled history remains accessible")
assert.equal(sharedExpenseDate("2/29/2025"), "")
assert.equal(sharedExpenseDate("11/1/2026"), "2026-11-01")
assert.equal(reimbursementTransaction(allocation()).category,"Needs")
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
async function queuedFeedbackContracts(){
 const {useReimbursementFeedback}=load(path.join(frontend,'src/reimbursement-feedback.tsx'))
 let feedback,tree;const Harness=({snapshot})=>{feedback=useReimbursementFeedback(snapshot);return null}
 const saved={...clone(undoResult),projectionPending:true,undoState:'financial-revision'},job={id:'durable-job',actorOwner:'brian',operation:'reverse_operation',status:'queued',error:'',createdAt:'',updatedAt:''}
 await act(async()=>{tree=Renderer.create(React.createElement(Harness,{snapshot:saved}));await flush()});await act(async()=>{feedback.acknowledge({operation:'receive_all'},saved);await flush()})
 assert.equal(feedback.command.operation,'queue_undo');assert.equal(feedback.modal,false)
 assert(feedback.notice.deadline>0,'An acknowledged action uses the normal timed toast even while persistence catches up');assert.equal(feedback.detail,undefined)
 const savedNotice=feedback.notice
 await act(async()=>{tree.update(React.createElement(Harness,{snapshot:{...saved,projectionPending:false}}));await flush()})
 assert.equal(feedback.notice,savedNotice,'Projection completion never replaces or restarts the success toast')
 await act(async()=>{tree.update(React.createElement(Harness,{snapshot:saved}));await flush()})
 await act(async()=>{feedback.dismiss();feedback.acknowledge({operation:'queue_undo'},{...saved,undoJob:job,undoJobs:[job]});tree.update(React.createElement(Harness,{snapshot:{...saved,undoJobs:[job]}}));await flush()})
 assert.equal(feedback.notice.title,'Undone');assert.equal(feedback.command,null);assert.equal(feedback.modal,false)
 await act(async()=>{tree.unmount();await flush();tree=Renderer.create(React.createElement(Harness,{snapshot:{...saved,undoJobs:[job]}}));await flush()})
 assert.equal(feedback.notice.title,'Undone','Refresh reconstructs queued feedback from canonical SQL status')
 const acceptedNotice=feedback.notice
 await act(async()=>{tree.update(React.createElement(Harness,{snapshot:{...saved,projectionPending:false,undoJobs:[{...job,status:'completed'}]}}));await flush()})
 assert.equal(feedback.notice.title,'Undone');assert(feedback.notice.deadline>0);assert.equal(feedback.command,null)
 assert.equal(feedback.notice,acceptedNotice,'Background completion does not repeat the success message')
 await act(async()=>{feedback.dismiss();tree.update(React.createElement(Harness,{snapshot:{...saved,projectionPending:false,undoJobs:[{...job,status:'completed'}]}}));await flush()})
 assert.equal(feedback.notice,null,'Dismissed completion stays dismissed on later reads')
 await act(async()=>{tree.unmount();await flush()})
}
async function immediateUndoAndRollback(){
 const {reimbursementDisplay}=load(path.join(frontend,'src/reimbursement-display-state.ts'))
 for(const failure of [409,503,401,403]){
  const held=deferred();let reads=0
  const state=fixture({post:(body,state)=>{
   if(body.operation==='reverse_operation')return held.promise
   for(const entry of body.entries){const row=state.snapshot.allocations.find(r=>r.id===entry.allocationId);row.settledCents+=entry.amountCents;row.outstandingCents-=entry.amountCents;row.version++;row.projectedVersion=row.version}
   state.snapshot.events.push(...body.entries.map((e,i)=>receipt({id:'new-offset-'+i,operationId:'new-offset',allocationId:e.allocationId,kind:'offset',amountCents:e.amountCents})))
   state.snapshot.operationId='new-offset';state.snapshot.resetState='after-offset'
   return response(clone(state.snapshot))
  }})
  const tree=await mount({balanceFirst:true}),initial=clone(reimbursementDisplay.read('brian').allocations).map(r=>r.outstandingCents)
  await tap(button(tree.root,'Offset & settle'));await tap(button(tree.root,'Confirm offset'))
  const saved=clone(reimbursementDisplay.read('brian').allocations).map(r=>r.outstandingCents)
  assert.notDeepEqual(saved,initial)
  await tap(button(tree.root,'Undo'))
  assert.deepEqual(clone(reimbursementDisplay.read('brian').allocations).map(r=>r.outstandingCents),initial,'Visible balances and shared row state change before the Undo response')
  assert.equal(writes(state).length,2)
  await act(async()=>{held.resolve(response({error:'Undo rejected'},failure));await flush()})
  if([401,403].includes(failure))assert.equal(reimbursementDisplay.read('brian'),null,'Lost access purges the shared private display')
  else assert.deepEqual(clone(reimbursementDisplay.read('brian').allocations).map(r=>r.outstandingCents),failure===409?saved:initial,'Known rejection restores canonical state; uncertain response retains exact-request recovery')
  if(failure===503){const original=clone(writes(state)[1].body);await tap(button(tree.root,'Retry this record'));assert.deepEqual(clone(writes(state)[2].body),original)}
  await unmount(tree)
 }
}
async function acknowledgedUndoDoesNotWaitForDuplicateRead(){
 const never=deferred();let reads=0
 const state=fixture({get:state=>++reads===1?response(clone(state.snapshot)):never.promise,post:(body,state)=>{
  if(body.operation==='offset'){
   for(const entry of body.entries){const row=state.snapshot.allocations.find(r=>r.id===entry.allocationId);row.settledCents+=entry.amountCents;row.outstandingCents-=entry.amountCents;row.version++;row.projectedVersion=row.version}
   state.snapshot.events.push(...body.entries.map((e,i)=>receipt({id:'offset-'+i,operationId:'saved-offset',allocationId:e.allocationId,kind:'offset',amountCents:e.amountCents})))
   state.snapshot.operationId='saved-offset';state.snapshot.resetState='after-offset'
  }else assert.equal(body.operation,'reverse_operation')
  return response(clone(state.snapshot))
 }})
 const tree=await mount({balanceFirst:true})
 await tap(button(tree.root,'Offset & settle'));await tap(button(tree.root,'Confirm offset'))
 assert.equal(reads,1,'A complete command snapshot needs no duplicate GET before Undo becomes usable')
 await tap(button(tree.root,'Undo'));assert.equal(writes(state).length,2,'Undo is accepted immediately after acknowledgement')
 await unmount(tree)
}
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
    assert.equal(new URL(url,"https://bookie.test").pathname, "/app/reimbursements")
    for (const [key, value] of Object.entries({ credentials: "same-origin", mode: "same-origin", referrerPolicy: "same-origin", cache: "no-store", redirect: "error" })) assert.equal(options[key], value)
    const body = options.body ? JSON.parse(options.body) : undefined
    state.calls.push({ url, body, options })
    if (!body) return get ? get(state) : response(clone(state.snapshot))
    assert.equal(options.headers["X-BookieBot-App"], "1")
    assert.ok(body.requestId)
    return post ? post(body, state) : response(clone(state.snapshot))
  }
  return state
}
const writes = state => state.calls.filter(call => call.body)
async function mount(props = {}) { let tree; await act(async () => { tree = Renderer.create(React.createElement(ReimbursementLedger, { fallback, refreshKey: "one", ...props })); await flush() }); return tree }
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
  await tap(button(september, "Load all expenses"))
  assert.equal(displayed(september).length, 12)
  assert.equal(button(september, "Load all expenses"), undefined)
  await tap(rowToggle(displayed(september)[0]))
  await tap(button(september, "Record received"))
  await fill(tree, "Amount", "12.34")
  await tap(monthToggle(september))
  assert.equal(displayed(september).length, 0)
  assert.equal(form(tree), undefined, "Collapsed month controls are inaccessible")
  await tap(monthToggle(september))
  assert.equal(displayed(september).length, 12, "Reopening keeps previously loaded expenses")
  assert.equal(form(tree).findAllByType("input")[0].props.value, "12.34", "Month collapse retains payment drafts")
  await tap(button(tree.root, "Load all months"))
  assert.ok(monthGroups().slice(5).every(group => !monthToggle(group).props["aria-expanded"]))
  assert.equal(monthGroups().length, 13)
  assert.equal(button(tree.root, "Load all months"), undefined)
  assert.equal(monthGroups().at(-1).props["aria-label"], "Undated")
  const august = monthGroups()[1]
  await tap(monthToggle(august))
  assert.equal(displayed(august).length, 1)
  assert.equal(button(august, "Load all expenses"), undefined)
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
  await tap(button(september, "Load all expenses"))
  assert.equal(september.findAll(node => hasClass(node, "bb-reimbursement-entry")).length, 13, "Load all reveals every remaining expense after a retained cutoff expands")
  assert.equal(button(september, "Load all expenses"), undefined)
  state.snapshot.allocations.push(allocation({ id: "new-row-after-all", item: "New expense after Load all", expenseDate: "2026-09-30" }))
  await refresh()
  assert.equal(september.findAll(node => hasClass(node, "bb-reimbursement-entry")).length, 14, "Load all remains active when new expenses arrive")
  assert.equal(form(tree).findAllByType("input")[0].props.value, "12.34", "Load all and refresh preserve the open payment draft")
  assert.equal(button(september, "Load all expenses"), undefined)
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
  await tap(button(tree.root, "Load all months"))
  await tap(button(tree.root, "Owed to you", true))
  state.snapshot.allocations.push(allocation({ id: "hannah-newest-month", payerOwner: "hannah", partnerOwner: "brian", expenseDate: "2026-10-01" }))
  await refresh()
  await tap(button(tree.root, "You owe", true))
  assert.equal(shownMonths().length, 8, "Load all includes new months while their direction is hidden")
  assert.equal(button(tree.root, "Load all months"), undefined)
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
  assert.ok(!text(tree.root).includes("Recorded. Expense sheets are still syncing."))
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
  assert.ok(!text(tree.root).includes("sheets still need to update"), "Persistence details belong behind the scenes")
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
  assert.ok(!text(tree.root).includes("Recorded. Expense sheets are still syncing."))
  state.snapshot.projectionPending = false
  await act(async()=>{await latestPageRefresh.refresh();await flush()})
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
  assert.ok(!text(tree.root).includes("Recorded. Expense sheets are still syncing."))
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
  assert.ok(text(form(tree)).includes("3 outstanding expenses across all months"))
  assert.ok(text(form(tree)).includes("Purchases and receipts stay unchanged"))
  assert.ok(text(form(tree)).includes("No payment is recorded"))
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

async function bulkReceiveContracts() {
  let state = fixture({ post: (body, state) => {
    assert.equal(body.operation, "receive_all")
    for (const item of state.snapshot.allocations.filter(item => item.payerOwner === state.snapshot.ownerKey && item.outstandingCents > 0)) {
      item.settledCents += item.outstandingCents; item.outstandingCents = 0; item.status = "settled"; item.version++; item.projectedVersion++
    }
    state.snapshot.resetState = "after-bulk-receipt"
    return response(clone(state.snapshot))
  } })
  let tree = await mount()
  await tap(button(tree.root, "Mark all received"))
  assert.ok(text(form(tree)).includes("$105.00 received across 2 outstanding expenses"))
  assert.ok(text(form(tree)).includes("across all months"))
  assert.ok(text(form(tree)).includes("Money you owe stays unchanged"))
  await submit(tree)
  assert.equal(writes(state).length, 1, "One command records the complete balance, not one request per row")
  assert.equal(writes(state)[0].body.expectedState, "review-state-one")
  assert.equal(state.calls.filter(call => !call.body).length, 1, "The command response already contains fresh balances; no duplicate GET after bulk save")
  assert.ok(text(tree.root).includes("Owed to you$0.00"))
  assert.ok(text(tree.root).includes("You owe$60.00"))
  await tap(button(tree.root, "You owe", true))
  assert.equal(button(tree.root, "Mark all received"), undefined)
  await unmount(tree)

  state = fixture(); tree = await mount(); await tap(button(tree.root, "Mark all received"))
  state.snapshot.resetState = "changed-preview"
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.ok(button(tree.root, "Confirm all received").props.disabled)
  await submit(tree); assert.equal(writes(state).length, 0)
  await unmount(tree)

  state = fixture(); state.snapshot.allocations[0].projectedVersion = 2
  tree = await mount()
  assert.ok(button(tree.root, "Mark all received").props.disabled)
  await unmount(tree)

  let attempts = 0
  state = fixture({ post: () => { if (++attempts === 1) throw Error("Lost bulk response"); return response(clone(state.snapshot)) } })
  tree = await mount(); await tap(button(tree.root, "Mark all received")); await submit(tree)
  await tap(button(tree.root, "Retry this record"))
  assert.deepEqual(writes(state)[0].body, writes(state)[1].body, "Bulk retries reuse the reviewed state and durable request ID")
  await unmount(tree)
}

async function matchedReceiptContracts() {
  const matchedReceipt = { allocationId: "a", bankAmountCents: 20000 }
  let state = fixture({ post: (body, state) => {
    const item = state.snapshot.allocations[0]
    item.settledCents += body.amountCents; item.outstandingCents -= body.amountCents; item.version++
    state.snapshot.projectionPending = true
    return response(clone(state.snapshot))
  } })
  let tree = await mount({ matchedReceipt })
  assert.equal(writes(state).length, 0)
  assert.ok(text(tree.root).includes("The bank match is saved separately"))
  assert.equal(button(tree.root, "Mark all received"), undefined)
  assert.equal(button(tree.root, "Reset balances"), undefined)
  await tap(button(tree.root, "Mark Hannah’s share received"))
  assert.equal(writes(state).length, 0, "Opening the separate confirmation never records a receipt")
  await fill(tree, "Amount", "12.34")
  await tap(button(tree.root, "Cancel")); assert.equal(writes(state).length, 0)
  await tap(button(tree.root, "Mark Hannah’s share received")); await fill(tree, "Amount", "12.34")
  await submit(tree)
  assert.equal(writes(state).length, 1)
  assert.equal(writes(state)[0].body.operation, "receive")
  assert.equal(writes(state)[0].body.allocationId, "a")
  assert.equal(writes(state)[0].body.amountCents, 1234)
  assert.equal(writes(state)[0].body.version, 3)
  assert.ok(text(tree.root).includes("sheet update pending"))
  assert.ok(button(tree.root, "Mark Hannah’s share received").props.disabled)
  assert.ok(dispatched.includes("bookiebot:reimbursements-changed"))
  await unmount(tree)

  for (const guard of ["gross", "payee", "cleared", "settled", "pending"]) {
    state = fixture()
    if (guard === "gross") state.snapshot.allocations[0].grossCents = 21000, state.snapshot.allocations[0].payerShareCents = 11000
    if (guard === "payee") state.snapshot.ownerKey = "hannah"
    if (guard === "cleared") state.snapshot.allocations[0].clearedCents = 8000, state.snapshot.allocations[0].outstandingCents = 0
    if (guard === "settled") state.snapshot.allocations[0].settledCents = 10000, state.snapshot.allocations[0].outstandingCents = 0
    if (guard === "pending") state.snapshot.events.push(receipt({ id: "sent", status: "pending", kind: "report_payment" }))
    tree = await mount({ matchedReceipt })
    const mark = button(tree.root, "Mark Hannah’s share received")
    assert.ok(!mark || mark.props.disabled, `${guard} cannot create an unreviewed receipt`)
    if (guard === "pending") {
      await tap(button(tree.root, "Review")); assert.equal(writes(state).length, 0)
      await tap(button(tree.root, "Confirm received"))
      assert.equal(writes(state)[0].body.operation, "confirm_payment")
      assert.equal(writes(state)[0].body.eventId, "sent")
    }
    await unmount(tree)
  }

  state = fixture(); tree = await mount({ matchedReceipt })
  await tap(button(tree.root, "Mark Hannah’s share received")); await fill(tree, "Amount", "12.34")
  state.snapshot.allocations[0].version++
  state.snapshot.allocations[0].projectedVersion++
  state.snapshot.allocations[0].settledCents += 100
  state.snapshot.allocations[0].outstandingCents -= 100
  await act(async () => { for (const callback of listeners.window.get("focus")) callback(); await flush() })
  assert.equal(form(tree).findAllByType("input")[0].props.value, "12.34", "An external receipt cannot replace the reviewed amount with the new remainder")
  assert.ok(form(tree).findByType("fieldset").props.disabled)
  await submit(tree); assert.equal(writes(state).length, 0)
  assert.ok(text(tree.root).includes("This payment changed"))
  await unmount(tree)

  let attempts = 0
  state = fixture({ post: () => { if (++attempts === 1) throw Error("Saved response lost"); return response(clone(state.snapshot)) } })
  tree = await mount({ matchedReceipt })
  await tap(button(tree.root, "Mark Hannah’s share received")); await submit(tree)
  assert.ok(button(tree.root, "Back to reconciliation").props.disabled, "An uncertain receipt stays mounted for its safe retry")
  await tap(button(tree.root, "Retry this record"))
  assert.deepEqual(writes(state)[0].body, writes(state)[1].body)
  assert.ok(!button(tree.root, "Back to reconciliation").props.disabled)
  await unmount(tree)

  let rejected = ""
  state = fixture({ get: () => response({ error: "Session revoked" }, 401) })
  tree = await mount({ matchedReceipt, onRejectAccess: message => { rejected = message } })
  assert.equal(rejected, "Session revoked")
  assert.ok(!text(tree.root).includes("PG&E"))
  await unmount(tree)
}


async function splitEditorContracts() {
  const ready = () => {
    const state = fixture()
    state.snapshot.allocations = [allocation({ settledCents: 0, outstandingCents: 10000 })]
    state.snapshot.events = []
    return state
  }
  let state = ready(), tree = await mount()
  await expand(tree, "PG&E")
  await tap(button(tree.root, "Edit split"))
  assert.equal(button(tree.root, "Save split").props.disabled, true)
  await fill(tree, "Your share", "33.33")
  assert.ok(text(form(tree)).includes("Brian · 33.33%$66.66"))
  assert.ok(text(form(tree)).includes("Hannah · 66.67%$133.34"))
  await fill(tree, "Expense total", "100.01")
  assert.ok(text(form(tree)).includes("Brian · 33.33%$33.33"))
  assert.ok(text(form(tree)).includes("Hannah · 66.67%$66.68"))
  assert.equal(writes(state).length, 0, "Dragging and typing never persist a financial change")
  for (const [value, payer, partner] of [["0", "$0.00", "$100.01"], ["100", "$100.01", "$0.00"]]) {
    await fill(tree, "Your share", value)
    assert.ok(text(form(tree)).includes(`Brian · ${value}%${payer}`))
    assert.ok(text(form(tree)).includes(`Hannah · ${100 - Number(value)}%${partner}`))
  }
  for (const invalid of ["", "0", "-1", "1.001", "1e3", "100000000.01"]) {
    await fill(tree, "Expense total", invalid)
    assert.ok(button(tree.root, "Save split").props.disabled)
    await submit(tree)
  }
  assert.equal(writes(state).length, 0)
  await tap(button(tree.root, "Cancel"))
  await tap(button(tree.root, "Edit split"))
  assert.equal(form(tree).findByProps({ type: "range" }).props.value, 50, "Reopening starts from saved values")
  await fill(tree, "Your share", "65.25")
  await fill(tree, "Expense total", "123.45")
  await submit(tree)
  assert.deepEqual(clone(writes(state)[0].body), {
    operation: "edit_split", allocationId: "a", version: 3, grossCents: 12345, payerBasisPoints: 6525,
    requestId: writes(state)[0].body.requestId,
  })
  await unmount(tree)

  state = ready()
  state.snapshot.allocations[0] = allocation({ settledCents: 0, outstandingCents: 0, partnerShareCents: 0,
    payerShareCents: 20000, status: "settled", method: "custom", customPayerBasisPoints: 10000 })
  tree = await mount(); await expand(tree, "PG&E")
  assert.ok(text(row(tree, "PG&E")).includes("No reimbursement due"), "A zero partner share is not a receipt")
  assert.ok(!button(tree.root, "Record received"))
  await tap(button(tree.root, "Edit split"))
  assert.equal(form(tree).findByProps({ type: "range" }).props.value, 100, "Saved custom percentages reopen exactly")
  await unmount(tree)

  state = ready()
  state.snapshot.allocations[0] = allocation({ grossCents:46472, payerShareCents:1000, partnerShareCents:45472,
    settledCents:0, outstandingCents:45472, method:"custom", customPayerRatio:[1000,46472] })
  tree = await mount(); await expand(tree,"PG&E"); await tap(button(tree.root,"Edit split"))
  assert.ok(text(form(tree)).includes("$10.00"),"Exact dollar allocations stay readable in Shared")
  await fill(tree,"Expense total","123.45"); await submit(tree)
  assert.equal(writes(state)[0].body.payerShareCents,266,"A total-only Shared edit preserves the exact amount ratio")
  assert.equal(writes(state)[0].body.payerBasisPoints,undefined)
  await unmount(tree)

  for (const changes of [{ settledCents: 2000, outstandingCents: 8000 }, { projectedVersion: 2 },
    { clearedCents: 10000, outstandingCents: 0 }, { accounting: "legacy_net" },
    { payerOwner: "hannah", partnerOwner: "brian" }]) {
    state = ready(); state.snapshot.allocations[0] = allocation({ settledCents: 0, outstandingCents: 10000, ...changes })
    tree = await mount()
    if (changes.payerOwner) await tap(button(tree.root, "You owe", true))
    await expand(tree, "PG&E")
    const edit = button(tree.root, "Edit split")
    assert.ok(!edit || edit.props.disabled, "Only an eligible payer can edit")
    await unmount(tree)
  }
  state = ready(); state.snapshot.events = [receipt({ kind: "report_payment", status: "pending" })]
  tree = await mount(); await expand(tree, "PG&E")
  assert.ok(button(tree.root, "Edit split").props.disabled)
  await unmount(tree)

  state = ready(); tree = await mount(); await expand(tree, "PG&E"); await tap(button(tree.root, "Edit split"))
  await fill(tree, "Expense total", "90.00")
  state.snapshot.allocations[0].version++
  await act(async () => { tree.update(React.createElement(ReimbursementLedger, { fallback, refreshKey: "new" })); await flush() })
  assert.ok(text(tree.root).includes("This expense changed."))
  assert.equal(form(tree).findAllByType("input")[0].props.value, "90.00", "A refresh retains the user's draft")
  await submit(tree); assert.equal(writes(state).length, 0, "A stale draft cannot write")
  await tap(button(tree.root, "Cancel")); await unmount(tree)

  let attempts = 0
  state = fixture({ post: () => { if (++attempts === 1) throw Error("Saved response lost"); return response(clone(state.snapshot)) } })
  state.snapshot.allocations = [allocation({ settledCents: 0, outstandingCents: 10000 })]; state.snapshot.events = []
  tree = await mount(); await expand(tree, "PG&E"); await tap(button(tree.root, "Edit split"))
  await fill(tree, "Your share", "12.34"); await submit(tree)
  assert.ok(form(tree).findByType("fieldset").props.disabled)
  await submit(tree); assert.equal(writes(state).length, 1)
  await tap(button(tree.root, "Retry this record"))
  assert.deepEqual(writes(state)[0].body, writes(state)[1].body, "Retry uses the identical reviewed split and request ID")
  await unmount(tree)
}

async function balanceFirstRejectedCommandContracts() {
  for (const operation of ["offset","receive_all","report_all"]) for (const status of [401,409]) {
    const state = fixture({post:body=>{assert.equal(body.operation,operation);return response({error:"Rejected review"},status)}})
    state.snapshot.allocations = operation === "offset" ? [sample.allocations[0],sample.allocations[2]] : [sample.allocations[operation === "receive_all" ? 0 : 2]]
    state.snapshot.events=[]
    const tree=await mount({balanceFirst:true})
    await tap(button(tree.root,operation === "offset" ? "Offset & settle" : operation === "receive_all" ? "Record received" : "Record sent payment"))
    await tap(button(tree.root,operation === "offset" ? "Confirm offset" : operation === "receive_all" ? "Confirm received" : "Record sent"))
    assert.equal(writes(state).length,1)
    assert.ok(!text(tree.root).includes("Balances updated")&&!text(tree.root).includes("Payment reported"),`${status} ${operation} cannot display success or invent a receipt`)
    assert.equal(button(tree.root,"View reimbursements"),undefined)
    assert.equal(button(tree.root,"Confirm received"),undefined,"Rejected offset does not progress to the cash step")
    await unmount(tree)
  }
}

async function balanceFirstRetainedDraftContracts() {
  const state=fixture();state.snapshot.allocations=[sample.allocations[0]];state.snapshot.events=[]
  const tree=await mount({balanceFirst:true})
  const rowButton=()=>tree.root.findAllByType('button').find(node=>node.props.className==='sr-row-main')
  const detail=()=>tree.root.findAll(node=>node.props.className==='sr-detail-host'&&node.props['data-open']===true)[0]
  await tap(rowButton());await tap(button(detail(),'Record received'));await fill(tree,'Amount ($)','12.34');await fill(tree,'Note','Retained payment')
  await tap(rowButton())
  await act(async()=>{for(const [id,timer]of [...timers])if(timer.delay===320){timers.delete(id);timer.callback()}await flush()})
  await tap(rowButton())
  assert.equal(form(tree).findAllByType('input')[0].props.value,'12.34','Both expansion levels retain the payment draft after closure completes')
  assert.equal(form(tree).findAllByType('input')[2].props.value,'Retained payment')
  await unmount(tree)
}

async function balanceFirstNativeSplitContracts() {
  const state=fixture({post:body=>{
    const item=state.snapshot.allocations[0];item.payerShareCents=body.payerShareCents;item.partnerShareCents=item.grossCents-body.payerShareCents;
    item.outstandingCents=item.partnerShareCents;item.method=body.method;item.version++;item.projectedVersion=item.version;
    return response(clone(state.snapshot))
  }})
  state.snapshot.allocations=[allocation({settledCents:0,outstandingCents:10000})];state.snapshot.events=[]
  state.snapshot.splitOptions={a:{incomePayerCents:12946}}
  const tree=await mount({balanceFirst:true}),rowButton=()=>tree.root.findAllByType('button').find(node=>node.props.className==='sr-row-main')
  await tap(rowButton());assert.equal(button(tree.root,'Close reimbursement details'),undefined)
  await tap(button(tree.root,'Edit split'))
  assert.equal(form(tree).findAll(node=>hasClass(node,'bs-orb')).length,2,'The actual Transactions percentage circles render')
  await act(async()=>{form(tree).findByProps({'aria-label':"Brian's share amount"}).props.onChange({target:{value:'.'}});await flush()})
  assert.equal(button(tree.root,'Review split').props.disabled,true,'Incomplete share text cannot be reviewed')
  await tap(rowButton());await tap(rowButton())
  assert.equal(form(tree).findByProps({'aria-label':"Brian's share amount"}).props.value,'.','Parent closure retains incomplete share text')
  await tap(button(tree.root,'Split by income'))
  assert.equal(form(tree).findByProps({type:'range'}).props.value,12946,'Income uses the exact writer cents')
  await tap(rowButton());await tap(rowButton())
  assert.equal(form(tree).findByProps({type:'range'}).props.value,12946,'Parent close/reopen retains the split draft')
  await submit(tree)
  assert.equal(writes(state).length,0,'Review is read only')
  assert.match(text(tree.root),/By income/)
  await tap(button(tree.root,'Back'))
  assert.equal(form(tree).findByProps({type:'range'}).props.value,12946,'Back retains the selected income amount')
  await submit(tree);await tap(button(tree.root,'Confirm split'))
  assert.deepEqual(clone(writes(state)[0].body),{operation:'edit_split',allocationId:'a',version:3,grossCents:20000,method:'income',payerShareCents:12946,requestId:writes(state)[0].body.requestId})
  assert.match(text(tree.root),/\$70.54/)
  assert.equal(state.snapshot.events.length,0,'Editing a split never records a reimbursement')
  await unmount(tree)
}

async function balanceFirstZeroShareRetentionContracts(){
  const state=fixture({post:body=>{const item=state.snapshot.allocations[0];item.payerShareCents=body.payerShareCents;item.partnerShareCents=item.grossCents-item.payerShareCents;item.outstandingCents=item.partnerShareCents;item.status=item.outstandingCents?'outstanding':'settled';item.method=body.method;item.customPayerRatio=[body.payerShareCents,item.grossCents];item.version++;item.projectedVersion=item.version;return response(clone(state.snapshot))}})
  state.snapshot.allocations=[allocation({settledCents:0,outstandingCents:10000}),allocation({id:'b',item:'Other debt',settledCents:0,outstandingCents:10000})];state.snapshot.events=[]
  const tree=await mount({balanceFirst:true}),rows=()=>tree.root.findAllByType('button').filter(node=>node.props.className==='sr-row-main')
  await tap(rows()[0]);await tap(button(tree.root,'Edit split'))
  assert.equal(button(tree.root,'Split by income').props.disabled,true,'Missing income metadata cannot masquerade as 50/50')
  await act(async()=>{form(tree).findByProps({'aria-label':"Brian's share amount"}).props.onChange({target:{value:'200.00'}});await flush()})
  await submit(tree);await tap(button(tree.root,'Confirm split'))
  assert.equal(rows().length,2,'The selected zero-debt expense stays until its editor closes')
  assert.ok(text(tree.root).includes('Settled'));assert.equal(state.snapshot.events.length,0)
  await tap(button(tree.root,'Cancel'))
  assert.equal(rows().length,1,'Closing returns to the default outstanding scope')
  await unmount(tree)
}

async function balanceFirstFastLoadingContracts(){
  const first=deferred(), recovery=deferred()
  const state=fixture({get:state=>state.calls.length===1?first.promise:recovery.promise})
  state.snapshot.events=[]
  state.snapshot.allocations=Array.from({length:16},(_,i)=>allocation({id:'active-'+i,item:'Active '+i,expenseDate:i<10?'2026-09-03':`2026-${String(8-(i-10)).padStart(2,'0')}-03`,settledCents:0,outstandingCents:10000}))
  const tree=await mount({balanceFirst:true})
  assert.equal(state.calls.length,1);assert.equal(state.calls[0].url,'/app/reimbursements?snapshot=1')
  const initialSignal=state.calls[0].options.signal
  let queued,joined
  await act(async()=>{
    for(const callback of listeners.window.get('focus')){callback();callback()}
    queued=latestPageRefresh.refresh();joined=latestPageRefresh.refresh();await flush()
  })
  assert.equal(state.calls.length,1,'Focus/report reads coalesce without cancelling the first paint')
  assert.equal(initialSignal.aborted,false)
  await act(async()=>{first.resolve(response(clone(state.snapshot)));await flush()})
  assert.equal(state.calls.length,2);assert.equal(state.calls[1].url,'/app/reimbursements','Full recovery queues behind the display snapshot')
  const rows=()=>tree.root.findAllByType('button').filter(node=>node.props.className==='sr-row-main')
  assert.equal(rows().length,16,'Every active expense and month is present before recovery finishes')
  assert(rows().every(node=>!node.props.disabled),'Rows stay available for inspection while the fresh read verifies financial actions')
  assert.equal(button(tree.root,'Load all expenses'),undefined);assert.equal(button(tree.root,'Load all months'),undefined)
  await tap(rows()[9])
  const detail=tree.root.findAll(node=>node.props.className==='sr-detail-host'&&node.props['data-open']===true)[0]
  assert.equal(button(detail,'Record received').props.disabled,true,'A read still locks the payment action')
  await act(async()=>{recovery.resolve(response(clone(state.snapshot)));await queued;await joined;await flush()})
  assert.equal(rows().length,16);assert.equal(state.calls.length,2)
  assert.equal(button(detail,'Record received').props.disabled,false)
  await unmount(tree)

  const held=deferred();const abandoned=fixture({get:()=>held.promise});const closed=await mount({balanceFirst:true})
  const pending=latestPageRefresh.refresh();await unmount(closed)
  assert.equal(await pending,false,'Unmount cancels queued recovery before starting another read')
  assert.equal(abandoned.calls.length,1)
  held.resolve(response(clone(abandoned.snapshot)))
}

async function balanceFirstPendingRecoveryContracts(){
  const state=fixture();state.snapshot.projectionPending=true
  const tree=await mount({balanceFirst:true})
  const full=()=>state.calls.filter(call=>call.url==='/app/reimbursements'&&!call.body)
  assert.equal(full().length,1,'Pending work receives one automatic full recovery')
  await act(async()=>{for(const cb of listeners.window.get('focus')){cb();cb()}await flush()})
  assert.equal(full().length,1,'The same pending version cannot cause a recovery loop')
  await act(async()=>{await latestPageRefresh.refresh();await flush()})
  assert.equal(full().length,2,'Explicit refresh can retry a pending version')
  await unmount(tree)
}

async function balanceFirstHiddenRecoveryContracts(){
  const state=fixture();state.snapshot.allocations=[];state.snapshot.events=[];state.snapshot.projectionPending=true;state.snapshot.resetState='inactive-revision-1'
  const tree=await mount({balanceFirst:true}),full=()=>state.calls.filter(call=>call.url==='/app/reimbursements'&&!call.body)
  assert.equal(full().length,1,'Hidden pending corrections recover even when the visible list is empty')
  assert.ok(!text(tree.root).includes('Recorded. Expense sheets are still syncing.'))
  state.snapshot.resetState='inactive-revision-2'
  await act(async()=>{for(const callback of listeners.window.get('focus'))callback();await flush()})
  assert.equal(full().length,2,'An advanced complete cursor recovers another hidden correction')
  await act(async()=>{for(const callback of listeners.window.get('focus'))callback();await flush()})
  assert.equal(full().length,2,'Unchanged inactive work remains bounded')
  await unmount(tree)
}

async function reimbursementUpdatedTimeContracts(){
  const initial=deferred(),seen=[];let fail=false,revoked=false,reads=0
  fixture({get:state=>++reads===1?initial.promise:response(fail?{error:'Read failed'}:revoked?{error:'Sign in again'}:state.snapshot,fail?503:revoked?401:200)})
  const tree=await mount({balanceFirst:true,onUpdated:value=>seen.push(value)})
  assert.equal(seen.at(-1),null,'Loading cannot claim a successful update')
  await act(async()=>{initial.resolve(response(clone(sample)));await flush()})
  assert.equal(typeof seen.at(-1),'number','A verified reimbursement display read owns its update time')
  const updated=seen.at(-1),count=seen.length;fail=true
  await act(async()=>{for(const callback of listeners.window.get('focus'))callback();await flush()})
  assert.equal(seen.length,count,'A failed refresh cannot advance freshness')
  assert.equal(seen.at(-1),updated)
  fail=false;revoked=true
  await act(async()=>{for(const callback of listeners.window.get('focus'))callback();await flush()})
  assert.equal(seen.at(-1),null,'Lost access clears the previous owner timestamp')
  await unmount(tree)
}

async function balanceFirstFreshReadContracts(){
  const held=deferred(),next=deferred(),last=deferred();let reads=0
  const state=fixture({get:state=>++reads===1?response(clone(state.snapshot)):reads===2?held.promise:reads===3?next.promise:last.promise})
  const tree=await mount({balanceFirst:true});let first,fresh,same
  await act(async()=>{first=latestPageRefresh.refresh();await flush()})
  const before=clone(state.snapshot)
  state.snapshot.allocations[0].settledCents+=100;state.snapshot.allocations[0].outstandingCents-=100;state.snapshot.allocations[0].version++;state.snapshot.allocations[0].projectedVersion++
  state.snapshot.events.push(receipt({id:'new-receipt',operationId:'new-receipt',amountCents:100}))
  await act(async()=>{fresh=latestPageRefresh.refresh();same=latestPageRefresh.refresh();await flush()})
  assert.equal(state.calls.length,2,'Concurrent fresh refreshes queue once behind an older full read')
  await act(async()=>{held.resolve(response(before));await first;await flush()})
  assert.equal(state.calls.length,3,'The newer refresh gets a separate source read')
  let late
  await act(async()=>{late=latestPageRefresh.refresh();await flush()})
  assert.equal(state.calls.length,3,'A later invalidation queues behind the running recovery')
  await act(async()=>{next.resolve(response(before));await fresh;await same;await flush()})
  assert.equal(state.calls.length,4,'A refresh requested after the queued read began receives its own source read')
  await act(async()=>{last.resolve(response(clone(state.snapshot)));await late;await flush()})
  const row=tree.root.findAllByType('button').find(node=>node.props.className==='sr-row-main'&&node.props['aria-label'].startsWith('PG&E,'))
  assert.ok(text(row).includes('$79.00'),'Only the final fresh version wins');assert.equal(state.calls.length,4);await unmount(tree)
}

async function lazyRetainedExpansionContracts(){
  const {EditorExpansion}=load(path.join(frontend,'src/transaction-editor-workspace.tsx'))
  for(const retain of [false,true]){
    let mounts=0,unmounts=0
    function Draft(){const [value,setValue]=React.useState('');React.useEffect(()=>{mounts++;return()=>{unmounts++}},[]);return React.createElement('input',{value,onChange:e=>setValue(e.target.value)})}
    const render=open=>React.createElement(EditorExpansion,{open,retain},React.createElement(Draft))
    let tree;await act(async()=>{tree=Renderer.create(render(false));await flush()});assert.equal(mounts,0,'Cold closed editors are never constructed')
    await act(async()=>{tree.update(render(true));await flush()});assert.equal(mounts,1)
    await act(async()=>{tree.root.findByType('input').props.onChange({target:{value:'Retain this draft'}});tree.update(render(false));await flush()})
    assert.equal(unmounts,retain?0:1,'Only opted-in visited editors retain their controller')
    await act(async()=>{tree.update(render(true));await flush()});assert.equal(mounts,retain?1:2)
    assert.equal(tree.root.findByType('input').props.value,retain?'Retain this draft':'')
    await act(async()=>{tree.unmount();await flush()})
  }
}

;(async () => {
  await lazyRetainedExpansionContracts()
  await balanceFirstRejectedCommandContracts()
  await balanceFirstRetainedDraftContracts()
  await balanceFirstNativeSplitContracts()
  await balanceFirstZeroShareRetentionContracts()
  await balanceFirstFastLoadingContracts()
  await queuedFeedbackContracts()
  await acknowledgedUndoDoesNotWaitForDuplicateRead()
  await immediateUndoAndRollback()
  await balanceFirstPendingRecoveryContracts()
  await balanceFirstHiddenRecoveryContracts()
  await reimbursementUpdatedTimeContracts()
  await balanceFirstFreshReadContracts()
  await splitEditorContracts()
  await matchedReceiptContracts()
  await bulkReceiveContracts()
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
