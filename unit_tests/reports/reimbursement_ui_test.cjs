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
const modules = new Map()
function load(file) {
  if (modules.has(file)) return modules.get(file)
  const exports = {}
  modules.set(file, exports)
  const localRequire = (name) => {
    if (!name.startsWith(".")) return frontendRequire(name)
    const base = path.resolve(path.dirname(file), name)
    return load([base + ".tsx", base + ".ts"].find(fs.existsSync))
  }
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  vm.runInNewContext(outputText, { exports, require: localRequire })
  return exports
}
const { SharedReimbursementsCard, reimbursementGroups, reimbursementTimeline } = load(path.join(frontend, "src/shared-reimbursements.tsx"))
const item = (id, changes = {}) => ({
  id, date: "9/3/2026", item: id, location: "Test Store", payer: "Brian", partner: "Hannah",
  responsibleOwner: "", responsiblePerson: "", grossAmount: 100, personalShare: 60,
  partnerShare: 40, receivedAmount: 0, outstandingAmount: 40, splitMethod: "50/50", status: "outstanding", ...changes,
})
const older = item("Last year's groceries", {date:"12/20/2025", outstandingAmount:25, receivedAmount:15})
const newer = item("This month's dinner")
const settled = item("Received dinner", {status:"reimbursed", outstandingAmount:0, receivedAmount:40})
const complete = {status:"complete", asOf:"2026-09-07", years:[2025,2026], unavailableYears:[], excludedRecords:0}
const propsFor = (props = {}) => ({
  items: [settled], openItems:[older,newer], coverage:complete, monthLabel:"September 2026", ...props,
})
const render = (props = {}) => renderToStaticMarkup(React.createElement(SharedReimbursementsCard, propsFor(props)))
const html = render()
assert.ok(html.includes("$65.00") && html.includes("Across all months"))
assert.ok(html.includes('aria-label="Owed by Hannah"'))
assert.ok(html.indexOf("Last year&#x27;s groceries") < html.indexOf("This month&#x27;s dinner"), "Oldest outstanding expense comes first")
assert.ok(html.includes("12/20/2025"), "Carried items retain their original date")
const summary = /<dl class="bb-reimbursement-summary"[\s\S]*?<\/dl>/.exec(html)[0]
assert.ok(summary.includes("$100.00") && summary.includes("$60.00") && summary.includes("$40.00"))
assert.ok(!summary.includes("$300.00"), "Old debt must not enter the selected expense-month statement")
const history = html.slice(html.indexOf('class="bb-reimbursement-history"'))
assert.ok(history.includes("September 2026 expenses"))
assert.ok(history.includes('aria-expanded="false"') && history.includes('inert=""'), "Received history starts collapsed")
assert.ok(history.includes("Received dinner"))
assert.ok(render({items:[],openItems:[older]}).includes("Last year&#x27;s groceries"), "Old debt remains visible in a month without new shared purchases")
assert.equal(render({items:[],openItems:[]}), "")
const partial = render({items:[],openItems:[],coverage:{...complete,status:"partial",unavailableYears:[2025]}})
assert.ok(partial.includes("Known outstanding") && partial.includes("balance may be incomplete"))
assert.ok(!partial.includes("No outstanding reimbursements"), "A failed historical read must not look like all debts were settled")
const unavailable = render({items:[],openItems:[],coverage:{...complete,status:"unavailable",years:[],unavailableYears:[2025,2026]}})
assert.ok(unavailable.includes("Known outstanding") && unavailable.includes("balance may be incomplete"))
assert.ok(!unavailable.includes("No outstanding reimbursements"))
const legacy = render({items:[newer],openItems:undefined,coverage:undefined})
assert.ok(legacy.includes("$40.00") && !legacy.includes("Across all months"), "Saved older payloads remain month-scoped")
const groups = reimbursementGroups([newer, older, item("Alex share",{partner:"Alex",outstandingAmount:12}),
  item("Void",{status:"void"}), item("Received",{status:"reimbursed"}), item("Zero",{outstandingAmount:0})])
assert.deepEqual(Array.from(groups, g => [g.partner,g.amount]), [["Alex",12],["Hannah",65]])
const chronological = reimbursementGroups([item("later",{date:"1/2/2026"}),item("earlier",{date:"2025-12-31"})])
assert.equal(chronological[0].items[0].id,"earlier")

// The graph has one scope: outstanding amounts, organized by expense month.
// Partial receipts affect the remaining debt, not a separate monthly denominator.
const timeline = entries => Array.from(reimbursementTimeline(entries), row => [row.label, row.amount])
assert.deepEqual(timeline([newer, older]), [["December 2025",25],["September 2026",40]])
assert.deepEqual(timeline([
  item("September ISO",{date:"2026-09-02",outstandingAmount:0.1}),
  item("September slash",{date:"9/3/2026",outstandingAmount:0.2}),
  item("Unknown",{date:"not a date",outstandingAmount:7}),
  item("Void",{status:"void"}), item("Received",{status:"reimbursed"}),
  item("Zero",{outstandingAmount:0}), item("Negative",{outstandingAmount:-5}),
]), [["September 2026",0.3],["Undated",7]])
assert.deepEqual(timeline([settled,item("Zero",{outstandingAmount:0})]), [])
assert.deepEqual(timeline([
  item("Leap day",{date:"2024-02-29",outstandingAmount:1}),
  item("Invalid day",{date:"2026-02-30",outstandingAmount:2}),
]), [["February 2024",1],["Undated",2]], "Invalid dates must not invent an expense month")
const sixMonths = Array.from({length:6}, (_,index) => item(`Month ${index+1}`, {
  date:`${index+1}/2/2026`,outstandingAmount:index+1,
}))
assert.deepEqual(timeline(sixMonths), [["Earlier expenses",6],["April 2026",4],["May 2026",5],["June 2026",6]])
assert.deepEqual(Array.from(reimbursementTimeline(sixMonths)[0].months), ["January 2026","February 2026","March 2026"],
  "The compacted group retains which expense months it contains")
assert.deepEqual(timeline([...sixMonths.slice(0,4),item("Unknown",{date:"",outstandingAmount:5})]),
  [["Earlier expenses",3],["March 2026",3],["April 2026",4],["Undated",5]])
assert.equal(reimbursementTimeline(sixMonths).reduce((sum,row) => sum + row.amount,0),21,
  "Compacting older months cannot lose or duplicate debt")
assert.ok(html.includes('aria-label="Outstanding by expense month"'))
assert.ok(html.includes("December 2025") && html.includes("September 2026"))
assert.ok(!render({items:[settled],openItems:[]}).includes('aria-label="Outstanding by expense month"'),
  "A fully settled month retains its statement without an invented outstanding graph")
const partialReceipt = render({items:[older],openItems:[older]})
const partialReceiptSummary = /<dl class="bb-reimbursement-summary"[\s\S]*?<\/dl>/.exec(partialReceipt)[0]
assert.ok(partialReceiptSummary.includes("$15.00"), "The monthly statement includes partial receipts, even before full settlement")
assert.ok(!partialReceipt.includes("$125.00"), "Gross amounts are not combined with outstanding amounts for a chart total")

// Use the real disclosure component: retaining hidden detail text for exit
// animation must not expose either long ledger until its own button is opened.
const renderer = frontendRequire("react-test-renderer")
let tree
renderer.act(() => { tree = renderer.create(React.createElement(SharedReimbursementsCard, propsFor())) })
const chart = tree.root.findByProps({"aria-label":"Outstanding by expense month"})
const bars = chart.findAllByProps({className:"bb-reimbursement-bar-track"})
const widths = bars.map(bar => parseFloat(bar.findByType("span").props.style.width))
assert.equal(tree.root.findByProps({className:"bb-reimbursement-total"}).props.children,"$65.00")
assert.ok(widths.every(width => Number.isFinite(width) && width > 0 && width <= 100))
assert.ok(Math.abs(widths[0] - 25 / 65 * 100) < 1e-9)
assert.ok(Math.abs(widths[1] - 40 / 65 * 100) < 1e-9)
assert.ok(Math.abs(widths.reduce((sum,width) => sum + width,0) - 100) < 1e-9,
  "Every bar uses the same outstanding total, without monthly receipts or gross amounts in its denominator")
assert.ok(bars.every(bar => bar.props["aria-hidden"] === "true" || bar.props["aria-hidden"] === true),
  "Decorative bars do not duplicate their visible amount labels for assistive technology")
const openList = tree.root.findByProps({className:"bb-reimbursement-open-list"})
const monthlyStatement = tree.root.findByProps({className:"bb-reimbursement-history"})
function disclosure(host) {
  const button = host.findAllByType("button").find(node => node.props["aria-controls"])
  assert.ok(button, "Each summary must control its own disclosure")
  const content = host.findAllByType("div").find(node => node.props.id === button.props["aria-controls"])
  assert.ok(content)
  return {button,content}
}
const openLedger = disclosure(openList), statement = disclosure(monthlyStatement)
for (const {button,content} of [openLedger,statement]) {
  assert.equal(button.props["aria-expanded"],false)
  assert.equal(content.props["aria-hidden"],true)
  assert.equal(content.props.inert,"")
}
assert.notEqual(openLedger.button.props["aria-controls"],statement.button.props["aria-controls"])
renderer.act(() => openLedger.button.props.onClick())
assert.equal(openLedger.button.props["aria-expanded"],true)
assert.equal(openLedger.content.props["data-state"],"open")
assert.equal(openLedger.content.props.inert,undefined)
assert.equal(statement.content.props.inert,"", "Opening old debt does not expand the monthly statement")
renderer.act(() => statement.button.props.onClick())
assert.equal(statement.content.props["aria-hidden"],false)
assert.equal(statement.content.props.inert,undefined)
const expense = openList.findAllByProps({className:"bb-reimbursement-entry"})[1]
const expenseDetails = disclosure(expense)
assert.equal(expenseDetails.content.props.inert,"", "Individual financial details remain a separate disclosure")
renderer.act(() => expenseDetails.button.props.onClick())
assert.equal(expenseDetails.content.props.inert,undefined)
renderer.act(() => openLedger.button.props.onClick())
assert.equal(openLedger.content.props.inert,"")
assert.equal(openLedger.content.props["data-state"],"closed", "Closing retains the same animation container")
renderer.act(() => tree.unmount())
renderer.act(() => { tree = renderer.create(React.createElement(SharedReimbursementsCard, propsFor({
  coverage:{...complete,status:"partial",unavailableYears:[2025]},
}))) })
const warning = tree.root.findByProps({className:"bb-reimbursement-warning"})
assert.equal(warning.props.role,"status")
for (let ancestor = warning.parent; ancestor; ancestor = ancestor.parent) {
  assert.notEqual(ancestor.props.inert,"", "Incomplete coverage is always visible outside the closed financial details")
  assert.notEqual(ancestor.props["aria-hidden"],true)
}
renderer.act(() => tree.unmount())
console.log("Reimbursement carry-forward, timeline and disclosure checks passed")
