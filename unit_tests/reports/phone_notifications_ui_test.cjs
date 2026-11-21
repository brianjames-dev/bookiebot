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
const TestRenderer = frontendRequire("react-test-renderer")
const { act } = TestRenderer
global.IS_REACT_ACT_ENVIRONMENT = true
const browser = {}
const timers = new Map()
let timerId = 0
const browserNotification = { requestPermission: () => browser.permission() }
const browserWindow = { isSecureContext: true, PushManager: function () {}, Notification: browserNotification,
  setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id },
  clearTimeout: id => timers.delete(id) }
const browserNavigator = {}
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
  vm.runInNewContext(outputText, { exports, require: localRequire, atob, AbortController, Error, window: browserWindow,
    navigator: browserNavigator, Notification: browserNotification, fetch: (...args) => browser.fetch(...args) })
  return exports
}
const { PhoneNotifications, pushKeyBytes } = load(path.join(frontend, "src/phone-notifications.tsx"))
const html = renderToStaticMarkup(React.createElement(PhoneNotifications))
const embeddedHtml = renderToStaticMarkup(React.createElement(PhoneNotifications, { embedded: true }))
assert.ok(embeddedHtml.includes('aria-label="Phone notifications"'))
assert.ok(!embeddedHtml.includes('aria-expanded='), "Settings embeds notifications without another collapsed heading")
assert.ok(embeddedHtml.includes('role="status"') && embeddedHtml.includes('bb-report-loading-spinner') && embeddedHtml.includes('Loading notification settings…'), "Embedded settings retains an accessible device status with the shared compact spinner")
assert.ok(html.includes('aria-label="Phone notifications"'))
assert.ok(html.includes('aria-expanded="false"') && html.includes('inert=""'))
assert.ok(!embeddedHtml.includes('role="switch"'), "Wait for the stored preferences before displaying the controls")
assert.ok(!embeddedHtml.includes("Enable on this phone") && !embeddedHtml.includes("Send a test"))
const bytes = new Uint8Array([4, 0, 1, 254, 255])
assert.deepEqual(Array.from(pushKeyBytes(Buffer.from(bytes).toString("base64url"))), Array.from(bytes))

async function workerContracts() {
  const handlers = {}, shown = [], opened = [], focused = []
  let windows = []
  const self = {
    location: { origin: "https://bookiebot.example" },
    addEventListener: (name, handler) => { handlers[name] = handler },
    registration: { showNotification: async (...args) => { shown.push(args) } },
    clients: { matchAll: async () => windows, openWindow: async (url) => { opened.push(url) } },
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../src/bookiebot/reports/assets/phone-notifications-worker.js"), "utf8"), { self, URL })
  assert.equal(handlers.fetch, undefined, "Worker must not intercept or cache financial requests")
  let completed
  handlers.push({ data: { json: () => ({ title: "untrusted", body: "Scheduled payments tomorrow", tag: "upcoming:2026-09-07", url: "https://untrusted.test" }) }, waitUntil: promise => { completed = promise } })
  await completed
  assert.equal(shown[0][0], "BookieBot")
  assert.equal(shown[0][1].tag, "upcoming:2026-09-07")
  assert.equal(shown[0][1].data.url, "/app/expenses")
  handlers.push({ data: { json: () => { throw Error("Malformed push") } }, waitUntil: promise => { completed = promise } })
  await completed
  assert.ok(shown[1][1].body.includes("latest report"), "Malformed payload still displays a private user-visible notification")
  const notification = { close() {}, data: { url: "https://untrusted.test" } }
  handlers.notificationclick({ notification, waitUntil: promise => { completed = promise } })
  await completed
  assert.deepEqual(opened, ["/app/expenses"])
  windows = [{ url: "https://bookiebot.example/app/expenses", focus: async () => focused.push("report") }]
  handlers.notificationclick({ notification, waitUntil: promise => { completed = promise } })
  await completed
  assert.deepEqual(focused, ["report"])
  assert.equal(opened.length, 1)
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const prefs = { weekly: true, weeklyDays: [0], upcoming: false, reminderDaysBefore: 1, showAmounts: false, hour: 10 }
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url")
const response = data => ({ ok: true, json: async () => data })
function resetBrowser(changes = {}) {
  timers.clear()
  const calls = [], steps = { permission: 0, get: 0, subscribe: 0, unsubscribe: 0, register: 0 }
  const subscription = { toJSON: () => ({ endpoint: "https://web.push.apple.com/example", keys: {} }), unsubscribe: async () => { steps.unsubscribe++ } }
  const registration = { pushManager: {
    getSubscription: () => { steps.get++; return changes.getSubscription ? changes.getSubscription() : Promise.resolve(subscription) },
    subscribe: (options) => {
      steps.subscribe++
      if (changes.requireActivation && !browser.activation) return Promise.reject(Error("Push subscription requires the original tap"))
      assert.equal(options.userVisibleOnly, true)
      assert.equal(options.applicationServerKey.length, 65)
      return changes.subscribe ? changes.subscribe() : Promise.resolve(subscription)
    },
  } }
  browserNotification.permission = "default"
  browserWindow.PushManager = function () {}
  browser.permission = () => { steps.permission++; return changes.permission ? changes.permission() : Promise.resolve("granted") }
  browserNavigator.serviceWorker = { register: () => { steps.register++; return changes.register ? changes.register() : Promise.resolve(registration) }, ready: Promise.resolve(registration) }
  browser.fetch = (url, options = {}) => {
    if (["POST", "DELETE"].includes(options.method)) {
      assert.equal(options.mode, "same-origin")
      assert.equal(options.referrerPolicy, "same-origin", "Mutations must retain the app Origin despite the page's no-referrer policy")
      assert.equal(options.credentials, "same-origin")
      assert.equal(options.redirect, "error")
    }
    calls.push({ url, options })
    return changes.fetch ? changes.fetch(url, options) : Promise.resolve(response(options.method === "POST"
      ? { enabled: true, preferences: JSON.parse(options.body).preferences }
      : options.method === "DELETE" ? { enabled: false } : { enabled: false, preferences: prefs, publicKey }))
  }
  return { calls, steps, subscription, registration }
}
const button = (tree, text) => tree.root.findAllByType("button").find(node => node.children.join("") === text)
async function mount(props) {
  let tree
  await act(async () => { tree = TestRenderer.create(React.createElement(PhoneNotifications, props)); await flush() })
  return tree
}
async function tap(tree, text) {
  const selected = button(tree, text)
  assert.ok(selected, `Expected button ${text}`)
  assert.ok(!selected.props.disabled, `Expected enabled button ${text}`)
  await act(async () => {
    browser.activation = true
    try { selected.props.onClick() } finally { browser.activation = false }
    await flush()
  })
}
async function unmount(tree) { await act(async () => { tree.unmount(); await flush() }) }
const mutations = state => state.calls.filter(call => ["POST", "DELETE"].includes(call.options.method))

async function lifecycleContracts() {
  // Real React handlers/effects must invoke subscribe before yielding the tap.
  // The browser's subscribe call requests permission and reuses existing keys.
  let state = resetBrowser({ requireActivation: true, getSubscription: () => Promise.resolve(null) })
  let tree = await mount({ embedded: true })
  assert.equal(state.steps.permission, 0, "Loading settings must never ask for OS permission")
  assert.equal(state.steps.subscribe, 0, "Loading settings must never subscribe automatically")
  await tap(tree, "Mo")
  assert.equal(button(tree, "Mo").props["aria-pressed"], true, "Selecting a day directly enables that summary day")
  assert.ok(!button(tree, "Turn off") && !button(tree, "Send a test"))
  assert.equal(state.steps.subscribe, 1)
  assert.equal(state.steps.get, 0)
  assert.equal(state.steps.permission, 0, "Do not separate permission and subscription into two asynchronous requests")
  assert.deepEqual(JSON.parse(mutations(state)[0].options.body).preferences, prefs)
  await unmount(tree)

  // Run real React cleanup while the OS prompt/subscription is pending.
  const subscribing = deferred()
  state = resetBrowser({ subscribe: () => subscribing.promise })
  tree = await mount(); await tap(tree, "Mo")
  assert.equal(state.steps.subscribe, 1)
  await unmount(tree)
  await act(async () => { subscribing.resolve(state.subscription); await flush() })
  assert.equal(mutations(state).length, 0)
  assert.equal(state.steps.unsubscribe, 0, "Late cleanup must not revoke a subscription reused by another page")

  const saving = deferred()
  state = resetBrowser({ fetch: (_url, options) => options.method === "POST" ? saving.promise : Promise.resolve(response({ enabled: false, preferences: prefs, publicKey })) })
  tree = await mount(); await tap(tree, "Mo")
  assert.equal(mutations(state).length, 1)
  const postSignal = mutations(state)[0].options.signal
  await unmount(tree)
  assert.equal(postSignal.aborted, true, "Unmount aborts the in-flight authenticated mutation")
  await act(async () => { saving.resolve(response({ enabled: true, preferences: prefs })); await flush() })
  assert.equal(mutations(state).length, 1)

  let offline = true
  state = resetBrowser({ fetch: () => offline ? Promise.reject(Error("Offline")) : Promise.resolve(response({ enabled: false, preferences: prefs, publicKey })) })
  tree = await mount()
  assert.ok(button(tree, "Try again"))
  offline = false; await tap(tree, "Try again")
  assert.ok(!tree.root.findByType("fieldset").props.disabled)
  await unmount(tree)

  let registrationFails = true
  state = resetBrowser({ register: () => registrationFails ? Promise.reject(Error("Worker unavailable")) : Promise.resolve(state.registration) })
  tree = await mount()
  assert.ok(button(tree, "Try again"), "A worker failure after settings loaded must still offer a retry")
  registrationFails = false; await tap(tree, "Try again")
  assert.ok(!tree.root.findByType("fieldset").props.disabled)
  await unmount(tree)

  const waiting = deferred()
  state = resetBrowser({ subscribe: () => waiting.promise })
  tree = await mount(); await tap(tree, "Mo")
  const timeout = [...timers.values()].find(timer => timer.delay === 30000)
  assert.ok(timeout)
  await act(async () => { timeout.callback(); await flush() })
  assert.ok(!tree.root.findByType("fieldset").props.disabled, "A stuck subscription step must release busy state after timeout")
  await act(async () => { waiting.resolve(state.subscription); await flush() })
  assert.equal(mutations(state).length, 0)
  await unmount(tree)

  // Preferences save independently of browser permission/worker readiness,
  // then survive a full React unmount and settings reload.
  let persisted = { enabled: true, preferences: { ...prefs, hour: 12 }, publicKey }
  let savingFails = false
  state = resetBrowser({
    register: () => Promise.reject(Error("Worker update temporarily unavailable")),
    subscribe: () => { throw Error("Saving preferences must not touch browser subscription") },
    permission: () => { throw Error("Saving preferences must not request permission") },
    fetch: (_url, options) => {
      if (options.method === "POST") {
        if (savingFails) return Promise.reject(Error("Offline while saving"))
        const body = JSON.parse(options.body)
        assert.equal(body.subscription, undefined)
        persisted = { ...persisted, preferences: body.preferences }
      }
      return Promise.resolve(response(persisted))
    },
  })
  tree = await mount()
  await tap(tree, "We")
  assert.deepEqual(persisted.preferences.weeklyDays, [0, 2])
  await tap(tree, "Mo")
  await tap(tree, "We")
  assert.equal(persisted.preferences.weekly, false, "Deselecting the last day disables the summary")
  assert.deepEqual(persisted.preferences.weeklyDays, [])
  assert.equal(state.steps.subscribe, 0, "Turning all types off retains the existing device subscription")
  const changeSwitch = async (index, checked) => {
    await act(async () => {
      tree.root.findAllByProps({ role: "switch" })[index].props.onChange({ target: { checked } })
      await flush()
    })
  }
  await changeSwitch(0, true)
  assert.equal(persisted.preferences.upcoming, true)
  const timing = tree.root.findByProps({ "aria-label": "Payment reminder timing" })
  await act(async () => { timing.props.onChange({ target: { value: "2" } }); await flush() })
  assert.equal(persisted.preferences.reminderDaysBefore, 2)
  const deliveryTime = tree.root.findByProps({ "aria-label": "Notification delivery time" })
  await act(async () => { deliveryTime.props.onChange({ target: { value: "18" } }); await flush() })
  assert.equal(persisted.preferences.hour, 18)
  savingFails = true
  await changeSwitch(1, true)
  assert.equal(tree.root.findAllByProps({ role: "switch" })[1].props.checked, false, "A failed save restores the actual setting")
  assert.equal(persisted.preferences.showAmounts, false)
  assert.ok(tree.root.findByProps({ role: "alert" }).children.join("").includes("Offline"))
  savingFails = false
  await changeSwitch(1, true)
  assert.equal(persisted.preferences.showAmounts, true)
  assert.equal(state.steps.subscribe, 0)
  assert.equal(state.steps.permission, 0)
  await unmount(tree)
  tree = await mount()
  assert.equal(tree.root.findAllByProps({ role: "switch" })[0].props.checked, true)
  assert.equal(tree.root.findByProps({ "aria-label": "Notification delivery time" }).props.value, 18)
  await unmount(tree)

  const loading = deferred()
  state = resetBrowser({ fetch: () => loading.promise })
  tree = await mount()
  assert.equal(tree.root.findAllByProps({ role: "switch" }).length, 0, "Loading cannot overwrite choices edited before settings arrived")
  assert.equal(tree.root.findByProps({ className: "bb-notification-state" }).findByProps({className:'sr-only'}).children.join(''), 'Loading notification settings…')
  await unmount(tree)

  state = resetBrowser({ subscribe: () => Promise.reject(Object.assign(Error("Denied"), { name: "NotAllowedError" })) })
  tree = await mount(); await tap(tree, "Mo")
  assert.equal(mutations(state).length, 0)
  assert.ok(tree.root.findByProps({ role: "alert" }).children.join("").includes("iPhone Settings"))
  await unmount(tree)

  state = resetBrowser()
  tree = await mount(); await tap(tree, "Mo")
  assert.deepEqual(JSON.parse(mutations(state)[0].options.body).preferences, prefs)
  await tap(tree, "Mo")
  assert.equal(mutations(state)[1].options.method, "POST")
  const disabled = JSON.parse(mutations(state)[1].options.body)
  assert.equal(disabled.preferences.weekly, false)
  assert.equal(disabled.subscription, undefined)
  assert.equal(state.steps.unsubscribe, 0, "Disabling the last type retains the device subscription for later use")
  await unmount(tree)

  state = resetBrowser(); delete browserWindow.PushManager
  tree = await mount()
  assert.equal(tree.root.findByType("fieldset").props.disabled, true)
  assert.equal(state.steps.register, 0)
  assert.equal(state.steps.permission, 0)
  assert.equal(mutations(state).length, 0)
  await unmount(tree)
  assert.equal(timers.size, 0, "Unmount cleans up all notification timeouts")


}
workerContracts().then(lifecycleContracts).then(() => console.log("Phone notification UI, worker and real React lifecycle checks passed")).catch(error => { console.error(error); process.exitCode = 1 })
