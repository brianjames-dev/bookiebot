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
assert.ok(html.includes('aria-label="Phone notifications"'))
assert.ok(html.includes('aria-expanded="false"') && html.includes('inert=""'))
assert.ok(html.includes("iOS 16.4"))
const switches = [...html.matchAll(/<input[^>]*role="switch"[^>]*>/g)].map(match => match[0])
assert.equal(switches.length, 3)
assert.ok(switches[0].includes("checked"))
assert.ok(!switches[1].includes("checked"), "Daily payment reminders require their own opt-in")
assert.ok(!switches[2].includes("checked"), "Lock screen amounts default to private")
assert.ok(!html.includes("Send a test"), "No test can be sent before device opt-in")
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
const prefs = { weekly: true, upcoming: false, showAmounts: false, hour: 10 }
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
    calls.push({ url, options })
    return changes.fetch ? changes.fetch(url, options) : Promise.resolve(response(options.method === "POST"
      ? { enabled: true, preferences: prefs, message: "Accepted" }
      : options.method === "DELETE" ? { enabled: false } : { enabled: false, preferences: prefs, publicKey }))
  }
  return { calls, steps, subscription, registration }
}
const button = (tree, text) => tree.root.findAllByType("button").find(node => node.children.join("") === text)
async function mount() {
  let tree
  await act(async () => { tree = TestRenderer.create(React.createElement(PhoneNotifications)); await flush() })
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
  let tree = await mount()
  assert.equal(state.steps.permission, 0, "Loading settings must never ask for OS permission")
  assert.equal(state.steps.subscribe, 0, "Loading settings must never subscribe automatically")
  await tap(tree, "Enable on this phone")
  assert.ok(button(tree, "Turn off"), "The original user gesture reaches subscribe and the persisted device is On")
  assert.equal(state.steps.subscribe, 1)
  assert.equal(state.steps.get, 0)
  assert.equal(state.steps.permission, 0, "Do not separate permission and subscription into two asynchronous requests")
  assert.deepEqual(JSON.parse(mutations(state)[0].options.body).preferences, prefs)
  await unmount(tree)

  // Run real React cleanup while the OS prompt/subscription is pending.
  const subscribing = deferred()
  state = resetBrowser({ subscribe: () => subscribing.promise })
  tree = await mount(); await tap(tree, "Enable on this phone")
  assert.equal(state.steps.subscribe, 1)
  await unmount(tree)
  await act(async () => { subscribing.resolve(state.subscription); await flush() })
  assert.equal(mutations(state).length, 0)
  assert.equal(state.steps.unsubscribe, 0, "Late cleanup must not revoke a subscription reused by another page")

  const saving = deferred()
  state = resetBrowser({ fetch: (_url, options) => options.method === "POST" ? saving.promise : Promise.resolve(response({ enabled: false, preferences: prefs, publicKey })) })
  tree = await mount(); await tap(tree, "Enable on this phone")
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
  assert.ok(!button(tree, "Enable on this phone").props.disabled)
  await unmount(tree)

  let registrationFails = true
  state = resetBrowser({ register: () => registrationFails ? Promise.reject(Error("Worker unavailable")) : Promise.resolve(state.registration) })
  tree = await mount()
  assert.ok(button(tree, "Try again"), "A worker failure after settings loaded must still offer a retry")
  registrationFails = false; await tap(tree, "Try again")
  assert.ok(!button(tree, "Enable on this phone").props.disabled)
  await unmount(tree)

  const waiting = deferred()
  state = resetBrowser({ subscribe: () => waiting.promise })
  tree = await mount(); await tap(tree, "Enable on this phone")
  const timeout = [...timers.values()].find(timer => timer.delay === 30000)
  assert.ok(timeout)
  await act(async () => { timeout.callback(); await flush() })
  assert.ok(!button(tree, "Enable on this phone").props.disabled, "A stuck subscription step must release busy state after timeout")
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
  const requestsBeforeLastType = mutations(state).length
  await act(async () => { tree.root.findAllByProps({ role: "switch" })[0].props.onChange({ target: { checked: false } }); await flush() })
  assert.equal(tree.root.findAllByProps({ role: "switch" })[0].props.checked, true, "The last notification type stays selected; turning off has its own explicit action")
  assert.equal(mutations(state).length, requestsBeforeLastType)
  assert.equal(persisted.preferences.weekly, true)
  assert.ok(tree.root.findByProps({ role: "status" }).children.join("").includes("Use Turn off"))
  const switches = tree.root.findAllByProps({ role: "switch" })
  await act(async () => { switches[1].props.onChange({ target: { checked: true } }); await flush() })
  assert.equal(persisted.preferences.upcoming, true, "An opted-in phone automatically persists changed toggles")
  const deliveryTime = tree.root.findByProps({ "aria-label": "Notification delivery time" })
  await act(async () => { deliveryTime.props.onChange({ target: { value: "18" } }); await flush() })
  assert.equal(persisted.preferences.hour, 18)
  savingFails = true
  await act(async () => { tree.root.findAllByProps({ role: "switch" })[2].props.onChange({ target: { checked: true } }); await flush() })
  assert.equal(tree.root.findAllByProps({ role: "switch" })[2].props.checked, true, "A failed save keeps the user's selected preferences available to retry")
  assert.equal(persisted.preferences.showAmounts, false)
  assert.ok(tree.root.findByProps({ role: "alert" }).children.join("").includes("Offline"))
  savingFails = false
  await tap(tree, "Save preferences")
  assert.equal(persisted.preferences.showAmounts, true)
  assert.equal(state.steps.subscribe, 0)
  assert.equal(state.steps.permission, 0)
  await unmount(tree)
  tree = await mount()
  assert.equal(tree.root.findAllByProps({ role: "switch" })[1].props.checked, true)
  assert.equal(tree.root.findByProps({ "aria-label": "Notification delivery time" }).props.value, 18)
  await unmount(tree)

  const loading = deferred()
  state = resetBrowser({ fetch: () => loading.promise })
  tree = await mount()
  assert.ok(tree.root.findAllByProps({ role: "switch" }).every(node => node.props.disabled), "Loading cannot overwrite choices edited before settings arrived")
  assert.equal(tree.root.findByProps({ className: "bb-notification-state" }).children.join(""), "Loading…")
  await unmount(tree)

  state = resetBrowser({ subscribe: () => Promise.reject(Object.assign(Error("Denied"), { name: "NotAllowedError" })) })
  tree = await mount(); await tap(tree, "Enable on this phone")
  assert.equal(mutations(state).length, 0)
  assert.ok(tree.root.findByProps({ role: "alert" }).children.join("").includes("iPhone Settings"))
  await unmount(tree)

  state = resetBrowser()
  tree = await mount(); await tap(tree, "Enable on this phone")
  assert.deepEqual(JSON.parse(mutations(state)[0].options.body).preferences, prefs)
  await tap(tree, "Turn off")
  assert.equal(mutations(state)[1].options.method, "DELETE")
  assert.ok(!button(tree, "Send a test"))
  assert.equal(state.steps.unsubscribe, 0, "Turning off delivery must not revoke another page's shared browser endpoint")
  await unmount(tree)

  state = resetBrowser(); delete browserWindow.PushManager
  tree = await mount()
  assert.equal(button(tree, "Enable on this phone").props.disabled, true)
  assert.equal(state.steps.register, 0)
  assert.equal(state.steps.permission, 0)
  assert.equal(mutations(state).length, 0)
  await unmount(tree)
  assert.equal(timers.size, 0, "Unmount cleans up all notification timeouts")
}
workerContracts().then(lifecycleContracts).then(() => console.log("Phone notification UI, worker and real React lifecycle checks passed")).catch(error => { console.error(error); process.exitCode = 1 })
