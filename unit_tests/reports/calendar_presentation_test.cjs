const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const ts = require("../../web/expense-report/node_modules/typescript")
const { renderToStaticMarkup } = require("../../web/expense-report/node_modules/react-dom/server")
const jsxRuntime = require("../../web/expense-report/node_modules/react/jsx-runtime")

// Render the production date cells and calendar markers with a fixed clock.
// Extract declarations through the TS parser so the surrounding report remains
// free to change without a copied implementation or a browser dependency.
const source = fs.readFileSync("web/expense-report/src/report-app.tsx", "utf8")
const file = ts.createSourceFile("report-app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set([
  "money", "CATEGORY_CHART_COLORS", "SUBSCRIPTION_TONES", "PACIFIC_CALENDAR_DATE",
  "formatMoney", "dailyEntryDayLabel", "DailyEntriesTable", "compareDayGroups", "isCurrentCalendarDay",
])
const declarations = file.statements.filter((statement) => {
  if (ts.isFunctionDeclaration(statement)) return names.has(statement.name?.text)
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((item) => names.has(item.name.getText(file)))
  return false
})
assert.equal(declarations.length, names.size)
const activitySource = fs.readFileSync("web/expense-report/src/report-activity.ts", "utf8")
const activityFile = ts.createSourceFile("report-activity.ts", activitySource, ts.ScriptTarget.Latest, true)
const activityDeclaration = activityFile.statements
  .filter(node => ts.isFunctionDeclaration(node) && ["activityDay", "calendarActivityStatus"].includes(node.name?.text))
  .map(node => node.getText(activityFile).replace("export ", "")).join("\n")
const compiled = ts.transpileModule(activityDeclaration + "\n" + declarations.map((node) => node.getText(file)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const frozen = new Date("2026-09-07T06:55:00Z") // September 6, 11:55 PM Pacific.
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [frozen])) }
}
const runtime = vm.createContext({
  Date: Clock,
  DailyTransactionDays: require("./load_frontend_module.cjs")("daily-transactions.tsx").DailyTransactionDays,
  exports: {},
  require: (id) => {
    assert.equal(id, "react/jsx-runtime")
    return jsxRuntime
  },
})
vm.runInContext(compiled, runtime)
const palette = vm.runInContext("CATEGORY_CHART_COLORS", runtime)
const subscriptionTones = vm.runInContext("SUBSCRIPTION_TONES", runtime)
assert.equal(subscriptionTones.needs.color, palette.static_bills_subscriptions_needs)
assert.equal(subscriptionTones.wants.color, palette.subscriptions_wants)
// Browser-local date may already be tomorrow. Highlight the report's current
// Pacific day only, including midnight, month/year rollover and DST boundaries.
assert.equal(runtime.isCurrentCalendarDay(2026, 9, 6), true)
assert.equal(runtime.isCurrentCalendarDay(2026, 9, 7), false)
assert.equal(runtime.isCurrentCalendarDay(2026, 8, 6), false)
assert.equal(runtime.isCurrentCalendarDay(2025, 9, 6), false)
assert.equal(runtime.isCurrentCalendarDay(2026, 9, NaN), false)
for (const [iso, year, month, day] of [
  ["2026-09-07T07:00:00Z", 2026, 9, 7],
  ["2027-01-01T07:59:59Z", 2026, 12, 31],
  ["2027-01-01T08:00:00Z", 2027, 1, 1],
  ["2026-03-08T10:00:00Z", 2026, 3, 8],
]) assert.equal(runtime.isCurrentCalendarDay(year, month, day, new Date(iso)), true)

const entries = [6, 7].map((day) => ({
  date: `9/${day}`, amount: day * 10, category: "Food", item: "Lunch", person: "Brian", location: "",
}))
const daily = (items = entries, year = 2026, month = 9) => renderToStaticMarkup(runtime.DailyEntriesTable({
  entries: items, year, month, categoryColors: { Food: palette.food },
}))
const dailyHtml = daily()
assert.equal((dailyHtml.match(/aria-current="date"/g) || []).length, 1)
assert.ok(dailyHtml.includes('aria-current="date" title="Today"'))
assert.ok(dailyHtml.includes('aria-expanded="false" aria-controls='))
assert.ok(dailyHtml.includes("$60.00"))
assert.ok(dailyHtml.includes("$70.00"))
assert.equal((dailyHtml.match(/class="bb-daily-day-group"/g) || []).length, 2, "No synthetic spending days")
assert.ok(!daily(entries, 2026, 8).includes('aria-current="date"'))
assert.ok(!daily(entries, 2025, 9).includes('aria-current="date"'))
assert.ok(!daily([entries[1]]).includes('aria-current="date"'), "No invented entry if today has no spending")
assert.ok(!daily([]).includes("<tr>"))
assert.ok(!daily([{ ...entries[0], date: "" }]).includes('aria-current="date"'))
console.log("Daily category colors and Pacific-day highlight checks passed")

assert.equal(runtime.dailyEntryDayLabel({date:"2026-09-03"}), "3")
assert.equal(runtime.dailyEntryDayLabel({date:"9/03/2026"}), "3")
assert.equal(runtime.dailyEntryDayLabel({date:""}), null)
assert.equal((daily([{...entries[0],date:"2026-09-03"},{...entries[1],date:"9/3/2026"}]).match(/class="bb-daily-day-group"/g)||[]).length,1)

assert.equal(runtime.dailyEntryDayLabel({date:"2/30/2026"}), null)
assert.equal(runtime.dailyEntryDayLabel({date:"2026-09-03"},2026,8), null)
assert.ok(daily([{...entries[0], date:"2/30/2026"}]).includes("No date"))
