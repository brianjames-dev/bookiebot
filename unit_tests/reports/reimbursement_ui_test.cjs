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
const { SharedReimbursementsCard, reimbursementGroups } = load(path.join(frontend, "src/shared-reimbursements.tsx"))
const item = (id, changes = {}) => ({
  id, date: "9/3/2026", item: id, location: "Test Store", payer: "Brian", partner: "Hannah",
  responsibleOwner: "", responsiblePerson: "", grossAmount: 100, personalShare: 60,
  partnerShare: 40, receivedAmount: 0, outstandingAmount: 40, splitMethod: "50/50", status: "outstanding", ...changes,
})
const older = item("Last year's groceries", {date:"12/20/2025", outstandingAmount:25, receivedAmount:15})
const newer = item("This month's dinner")
const settled = item("Received dinner", {status:"reimbursed", outstandingAmount:0, receivedAmount:40})
const complete = {status:"complete", asOf:"2026-09-07", years:[2025,2026], unavailableYears:[], excludedRecords:0}
const render = (props = {}) => renderToStaticMarkup(React.createElement(SharedReimbursementsCard, {
  items: [settled], openItems:[older,newer], coverage:complete, monthLabel:"September 2026", ...props,
}))
const html = render()
assert.ok(html.includes("$65.00") && html.includes("Across all months"))
assert.ok(html.includes('aria-label="Owed by Hannah"'))
assert.ok(html.indexOf("Last year&#x27;s groceries") < html.indexOf("This month&#x27;s dinner"), "Oldest outstanding expense comes first")
assert.ok(html.includes("12/20/2025"), "Carried items retain their original date")
const summary = /<dl class="bb-reimbursement-summary"[\s\S]*?<\/dl>/.exec(html)[0]
assert.ok(summary.includes("$100.00") && summary.includes("$60.00") && summary.includes("$40.00"))
assert.ok(!summary.includes("$300.00"), "Old debt must not enter the selected expense-month statement")
const history = html.slice(html.indexOf('class="bb-reimbursement-history"'))
assert.ok(history.includes("For September 2026 expenses"))
assert.ok(history.includes('aria-expanded="false"') && history.includes('inert=""'), "Received history starts collapsed")
assert.ok(history.includes("Received dinner"))
assert.ok(render({items:[],openItems:[older]}).includes("Last year&#x27;s groceries"), "Old debt remains visible in a month without new shared purchases")
assert.equal(render({items:[],openItems:[]}), "")
const partial = render({items:[],openItems:[],coverage:{...complete,status:"partial",unavailableYears:[2025]}})
assert.ok(partial.includes("Known outstanding") && partial.includes("balance may be incomplete"))
assert.ok(!partial.includes("No outstanding reimbursements"), "A failed historical read must not look like all debts were settled")
const legacy = render({items:[newer],openItems:undefined,coverage:undefined})
assert.ok(legacy.includes("$40.00") && !legacy.includes("Across all months"), "Saved older payloads remain month-scoped")
const groups = reimbursementGroups([newer, older, item("Alex share",{partner:"Alex",outstandingAmount:12}),
  item("Void",{status:"void"}), item("Received",{status:"reimbursed"}), item("Zero",{outstandingAmount:0})])
assert.deepEqual(Array.from(groups, g => [g.partner,g.amount]), [["Alex",12],["Hannah",65]])
const chronological = reimbursementGroups([item("later",{date:"1/2/2026"}),item("earlier",{date:"2025-12-31"})])
assert.equal(chronological[0].items[0].id,"earlier")
console.log("Reimbursement carry-forward presentation checks passed")
