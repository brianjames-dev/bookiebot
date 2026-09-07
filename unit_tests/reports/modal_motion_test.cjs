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
function harness(reducedMotion = false) {
  let cursor = 0
  let dirty = true
  let tree
  let serial = 0
  const hooks = []
  const pending = []
  const frames = new Map()
  const timers = new Map()
  const calls = []
  const body = { style: { position: "", top: "", width: "", overflow: "", paddingRight: "" } }
  const root = { clientWidth: 1000, style: { overflow: "", setProperty() {} } }
  const win = {
    innerWidth: 1024,
    scrollY: 640,
    matchMedia: () => ({ matches: reducedMotion }),
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    scrollTo(x, y) { calls.push(["scroll", x, y]); win.scrollY = y },
  }
  const dialog = {
    open: false,
    showModal() { this.open = true; calls.push(["show", body.style.position]) },
    close() {
      this.open = false
      calls.push(["close", body.style.position])
      // Native focus restoration is permitted to scroll. Cleanup must run
      // afterward to restore the position captured when the modal opened.
      win.scrollY = 999
    },
  }
  const effect = (fn, deps) => {
    const index = cursor++
    const old = hooks[index]
    if (!old || deps.some((dep, n) => !Object.is(dep, old.deps[n]))) {
      pending.push({ index, fn, deps, cleanup: old?.cleanup })
    }
  }
  const runtime = vm.createContext({
    exports: {}, require: frontendRequire, document: { body, documentElement: root }, window: win,
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
      tree = runtime.ModalDetails({ summary: "Details", title: "Calendar details", children: "Bills" })
      tree.props.children[1].ref.current = dialog
      const updates = pending.splice(0)
      for (const update of updates) update.cleanup?.()
      for (const update of updates) hooks[update.index] = { deps: update.deps, cleanup: update.fn() }
    }
  }
  const act = (fn) => { fn(); flush() }
  flush()
  return {
    dialog, body, win, calls, timers,
    get modal() { return tree.props.children[1] },
    get phase() { return tree.props.children[1].props["data-state"] },
    act,
    open() { act(() => tree.props.children[0].props.onClick()) },
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
  }
}

const app = harness()
app.open()
assert.equal(app.phase, "opening")
assert.equal(app.dialog.open, true)
assert.deepEqual(app.calls[0], ["show", "fixed"])
app.frame()
assert.equal(app.phase, "opening", "Entrance must cross a painted initial pose")
app.frame()
assert.equal(app.phase, "open")
app.cancel()
assert.equal(app.phase, "closing")
assert.equal(app.dialog.open, true)
assert.equal(app.body.style.position, "fixed")
app.transition("opacity", true)
app.transition("transform")
assert.equal(app.phase, "closing", "Child transitions and transform must not end the exit")
app.transition()
assert.equal(app.phase, "closed")
assert.equal(app.dialog.open, false)
assert.equal(app.body.style.position, "")
assert.equal(app.win.scrollY, 640)
assert.deepEqual(app.calls.slice(-2), [["close", "fixed"], ["scroll", 0, 640]])
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
// native focus trapping and the fixed page without waiting on CSS events.
const rapid = harness(true)
rapid.open(); rapid.cancel()
assert.deepEqual([...rapid.timers.values()].map((timer) => timer.delay), [0])
rapid.timeout(); rapid.frame(); rapid.frame()
assert.equal(rapid.phase, "closed")
assert.equal(rapid.dialog.open, false)
assert.equal(rapid.win.scrollY, 640)

console.log("Modal transition interruption, focus and scroll restoration checks passed")
