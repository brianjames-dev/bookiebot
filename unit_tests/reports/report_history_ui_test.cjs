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
  return [element, ...nodes(element.props?.children ?? element.children)]
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

  const React = req("react")
  const renderer = req("react-test-renderer")
  const calls = [], timers = new Map()
  let timerId = 0, ignoreAbort = false
  const runtime = { exports: {}, AbortController, Intl, Date,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    fetch: (url, init) => new Promise((resolve, reject) => {
      calls.push({ url, init, resolve, reject })
      init.signal.addEventListener("abort", () => { if (!ignoreAbort) reject(new Error("aborted")) }, { once: true })
    }),
    require: name => name === "react" ? React : name.endsWith(".css") ? {}
      : name.startsWith("./components") ? {
        CollapsibleContent: ({children}) => React.createElement("div", null, children),
        FittedAmount: ({children}) => React.createElement("span", null, children),
      } : req(name),
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("web/expense-report/src/report-history.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, runtime)
  let report = { ownerName:"Brian", year:2026, month:9 }, mainRefreshing = false
  let tree
  const months = { currentMonth:"2026-09", months:[
    {value:"2026-09",label:"September 2026"}, {value:"2026-08",label:"August 2026"},
    {value:"2025-09",label:"September 2025"}], coverage:{status:"complete"} }
  const props = () => ({report, refreshing:mainRefreshing, catalog:months, onExpired:()=>expired++})
  const component = () => React.createElement(runtime.exports.ReportComparison, props())
  const read = () => text(tree.toJSON())
  const findButton = label => tree.root.findAllByType("button").find(item => item.children.join("") === label
    || item.findAllByType("span").some(span => span.children.join("") === label))
  const click = label => renderer.act(() => findButton(label).props.onClick())
  const selectMonth = value => renderer.act(() => tree.root.findByProps({"aria-label":"Comparison month"}).props.onChange({target:{value}}))
  const result = (baseline, note) => ({selectedMonth:"2026-09", baselineMonth:baseline,
    baselineKind:"selected-month", throughDay:7, status:"complete", selected:{datedSpending:25},
    baseline:{datedSpending:50}, changeAmount:-25, changePercent:-50, coverageNote:note})
  const finish = async (call, status, data) => renderer.act(async () => { call.resolve(response(status, data)); await flush() })
  renderer.act(() => { tree = renderer.create(component()) })
  assert.equal(calls.length, 0, "Closed comparisons do not fetch two reports")
  click("Compare spending")
  const oldMonth = calls.at(-1)
  assert.equal(oldMonth.url, "/app/expenses/comparison?month=2026-09&compare_month=2026-08")
  assert.equal(oldMonth.init.cache, "no-store")
  assert.equal(oldMonth.init.credentials, "same-origin")
  assert.ok([...timers.values()].some(timer => timer.delay === 60000), "Paired live builds have a 60s budget")
  assert.ok(!findButton("Last year"), "Comparison uses one accessible month dropdown")
  assert.equal(tree.root.findAllByType("option").length, 2, "Selected month is excluded and previous month is not duplicated")
  selectMonth("2025-09")
  selectMonth("2026-08")
  click("Compare spending")
  click("Compare spending")
  assert.equal(oldMonth.init.signal.aborted, false, "Selection/disclosure changes retain the live request")
  assert.equal(calls.length, 1, "Rapid selections cannot flood the server queue")
  selectMonth("2025-09")
  await finish(oldMonth, 200, result("2026-08", "August completed"))
  assert.equal(calls.length, 2, "Only the latest waiting selection is fetched")
  assert.equal(calls.at(-1).url, "/app/expenses/comparison?month=2026-09&compare_month=2025-09")
  assert.ok(!read().includes("August completed"), "A superseded reply never displays for the new month")
  await finish(calls.at(-1), 200, result("2025-09", "September completed"))
  assert.match(read(), /September completed/)
  selectMonth("2026-08")
  assert.match(read(), /August completed/)
  assert.equal(calls.length, 2, "Revisiting a month reuses its result for this displayed report")
  renderer.act(() => tree.update(component()))
  assert.equal(calls.length, 2, "New callback identities do not restart requests")
  report = {...report}
  renderer.act(() => tree.update(component()))
  assert.equal(calls.length, 3, "A fresh report invalidates comparison results")
  assert.ok(!read().includes("August completed"), "Old amounts clear during a fresh comparison")
  const staleRefresh = calls.at(-1)
  report = {...report}
  renderer.act(() => tree.update(component()))
  assert.equal(staleRefresh.init.signal.aborted, true)
  await finish(staleRefresh, 200, result("2026-08", "OBSOLETE PRIVATE DATA"))
  await finish(calls.at(-1), 503, {})
  assert.match(read(), /Couldn’t load/)
  click("Try again")
  await finish(calls.at(-1), 503, { code: "sheets_rate_limited", error: "PRIVATE PROVIDER DETAILS" })
  assert.match(read(), /Google Sheets.*minute/)
  assert.ok(!read().includes("PRIVATE PROVIDER DETAILS"))
  const quotaCalls = calls.length
  await flush()
  assert.equal(calls.length, quotaCalls, "Quota feedback must not automatically hammer the source")
  click("Try again")
  await finish(calls.at(-1), 200, result("2026-08", "Retry succeeded"))
  assert.match(read(), /Retry succeeded/)
  assert.ok(!read().includes("OBSOLETE"))
  const beforeBusyReplacement = calls.length
  mainRefreshing = true
  report = {...report}
  renderer.act(() => tree.update(component()))
  assert.equal(calls.length, beforeBusyReplacement, "Replacement report does not start comparison during refresh")
  mainRefreshing = false
  renderer.act(() => tree.update(component()))
  assert.equal(calls.length, beforeBusyReplacement + 1)
  await finish(calls.at(-1), 200, result("2026-08", "Replacement after refresh"))
  report = {...report}
  renderer.act(() => tree.update(component()))
  const timedOut = calls.at(-1)
  await renderer.act(async () => { [...timers.values()].find(timer => timer.delay === 60000).fn(); await flush() })
  assert.equal(timedOut.init.signal.aborted, true)
  assert.match(read(), /Couldn’t load/)
  click("Try again")
  await finish(calls.at(-1), 200, result("2026-08", "Recovered from timeout"))
  // A timeout must release the client queue even if a suspended browser's
  // fetch does not settle after abort. Otherwise every later month waits forever.
  ignoreAbort = true
  report = {...report}
  renderer.act(() => tree.update(component()))
  const stalledTransport = calls.at(-1)
  await renderer.act(async () => { [...timers.values()].find(timer => timer.delay === 60000).fn(); await flush() })
  assert.equal(stalledTransport.init.signal.aborted, true)
  assert.match(read(), /Couldn’t load/, "Timeout must finish even when transport ignores cancellation")
  ignoreAbort = false
  click("Try again")
  const transportRetry = calls.at(-1)
  assert.notEqual(transportRetry, stalledTransport, "A stalled request cannot retain the retry slot")
  await finish(transportRetry, 200, result("2026-08", "Recovered from stalled transport"))
  await finish(stalledTransport, 200, result("2026-08", "STALE HUNG RESPONSE"))
  assert.match(read(), /Recovered from stalled transport/)
  assert.ok(!read().includes("STALE HUNG RESPONSE"))
  report = {...report}
  renderer.act(() => tree.update(component()))
  const expiredBefore = expired
  await finish(calls.at(-1), 401, {})
  assert.equal(expired, expiredBefore + 1)
  const afterExpiry = calls.length
  renderer.act(() => tree.update(component()))
  assert.equal(calls.length, afterExpiry, "Expired responses never trigger an automatic request loop")
  click("Try again")
  const unmounted = calls.at(-1)
  renderer.act(() => tree.unmount())
  assert.equal(unmounted.init.signal.aborted, true)
  await finish(unmounted, 200, result("2026-08", "AFTER UNMOUNT"))
  assert.equal(timers.size, 0, "All request timers are released")

  let finishBody, bodyOutcome
  const bodyController = new AbortController()
  const bodyJob = runtime.exports.requestReportHistory("/slow-body", bodyController, 60000)
    .then(() => { bodyOutcome = "completed" }, () => { bodyOutcome = "interrupted" })
  calls.at(-1).resolve({status:200, ok:true, json:() => new Promise(resolve => { finishBody = resolve })})
  await flush()
  ;[...timers.values()].find(timer => timer.delay === 60000).fn()
  await flush()
  assert.equal(bodyOutcome, "interrupted", "Timeout also covers a stalled response body")
  finishBody({private:"late body"})
  await bodyJob
  assert.equal(bodyOutcome, "interrupted")
  const cancelled = new AbortController()
  cancelled.abort()
  const beforeCancelled = calls.length
  await assert.rejects(runtime.exports.requestReportHistory("/already-cancelled", cancelled), /interrupted/)
  assert.equal(calls.length, beforeCancelled, "An already cancelled read must not reach the network")

  // Exercise the actual report session together with the actual React
  // comparison. Reproduce both error banners, then recover without remounting.
  const sessionRuntime = {...runtime, exports:{}}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("web/expense-report/src/expense-app-session.ts", "utf8"), {
    compilerOptions: {module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2020},
  }).outputText, sessionRuntime)
  let now = 100000, sessionState, pageTreeMounted = false
  const session = new sessionRuntime.exports.ExpenseAppSession({reportUrl:"/app/expenses/data",logoutUrl:"/app/logout",ownerName:"Brian"},
    {fetch:runtime.fetch,now:()=>now})
  const stop = session.subscribe(state => {
    sessionState = state
    mainRefreshing = state.phase === "loading" || state.phase === "refreshing"
    if (!state.report) return
    report = state.report
    if (pageTreeMounted) tree.update(component())
    else { tree = renderer.create(component()); pageTreeMounted = true }
  })
  const liveReport = () => ({ownerName:"Brian",year:2026,month:9,metrics:{},incomeProjection:{},savingsProjection:{},breakdown:[],dailyEntries:[]})
  let mainJob
  renderer.act(() => { mainJob = session.refresh(true) })
  await finish(calls.at(-1), 200, liveReport())
  await mainJob
  renderer.act(() => { mainJob = session.refresh(true) })
  const unopenedRefresh = calls.at(-1)
  click("Compare spending")
  assert.equal(calls.at(-1), unopenedRefresh, "Opening comparison waits for the active report refresh")
  await finish(unopenedRefresh, 503, {})
  await mainJob
  const beforeRefreshComparison = calls.at(-1)
  assert.match(beforeRefreshComparison.url, /compare_month=2026-08/)
  renderer.act(() => { mainJob = session.refresh(true) })
  const firstRefresh = calls.at(-1)
  assert.equal(firstRefresh.url, "/app/expenses/data")
  assert.equal(beforeRefreshComparison.init.signal.aborted, false, "An already running comparison can finish alongside refresh")
  await finish(beforeRefreshComparison, 503, {})
  assert.equal(calls.at(-1), firstRefresh, "A comparison failure does not retry during main refresh")
  await finish(firstRefresh, 503, {})
  await mainJob
  const automaticRecovery = calls.at(-1)
  assert.notEqual(automaticRecovery, firstRefresh, "Finishing a failed refresh retries a failed comparison without remounting")
  assert.match(automaticRecovery.url, /compare_month=2026-08/)
  const beforeRecoveryFailed = calls.length
  await finish(automaticRecovery, 503, {})
  assert.equal(calls.length, beforeRecoveryFailed, "Automatic recovery is one attempt, not an error loop")
  assert.equal(sessionState.phase, "stale")
  assert.match(sessionState.message, /Couldn’t refresh/)
  assert.match(read(), /Couldn’t load/)
  click("Try again")
  await finish(calls.at(-1), 200, result("2026-08", "Comparison recovered while report stayed stale"))
  assert.match(read(), /Comparison recovered while report stayed stale/)
  assert.equal(sessionState.phase, "stale")

  selectMonth("2025-09")
  const obsoleteComparison = calls.at(-1)
  renderer.act(() => { mainJob = session.refresh(true) })
  await finish(calls.at(-1), 200, liveReport())
  await mainJob
  assert.equal(sessionState.phase, "ready")
  assert.equal(obsoleteComparison.init.signal.aborted, true)
  const afterRefreshComparison = calls.at(-1)
  assert.match(afterRefreshComparison.url, /compare_month=2025-09/)
  await finish(obsoleteComparison, 200, result("2025-09", "PRE-REFRESH AMOUNTS"))
  await finish(afterRefreshComparison, 200, result("2025-09", "Fresh report comparison"))
  assert.match(read(), /Fresh report comparison/)
  assert.ok(!read().includes("PRE-REFRESH AMOUNTS"))

  const browser = new EventTarget(), page = new EventTarget()
  page.visibilityState = "visible"
  const stopWatching = sessionRuntime.exports.watchExpenseAppLifecycle(session, browser, page)
  now += 3000
  renderer.act(() => browser.dispatchEvent(new Event("focus")))
  const pausedRefresh = calls.at(-1)
  renderer.act(() => browser.dispatchEvent(new Event("pagehide")))
  assert.equal(pausedRefresh.init.signal.aborted, true)
  now += 3000
  renderer.act(() => browser.dispatchEvent(new Event("focus")))
  const foregroundRefresh = calls.at(-1)
  assert.notEqual(foregroundRefresh, pausedRefresh)
  await finish(pausedRefresh, 503, {})
  await finish(foregroundRefresh, 200, liveReport())
  assert.equal(sessionState.phase, "ready")
  await finish(calls.at(-1), 200, result("2025-09", "Foreground comparison recovered"))
  assert.match(read(), /Foreground comparison recovered/)
  renderer.act(() => { mainJob = session.refresh(true) })
  const deferredSelectionRefresh = calls.at(-1)
  assert.match(read(), /Foreground comparison recovered/, "A refresh preserves a valid comparison until fresh report data arrives")
  selectMonth("2026-08")
  click("Compare spending")
  click("Compare spending")
  assert.equal(calls.at(-1), deferredSelectionRefresh, "A newly selected month and reopening wait while main refresh is busy")
  await finish(deferredSelectionRefresh, 503, {})
  await mainJob
  assert.match(calls.at(-1).url, /compare_month=2026-08/)
  await finish(calls.at(-1), 200, result("2026-08", "Deferred month recovered"))
  assert.match(read(), /Deferred month recovered/)
  stopWatching(); stop(); session.dispose()
  renderer.act(() => tree.unmount())
  assert.equal(timers.size, 0)
  console.log("Month picker, comparison and report-refresh lifecycle checks passed")
}
main().catch(error => { console.error(error); process.exitCode = 1 })
