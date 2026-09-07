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
  vm.runInNewContext(outputText, { exports, require: localRequire, AbortController, setTimeout, clearTimeout,
    fetch: () => { throw new Error("Mount/render must not contact the model") } })
  return exports
}
const { ReportQuestionClient, initialQuestionState } = load(path.join(frontend, "src/report-question-client.ts"))
const { ReportQuestions } = load(path.join(frontend, "src/report-questions.tsx"))
const answer = (changes = {}) => ({ answer: "You have $300 left.", month: "2026-09", monthLabel: "September 2026",
  mode: "current", sources: ["overview", "overview", "unknown", "toString"], generatedAt: "Today at 10 AM", ...changes })
const response = (data, ok = true) => ({ ok, json: async () => data })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function main() {
  const markup = renderToStaticMarkup(React.createElement(ReportQuestions, { month: "2026-09", mode: "projected" }))
  assert.ok(markup.includes("September 2026") && markup.includes("Projected"))
  assert.ok(markup.includes('aria-expanded="false"') && markup.includes('inert=""'))
  assert.ok(markup.includes('maxLength="2000"'))
  assert.ok(markup.includes("This app doesn’t save a conversation"))
  assert.match(markup, /<button type="button"[^>]*>What is driving my spending\?<\/button>/, "Suggestions fill the input; they are not form submissions")
  assert.match(markup, /<button type="submit" disabled="">Ask BookieBot<\/button>/)
  const states = [], calls = [], first = deferred()
  const client = new ReportQuestionClient("2026-09", "current", state => states.push(state), (url, options) => { calls.push({ url, options }); return first.promise })
  assert.equal(calls.length, 0)
  await client.ask(" "); await client.ask("x".repeat(2001))
  assert.equal(calls.length, 0)
  const task = client.ask("Explain what I have left")
  assert.equal(states.at(-1).phase, "loading")
  await client.ask("Repeated tap")
  assert.equal(calls.length, 1, "Busy interaction cannot issue duplicate model calls")
  const request = calls[0]
  assert.equal(request.url, "/app/expenses/ask")
  assert.equal(request.options.credentials, "same-origin")
  assert.equal(request.options.cache, "no-store")
  assert.equal(request.options.headers["X-BookieBot-App"], "1")
  assert.deepEqual(JSON.parse(request.options.body), { question: "Explain what I have left", month: "2026-09", mode: "current" })
  first.resolve(response(answer())); await task
  assert.equal(states.at(-1).phase, "answered")
  assert.deepEqual(Array.from(states.at(-1).answer.sources), ["overview"])
  client.clear(); assert.equal(states.at(-1).phase, "idle"); assert.equal(states.at(-1).answer, null)

  for (const change of [{ month: "2026-08" }, { mode: "projected" }]) {
    const snapshots = []
    const mismatch = new ReportQuestionClient("2026-09", "current", state => snapshots.push(state), async () => response(answer(change)))
    await mismatch.ask("Explain")
    assert.equal(snapshots.at(-1).phase, "error")
    assert.equal(snapshots.at(-1).answer, null)
  }
  const retryStates = []; let count = 0
  const retry = new ReportQuestionClient("2026-09", "current", state => retryStates.push(state), async () => ++count === 1
    ? response({ error: "Please wait a moment." }, false) : response(answer()))
  await retry.ask("Explain")
  assert.equal(retryStates.at(-1).error, "Please wait a moment.")
  await retry.ask("Explain")
  assert.equal(retryStates.at(-1).phase, "answered"); assert.equal(count, 2)

  const late = deferred(), lateStates = []
  const oldView = new ReportQuestionClient("2026-09", "current", state => lateStates.push(state), () => late.promise)
  const oldTask = oldView.ask("Old view")
  oldView.dispose()
  late.resolve(response(answer())); await oldTask
  assert.equal(lateStates.length, 1, "A late old-view response cannot leak into the next month/mode/owner component")
  assert.equal(initialQuestionState("2026-08", "projected").answer, null)

  const canceled = deferred(), canceledStates = []
  const cancellable = new ReportQuestionClient("2026-09", "current", state => canceledStates.push(state), () => canceled.promise)
  const canceledTask = cancellable.ask("Cancel me")
  cancellable.clear(); canceled.resolve(response(answer())); await canceledTask
  assert.equal(canceledStates.at(-1).phase, "idle")
  assert.equal(canceledStates.at(-1).answer, null)
  console.log("Read-only report question UI and request lifecycle checks passed")
}
main().catch(error => { console.error(error); process.exitCode = 1 })
