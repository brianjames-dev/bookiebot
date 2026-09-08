const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("../../web/expense-report/node_modules/typescript")

const source = fs.readFileSync(path.join(__dirname, "../../web/expense-report/src/expense-app-session.ts"), "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText
const runtime = { exports: {}, AbortController, setTimeout, clearTimeout, Date, URL }
vm.runInNewContext(compiled, runtime)
const { ExpenseAppSession, ExpenseAppPairing, parseExpenseAppSetupLink, expenseReportIdentity, watchExpenseAppLifecycle } = runtime.exports
const config = { ownerName: "Brian", reportUrl: "/app/expenses/data", logoutUrl: "/app/logout" }
const report = (month = 9, amount = 50) => ({
  ownerName: "Brian", year: 2026, month, metrics: { monthlyIncome: amount },
  incomeProjection: {}, savingsProjection: {}, breakdown: [], dailyEntries: [],
})
const response = (status, data) => new Response(status === 204 ? null : JSON.stringify(data), { status })
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
function fixture(options = {}) {
  const calls = []
  let now = 10000
  const fetch = (url, init) => new Promise((resolve, reject) => calls.push({ url, init, resolve, reject }))
  const session = new ExpenseAppSession(config, { fetch, now: () => now, ...options })
  return { session, calls, advance: (ms = 3000) => { now += ms } }
}
async function load(f, data = report()) {
  const pending = f.session.refresh(true)
  f.calls.at(-1).resolve(response(200, data))
  await pending
}

async function main() {
  const token = "a".repeat(43)
  const origin = "https://bookiebot.example"
  assert.equal(parseExpenseAppSetupLink(`${origin}/app/connect#${token}`, origin), token)
  assert.equal(parseExpenseAppSetupLink(token, origin), token)
  for (const invalid of [`https://other.test/app/connect#${token}`, `${origin}/wrong#${token}`, `${origin}/app/connect?token=${token}`, "javascript:alert(1)"]) {
    assert.equal(parseExpenseAppSetupLink(invalid, origin), null)
  }
  const pairingCalls = []
  const pairing = new ExpenseAppPairing((url, init) => new Promise(resolve => pairingCalls.push({ url, init, resolve })))
  await pairing.connect()
  assert.equal(pairingCalls.length, 0, "Explicit owner confirmation is required")
  const check = pairing.check(token, origin)
  pairingCalls[0].resolve(response(200, { ownerName: "Brian" }))
  await check
  assert.equal(pairing.state.phase, "confirm")
  assert.equal(JSON.stringify(pairing.state).includes(token), false)
  const redeem = pairing.connect()
  assert.equal(pairingCalls[1].url, "/app/connect")
  assert.equal(pairingCalls[1].init.headers["X-BookieBot-App"], "1")
  assert.equal(pairingCalls[1].init.referrerPolicy, "same-origin", "Reconnect must keep its real Origin under the no-referrer page policy")
  pairingCalls[1].resolve(response(200, { next: "/app/expenses" }))
  await redeem
  assert.equal(pairing.state.phase, "connected")
  pairing.reset()
  await pairing.connect()
  assert.equal(pairingCalls.length, 2)
  pairing.dispose()
  const f = fixture()
  const first = f.session.refresh(true)
  assert.equal(f.session.state.phase, "loading")
  assert.equal(f.session.refresh(true), first, "Even manual refresh shares an in-flight request")
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, config.reportUrl)
  assert.equal(f.calls[0].init.credentials, "same-origin")
  assert.equal(f.calls[0].init.mode, "same-origin")
  assert.equal(f.calls[0].init.cache, "no-store")
  f.calls[0].resolve(response(200, report()))
  await first
  const identity = expenseReportIdentity(f.session.state.report)
  const updatedAt = f.session.state.updatedAt
  await f.session.refresh()
  assert.equal(f.calls.length, 1, "Focus immediately after completion must not fetch again")

  f.advance()
  const failed = f.session.refresh()
  const previous = f.session.state.report
  assert.equal(f.session.state.phase, "refreshing")
  f.calls.at(-1).resolve(response(503, {}))
  await failed
  assert.equal(f.session.state.phase, "stale")
  assert.equal(f.session.state.report, previous)
  assert.equal(f.session.state.updatedAt, updatedAt)
  assert.ok(f.session.state.message.includes("Couldn’t refresh"))
  assert.ok(!f.session.state.message.includes("connection"), "An unspecified server failure must not blame the phone connection")
  const sourceTimeout = f.session.refresh(true)
  f.calls.at(-1).resolve(response(503, { code: "source_timeout", error: "PRIVATE WORKBOOK AND PROVIDER DETAILS" }))
  await sourceTimeout
  assert.equal(f.session.state.phase,"stale")
  assert.equal(f.session.state.report,previous)
  assert.equal(f.session.state.updatedAt,updatedAt)
  assert.match(f.session.state.message,/Google Sheets took too long/)
  assert.ok(!f.session.state.message.includes("PRIVATE"))
  const afterSourceTimeout = f.calls.length
  await flush()
  assert.equal(f.calls.length,afterSourceTimeout,"A source timeout cannot start an automatic retry loop")
  const limited = f.session.refresh(true)
  f.calls.at(-1).resolve(response(503, { code: "sheets_rate_limited", error: "provider-private-details" }))
  await limited
  assert.equal(f.session.state.phase, "stale")
  assert.equal(f.session.state.report, previous)
  assert.match(f.session.state.message, /Google Sheets.*minute/)
  assert.ok(!f.session.state.message.includes("provider-private-details"))
  assert.ok(!f.session.state.message.includes("connection"))
  await load(f, report(9, 75))
  assert.equal(f.session.state.phase, "ready")
  assert.equal(expenseReportIdentity(f.session.state.report), identity, "Same month keeps the React report key and UI state")
  assert.equal(f.session.state.report.metrics.monthlyIncome, 75)
  await load(f, report(10, 10))
  assert.notEqual(expenseReportIdentity(f.session.state.report), identity, "New month remounts report with Current defaults")

  const expired = f.session.refresh(true)
  f.calls.at(-1).resolve(response(401, {}))
  await expired
  assert.equal(f.session.state.phase, "expired")
  assert.equal(f.session.state.report, null)
  assert.equal(f.session.state.updatedAt, null)
  const count = f.calls.length
  await f.session.refresh(true)
  assert.equal(f.calls.length, count, "An expired session stays closed until reconnection")
  f.session.dispose()

  const logout = fixture()
  await load(logout)
  const obsoleteRefresh = logout.session.refresh(true)
  const obsolete = logout.calls.at(-1)
  const signingOut = logout.session.signOut()
  assert.equal(obsolete.init.signal.aborted, true)
  assert.equal(logout.session.state.signingOut, true)
  assert.equal(logout.session.signOut(), signingOut)
  const post = logout.calls.at(-1)
  assert.equal(post.url, config.logoutUrl)
  assert.equal(post.init.method, "POST")
  assert.equal(post.init.headers["X-BookieBot-App"], "1")
  post.resolve(response(204))
  await signingOut
  obsolete.resolve(response(200, report()))
  await obsoleteRefresh
  assert.equal(logout.session.state.phase, "signed-out")
  assert.equal(logout.session.state.report, null, "A late refresh cannot restore data after signout")
  logout.session.dispose()

  const retry = fixture()
  await load(retry)
  const rejectedLogout = retry.session.signOut()
  retry.calls.at(-1).resolve(response(503, {}))
  await rejectedLogout
  assert.equal(retry.session.state.phase, "stale")
  assert.ok(retry.session.state.report)
  assert.ok(retry.session.state.message.includes("Couldn’t sign out"))
  assert.equal(retry.session.state.signingOut, false)
  retry.session.dispose()

  const timeout = fixture({ timeoutMs: 10 })
  const timed = timeout.session.refresh(true)
  await timed
  assert.equal(timeout.calls[0].init.signal.aborted, true)
  assert.equal(timeout.session.state.phase, "error")
  assert.match(timeout.session.state.message,/taking longer than expected/)
  timeout.calls[0].resolve(response(200, report()))
  await flush()
  assert.equal(timeout.session.state.report, null, "Late data cannot override a timeout")
  timeout.session.dispose()
  const staleTimeout = fixture({timeoutMs:10})
  await load(staleTimeout)
  const beforeDeadline = staleTimeout.session.state.report
  const timestampBeforeDeadline = staleTimeout.session.state.updatedAt
  await staleTimeout.session.refresh(true)
  assert.equal(staleTimeout.session.state.report,beforeDeadline)
  assert.equal(staleTimeout.session.state.updatedAt,timestampBeforeDeadline)
  assert.equal(staleTimeout.session.state.phase,"stale")
  assert.match(staleTimeout.session.state.message,/taking longer than expected/)
  assert.equal(staleTimeout.calls.length,2)
  await load(staleTimeout,report(9,75))
  assert.equal(staleTimeout.session.state.phase,"ready","A client deadline releases the slot for an explicit retry")
  staleTimeout.session.dispose()

  const lifecycle = fixture()
  const browser = new EventTarget()
  const page = new EventTarget()
  page.visibilityState = "visible"
  const disconnect = watchExpenseAppLifecycle(lifecycle.session, browser, page)
  await load(lifecycle)
  lifecycle.advance()
  browser.dispatchEvent(new Event("focus"))
  browser.dispatchEvent(new Event("online"))
  page.dispatchEvent(new Event("visibilitychange"))
  assert.equal(lifecycle.calls.length, 2, "Resume signals share one request")
  lifecycle.calls.at(-1).resolve(response(200, report()))
  await flush()
  browser.dispatchEvent(new Event("focus"))
  assert.equal(lifecycle.calls.length, 2)
  lifecycle.advance()
  page.visibilityState = "hidden"
  browser.dispatchEvent(new Event("focus"))
  assert.equal(lifecycle.calls.length, 2)
  page.visibilityState = "visible"
  page.dispatchEvent(new Event("visibilitychange"))
  assert.equal(lifecycle.calls.length, 3)
  browser.dispatchEvent(new Event("pagehide"))
  assert.equal(lifecycle.calls.at(-1).init.signal.aborted, true)
  const restored = new Event("pageshow")
  restored.persisted = true
  browser.dispatchEvent(restored)
  assert.equal(lifecycle.calls.length, 4, "Back/forward restoration starts a fresh request after abort")
  lifecycle.calls.at(-1).resolve(response(200, report()))
  await flush()
  disconnect()
  lifecycle.advance()
  browser.dispatchEvent(new Event("focus"))
  page.dispatchEvent(new Event("visibilitychange"))
  assert.equal(lifecycle.calls.length, 4)
  lifecycle.session.dispose()

  const history = fixture()
  await load(history)
  const august = history.session.selectMonth("2026-08")
  const obsoleteAugust = history.calls.at(-1)
  assert.equal(obsoleteAugust.url, "/app/expenses/data?month=2026-08")
  assert.equal(history.session.state.report, null, "A requested month never displays the old month's report")
  const july = history.session.selectMonth("2026-07")
  assert.equal(obsoleteAugust.init.signal.aborted, true)
  history.calls.at(-1).resolve(response(200, report(7, 123)))
  await july
  obsoleteAugust.resolve(response(200, report(8, 999)))
  await august
  assert.equal(history.session.state.report.month, 7, "Latest month selection wins even when an older response arrives late")
  history.advance()
  const refreshJuly = history.session.refresh()
  assert.equal(history.calls.at(-1).url, "/app/expenses/data?month=2026-07", "Foreground refresh retains a selected historical month")
  history.calls.at(-1).resolve(response(200, report(7, 130)))
  await refreshJuly
  const failedMonth = history.session.selectMonth("2026-06")
  history.calls.at(-1).resolve(response(503, {}))
  await failedMonth
  assert.equal(history.session.state.phase, "error")
  assert.equal(history.session.state.report, null)
  assert.equal(history.session.state.selectedMonth, "2026-06")
  assert.match(history.session.state.message, /2026-06/)
  const wrongMonth = history.session.selectMonth("2026-05")
  history.calls.at(-1).resolve(response(200, report(9)))
  await wrongMonth
  assert.equal(history.session.state.report, null, "A mismatched server period is rejected")
  const backToCurrent = history.session.selectMonth(null)
  assert.equal(history.calls.at(-1).url, config.reportUrl)
  history.calls.at(-1).resolve(response(200, report(10)))
  await backToCurrent
  assert.equal(history.session.state.selectedMonth, null)
  assert.equal(history.session.state.report.month, 10, "This month follows a month rollover")
  assert.throws(() => history.session.selectMonth("2026-99"), /valid report month/)
  history.session.expire()
  assert.equal(history.session.state.phase, "expired")
  assert.equal(history.session.state.report, null)
  assert.equal(history.session.state.selectedMonth, null)
  history.session.dispose()

  const disposed = fixture()
  let publications = 0
  disposed.session.subscribe(() => publications++)
  const unfinished = disposed.session.refresh(true)
  disposed.session.dispose()
  assert.equal(disposed.calls[0].init.signal.aborted, true)
  disposed.calls[0].resolve(response(200, report()))
  await unfinished
  assert.equal(publications, 1, "Unmounted sessions never publish late financial data")
  console.log("Fresh expense app session runtime checks passed")
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
