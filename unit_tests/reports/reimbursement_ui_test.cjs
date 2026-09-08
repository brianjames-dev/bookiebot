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
const { SharedReimbursementsCard, reimbursementGroups, reimbursementTimeline, reimbursementLedger } = load(path.join(frontend, "src/shared-reimbursements.tsx"))
const item = (id, changes = {}) => ({
  id, date: "9/3/2026", item: id, location: "Test Store", payer: "Brian", partner: "Hannah",
  responsibleOwner: "", responsiblePerson: "", grossAmount: 100, personalShare: 60,
  partnerShare: 40, receivedAmount: 0, outstandingAmount: 40, splitMethod: "50/50", status: "outstanding", ...changes,
})
const older = item("Last year's groceries", {date:"12/20/2025", outstandingAmount:25, receivedAmount:15})
const newer = item("This month's dinner")
const settled = item("Received dinner", {status:"reimbursed", outstandingAmount:0, receivedAmount:40})
const oldReceipt = {...older,status:"reimbursed",outstandingAmount:0,receivedAmount:40}
const complete = {status:"complete", asOf:"2026-09-07", years:[2025,2026], unavailableYears:[], excludedRecords:0}
const propsFor = (props = {}) => ({
  items: [settled], openItems:[older,newer], coverage:complete, monthLabel:"September 2026", year:2026, month:9, ...props,
})
const render = (props = {}) => renderToStaticMarkup(React.createElement(SharedReimbursementsCard, propsFor(props)))
const html = render()
assert.ok(html.includes("$65.00"))
assert.ok(html.includes('aria-label="September 2026 expenses"') && html.includes('aria-label="December 2025 expenses"'))
assert.ok(html.indexOf("This month&#x27;s dinner") < html.indexOf("Last year&#x27;s groceries"), "The selected expense month comes first")
assert.ok(html.includes("12/20/2025"), "Carried items retain their original date")
const summary = /<dl class="bb-reimbursement-summary"[\s\S]*?<\/dl>/.exec(html)[0]
assert.ok(summary.includes("$100.00") && summary.includes("$60.00") && summary.includes("$40.00"))
assert.ok(!summary.includes("$300.00"), "Old debt must not enter the selected expense-month statement")
assert.ok(!html.includes('class="bb-reimbursement-history"'), "Received and due expenses share one ledger")
assert.ok(html.includes("Received dinner") && html.includes("This month"))
assert.ok(html.includes('aria-expanded="false"') && html.includes('inert=""'), "The unified ledger starts collapsed")
assert.ok(render({items:[],openItems:[older]}).includes("Last year&#x27;s groceries"), "Old debt remains visible in a month without new shared purchases")
assert.equal(render({items:[],openItems:[]}), "")
const partial = render({items:[],openItems:[],coverage:{...complete,status:"partial",unavailableYears:[2025]}})
assert.ok(partial.includes("Known outstanding") && partial.includes("balance may be incomplete"))
assert.ok(!partial.includes("No outstanding reimbursements"), "A failed historical read must not look like all debts were settled")
const unavailable = render({items:[],openItems:[],coverage:{...complete,status:"unavailable",years:[],unavailableYears:[2025,2026]}})
assert.ok(unavailable.includes("Known outstanding") && unavailable.includes("balance may be incomplete"))
assert.ok(!unavailable.includes("No outstanding reimbursements"))
const legacy = render({items:[newer],openItems:undefined,coverage:undefined})
assert.ok(legacy.includes("$40.00") && legacy.includes('class="bb-reimbursement-note">September 2026'), "Saved older payloads remain month-scoped")
const groups = reimbursementGroups([newer, older, item("Alex share",{partner:"Alex",outstandingAmount:12}),
  item("Void",{status:"void"}), item("Received",{status:"reimbursed"}), item("Zero",{outstandingAmount:0})])
assert.deepEqual(Array.from(groups, g => [g.partner,g.amount]), [["Alex",12],["Hannah",65]])
const chronological = reimbursementGroups([item("later",{date:"1/2/2026"}),item("earlier",{date:"2025-12-31"})])
assert.equal(chronological[0].items[0].id,"earlier")

const partialCurrent = {...newer,receivedAmount:15,outstandingAmount:25}
const voided = item("Cancelled expense",{status:"void"})
const unified = reimbursementLedger([partialCurrent,settled,voided], [
  older,newer,item(settled.id),item(voided.id),item("Ignore received history",{status:"reimbursed"}),
  item("Ignore zero",{outstandingAmount:0}),item("Ignore negative",{outstandingAmount:-5}),
], "2026-09")
assert.deepEqual(Array.from(unified,group => group.key),["2026-09","2025-12"])
const unifiedItems = Array.from(unified).flatMap(group => Array.from(group.items))
assert.equal(unifiedItems.length,3, "Overlapping monthly and open records appear only once")
assert.equal(unifiedItems.find(entry => entry.id === newer.id).receivedAmount,15)
assert.equal(unifiedItems.find(entry => entry.id === newer.id).outstandingAmount,25)
assert.equal(unifiedItems.find(entry => entry.id === settled.id).status,"reimbursed",
  "A monthly receipt must not be overwritten by a repeated open record")
assert.ok(!unifiedItems.some(entry => entry.id === voided.id), "A monthly void must suppress a repeated open record")
assert.deepEqual(Array.from(reimbursementLedger([], [
  item("Old",{date:"7/2/2026"}),item("Current",{date:"9/2/2026"}),item("Selected",{date:"8/2/2026"}),
  item("Unknown",{date:"2026-02-30"}),
], "2026-08"),group => group.key),["2026-08","2026-09","2026-07","undated"],
  "Selected month comes first, then newest months, with uncertain dates last")
assert.equal(reimbursementLedger([
  item("First purchase",{item:"Same description"}),item("Second purchase",{item:"Same description"}),
],[],"2026-09")[0].items.length,2, "Matching names, dates and amounts cannot identify duplicate expenses")
const receivedLedger = reimbursementLedger([settled,voided],[older,newer,item(voided.id)],"2026-09",[
  oldReceipt,{...voided,status:"reimbursed",outstandingAmount:0,receivedAmount:40},partialCurrent,
])
const receivedLedgerItems = Array.from(receivedLedger).flatMap(group => Array.from(group.items))
assert.equal(receivedLedgerItems.length,3)
assert.equal(receivedLedgerItems.find(entry => entry.id === older.id).status,"reimbursed",
  "A carried expense remains listed as received after it leaves the open-items source")
assert.equal(receivedLedgerItems.find(entry => entry.id === newer.id).outstandingAmount,40,
  "Partial payments are not mistaken for fully received historical records")
assert.ok(!receivedLedgerItems.some(entry => entry.id === voided.id), "Monthly voids also suppress repeated receipt-history records")
assert.equal(reimbursementLedger([partialCurrent],[],"2026-09",[
  {...newer,status:"reimbursed",receivedAmount:40,outstandingAmount:0},
])[0].items[0].receivedAmount,15, "A complete monthly record wins over a repeated history record")

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
assert.deepEqual(timeline([
  item("Short year",{date:"9/3/26",outstandingAmount:1}),
  item("Earlier century",{date:"1/1/69",outstandingAmount:2}),
  item("Later century",{date:"1/1/68",outstandingAmount:3}),
]), [["January 1969",2],["September 2026",1],["January 2068",3]],
  "Two-digit date years follow the backend parser's century pivot")
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
const receivedOnly = render({items:[],openItems:[],receivedItems:[oldReceipt]})
assert.ok(receivedOnly.includes("Last year&#x27;s groceries") && receivedOnly.includes("Received"))
assert.ok(receivedOnly.includes("View 1") && receivedOnly.includes("No outstanding reimbursements"))
assert.ok(!receivedOnly.includes('aria-label="Outstanding by expense month"'))
assert.ok(!receivedOnly.includes('class="bb-reimbursement-summary"'), "Past receipts do not invent totals for an empty selected expense month")
const withOldReceipt = render({receivedItems:[oldReceipt],openItems:[newer]})
const receiptScopedSummary = /<dl class="bb-reimbursement-summary"[\s\S]*?<\/dl>/.exec(withOldReceipt)[0]
assert.ok(receiptScopedSummary.includes("$40.00") && !receiptScopedSummary.includes("$80.00"),
  "A prior expense month's receipt does not enter selected-month receipt totals")

// Use the real disclosure component: retaining hidden detail text for exit
// animation must not expose either long ledger until its own button is opened.
const renderer = frontendRequire("react-test-renderer")
let tree
renderer.act(() => { tree = renderer.create(React.createElement(SharedReimbursementsCard, propsFor())) })
const chart = tree.root.findByProps({"aria-label":"Outstanding by expense month"})
const bars = chart.findAllByProps({className:"bb-reimbursement-bar-track"})
assert.equal(bars.length,1,"Outstanding months share one stacked bar")
const segments = bars[0].findAllByType("span")
const widths = segments.map(segment => parseFloat(segment.props.style.width))
assert.equal(tree.root.findByProps({className:"bb-reimbursement-total"}).props.children,"$65.00")
assert.ok(widths.every(width => Number.isFinite(width) && width > 0 && width <= 100))
assert.ok(Math.abs(widths[0] - 25 / 65 * 100) < 1e-9)
assert.ok(Math.abs(widths[1] - 40 / 65 * 100) < 1e-9)
assert.ok(Math.abs(widths.reduce((sum,width) => sum + width,0) - 100) < 1e-9,
  "Stacked segments represent the whole outstanding amount, excluding received or personal shares")
const legend = chart.findAllByType("li")
assert.equal(legend.length,segments.length)
for (const [index,segment] of segments.entries()) {
  assert.equal(segment.props["data-segment"],legend[index].props["data-segment"],
    "Each segment and its legend must select the same color")
  assert.ok(legend[index].findByProps({className:"bb-reimbursement-swatch"}))
}
assert.equal(new Set(segments.map(segment => segment.props["data-segment"])).size,segments.length,
  "Different expense months retain distinguishable legend colors")
assert.ok(bars.every(bar => bar.props["aria-hidden"] === "true" || bar.props["aria-hidden"] === true),
  "Decorative bars do not duplicate their visible amount labels for assistive technology")
const openList = tree.root.findByProps({className:"bb-reimbursement-open-list"})
assert.equal(tree.root.findAllByProps({className:"bb-reimbursement-history"}).length,0)
function disclosure(host) {
  const button = host.findAllByType("button").find(node => node.props["aria-controls"])
  assert.ok(button, "Each summary must control its own disclosure")
  const content = host.findAllByType("div").find(node => node.props.id === button.props["aria-controls"])
  assert.ok(content)
  return {button,content}
}
const openLedger = disclosure(openList)
assert.equal(openLedger.button.props["aria-expanded"],false)
assert.equal(openLedger.content.props["aria-hidden"],true)
assert.equal(openLedger.content.props.inert,"")
const monthGroups = openList.findAllByProps({className:"bb-reimbursement-group"})
assert.equal(monthGroups[0].props["aria-label"],"September 2026 expenses")
assert.equal(monthGroups[0].findByProps({className:"bb-reimbursement-month-tag"}).children.join(""),"This month")
assert.equal(monthGroups[0].findAllByProps({className:"bb-reimbursement-entry"}).length,2,
  "Received and outstanding expenses are grouped together by their original expense month")
assert.equal(monthGroups[0].findAllByProps({className:"bb-reimbursement-summary"}).length,1)
assert.equal(monthGroups[1].findAllByProps({className:"bb-reimbursement-summary"}).length,0,
  "Carried-forward debts do not acquire a misleading complete monthly statement")
const totalsButton = monthGroups[0].findByProps({"aria-label":"September 2026 reimbursement totals"})
assert.equal(totalsButton.type,"button")
assert.equal(totalsButton.props.type,"button")
assert.equal(totalsButton.props["aria-expanded"],false)
const totalsPanel = monthGroups[0].findAllByType("div").find(node => node.props.id === totalsButton.props["aria-controls"])
assert.ok(totalsPanel,"The month info button must control the selected expense-month totals")
assert.equal(totalsPanel.props["aria-hidden"],true)
assert.equal(totalsPanel.props.inert,"")
renderer.act(() => openLedger.button.props.onClick())
assert.equal(openLedger.button.props["aria-expanded"],true)
assert.equal(openLedger.content.props["data-state"],"open")
assert.equal(openLedger.content.props.inert,undefined)
assert.equal(totalsPanel.props.inert,"","Opening the expense ledger does not automatically show its aggregate totals")
renderer.act(() => totalsButton.props.onClick())
assert.equal(totalsButton.props["aria-expanded"],true)
assert.equal(totalsPanel.props["data-state"],"open")
assert.equal(totalsPanel.props.inert,undefined)
assert.equal(totalsPanel.findAllByProps({className:"bb-reimbursement-summary"}).length,1)
renderer.act(() => totalsButton.props.onClick())
assert.equal(totalsPanel.props["data-state"],"closed")
assert.equal(totalsPanel.props.inert,"","Totals retain the animated closing container and leave keyboard navigation")
const expense = openList.findAllByProps({className:"bb-reimbursement-entry"})[1]
const expenseDetails = disclosure(expense)
const compactLabel = expenseDetails.button.findByProps({className:"bb-reimbursement-item"})
assert.equal(compactLabel.findAllByType("strong").length,1)
assert.equal(compactLabel.findAllByType("span").length,1,"The compact item label contains no date/partner subtitle")
const receiptMeta = expenseDetails.content.findByProps({className:"bb-reimbursement-receipt-meta"})
assert.match(receiptMeta.children.join(""),/Test Store.*9\/3\/2026.*Hannah/,
  "The full location, expense date and partner remain available in expanded details")
assert.equal(expenseDetails.content.props.inert,"", "Individual financial details remain a separate disclosure")
renderer.act(() => expenseDetails.button.props.onClick())
assert.equal(expenseDetails.content.props.inert,undefined)
renderer.act(() => openLedger.button.props.onClick())
assert.equal(openLedger.content.props.inert,"")
assert.equal(openLedger.content.props["data-state"],"closed", "Closing retains the same animation container")
renderer.act(() => tree.unmount())
renderer.act(() => { tree = renderer.create(React.createElement(SharedReimbursementsCard, propsFor({
  items:[item("Future expense",{date:"9/20/2026"})],openItems:[older],
}))) })
assert.equal(tree.root.findByProps({className:"bb-reimbursement-total"}).props.children,"$25.00",
  "Future-dated monthly records may be inspected without entering the currently outstanding balance")
assert.equal(tree.root.findByProps({"aria-label":"Outstanding by expense month"}).findAllByType("li").length,1)
assert.equal(tree.root.findAllByProps({className:"bb-reimbursement-group"})[0].props["aria-label"],"September 2026 expenses")
renderer.act(() => tree.unmount())
renderer.act(() => { tree = renderer.create(React.createElement(SharedReimbursementsCard, propsFor({
  items:[{...settled,date:"8/3/2026"}],month:8,monthLabel:"August 2026",
}))) })
const historicalGroups = tree.root.findAllByProps({className:"bb-reimbursement-group"})
assert.equal(historicalGroups[0].props["aria-label"],"August 2026 expenses")
assert.equal(historicalGroups[0].findByProps({className:"bb-reimbursement-month-tag"}).children.join(""),"Selected month")
assert.equal(historicalGroups[1].props["aria-label"],"September 2026 expenses")
assert.equal(historicalGroups[1].findByProps({className:"bb-reimbursement-month-tag"}).children.join(""),"This month",
  "Current-month labels follow the report's Pacific as-of date, not the browser's clock")
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
