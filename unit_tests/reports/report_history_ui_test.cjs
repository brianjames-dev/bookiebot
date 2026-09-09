const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")
const req = createRequire(path.resolve("web/expense-report/package.json"))
const ts = req("typescript")
globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
    : name.startsWith("./components") ? { CollapsibleContent: "disclosure", SlidingSelection: "selection", FittedAmount: "amount", MonthPicker: "month-picker" } : req(name)
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
  const select = nodes(picker).find(node => node?.type === "month-picker")
  assert.equal(select.props.label, "Report month")
  assert.match(text(picker), /Some history is unavailable/)
  select.props.onSelect("2026-08")
  assert.equal(selection, "2026-08")
  select.props.onSelect("2026-09")
  assert.equal(selection, null)
  assert.deepEqual(Array.from(select.props.options, option => option.label), ["September 2026", "August 2026"])
  const unavailablePicker = pure.MonthHistoryControl({ monthLabel:"December 2025", selectedMonth:"2025-12", catalog:null,
    loading:true, error:true, onSelect:()=>{}, onRetry:()=>{} })
  const unavailableControl = nodes(unavailablePicker).find(node => node?.type === "month-picker")
  assert.equal(unavailableControl.props.disabled, true, "Initial history loading cannot open an incomplete picker")
  assert.ok(unavailableControl.props.options.some(option => option.value === "2025-12"), "A loaded report remains represented while history is unavailable")
  const currentPicker = pure.MonthHistoryControl({ monthLabel:"September 2026", selectedMonth:"2026-09", loading:false, error:false,
    catalog:{ currentMonth:"2026-09", months:[{value:"2026-09",label:"September 2026"}],coverage:{status:"complete"}},
    onSelect:value=>{selection=value},onRetry:()=>{} })
  const currentControl = nodes(currentPicker).find(node => node?.type === "month-picker")
  assert.equal(currentControl.props.options.length, 1, "Current month is never duplicated for an explicit current selection")
  currentControl.props.onSelect("2026-09")
  assert.equal(selection, null, "Selecting the current month resumes automatic rollover")
  assert.ok(!button(picker, "This month"), "The month dropdown also provides the return to the automatic current month")
  assert.equal(pure.reportMonthLabel("2026-08"), "August 2026")
  assert.match(pure.reportMonthLabel(null), /^[A-Z][a-z]+ \d{4}$/, "The opening view uses a month name, not a relative label")

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
  const motion = { exports: {}, require: req }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync("web/expense-report/src/components/ui/motion.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, motion)
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
        CollapsibleContent: motion.exports.CollapsibleContent,
        FittedAmount: ({children}) => React.createElement("span", null, children),
        MonthPicker: ({ label, ...props }) => React.createElement("test-month-picker", { "aria-label":label, ...props }),
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
  const findButton = label => tree.root.findAllByType("button").find(item => text(item.props.children) === label
    || item.findAllByType("span").some(span => span.children.join("") === label))
  const click = label => renderer.act(() => findButton(label).props.onClick())
  const selectMonth = value => renderer.act(() => tree.root.findByProps({"aria-label":"Comparison month"}).props.onSelect(value))
  const period = amount => ({datedSpending:amount,undatedSpending:0,scheduledSpending:0,unitemizedSpending:0,complete:true})
  const result = (baseline, note) => ({selectedMonth:"2026-09", baselineMonth:baseline,
    baselineKind:"selected-month", throughDay:7, status:"complete", selected:period(25),
    baseline:period(50), changeAmount:-25, changePercent:-50, coverageNote:note})
  const finish = async (call, status, data) => renderer.act(async () => { call.resolve(response(status, data)); await flush() })
  renderer.act(() => { tree = renderer.create(component()) })
  assert.equal(calls.length, 0, "Closed comparisons do not fetch two reports")
  const comparisonMarker = findButton("Compare spending").findByProps({ className: "bb-disclosure-mark" })
  assert.deepEqual(comparisonMarker.children, [])
  assert.equal(comparisonMarker.props["aria-hidden"], "true")
  click("Compare spending")
  assert.equal(findButton("Compare spending").props["aria-expanded"], true)
  assert.equal(findButton("Compare spending").findByProps({ className: "bb-disclosure-mark" }), comparisonMarker)
  const oldMonth = calls.at(-1)
  assert.equal(oldMonth.url, "/app/expenses/comparison?month=2026-09&compare_month=2026-08")
  assert.equal(oldMonth.init.cache, "no-store")
  assert.equal(oldMonth.init.credentials, "same-origin")
  assert.ok([...timers.values()].some(timer => timer.delay === 60000), "Paired live builds have a 60s budget")
  assert.ok(!findButton("Last year"), "Comparison uses one accessible month dropdown")
  assert.equal(tree.root.findByProps({"aria-label":"Comparison month"}).props.options.length, 2, "Selected month is excluded and previous month is not duplicated")
  assert.deepEqual(Array.from(tree.root.findByProps({"aria-label":"Comparison month"}).props.options, option => option.label), ["August 2026", "September 2025"])
  selectMonth("2025-09")
  selectMonth("2026-08")
  click("Compare spending")
  assert.equal(findButton("Compare spending").props["aria-expanded"], false)
  assert.equal(findButton("Compare spending").findByProps({ className: "bb-disclosure-mark" }), comparisonMarker, "The outer comparison stroke persists throughout collapse")
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
  const detailsPanel = () => tree.root.findAllByType("div").find(item => item.props.id === findButton("Details").props["aria-controls"])
  assert.equal(findButton("Details").props["aria-expanded"], false)
  const detailsMarker = findButton("Details").findByProps({ className: "bb-disclosure-mark" })
  assert.deepEqual(detailsMarker.children, [])
  assert.equal(detailsMarker.props["aria-hidden"], "true")
  assert.equal(detailsPanel().props["aria-hidden"], true)
  assert.equal(detailsPanel().props.inert, true, "Calculation notes start hidden from keyboard and screen reader navigation")
  assert.match(text(detailsPanel().props.children), /September completed/)
  const beforeDetails = calls.length
  click("Details")
  assert.equal(findButton("Details").findByProps({ className: "bb-disclosure-mark" }), detailsMarker)
  assert.equal(detailsPanel().props["data-state"], "open")
  assert.equal(detailsPanel().props.inert, false)
  click("Details")
  assert.equal(findButton("Details").findByProps({ className: "bb-disclosure-mark" }), detailsMarker, "Details collapse reuses the same CSS stroke element")
  assert.equal(detailsPanel().props["data-state"], "closed")
  assert.equal(calls.length, beforeDetails, "Calculation notes do not trigger another comparison read")
  click("Details")
  selectMonth("2026-08")
  assert.equal(findButton("Details").props["aria-expanded"], false, "A different month starts with its own compact summary")
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
  await finish(calls.at(-1),503,{code:"source_timeout",error:"PRIVATE PROVIDER TIMEOUT"})
  assert.match(read(),/Google Sheets took too long/)
  assert.ok(!read().includes("PRIVATE PROVIDER"))
  const timeoutCalls = calls.length
  await flush()
  assert.equal(calls.length,timeoutCalls,"Source timeouts remain explicit retry states")
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
  assert.match(read(), /taking longer than expected/)
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
  assert.match(read(), /taking longer than expected/, "Timeout must finish even when transport ignores cancellation")
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
  const partial = {...result("2026-08", "Undated costs, sheet adjustments and scheduled subscriptions are excluded."),status:"partial",
    selected:{...period(540.01),undatedSpending:2287.40,scheduledSpending:92.48,unitemizedSpending:-100},
    baseline:{...period(349.31),undatedSpending:2563.71,scheduledSpending:92.48},changeAmount:190.70,changePercent:54.6}
  await finish(calls.at(-1), 200, partial)
  assert.match(read(), /Recorded spending · days 1– 7/)
  assert.match(text(tree.root.findByProps({className:"bb-comparison-change"}).props.children), /\$190.70\s+more.*54.6/)
  assert.equal(detailsPanel().props["aria-hidden"], true)
  click("Details")
  const exclusions = tree.root.findByType("table")
  assert.equal(exclusions.findByType("caption").children.join(""), "Excluded amounts")
  const rows = exclusions.findByType("tbody").findAllByType("tr")
  assert.deepEqual(rows.map(row => text(row.props.children)), ["Without dates $2,287.40 $2,563.71", "Scheduled subscriptions $92.48 $92.48", "Sheet adjustments -$100.00 $0.00"])
  assert.match(text(exclusions.findByType("thead").props.children), /September 2026.*August 2026/)

  report = {...report}
  renderer.act(() => tree.update(component()))
  await finish(calls.at(-1), 200, {...result("2026-08", "Matching days"),selected:period(0),baseline:period(0),changeAmount:0,changePercent:null})
  assert.equal(text(tree.root.findByProps({className:"bb-comparison-change"}).props.children), "Same spending")
  assert.equal(tree.root.findAllByType("table").length, 0, "Zero exclusions do not create unnecessary rows")

  report = {...report}
  renderer.act(() => tree.update(component()))
  await finish(calls.at(-1), 200, {...result("2026-08", "The comparison month is unavailable."),status:"unavailable",baseline:null,changeAmount:null,changePercent:null})
  assert.ok(!findButton("Details"), "Unavailable data cannot be hidden behind a successful-result disclosure")
  assert.match(read(), /The comparison month is unavailable/)
  assert.equal(tree.root.findAllByProps({className:"bb-comparison-values"}).length, 0, "Missing months are never presented as zero spending")
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

  // A recovered main report should clear a stale catalog warning once. Keep
  // actual React effects so catalog retries cannot be hidden by hook stubs.
  let catalogReport = liveReport(), catalogState, catalogTree
  function CatalogProbe() {
    catalogState = runtime.exports.useReportMonthCatalog(true,()=>{},"2026-09",catalogReport)
    return React.createElement(runtime.exports.MonthHistoryControl,{
      monthLabel:"September 2026",selectedMonth:null,catalog:catalogState.catalog,
      loading:catalogState.loading,error:catalogState.error,errorMessage:catalogState.errorMessage,
      onSelect:()=>{},onRetry:catalogState.refresh,
    })
  }
  const catalogPartial = {...months,coverage:{status:"partial",unavailableYears:[2025],code:"source_timeout"}}
  const initialCatalogCalls = calls.length
  renderer.act(() => { catalogTree = renderer.create(React.createElement(CatalogProbe)) })
  await finish(calls.at(-1),200,catalogPartial)
  assert.match(text(catalogTree.toJSON()),/Google Sheets timed out/)
  assert.equal(catalogState.catalog.months.length,3,"Partial reads keep usable month options")
  assert.equal(calls.length,initialCatalogCalls+1)
  renderer.act(() => catalogTree.update(React.createElement(CatalogProbe)))
  assert.equal(calls.length,initialCatalogCalls+1,"Rerenders and failed main refreshes with unchanged report do not retry history")
  catalogReport = liveReport()
  renderer.act(() => catalogTree.update(React.createElement(CatalogProbe)))
  assert.equal(calls.length,initialCatalogCalls+2,"A newly successful report retries incomplete history once")
  assert.equal(catalogState.catalog.months.length,3,"Recovery retains partial choices while it checks the missing months")
  await finish(calls.at(-1),200,months)
  assert.equal(catalogState.catalog.coverage.status,"complete")
  assert.ok(!text(catalogTree.toJSON()).includes("timed out"))
  catalogReport = liveReport()
  renderer.act(() => catalogTree.update(React.createElement(CatalogProbe)))
  assert.equal(calls.length,initialCatalogCalls+2,"Fresh reports do not re-fetch an already complete catalog")

  renderer.act(() => catalogState.refresh())
  await finish(calls.at(-1),503,{code:"source_timeout",error:"PRIVATE CATALOG DETAILS"})
  assert.match(text(catalogTree.toJSON()),/Google Sheets took too long/)
  assert.ok(!text(catalogTree.toJSON()).includes("PRIVATE"))
  catalogReport = liveReport()
  renderer.act(() => catalogTree.update(React.createElement(CatalogProbe)))
  const recoveryCalls = calls.length
  await finish(calls.at(-1),200,catalogPartial)
  renderer.act(() => catalogTree.update(React.createElement(CatalogProbe)))
  assert.equal(calls.length,recoveryCalls,"An incomplete recovery result cannot create another recovery attempt")

  renderer.act(() => catalogState.refresh())
  const existingCatalog = calls.at(-1)
  catalogReport = liveReport()
  renderer.act(() => catalogTree.update(React.createElement(CatalogProbe)))
  assert.equal(calls.at(-1),existingCatalog,"A successful report waits for the existing catalog read")
  assert.equal(existingCatalog.init.signal.aborted,false)
  await finish(existingCatalog,200,catalogPartial)
  assert.notEqual(calls.at(-1),existingCatalog,"Pending success recovers once after the existing incomplete read")
  await finish(calls.at(-1),200,months)
  assert.equal(catalogState.catalog.coverage.status,"complete")
  renderer.act(() => catalogState.refresh())
  const slowCatalog = calls.at(-1)
  const beforeCatalogDeadline = calls.length
  await renderer.act(async () => { [...timers.values()].find(timer => timer.delay === 30000).fn(); await flush() })
  assert.equal(slowCatalog.init.signal.aborted,true)
  assert.match(catalogState.errorMessage,/History is taking longer than expected/)
  assert.equal(catalogState.catalog.months.length,3,"A catalog deadline preserves known month choices")
  assert.equal(calls.length,beforeCatalogDeadline,"A client catalog deadline cannot start another request")
  renderer.act(() => catalogTree.unmount())
  assert.equal(timers.size,0)
  console.log("Month picker, comparison and report-refresh lifecycle checks passed")
}
main().catch(error => { console.error(error); process.exitCode = 1 })
