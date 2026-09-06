const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("../../web/expense-report/node_modules/typescript")

// Execute the production helpers after stripping TypeScript, so these checks
// cover the amounts/ticks actually passed to Recharts, without copying the math.
const source = fs.readFileSync(path.join(__dirname, "../../web/expense-report/src/report-app.tsx"), "utf8")
const start = source.indexOf("function dailySpendingAxis(")
const end = source.indexOf("function dailySpendingCursorFill(", start)
assert.ok(start >= 0 && end > start, "Daily Spending axis helpers must exist")
const { outputText } = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
})
const runtime = vm.createContext({})
vm.runInContext(outputText, runtime)

const rows = (amounts) => amounts.map((amount, index) => ({
  label: String(index + 1),
  amount,
  needsAmount: amount * 0.6,
  wantsAmount: amount * 0.4,
}))

// Exercise empty, tiny, ordinary and large uncompressed views. The $175 case
// reproduces the large unlabeled gap above $100 in the user's screenshot.
for (const amounts of [[], [0], [0.01], [9], [29, 18], [59, 38], [99, 75], [149, 95], [175, 93], [220, 160], [450, 350], [1200], [10000, 9000]]) {
  const axis = runtime.dailySpendingAxis(rows(amounts))
  assert.equal(axis.compressed, false)
  assert.equal(axis.ticks[0], 0)
  assert.equal(axis.ticks.at(-1), axis.domain[1], `Top tick missing for ${amounts}`)
  assert.ok(axis.domain[1] > Math.max(0, ...amounts), "Bars need upper headroom")
  assert.equal(new Set(axis.ticks).size, axis.ticks.length, "Ticks must be unique")
  assert.ok(axis.ticks.every((tick, index) => index === 0 || tick > axis.ticks[index - 1]))
  assert.ok(runtime.dailySpendingAxisTickLabel(axis.ticks.at(-1), axis).startsWith("$"))
}

// Outlier compression must retain its real-dollar top label and stacked totals,
// with the final guide within five percent of the top of the plotting area.
for (const amounts of [[2709.99, 175, 93], [500, 150], [10000, 1200]]) {
  const data = rows(amounts)
  const axis = runtime.dailySpendingAxis(data)
  assert.equal(axis.compressed, true)
  assert.ok(axis.ticks.at(-1) / axis.domain[1] >= 0.95)
  assert.equal(runtime.dailySpendingActualAmount(axis.ticks.at(-1), axis), amounts[0])
  for (const item of runtime.dailySpendingChartRows(data, axis)) {
    assert.ok(Math.abs(item.chartNeedsAmount + item.chartWantsAmount - item.chartAmount) < 1e-8)
    assert.ok(Math.abs(runtime.dailySpendingActualAmount(item.chartAmount, axis) - item.amount) < 1e-8)
  }
}

console.log("Daily Spending axis runtime checks passed")
