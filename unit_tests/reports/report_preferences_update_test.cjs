const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")
const frontend = path.join(__dirname, "../../web/expense-report")
const frontendRequire = createRequire(path.join(frontend, "package.json"))
const ts = frontendRequire("typescript")
// Konsta exports ESM only. Bundle its actual implementation for this CJS harness.
const { Module } = require("node:module")
const konstaModule = new Module(path.join(frontend, "__konsta_test.cjs"), module)
konstaModule.filename = path.join(frontend, "__konsta_test.cjs")
konstaModule.paths = module.paths
konstaModule.require = frontendRequire
konstaModule._compile(frontendRequire("esbuild").buildSync({ stdin: { contents: 'export * from "konsta/react"', resolveDir: frontend }, bundle: true, platform: "node", format: "cjs", write: false, external: ["react", "react-dom"], logLevel: "silent" }).outputFiles[0].text, konstaModule.filename)

const React = frontendRequire("react")
const { renderToStaticMarkup } = frontendRequire("react-dom/server")
const modules = new Map()
function load(file) {
  if (modules.has(file)) return modules.get(file)
  const exports = {}; modules.set(file, exports)
  const localRequire = (name) => {
    if (name.endsWith(".css")) return {}
    if (name === "konsta/react") return konstaModule.exports
    if (!name.startsWith(".")) return frontendRequire(name)
    const base = path.resolve(path.dirname(file), name)
    return load([base + ".tsx", base + ".ts"].find(fs.existsSync))
  }
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  vm.runInNewContext(outputText, { exports, require: localRequire, AbortController, setTimeout, clearTimeout })
  return exports
}
const { reportPreferenceKey, loadReportViewPreferences, saveReportViewPreferences, availablePreferredChart } = load(path.join(frontend, "src/report-view-preferences.ts"))
const values = new Map()
const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
const asPlain = value => JSON.parse(JSON.stringify(value))
assert.deepEqual(asPlain(loadReportViewPreferences("Brian", true, storage)), { mode: "current", chartId: "burn-rate" })
assert.deepEqual(asPlain(loadReportViewPreferences("Brian", false, storage)), { mode: "current", chartId: "category" })
saveReportViewPreferences("Brian", { mode: "projected", chartId: "calendar", income: 1234, expenses: ["private"] }, storage)
assert.deepEqual(asPlain(loadReportViewPreferences(" brian ", true, storage)), { mode: "projected", chartId: "calendar" })
assert.deepEqual(asPlain(loadReportViewPreferences("Hannah", true, storage)), { mode: "current", chartId: "burn-rate" })
assert.deepEqual(JSON.parse(values.get(reportPreferenceKey("Brian"))), { version: 1, mode: "projected", chartId: "calendar" }, "Only presentation preferences may be persisted")
values.set(reportPreferenceKey("Brian"), JSON.stringify({ version: 1, mode: "bogus", chartId: "deleted-chart" }))
assert.deepEqual(asPlain(loadReportViewPreferences("Brian", true, storage)), { mode: "current", chartId: "burn-rate" })
values.set(reportPreferenceKey("Brian"), "{invalid")
assert.equal(loadReportViewPreferences("Brian", true, storage).mode, "current")
const blocked = { getItem() { throw Error("Storage unavailable") }, setItem() { throw Error("Quota exceeded") } }
assert.equal(loadReportViewPreferences("Brian", true, blocked).mode, "current")
assert.doesNotThrow(() => saveReportViewPreferences("Brian", { mode: "current", chartId: "bills" }, blocked))
saveReportViewPreferences("Brian", { mode: "current", chartId: "burn-rate" }, storage)
assert.equal(availablePreferredChart(loadReportViewPreferences("Brian", false, storage).chartId, false), "category")
assert.equal(loadReportViewPreferences("Brian", true, storage).chartId, "burn-rate", "A temporarily missing chart must not erase the preference")
assert.equal(availablePreferredChart("bills", false), "bills")

const { AppVersionWatcher, watchAppVersionLifecycle } = load(path.join(frontend, "src/app-update.ts"))
const { AppUpdatePrompt } = load(path.join(frontend, "src/app-update-prompt.tsx"))
const html = renderToStaticMarkup(React.createElement(AppUpdatePrompt, { initialVersion: "version1" }))
assert.ok(html.includes('aria-hidden="true"') && html.includes('inert=""'), "The update prompt starts hidden and cannot steal focus")
const response = (version, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => ({ version }) })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function updateContracts() {
  let answer = response("version1"), calls = [], notifications = []
  const watcher = new AppVersionWatcher("version1", { fetch: async (...args) => { calls.push(args); return answer } })
  watcher.subscribe(version => notifications.push(version))
  await watcher.check()
  assert.equal(watcher.availableVersion, null)
  assert.equal(calls[0][0], "/app/version")
  assert.equal(calls[0][1].cache, "no-store")
  assert.equal(calls[0][1].credentials, "same-origin")
  assert.equal(calls[0][1].redirect, "error")
  answer = response("version2")
  await watcher.check()
  assert.equal(watcher.availableVersion, "version2")
  watcher.dismiss(); assert.equal(watcher.availableVersion, "version2", "Settings still exposes a dismissed update")
  assert.equal(watcher.noticeVersion, null)
  await watcher.check(); assert.equal(watcher.noticeVersion, null)
  answer = response("version3")
  await watcher.check(); assert.equal(watcher.availableVersion, "version3")
  answer = response("version4", 503)
  await watcher.check(); assert.equal(watcher.availableVersion, "version3", "Temporary failures preserve the current app and existing update notice")
  answer = response("<script>unsafe</script>")
  await watcher.check(); assert.equal(watcher.availableVersion, "version3")
  answer = response("version4", 401)
  await watcher.check(); assert.equal(watcher.availableVersion, null)
  watcher.dispose(); const before = calls.length
  await watcher.check(); assert.equal(calls.length, before)

  const dismissedValues = new Map()
  const dismissedStorage = { getItem: key => dismissedValues.get(key), setItem: (key, value) => dismissedValues.set(key, value) }
  const firstSession = new AppVersionWatcher("version1", { storage: dismissedStorage, fetch: async () => response("version5") })
  await firstSession.check(); firstSession.dismiss(); firstSession.dispose()
  const remounted = new AppVersionWatcher("version1", { storage: dismissedStorage, fetch: async () => response("version5") })
  let available = null, notice = "initial"
  remounted.subscribeAvailability(value => { available = value }); remounted.subscribe(value => { notice = value })
  await remounted.check()
  assert.equal(available, "version5"); assert.equal(notice, null, "Later persists across prompt remounts in this session")
  assert.deepEqual([...dismissedValues.values()].map(JSON.parse), [["version5"]], "Only release version identifiers are stored")
  remounted.dispose()
  const blockedStorage = new AppVersionWatcher("version1", { storage: blocked, fetch: async () => response("version6") })
  await blockedStorage.check(); assert.doesNotThrow(() => blockedStorage.dismiss()); await blockedStorage.check()
  assert.equal(blockedStorage.noticeVersion, null); assert.equal(blockedStorage.availableVersion, "version6"); blockedStorage.dispose()

  let resolve, concurrent = 0
  const shared = new AppVersionWatcher("version1", { fetch: () => { concurrent++; return new Promise(done => { resolve = done }) } })
  const first = shared.check(), second = shared.check()
  assert.equal(concurrent, 1)
  assert.equal(first, second)
  resolve(response("version2")); await first
  assert.equal(shared.availableVersion, "version2")
  shared.dispose()

  const winEvents = new Map(), docEvents = new Map()
  let interval, checks = 0, cleared = false
  const win = {
    navigator: { onLine: true },
    setInterval: (callback, delay) => { assert.equal(delay, 300000); interval = callback; return 5 },
    clearInterval: value => { assert.equal(value, 5); cleared = true },
    addEventListener: (name, callback) => winEvents.set(name, callback),
    removeEventListener: name => winEvents.delete(name),
  }
  const doc = { visibilityState: "visible", addEventListener: (name, callback) => docEvents.set(name, callback), removeEventListener: name => docEvents.delete(name) }
  const stop = watchAppVersionLifecycle({ check: () => { checks++; return Promise.resolve() } }, win, doc)
  assert.equal(checks, 1)
  winEvents.get("focus")(); winEvents.get("online")(); interval()
  assert.equal(checks, 4)
  doc.visibilityState = "hidden"; interval(); winEvents.get("focus")(); assert.equal(checks, 4)
  doc.visibilityState = "visible"; docEvents.get("visibilitychange")(); assert.equal(checks, 5)
  win.navigator.onLine = false; interval(); assert.equal(checks, 5)
  stop(); assert.equal(cleared, true); assert.equal(winEvents.size, 0); assert.equal(docEvents.size, 0)
  await flush()
}
updateContracts().then(() => console.log("Report preference and deployed update checks passed")).catch(error => { console.error(error); process.exitCode = 1 })
