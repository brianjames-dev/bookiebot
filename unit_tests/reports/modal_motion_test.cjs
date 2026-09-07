const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")

const frontend = path.join(__dirname, "../../web/expense-report")
const frontendRequire = createRequire(path.join(frontend, "package.json"))
const ts = frontendRequire("typescript")
const source = fs.readFileSync(path.join(frontend, "src/report-app.tsx"), "utf8")
const start = source.indexOf("function useModalPageScrollLock(")
const end = source.indexOf("function ExpandRowsButton(", start)
assert.ok(start >= 0 && end > start)
const { outputText } = ts.transpileModule(source.slice(start, end), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
})

// Run the actual modal and its scroll lock with a deterministic hook/frame
// scheduler. This exercises interrupted entrances/exits and native close order,
// which a source-string or static markup test cannot verify.
function harness(reducedMotion = false, options = {}) {
  let selection = options.selection
  let dismissCount = 0
  let cursor = 0
  let dirty = true
  let tree
  let serial = 0
  const hooks = []
  const pending = []
  const frames = new Map()
  const timers = new Map()
  const calls = []
  const body = { style: { position: "", top: "", width: "", overflow: "", paddingRight: options.paddingRight || "" } }
  const variables = new Map()
  const root = { clientWidth: options.clientWidth || 1000, dataset: {}, style: { overflow: "", setProperty(key, value) { variables.set(key, value) } } }
  const win = {
    innerWidth: 1024,
    scrollX: 0,
    scrollY: 640,
    getComputedStyle: () => ({ paddingRight: options.paddingRight || "0px" }),
    matchMedia: () => ({ matches: reducedMotion }),
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    scrollTo(x, y) { calls.push(["scroll", x, y]); win.scrollY = y },
  }
  const listeners = new Map()
  class Element {
    constructor(inBody = false) { this.inBody = inBody }
    closest(selector) { return selector === ".bb-details-dialog-body" && this.inBody ? this : null }
  }
  const trigger = { isConnected: true, focus(options) { calls.push(["focus-trigger", options.preventScroll]); doc.activeElement = trigger } }
  const title = {
    attributes: {},
    setAttribute(key, value) { this.attributes[key] = value },
    focus(options) { calls.push(["focus-title", options.preventScroll]); doc.activeElement = title },
  }
  const doc = { body, documentElement: root, activeElement: trigger }
  const dialog = {
    open: false,
    showModal() {
      assert.equal(title.attributes.autofocus, "", "Set the native initial focus target before entering the top layer")
      this.open = true
      calls.push(["show", body.style.position])
    },
    close() {
      this.open = false
      calls.push(["close", body.style.position])
      // Native focus restoration is permitted to scroll. Cleanup must run
      // afterward to restore the position captured when the modal opened.
      if (options.nativeFocusScroll !== false) win.scrollY = 999
    },
    addEventListener(name, listener, options) { listeners.set(name, { listener, options }) },
    removeEventListener(name) { listeners.delete(name) },
  }
  const effect = (fn, deps) => {
    const index = cursor++
    const old = hooks[index]
    if (!old || deps.some((dep, n) => !Object.is(dep, old.deps[n]))) {
      pending.push({ index, fn, deps, cleanup: old?.cleanup })
    }
  }
  const runtime = vm.createContext({
    exports: {}, require: frontendRequire, document: doc, window: win, Element,
    createPortal: (element) => element,
    requestAnimationFrame(fn) { const id = ++serial; frames.set(id, fn); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: initial }
      return [hooks[index].value, (next) => {
        const value = typeof next === "function" ? next(hooks[index].value) : next
        if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true }
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { current: initial }
      return hooks[index]
    },
    useLayoutEffect: effect,
    useEffect: effect,
  })
  vm.runInContext(outputText, runtime)
  function flush() {
    while (dirty) {
      dirty = false
      cursor = 0
      tree = runtime.ModalDetails({ summary: "Details", title: "Calendar details", children: "Bills", selection, triggerHidden: options.triggerHidden, onDismiss: () => { dismissCount++ } })
      tree.props.children[1].ref.current = dialog
      tree.props.children[1].props.children[1].props.children[0].props.children[0].ref.current = title
      const updates = pending.splice(0)
      for (const update of updates) update.cleanup?.()
      for (const update of updates) hooks[update.index] = { deps: update.deps, cleanup: update.fn() }
    }
  }
  const act = (fn) => { fn(); flush() }
  flush()
  return {
    dialog, body, root, win, calls, timers, listeners, variables, doc, title, trigger,
    get dismissCount() { return dismissCount },
    select(value) { act(() => { selection = value; dirty = true }) },
    get modal() { return tree.props.children[1] },
    get phase() { return tree.props.children[1].props["data-state"] },
    act,
    open() { act(() => tree.props.children[0].props.onClick({ currentTarget: trigger })) },
    frame() { act(() => { const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn()) }) },
    cancel() {
      let prevented = false
      act(() => this.modal.props.onCancel({ preventDefault() { prevented = true } }))
      assert.equal(prevented, true, "Escape must not bypass the exit")
    },
    transition(propertyName = "opacity", child = false) {
      const surface = this.modal.props.children[1]
      act(() => surface.props.onTransitionEnd({
        target: child ? {} : surface, currentTarget: surface, propertyName,
      }))
    },
    timeout() { act(() => { const batch = [...timers.values()]; timers.clear(); batch.forEach(({ fn }) => fn()) }) },
    touch(inBody) {
      let prevented = false
      const listener = listeners.get("touchmove")
      assert.equal(listener.options.passive, false)
      listener.listener({ target: new Element(inBody), preventDefault() { prevented = true } })
      return prevented
    },
  }
}

const app = harness()
app.open()
assert.equal(app.phase, "opening")
assert.equal(app.dialog.open, true)
assert.deepEqual(app.calls[0], ["show", ""])
assert.equal(app.root.style.overflow, "hidden")
assert.equal(app.root.dataset.bbModalScrollLock, "true")
assert.equal(app.body.style.paddingRight, "24px", "Preserve content width when the native scrollbar is hidden")
assert.equal(app.variables.get("--bb-viewport-scrollbar-width"), "24px")
assert.equal(app.body.style.top, "", "Do not move the underlying charts or reset the page scroll")
assert.equal(app.body.style.width, "")
assert.equal(app.win.scrollY, 640)
assert.equal(app.doc.activeElement, app.title, "Initial focus is the title, not the Close control")
const header = app.modal.props.children[1].props.children[0]
assert.equal(header.props.children[0].props.tabIndex, -1, "Static initial focus must not add an extra Tab stop")
assert.equal(header.props.children[1].props["aria-label"], "Close Calendar details")
assert.equal(header.props.children[1].props.children.type, "svg", "A centered icon must not depend on a text glyph's baseline")
assert.equal(app.touch(false), true, "The shade/header must contain iPhone touch scrolling")
assert.equal(app.touch(true), false, "Modal content retains native touch scrolling")
app.frame()
assert.equal(app.phase, "opening", "Entrance must cross a painted initial pose")
app.frame()
assert.equal(app.phase, "open")
app.cancel()
assert.equal(app.phase, "closing")
assert.equal(app.dialog.open, true)
assert.equal(app.body.style.position, "")
assert.equal(app.root.style.overflow, "hidden")
app.transition("opacity", true)
app.transition("transform")
assert.equal(app.phase, "closing", "Child transitions and transform must not end the exit")
app.transition()
assert.equal(app.phase, "closed")
assert.equal(app.dialog.open, false)
assert.equal(app.body.style.position, "")
assert.equal(app.win.scrollY, 640)
assert.deepEqual(app.calls.slice(-3), [["close", ""], ["focus-trigger", true], ["scroll", 0, 640]])
assert.equal(app.doc.activeElement, app.trigger)
assert.equal(app.root.style.overflow, "")
assert.equal(app.root.dataset.bbModalScrollLock, undefined)
assert.equal(app.body.style.paddingRight, "")
assert.equal(app.listeners.size, 0, "Release touch containment after the exit")
assert.equal(app.timers.size, 0, "A completed exit cancels its fallback")

// A new entrance cancels the old exit timer; a late native close event from the
// previous cycle must not close the new dialog.
app.open(); app.frame(); app.frame(); app.cancel(); app.open()
assert.equal(app.timers.size, 0)
app.act(() => app.modal.props.onClose({ currentTarget: app.dialog }))
assert.equal(app.phase, "opening")
app.frame(); app.frame()
app.cancel(); app.timeout()
assert.equal(app.phase, "closed", "Missing transition events must still release the dialog")
assert.equal(app.body.style.position, "")

// Rapid dismissal during entrance and reduced-motion mode also release both
// native focus trapping and the page lock without waiting on CSS events.
const rapid = harness(true)
rapid.open(); rapid.cancel()
assert.deepEqual([...rapid.timers.values()].map((timer) => timer.delay), [0])
rapid.timeout(); rapid.frame(); rapid.frame()
assert.equal(rapid.phase, "closed")
assert.equal(rapid.dialog.open, false)
assert.equal(rapid.win.scrollY, 640)

// Overlay scrollbars on phones need no padding adjustment. Normal native focus
// restoration must not schedule a redundant full-page scroll on either edge.
const phone = harness(false, { clientWidth: 1024, paddingRight: "12px", nativeFocusScroll: false })
phone.open(); phone.frame(); phone.frame(); phone.cancel(); phone.transition()
assert.equal(phone.body.style.paddingRight, "12px")
assert.equal(phone.calls.some(([action]) => action === "scroll"), false)
assert.equal(phone.win.scrollY, 640)
const padded = harness(false, { paddingRight: "12px" })
padded.open()
assert.equal(padded.body.style.paddingRight, "36px", "Scrollbar compensation preserves existing page padding")
padded.cancel(); padded.timeout()
assert.equal(padded.body.style.paddingRight, "12px")

console.log("Modal transition interruption, focus and scroll restoration checks passed")

const selected = harness(false, {triggerHidden:true})
selected.select("day-3")
assert.equal(selected.phase, "opening")
assert.equal(selected.doc.activeElement, selected.title)
selected.frame(); selected.frame()
assert.equal(selected.phase, "open")
selected.cancel()
assert.equal(selected.phase, "closing")
assert.equal(selected.dismissCount, 0, "Keep content during exit")
selected.transition()
assert.equal(selected.phase, "closed")
assert.equal(selected.dismissCount, 1, "Dismiss selected transaction only after exit")
assert.equal(selected.doc.activeElement, selected.trigger, "A keyboard-selected chart/day restores its invoker")

// A real viewport resize while a modal hides the desktop scrollbar must keep
// the carousel's compensation; otherwise its observed width changes twice.
const viewportStart = source.indexOf("function useViewportScrollbarWidth(")
const viewportEnd = source.indexOf("export function ExpenseReportApp(", viewportStart)
assert.ok(viewportStart >= 0 && viewportEnd > viewportStart)
const viewportScript = ts.transpileModule(source.slice(viewportStart, viewportEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText
let resize
const viewport = { dataset: {}, clientWidth: 1000, style: { setProperty(key, value) { this[key] = value } } }
const viewportRuntime = vm.createContext({
  document: { documentElement: viewport },
  window: { innerWidth: 1024, addEventListener(event, callback) { assert.equal(event, "resize"); resize = callback } },
  useLayoutEffect: (effect) => effect(),
})
vm.runInContext(`${viewportScript}\nuseViewportScrollbarWidth()`, viewportRuntime)
assert.equal(viewport.style["--bb-viewport-scrollbar-width"], "24px")
viewport.dataset.bbModalScrollLock = "true"
viewport.clientWidth = 1024
resize()
assert.equal(viewport.style["--bb-viewport-scrollbar-width"], "24px", "Do not resize charts based on temporarily hidden scrollbars")
delete viewport.dataset.bbModalScrollLock
resize()
assert.equal(viewport.style["--bb-viewport-scrollbar-width"], "0px", "Ordinary viewport measurement resumes when unlocked")
