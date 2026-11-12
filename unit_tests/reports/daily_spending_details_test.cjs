const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")
const req = createRequire(path.resolve("web/expense-report/package.json"))
const ts = req("typescript")
const React = req("react")
const { act, create } = req("react-test-renderer")
global.IS_REACT_ACT_ENVIRONMENT = true

// Exercise the real disclosure, dropdown, table and chart button. Only the
// chart's drawing surface is replaced; no browser or financial service is used.
const source = fs.readFileSync("web/expense-report/src/report-app.tsx", "utf8")
const file = ts.createSourceFile("report-app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set([
  "money", "formatMoney", "DailySpendingSection", "DailySpendingChart", "MemoizedDailySpendingChart", "DailyEntriesTable",
  "DailySpendingPlot", "MemoizedDailySpendingPlot", "CategoryFilterControl", "compareDayGroups", "dailyEntryDayLabel", "isCurrentCalendarDay", "PACIFIC_CALENDAR_DATE",
  "NEEDS_BAR_COLOR", "WANTS_BAR_COLOR", "DAILY_SPENDING_BAR_RADIUS", "DAILY_SPENDING_GRID_COLOR", "DAILY_SPENDING_BOUNDARY_COLOR",
  "dailySpendingAxis", "dailySpendingBreakAmount", "dailySpendingChartRows", "dailySpendingVisualAmount",
  "dailySpendingActualAmount", "dailySpendingAxisTickLabel", "dailySpendingYAxisDomain", "dailySpendingYAxisTicks",
  "dailySpendingTickRange", "dailySpendingCursorFill",
])
const declarations = file.statements.filter(statement => {
  if (ts.isFunctionDeclaration(statement)) return names.has(statement.name?.text)
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => names.has(item.name.getText(file)))
})
assert.equal(declarations.length, names.size)
const activityFile = ts.createSourceFile("activity.ts", fs.readFileSync("web/expense-report/src/report-activity.ts", "utf8"), ts.ScriptTarget.Latest, true)
const activityDay = activityFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "activityDay").getText(activityFile).replace("export ", "")
const motion = ts.transpileModule(fs.readFileSync("web/expense-report/src/components/ui/motion.tsx", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const motionRuntime = { exports: {}, require: req, window: {
  matchMedia: () => ({ matches: false }), setTimeout, clearTimeout,
} }
vm.runInNewContext(motion, motionRuntime)
const compiled = ts.transpileModule(activityDay + "\n" + declarations.map(node => node.getText(file)).join("\n") + "\nexports.Section = DailySpendingSection", {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const chartSurface = ({ children }) => React.createElement("div", null, children)
const runtime = {
  useAppNavigation: () => null,
  useDailySpendingSelection: require('./load_frontend_module.cjs')('daily-spending-selection.ts').useDailySpendingSelection,
recordedDateLabel:require('./load_frontend_module.cjs')('recorded-transaction-view.ts').recordedDateLabel,
  exports: {}, require: req, useState: React.useState, useEffect: React.useEffect, useLayoutEffect: React.useLayoutEffect, useId: React.useId,
  useRef: React.useRef, DailyTransactionDays: require("./load_frontend_module.cjs")("daily-transactions.tsx").DailyTransactionDays, memo: React.memo, useMemo: React.useMemo, useCallback: React.useCallback,
  CollapsibleContent: motionRuntime.exports.CollapsibleContent,
  useMediaQuery: () => true, stableBarAnimation: undefined, stableBarShape: undefined,
  ChartContainer: chartSurface, ResponsiveContainer: chartSurface, BarChart: chartSurface,
  CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Bar: () => null,
  ChartTooltip: () => null, DailySpendingTooltipContent: () => null,
}
runtime.X=props=>React.createElement('svg',props)
runtime.ChevronDown=props=>React.createElement('svg',props)
runtime.MetricAmount=({children,className})=>React.createElement('div',{className},children)
vm.runInNewContext(compiled, runtime)
const Section = runtime.exports.Section
let chartRenders = 0
const axis = runtime.dailySpendingAxis
runtime.dailySpendingAxis = (...args) => { chartRenders++; return axis(...args) }
const entries = Array.from({ length: 42 }, (_, index) => ({
  date: index === 41 ? "" : `10/${index % 10 + 1}/2026`,
  category: index % 2 ? "Shopping" : "Food", item: `Purchase ${index}`, location: "", person: "Brian",
  amount: index + 1, status: index === 40 ? "scheduled" : "recorded",
}))
let inspections = []
let props = { entries, year: 2026, month: 10, filter: "all", data: [{ label: "1", amount: 100, needsAmount: 0, wantsAmount: 100 }],
  total: 903, categoryColors: { Food: "red", Shopping: "blue" }, onInspectDay: (...args) => inspections.push(args) }
let renderer
const controlFocus=[]
act(() => { renderer = create(React.createElement(Section, props), {createNodeMock: element => element.props.className === 'bb-daily-morph-control' ? {
 querySelector: selector => ['.bb-daily-active-filter','.bb-daily-transactions-toggle'].includes(selector) ? {focus: options => controlFocus.push({selector,options})} : null,
} : null}) })
const toggle = () => renderer.root.findByProps({ className: "bb-details-toggle bb-daily-transactions-toggle" })
const disclosure = () => renderer.root.findAllByProps({ className: "bb-details-content" })[0]
const select = () => renderer.root.findByType("select")
const table = () => renderer.root.findByType(runtime.DailyEntriesTable)
const changeCategory = value => act(() => { select().props.onChange({ target: { value } }) })
const update = changes => { props = { ...props, ...changes }; act(() => renderer.update(React.createElement(Section, props))) }
const text = () => JSON.stringify(renderer.toJSON())

assert.equal(toggle().findByType('span').children.join(''), "Transactions")
assert.equal(toggle().findByType('svg').props['aria-hidden'], 'true')
const amountRow=renderer.root.findByProps({className:'bb-daily-amount-row'})
assert.equal(amountRow.children[0].type,runtime.MetricAmount,'Total amount and Transactions share the same row')
assert.equal(amountRow.findByProps({className:'bb-details-toggle bb-daily-transactions-toggle'}),toggle())
assert.equal(toggle().props["aria-expanded"], false)
assert.equal(renderer.root.findAllByType(runtime.DailyEntriesTable).length, 0, "Closed transaction rows are not mounted")
assert.equal(disclosure().props.inert, true)
assert.equal(toggle().props["aria-controls"], disclosure().props.id)
act(() => toggle().props.onClick())
assert.equal(controlFocus.at(-1).selector,'.bb-daily-active-filter','Opening must focus the group rather than invoke the native select picker')
const filterGroup=renderer.root.findByProps({className:'bb-daily-active-filter'})
assert.equal(filterGroup.props.role,'group')
assert.equal(filterGroup.props.tabIndex,-1)
assert.equal(filterGroup.props['aria-label'],'Transaction filters')
assert.equal(renderer.root.findByProps({ "aria-label": "Close transactions" }).props["aria-expanded"], true)
assert.equal(disclosure().props.inert, false)
assert.equal(table().props.entries.length, 42, "Details includes every entry without truncation")
const days = () => renderer.root.findAllByProps({ className: "bb-daily-day-header" })
assert.equal(days().length, 11, "Every day and the undated group remains")
assert.equal(days().at(-1).findByProps({className:"bb-daily-day"}).children.join(""), "No date")
act(() => days().at(-1).props.onClick())
assert.ok(text().includes("Purchase 41"), "Undated transactions remain in the full list")
act(() => days().at(-2).props.onClick())
act(() => days().find(day => day.findByProps({className:"bb-daily-day"}).children.join("") === "1").props.onClick())
assert.ok(text().includes("Scheduled") && !text().includes("Recorded"))
for (const label of ["Tracked days", "Avg/day", "Days counted", "Highest day"]) assert.ok(!text().includes(label))
assert.deepEqual(select().findAllByType("option").map(option => option.props.children), ["All types", "Food", "Shopping"])
assert.equal(select().props["aria-label"], "Transaction type")

const chartRendersBeforeTypeChange = chartRenders
changeCategory("Shopping")
assert.equal(chartRenders, chartRendersBeforeTypeChange, "A list type filter cannot rebuild or restart the chart")
assert.equal(table().props.entries.length, 21)
assert.ok(table().props.entries.every(entry => entry.category === "Shopping"))
assert.ok(!text().includes("Purchase 0\""))
assert.ok(text().includes("$68.00"), "Day 2 totals only its selected-category transactions")
assert.equal(renderer.root.findByProps({ className: "bb-chart-total" }).props.children, "$903.00", "Type filters leave chart totals unchanged")
assert.ok(days().every(day => day.props["aria-controls"]), "Day headers expand their own content")
act(() => renderer.root.findByType(runtime.DailySpendingPlot).props.onInspectDay("1"))
assert.deepEqual(inspections.pop(), ["1"], "The chart keeps its full daily inspection")
act(() => renderer.root.findByProps({ "aria-label": "Close transactions" }).props.onClick())
assert.equal(controlFocus.at(-1).selector,'.bb-daily-transactions-toggle','Closing restores the original trigger')
assert.equal(disclosure().props.inert, true)
act(() => toggle().props.onClick())
assert.equal(select().props.value, "Shopping", "Collapse/reopen retains the filter")
changeCategory("")
assert.equal(table().props.entries.length, 42)

changeCategory("Shopping")
update({ entries: [entries[0]], filter: "needs" })
assert.equal(select().props.value, "")
assert.equal(table().props.entries.length, 1, "A single entry still expands through Details")
update({ entries: [] })
assert.ok(text().includes("No transactions found."))
assert.equal(select().findAllByType("option").length, 1)
update({ entries: [entries[1]] })
changeCategory("Shopping")
update({ month: 9 })
assert.equal(select().props.value, "", "Month changes reset the category selection")
act(() => renderer.unmount())
console.log("Daily spending Details: full list, category filters, totals, scope changes and day inspection passed")

let disclosureFixture
act(()=>{disclosureFixture=create(React.createElement(runtime.DailySpendingChart,{data:[],total:0,filter:'all',detailsOpen:true,detailsId:'fixture-chart',onToggleDetails(){},onInspectDay(){},graphOpen:false,graphControls:React.createElement('button',null,'Graph period'),graphStatus:React.createElement('p',null,'Graph unavailable'),graphBusy:false}))})
const reveal=disclosureFixture.root.findByProps({className:'bb-recorded-graph-reveal'})
assert.equal(reveal.children.length,1,'Graph controls must remain inside the existing single collapse wrapper')
assert.equal(reveal.children[0].props.className,'bb-recorded-graph-clip')
assert.equal(reveal.children[0].findByType('button').children.join(''),'Graph period')
assert.equal(reveal.children[0].props['aria-busy'],false,'An error is a terminal state, not an endlessly busy graph')
act(()=>disclosureFixture.unmount())
