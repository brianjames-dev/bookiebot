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
function renderedText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (node?.props?.["aria-hidden"] === true || node?.props?.["aria-hidden"] === "true") return ""
  return (node?.children ?? []).map(renderedText).join("")
}
function definitionPairs(host) {
  const labels = host.findAllByType("dt"), values = host.findAllByType("dd")
  assert.equal(labels.length,values.length,"Every receipt field must retain its own labeled value")
  return labels.map((label,index) => [renderedText(label),renderedText(values[index])])
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
assert.equal(totalsButton.props.className,"bb-reimbursement-month-totals-toggle")
assert.equal(renderedText(totalsButton),"Totals","Month totals use a visible label instead of an information-only icon")
assert.equal(totalsButton.findAllByType("svg").length,1,"The Totals control retains its disclosure chevron")
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
assert.equal(receiptMeta.type,"div")
assert.equal(renderedText(receiptMeta.findByProps({className:"bb-reimbursement-date"})),"9/3/2026 · Test Store")
assert.equal(renderedText(receiptMeta.findByProps({className:"bb-reimbursement-arrangement"})),"Paid by Brian · Split 50/50 with Hannah",
  "The compact metadata retains date, location, payer, partner and split method")
assert.equal(expenseDetails.content.props.inert,"", "Individual financial details remain a separate disclosure")
renderer.act(() => expenseDetails.button.props.onClick())
assert.equal(expenseDetails.content.props.inert,undefined)
const expenseTitle = renderedText(compactLabel)
assert.equal(renderedText(expense).split(expenseTitle).length-1,1,"An expanded receipt shows its item title only once")
assert.deepEqual(definitionPairs(expenseDetails.content.findByProps({className:"bb-reimbursement-split"})),[
  ["Gross paid","$100.00"],["Your share","$60.00"],["Partner share","$40.00"],["Received","$40.00"],
],"The financial hierarchy preserves every named amount")
renderer.act(() => openLedger.button.props.onClick())
assert.equal(openLedger.content.props.inert,"")
assert.equal(openLedger.content.props["data-state"],"closed", "Closing retains the same animation container")
renderer.act(() => tree.unmount())
const auditItem = item("A long grocery receipt title that must remain available without being repeated",{
  date:"9/4/2026",location:"Neighborhood Market",partner:"Hannah",grossAmount:200,personalShare:125,
  partnerShare:75,receivedAmount:20,outstandingAmount:55,splitMethod:"By income",responsiblePerson:"Brian",
})
renderer.act(() => { tree = renderer.create(React.createElement(SharedReimbursementsCard,propsFor({items:[auditItem],openItems:[auditItem]}))) })
const auditExpense = tree.root.findAllByProps({className:"bb-reimbursement-entry"})[1]
const auditDisclosure = disclosure(auditExpense)
const auditFields = definitionPairs(auditDisclosure.content)
assert.deepEqual(auditFields,[
  ["Gross paid","$200.00"],["Your share","$125.00"],["Partner share","$75.00"],["Received","$20.00"],
],"Partial receipts retain all four individually labeled financial values")
assert.equal(renderedText(auditDisclosure.content.findByProps({className:"bb-reimbursement-date"})),"9/4/2026 · Neighborhood Market")
assert.equal(renderedText(auditDisclosure.content.findByProps({className:"bb-reimbursement-arrangement"})),"Paid by Brian · Split by income with Hannah",
  "The arrangement identifies the payer without repeating a matching budget owner")
assert.equal(new Set(auditFields.map(([label]) => label)).size,auditFields.length,"Receipt fields are not duplicated")
renderer.act(() => auditDisclosure.button.props.onClick())
assert.equal(renderedText(auditExpense).split(auditItem.item).length-1,1)
renderer.act(() => tree.unmount())
const minimalItem = item("Receipt with missing optional metadata",{date:" ",location:" ",payer:" ",partner:" ",splitMethod:" \t",responsiblePerson:" \n"})
renderer.act(() => { tree = renderer.create(React.createElement(SharedReimbursementsCard,propsFor({items:[minimalItem],openItems:[minimalItem]}))) })
const minimalExpense = tree.root.findAllByProps({className:"bb-reimbursement-entry"})[1]
const minimalDetails = disclosure(minimalExpense).content
assert.equal(renderedText(minimalDetails.findByProps({className:"bb-reimbursement-date"})),"Undated")
assert.equal(renderedText(minimalDetails.findByProps({className:"bb-reimbursement-arrangement"})),"Split with Partner",
  "Whitespace-only optional metadata does not produce empty labels or separators")
assert.equal(definitionPairs(minimalDetails).length,4,"Metadata fallbacks retain all four financial values")
renderer.act(() => tree.unmount())
for (const [changes, expected] of [
  [{payer:" Brian ",partner:" Hannah ",responsiblePerson:" bRIAN ",splitMethod:" By income "},"Paid by Brian · Split by income with Hannah"],
  [{splitMethod:"70/30",responsiblePerson:"Joint budget"},"Paid by Brian · Split 70/30 with Hannah · Budget: Joint budget"],
  [{splitMethod:"Fronted",responsiblePerson:" hANNAH "},"Paid by Brian · Fronted for Hannah"],
  [{splitMethod:"fronted",responsiblePerson:"Joint budget"},"Paid by Brian · Fronted for Hannah · Budget: Joint budget"],
  [{splitMethod:"",responsiblePerson:"Hannah"},"Paid by Brian · Split with Hannah · Budget: Hannah"],
]) {
  const arrangementItem = item("Arrangement receipt",changes)
  renderer.act(() => { tree = renderer.create(React.createElement(SharedReimbursementsCard,propsFor({items:[arrangementItem],openItems:[arrangementItem]}))) })
  assert.equal(renderedText(tree.root.findByProps({className:"bb-reimbursement-arrangement"})),expected,
    "Custom splits, fronted expenses and a distinct budget owner retain their meaning")
  renderer.act(() => tree.unmount())
}
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
// The shared disclosure still works by itself, while controlled callers own
// the open state used by the month accordion.
const { AnimatedDisclosure } = load(path.join(frontend,"src/components/ui/motion.tsx"))
let standalone, controlled, controlledOpen = false
const requests = []
renderer.act(() => { standalone = renderer.create(React.createElement(AnimatedDisclosure,{summary:"Standalone"},"Detail")) })
const single = disclosure(standalone.root)
assert.equal(single.button.props["aria-expanded"],false)
renderer.act(() => single.button.props.onClick())
assert.equal(single.button.props["aria-expanded"],true)
assert.equal(single.content.props.inert,undefined)
renderer.act(() => single.button.props.onClick())
assert.equal(single.content.props.inert,"")
renderer.act(() => { single.button.props.onClick(); single.button.props.onClick() })
assert.equal(single.button.props["aria-expanded"],false,"Batched standalone toggles compose against the latest state")
renderer.act(() => standalone.unmount())
const controlledComponent = () => React.createElement(AnimatedDisclosure,{
  summary:"Controlled",open:controlledOpen,onOpenChange:next=>requests.push(next),
},"Controlled detail")
renderer.act(() => { controlled = renderer.create(controlledComponent()) })
const controlledRow = disclosure(controlled.root)
const controlledId = controlledRow.content.props.id
renderer.act(() => controlledRow.button.props.onClick())
assert.deepEqual(requests,[true])
assert.equal(controlledRow.button.props["aria-expanded"],false,"Controlled state changes only after its owner updates it")
controlledOpen = true
renderer.act(() => controlled.update(controlledComponent()))
assert.equal(controlledRow.content.props.inert,undefined)
assert.equal(controlledRow.content.props.id,controlledId)
renderer.act(() => controlledRow.button.props.onClick())
assert.deepEqual(requests,[true,false])
assert.equal(controlledRow.button.props["aria-expanded"],true)
controlledOpen = false
renderer.act(() => controlled.update(controlledComponent()))
assert.equal(controlledRow.content.props.inert,"")
assert.equal(controlledRow.content.props["data-state"],"closed")
renderer.act(() => controlled.unmount())

const receiptA = item("Accordion receipt A",{date:"9/5/2026"})
const receiptB = item("Accordion receipt B",{date:"9/2/2026"})
let accordionProps = propsFor({items:[receiptA,receiptB],openItems:[receiptA,older,receiptB]})
renderer.act(() => { tree = renderer.create(React.createElement(SharedReimbursementsCard,accordionProps)) })
function receiptRow(title) {
  let row = tree.root.findByProps({title})
  while (row && row.props.className !== "bb-reimbursement-entry") row = row.parent
  assert.ok(row)
  return disclosure(row)
}
renderer.act(() => disclosure(tree.root.findByProps({className:"bb-reimbursement-open-list"})).button.props.onClick())
renderer.act(() => receiptRow(receiptA.item).button.props.onClick())
assert.equal(receiptRow(receiptA.item).button.props["aria-expanded"],true)
renderer.act(() => receiptRow(receiptB.item).button.props.onClick())
assert.equal(receiptRow(receiptA.item).button.props["aria-expanded"],false,"Opening another expense closes the previous expense in that month")
assert.equal(receiptRow(receiptA.item).content.props.inert,"")
assert.equal(receiptRow(receiptB.item).button.props["aria-expanded"],true)
renderer.act(() => receiptRow(older.item).button.props.onClick())
assert.equal(receiptRow(receiptB.item).button.props["aria-expanded"],true,"Different months keep independent open expenses")
renderer.act(() => receiptRow(receiptB.item).button.props.onClick())
assert.equal(receiptRow(receiptB.item).button.props["aria-expanded"],false,"Clicking the current expense closes it")
assert.equal(receiptRow(older.item).button.props["aria-expanded"],true)
renderer.act(() => receiptRow(receiptB.item).button.props.onClick())
const updatedB = {...receiptB,date:"9/9/2026",status:"reimbursed",outstandingAmount:0,receivedAmount:40}
accordionProps = propsFor({items:[updatedB,receiptA],openItems:[older,receiptA],receivedItems:[updatedB]})
renderer.act(() => tree.update(React.createElement(SharedReimbursementsCard,accordionProps)))
assert.equal(receiptRow(receiptB.item).button.props["aria-expanded"],true,"Reordering and receipt updates preserve the open allocation id")
assert.equal(receiptRow(older.item).button.props["aria-expanded"],true)
assert.match(renderedText(receiptRow(receiptB.item).button),/Received/)
const activeByMonth = tree.root.findAllByProps({className:"bb-reimbursement-group"}).map(group =>
  group.findAllByProps({className:"bb-reimbursement-toggle"}).filter(button=>button.props["aria-expanded"]).length)
assert.deepEqual(activeByMonth,[1,1])
renderer.act(() => tree.unmount())
console.log("Reimbursement carry-forward, timeline and disclosure checks passed")
