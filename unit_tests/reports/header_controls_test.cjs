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

function load(relative, globals = {}) {
  const { outputText } = ts.transpileModule(fs.readFileSync(path.join(frontend, "src", relative), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  })
  const runtime = vm.createContext({ exports: {}, require: frontendRequire, ...globals })
  vm.runInContext(outputText, runtime)
  return runtime.exports
}

const { AppRefreshControl } = load("app-refresh-control.tsx")
const render = (changes = {}) => renderToStaticMarkup(React.createElement(AppRefreshControl, {
  state: { phase: "ready", updatedAt: Date.now(), signingOut: false, message: "", ...changes },
  refresh: () => {},
}))
const ready = render()
assert.ok(ready.includes('aria-label="Refresh expenses"'), "Icon-only refresh retains a useful accessible name")
assert.ok(ready.includes("Updated "))
assert.ok(ready.includes("dateTime=") && ready.includes("title="), "Compact time retains the full timestamp")
assert.ok(!ready.includes("up to date") && !ready.includes("Sign out"))
assert.ok(!ready.includes('disabled=""'))
const refreshing = render({ phase: "refreshing" })
assert.ok(refreshing.includes("is-refreshing") && refreshing.includes('disabled=""'))
assert.ok(refreshing.includes("Refreshing…"))
const stale = render({ phase: "stale", message: "Couldn’t refresh. Check your connection and try again." })
assert.ok(stale.includes("Couldn’t refresh") && stale.includes("Showing "))
assert.ok(!stale.includes("Updated "), "A failed refresh must never suggest old data is freshly updated")
const unavailable = render({ phase: "error", updatedAt: null, message: "Couldn’t refresh." })
assert.ok(unavailable.includes("Couldn’t refresh") && !unavailable.includes("<time"))
assert.ok(render({ signingOut: true }).includes('disabled=""'))
const old = render({ updatedAt: new Date(2020, 0, 2, 8, 15).getTime() })
assert.ok(/Updated [^<]*Jan/.test(old), "An older update must include its date, not just a misleading clock time")

const { ReportMenu } = load("components/ui/report-menu.tsx")
const menu = renderToStaticMarkup(React.createElement(ReportMenu, null, React.createElement("button", null, "Sign out")))
assert.ok(menu.includes('aria-expanded="false"') && menu.includes('inert=""'))
const id = /aria-controls="([^"]+)"/.exec(menu)?.[1]
assert.ok(id && menu.includes(`id="${id}"`))
assert.ok(menu.includes("Sign out"), "Closed menu retains its children for an animated exit")

// Safari blurs a focused menu button to the body during a tap, with no related
// focus target. The disclosure must survive until the click can reach it.
const renderer = frontendRequire("react-test-renderer")
const listeners = new Map(), frames = new Map()
let serial = 0, focused = null, clicks = 0, tree
class TestNode {
  constructor(inside) { this.inside = inside }
  focus() { focused = this }
}
const triggerNode = new TestNode(true), actionNode = new TestNode(true), outsideNode = new TestNode(false)
const rootNode = { contains: node => node?.inside === true }
const { ReportMenu: InteractiveMenu } = load("components/ui/report-menu.tsx", {
  Node: TestNode,
  document: {
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name) },
  },
  requestAnimationFrame: fn => { const id = ++serial; frames.set(id, fn); return id },
  cancelAnimationFrame: id => frames.delete(id),
})
renderer.act(() => {
  tree = renderer.create(React.createElement(InteractiveMenu, null,
    React.createElement("button", { onClick: () => { clicks++ } }, "Dark mode")), {
    createNodeMock: element => element.props.className === "bb-report-menu" ? rootNode
      : element.props.className === "bb-report-menu-panel" ? { querySelector: () => actionNode }
      : element.props["aria-label"] === "Report settings" ? triggerNode : actionNode,
  })
})
const trigger = () => tree.root.findByProps({ "aria-label": "Report settings" })
const panel = () => tree.root.findByProps({ className: "bb-report-menu-panel" })
const open = () => renderer.act(() => {
  trigger().props.onClick()
})
const dispatch = (type, event) => renderer.act(() => listeners.get(type)?.(event))
open()
renderer.act(() => { for (const fn of frames.values()) fn(); frames.clear() })
assert.equal(focused, actionNode, "Keyboard opening still focuses the first action")
dispatch("pointerdown", { target: actionNode })
renderer.act(() => tree.root.findByProps({ className: "bb-report-menu" }).props.onBlur?.({
  currentTarget: rootNode, target: actionNode, relatedTarget: null,
}))
assert.equal(panel().props.inert, undefined, "A Safari tap's null-target blur cannot make the action inert before its click")
renderer.act(() => tree.root.findAllByType("button")[1].props.onClick())
assert.equal(clicks, 1)
dispatch("focusin", { target: actionNode })
assert.equal(trigger().props["aria-expanded"], true)
dispatch("focusin", { target: outsideNode })
assert.equal(trigger().props["aria-expanded"], false, "Tabbing to an outside control dismisses the menu")
assert.equal(listeners.size, 0)
open()
dispatch("pointerdown", { target: outsideNode })
assert.equal(trigger().props["aria-expanded"], false, "Outside taps still dismiss")
open()
let prevented = false
dispatch("keydown", { key: "Escape", preventDefault: () => { prevented = true } })
assert.ok(prevented)
assert.equal(trigger().props["aria-expanded"], false)
assert.equal(focused, triggerNode, "Escape returns focus to the trigger")
open()
renderer.act(() => tree.unmount())
assert.equal(listeners.size, 0)
assert.equal(frames.size, 0)
console.log("Compact header status and disclosure checks passed")
