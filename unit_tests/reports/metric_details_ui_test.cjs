const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")
const req = createRequire(path.resolve("web/expense-report/package.json"))
const ts = req("typescript")
const React = req("react")
const { renderToStaticMarkup } = req("react-dom/server")

// Execute the production details and shared progress renderer with synthetic
// current/projected values, without importing unrelated browser/chart effects.
const source = fs.readFileSync("web/expense-report/src/report-app.tsx", "utf8")
const file = ts.createSourceFile("report-app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set(["money", "formatMoney", "roundCurrency", "amountRowsTotal", "clamp", "isSavingsNearGoal", "SavingsProgress", "SavingsMetricCard", "MetricExplanationDetails"])
const declarations = file.statements.filter(statement => {
  if (ts.isFunctionDeclaration(statement)) return names.has(statement.name?.text)
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => names.has(item.name.getText(file)))
})
assert.equal(declarations.length, names.size)
const compiled = ts.transpileModule(declarations.map(node => node.getText(file)).join("\n") + "\nexports.Details = MetricExplanationDetails; exports.Card = SavingsMetricCard", {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText
const runtime = { exports: {}, require: req, FittedAmount: ({children, ...props}) => React.createElement("div", props, children) }
vm.runInNewContext(compiled, runtime)
const { Details, Card } = runtime.exports
const view = {
  metrics: { monthlyIncome: 5000, amountSaved: 300, savingsMinimum: 500, savingsIdeal: 1000 },
  categoryBudgets: { needs: 2500, wants: 1500, savings: 1000 },
  categorySpending: { needs: 1200, wants: 400, savings: 300 },
  breakdown: [{ key: "rent", amount: 1200 }, { key: "shopping", amount: 400 }],
}
const render = (key, changes = {}) => renderToStaticMarkup(React.createElement(Details, {detail: {
  key, view, value: 1600, equation: "Old calculation equation",
  components: [{label: "Old detailed expense", amount: 1600}],
  notes: ["Old verbose note", "Another grey explanation"], ...changes,
}}))
const rows = html => [...html.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map(match => [match[1], match[2]])

for (const [needs, wants, income, saved] of [[1200, 400, 5000, 300], [2200, 600, 7500, 300], [0, 0, 0, 0]]) {
  const html = render("spent", {value: needs + wants + saved, view: {...view,
    metrics: {...view.metrics, monthlyIncome: income, amountSaved: saved},
    categorySpending: {needs, wants, savings: saved},
  }})
  assert.deepEqual(rows(html), [["Needs", `$${needs.toLocaleString("en-US")}.00`], ["Wants", `$${wants.toLocaleString("en-US")}.00`], ["Saved", `$${saved.toLocaleString("en-US")}.00`]])
  assert.ok(html.includes(`<div class="bb-chart-total">$${(needs + wants + saved).toLocaleString("en-US")}.00</div>`))
  for (const removed of ["Old detailed expense", "Old calculation equation", "Old verbose note", "Another grey explanation", "bb-activity-footnote"]) assert.ok(!html.includes(removed))
}
assert.deepEqual(rows(render("spent", {value: 1925, view: {...view, breakdown: [...view.breakdown, {key: "savings", amount: 25}]}})),
  [["Needs", "$1,200.00"], ["Wants", "$400.00"], ["Saved", "$300.00"], ["Sheet adjustment", "$25.00"]], "Legacy expense adjustments stay separate from actual Saved")
assert.deepEqual(rows(render("spent", {value: 1950})).at(-1), ["Sheet adjustment", "$50.00"], "Legacy sheet totals retain any otherwise unclassified amount")

const remaining = ["Needs", "Wants", "Savings"].map(label => ({label: `${label} remaining`, amount: 100}))
for (const [budgets, expected] of [
  [{needs: 2500, wants: 1500, savings: 1000}, ["50", "30", "20"]],
  [{needs: 2000, wants: 1750, savings: 1250}, ["40", "35", "25"]],
  [{needs: 2012.5, wants: 1737.5, savings: 1250}, ["40.3", "34.8", "25"]],
]) {
  const html = render("left", {components: remaining, view: {...view, categoryBudgets: budgets}})
  assert.equal(rows(html).length, 3)
  assert.ok(html.includes("Savings remaining") && !html.toLowerCase().includes("budget"), "Left keeps its concise remaining labels")
  for (const percentage of expected) assert.ok(html.includes(`${percentage}% of income`), "Allocation percentages use the active mode and month settings")
  assert.ok(!html.includes("bb-activity-footnote") && !html.includes("Old calculation equation"))
}
const noIncome = render("left", {components: remaining, view: {...view, metrics: {...view.metrics, monthlyIncome: 0}}})
assert.ok(!noIncome.includes("% of income") && !/NaN|Infinity/.test(noIncome))

for (const [value, minimum, ideal, percent, tone] of [
  [300, 500, 1000, 30, "low"], [600, 500, 1000, 60, "minimum"],
  [950, 500, 1000, 95, "ideal"], [1500, 500, 1000, 100, "ideal"],
  [0, 0, 0, 0, "empty"], [-100, 500, 1000, 0, "empty"],
  [300, 750, 1500, 20, "low"],
]) {
  const html = render("saved", {value, view: {...view, metrics: {...view.metrics, savingsMinimum: minimum, savingsIdeal: ideal}},
    components: [{label: "Savings contribution 1", amount: 100}, {label: "Savings contribution 2", amount: 200}],
  })
  const card = renderToStaticMarkup(React.createElement(Card, {value, minimum, ideal}))
  for (const surface of [html, card]) {
    assert.ok(surface.includes(`bb-savings-progress-${tone}`))
    assert.ok(surface.includes(`width:${percent}%`))
    assert.ok(surface.includes('role="img"') && surface.includes("saved; minimum"))
    assert.equal(surface.includes("bb-savings-progress-minimum-marker"), ideal > 0 && minimum > 0 && minimum < ideal)
    assert.ok(!/NaN|Infinity/.test(surface))
  }
  assert.equal((html.match(/bb-activity-footnote/g) || []).length, 1)
  const target = `Minimum target: $${minimum.toLocaleString("en-US")}.00. Ideal target: $${ideal.toLocaleString("en-US")}.00.`
  assert.ok(html.includes(target), "The modal uses dynamic targets from the inspected mode")
  for (const removed of ["Savings contribution", "Old verbose note", "Another grey explanation", "Old calculation equation", "<dl>", "bb-savings-progress-labels"]) assert.ok(!html.includes(removed))
  assert.ok(card.includes("bb-savings-progress-labels"), "The card retains its compact target labels")
}
const income = render("income", {components: [{label: "Paycheck", amount: 1000, date: "2026-10-10", source: "scheduled"}]})
for (const retained of ["Old calculation equation", "Old verbose note", "2026-10-10", "Scheduled estimate"]) assert.ok(income.includes(retained), "Income retains its estimate context")
console.log("Metric details preserve totals, mode allocations and dynamic savings progress with compact content")
const investing={cashSaved:1200,esppContribution:400,combinedContributions:1600,takeHomeBeforeEspp:9000,estimatedEsppContribution:0}
const esppView={...view,savingsInvesting:investing,metrics:{...view.metrics,monthlyIncome:9000,amountSaved:1600,savingsMinimum:700,savingsIdeal:1400}}
const esppDetails=render('saved',{value:1600,view:esppView})
assert.deepEqual(rows(esppDetails),[['Cash saved','$1,200.00'],['SpaceX ESPP · calculated from payroll','$400.00'],['Cash saved + ESPP','$1,600.00']])
assert.ok(!esppDetails.includes('Take-home before ESPP'))
const esppCard=renderToStaticMarkup(React.createElement(Card,{value:1600,progressValue:1200,minimum:700,ideal:1400,onExplain:()=>{}}))
assert.ok(esppCard.includes('Explain Saved')&&!esppCard.includes('Explain Cash saved'))
for(const surface of [esppCard,esppDetails])assert.ok(surface.includes(`width:${1200/1400*100}%`),'The progress bar uses recorded cash while the headline includes ESPP')
for (const estimated of [0, 400]) {
  const saved = 1600 + estimated
  const spent = render('spent', {value: 1600 + saved, view: {...esppView,
    metrics: {...esppView.metrics, amountSaved: saved},
    savingsInvesting: {...investing, combinedContributions: saved, esppContribution: 400 + estimated, estimatedEsppContribution: estimated},
  }})
  assert.deepEqual(rows(spent), [['Needs', '$1,200.00'], ['Wants', '$400.00'],
    [estimated ? 'Saved<small>Includes estimated ESPP</small>' : 'Saved', `$${saved.toLocaleString('en-US')}.00`]])
  assert.ok(!spent.includes('Sheet adjustment'), 'Cash and actual/projected ESPP are included exactly once')
}
console.log('Saved separates cash progress and monthly ESPP while income owns reconstructed take-home.')
