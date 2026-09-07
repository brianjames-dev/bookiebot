const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")
const req = createRequire(path.resolve("web/expense-report/package.json"))
const ts = req("typescript")

function harness() {
  const slots = [], pending = [], calls = []
  let index = 0
  const hooks = {
    useState(initial) {
      const slot = index++
      if (!slots[slot]) slots[slot] = { value: typeof initial === "function" ? initial() : initial }
      return [slots[slot].value, value => { slots[slot].value = typeof value === "function" ? value(slots[slot].value) : value }]
    },
    useRef(initial) {
      const slot = index++
      if (!slots[slot]) slots[slot] = { current: initial }
      return slots[slot]
    },
    useId() { return "history-details" },
    useEffect(effect, deps) {
      const slot = index++
      const old = slots[slot]
      if (!old || deps.some((value, i) => value !== old.deps[i])) {
        old?.cleanup?.()
        slots[slot] = { deps }
        pending.push(() => { slots[slot].cleanup = effect() })
      }
    },
  }
  const fetch = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, init, resolve, reject })
    init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
  const require = name => name === "react" ? hooks : name.endsWith(".css") ? {}
    : name.startsWith("./components") ? { CollapsibleContent: "disclosure", SlidingSelection: "selection", FittedAmount: "amount" } : req(name)
  const source = ts.transpileModule(fs.readFileSync("web/expense-report/src/report-history.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const runtime = { exports: {}, require, fetch, AbortController, setTimeout, clearTimeout, Intl, Date }
  vm.runInNewContext(source, runtime)
  return {
    ...runtime.exports, calls,
    render(fn) { index = 0; const result = fn(); while (pending.length) pending.shift()(); return result },
    cleanup() { slots.forEach(slot => slot?.cleanup?.()) },
  }
}
const response = (status, data) => new Response(JSON.stringify(data), { status })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
function nodes(element) {
  if (element === null || element === undefined || typeof element === "boolean") return []
  if (Array.isArray(element)) return element.flatMap(nodes)
  if (typeof element !== "object") return [element]
  return [element, ...nodes(element.props?.children)]
}
const text = element => nodes(element).filter(node => typeof node === "string" || typeof node === "number").join(" ")
const button = (tree, label) => nodes(tree).find(node => node?.type === "button" && text(node) === label)

async function main() {
  const pure = harness()
  let selection = "unchanged"
  const picker = pure.MonthHistoryControl({
    monthLabel: "August 2026", selectedMonth: "2026-08", loading: false, error: false,
    catalog: { currentMonth: "2026-09", months: [{value:"2026-09",label:"September 2026"},{value:"2026-08",label:"August 2026"}], coverage:{status:"partial"}},
    onSelect: value => { selection = value }, onRetry: () => {},
  })
  const select = nodes(picker).find(node => node?.type === "select")
  assert.equal(select.props["aria-label"], "Report month")
  assert.match(text(picker), /Some history is unavailable/)
  select.props.onChange({target:{value:"2026-08"}})
  assert.equal(selection, "2026-08")
  button(picker, "This month").props.onClick()
  assert.equal(selection, null)
  assert.equal(pure.reportMonthLabel("2026-08"), "August 2026")

  const catalog = harness()
  let enabled = true, expired = 0
  const renderCatalog = () => catalog.render(() => catalog.useReportMonthCatalog(enabled, () => expired++, "2026-09"))
  renderCatalog()
  assert.equal(catalog.calls[0].url, "/app/expenses/months")
  const old = catalog.calls[0]
  enabled = false
  renderCatalog()
  assert.equal(old.init.signal.aborted, true)
  old.resolve(response(200, {currentMonth:"2026-09",months:[{value:"2026-08",label:"Private history"}],coverage:{status:"complete"}}))
  await flush()
  assert.equal(renderCatalog().catalog, null, "Closing an authenticated view drops late catalog data")
  enabled = true
  renderCatalog()
  catalog.calls.at(-1).resolve(response(401, {}))
  await flush()
  assert.equal(expired, 1)
  catalog.cleanup()

  const comparison = harness()
  const report = { ownerName:"Brian", year:2026, month:9 }
  const renderComparison = () => comparison.render(() => comparison.ReportComparison({report,onExpired:()=>expired++}))
  let tree = renderComparison()
  assert.equal(comparison.calls.length, 0, "Closed comparisons do not fetch two reports")
  button(tree,"Compare spending").props.onClick()
  tree = renderComparison()
  const oldMonth = comparison.calls.at(-1)
  assert.equal(oldMonth.url, "/app/expenses/comparison?month=2026-09&baseline=previous-month")
  assert.equal(oldMonth.init.cache, "no-store")
  assert.equal(oldMonth.init.credentials, "same-origin")
  button(tree,"Last year").props.onClick()
  tree = renderComparison()
  assert.equal(oldMonth.init.signal.aborted,true)
  const annual = comparison.calls.at(-1)
  annual.resolve(response(200, {
    selectedMonth:"2026-09", baselineMonth:"2025-09", baselineKind:"previous-year", throughDay:7,
    status:"unavailable", selected:{datedSpending:25}, baseline:null, changeAmount:null,changePercent:null,
    coverageNote:"The comparison month is unavailable.",
  }))
  await flush()
  oldMonth.resolve(response(200,{selectedMonth:"2026-09",baselineKind:"previous-month",coverageNote:"OBSOLETE PRIVATE DATA"}))
  await flush()
  tree = renderComparison()
  assert.match(text(tree), /The comparison month is unavailable/)
  assert.ok(!text(tree).includes("OBSOLETE"), "Latest baseline wins despite late replies")
  button(tree,"Compare spending").props.onClick()
  renderComparison()
  comparison.cleanup()
  console.log("Month picker and comparison hook lifecycle checks passed")
}
main().catch(error => { console.error(error); process.exitCode = 1 })
