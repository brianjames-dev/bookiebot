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
  "compareDayGroups", "dailyEntryDayLabel", "isCurrentCalendarDay", "PACIFIC_CALENDAR_DATE",
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
  exports: {}, require: req, useState: React.useState, useEffect: React.useEffect, useId: React.useId,
  memo: React.memo, useMemo: React.useMemo, useCallback: React.useCallback,
  CollapsibleContent: motionRuntime.exports.CollapsibleContent,
  ChartContainer: chartSurface, ResponsiveContainer: chartSurface, BarChart: chartSurface,
  CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Bar: () => null,
  ChartTooltip: () => null, DailySpendingTooltipContent: () => null,
}
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
act(() => { renderer = create(React.createElement(Section, props)) })
const toggle = () => renderer.root.findByProps({ className: "bb-details-toggle" })
const disclosure = () => renderer.root.findByProps({ className: "bb-details-content" })
const select = () => renderer.root.findByType("select")
const table = () => renderer.root.findByType(runtime.DailyEntriesTable)
const changeCategory = value => act(() => { select().props.onChange({ target: { value } }) })
const update = changes => { props = { ...props, ...changes }; act(() => renderer.update(React.createElement(Section, props))) }
const text = () => JSON.stringify(renderer.toJSON())

assert.equal(toggle().props.children, "Transactions")
assert.equal(toggle().props["aria-expanded"], false)
assert.equal(renderer.root.findAllByType(runtime.DailyEntriesTable).length, 0, "Closed transaction rows are not mounted")
assert.equal(disclosure().props.inert, true)
assert.equal(toggle().props["aria-controls"], disclosure().props.id)
act(() => toggle().props.onClick())
assert.equal(toggle().props["aria-expanded"], true)
assert.equal(disclosure().props.inert, false)
assert.equal(table().props.entries.length, 42, "Details includes every entry without truncation")
assert.ok(text().includes("Purchase 41"), "Undated transactions remain in the full list")
assert.ok(text().includes("Scheduled") && text().includes("Recorded"))
for (const label of ["Tracked days", "Avg/day", "Days counted", "Highest day"]) assert.ok(!text().includes(label))
assert.deepEqual(select().findAllByType("option").map(option => option.props.children), ["All types", "Food", "Shopping"])
assert.equal(renderer.root.findByType("label").props.htmlFor, select().props.id)

const chartRendersBeforeTypeChange = chartRenders
changeCategory("Shopping")
assert.equal(chartRenders, chartRendersBeforeTypeChange, "A list type filter cannot rebuild or restart the chart")
assert.equal(table().props.entries.length, 21)
assert.ok(table().props.entries.every(entry => entry.category === "Shopping"))
assert.ok(!text().includes("Purchase 0\"") && text().includes("Purchase 1\""))
assert.ok(text().includes("$68.00"), "Day 2 totals only its selected-category transactions")
assert.equal(renderer.root.findByProps({ className: "bb-chart-total" }).props.children, "$903.00", "Type filters leave chart totals unchanged")
act(() => table().props.onInspectDay("2"))
assert.deepEqual(inspections.pop(), ["2", "Shopping"], "Day inspection retains the selected type")
act(() => renderer.root.findByType(runtime.DailySpendingChart).props.onInspectDay("1"))
assert.deepEqual(inspections.pop(), ["1"], "The chart keeps its full daily inspection")
act(() => toggle().props.onClick())
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
