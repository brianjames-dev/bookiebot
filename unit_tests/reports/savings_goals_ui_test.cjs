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
  const exports = {}; modules.set(file, exports)
  const localRequire = (name) => {
    if (name.endsWith(".css")) return {}
    if (!name.startsWith(".")) return frontendRequire(name)
    const base = path.resolve(path.dirname(file), name)
    return load([base + ".tsx", base + ".ts"].find(fs.existsSync))
  }
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  const inspectionExports = file.endsWith("savings-goals.tsx") ? "\nexports.GoalEntry = GoalEntry; exports.ContributionHistoryRow = ContributionHistoryRow;" : ""
  vm.runInNewContext(outputText + inspectionExports, { exports, require: localRequire })
  return exports
}
const { SavingsGoals, GoalEntry, ContributionHistoryRow, goalAmountCents, goalProgress } = load(path.join(frontend, "src/savings-goals.tsx"))
assert.equal(goalAmountCents("1.01"), 101)
assert.equal(goalAmountCents("0.29"), 29, "Fractional dollar input must not lose a cent to floating point")
assert.equal(goalAmountCents(" 0002.3 "), 230)
assert.equal(goalAmountCents("0"), 0)
for (const invalid of ["", "-1", "1e3", "1.001", "Infinity", "1,000", "$3", "100000000.01"]) {
  assert.equal(goalAmountCents(invalid), null)
}
const goal = { targetCents: 10000, balanceCents: 3000 }
assert.equal(goalProgress(goal).percent, 30)
assert.equal(goalProgress(goal).remainingCents, 7000)
assert.equal(goalProgress({ ...goal, balanceCents: 12000 }).percent, 100)
assert.equal(goalProgress({ ...goal, balanceCents: 12000 }).remainingCents, 0)
const markup = renderToStaticMarkup(React.createElement(SavingsGoals))
assert.ok(markup.includes("Personal plans across months"))
assert.ok(markup.includes("don’t move money or change monthly Saved"))
assert.ok(markup.includes("Loading your goals"))
assert.ok(!markup.includes("$0.00"), "Unloaded balance must not look like a confirmed zero")
assert.match(markup, /<button[^>]*disabled=""[^>]*>＋ Goal<\/button>/)
const createButton = /<button[^>]*>＋ Goal<\/button>/.exec(markup)[0]
assert.ok(createButton.includes('aria-expanded="false"'))
const createId = /aria-controls="([^"]+)"/.exec(createButton)[1]
assert.ok(markup.includes(`id="${createId}"`), "New goal disclosure identifies its actual content region")
const completeGoal = { id: "goal-1", name: "Trip", targetCents: 10000, startingCents: 0, balanceCents: 3000, contributionCents: 3000, contributionCount: 1, targetDate: "", archived: false, version: 1 }
const goalMarkup = renderToStaticMarkup(React.createElement(GoalEntry, { goal: completeGoal, disabled: false, run() {} }))
const modeButtons = [...goalMarkup.matchAll(/<button[^>]*aria-controls="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)]
assert.equal(modeButtons.length, 4)
for (const [button, controlledId] of modeButtons) {
  assert.ok(button.includes('aria-expanded="false"'))
  assert.ok(goalMarkup.includes(`id="${controlledId}"`))
}
const entry = { id: "contribution-1", amountCents: 3000, date: "2026-09-07", note: "Trip allocation", reversedAt: "" }
const row = (changes = {}) => React.createElement(ContributionHistoryRow, { entry, goal: completeGoal, disabled: false, open: false, run() {}, onToggle() {}, onClose() {}, ...changes })
const closed = renderToStaticMarkup(row())
const open = renderToStaticMarkup(row({ open: true }))
assert.match(closed, /<button[^>]*aria-expanded="false"[^>]*>Reverse<\/button>/)
assert.match(open, /<button[^>]*aria-expanded="true"[^>]*>Reverse<\/button>/)
assert.ok(closed.includes("Confirm reversal"), "Closing retains the confirmation content so its height can animate")
assert.ok(closed.includes('data-state="closed"') && closed.includes('inert=""'), "Retained controls become inaccessible immediately on close")
assert.ok(open.includes('data-state="open"') && !open.includes('inert=""'))
const reverseId = /aria-controls="([^"]+)"/.exec(open)[1]
assert.ok(open.includes(`id="${reverseId}"`))
const both = renderToStaticMarkup(React.createElement(React.Fragment, null, row(), row({ entry: { ...entry, id: "contribution-2" } })))
const rowIds = [...both.matchAll(/aria-controls="([^"]+)"/g)].map(match => match[1])
assert.equal(new Set(rowIds).size, 2, "Each contribution has a distinct confirmation region")
assert.ok(!renderToStaticMarkup(row({ entry: { ...entry, reversedAt: "2026-09-07" }, open: true })).includes('aria-expanded="true"'))
console.log("Savings goals input, progress, disclosure accessibility and retained reversal checks passed")
