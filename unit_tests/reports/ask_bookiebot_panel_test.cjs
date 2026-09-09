const assert = require("node:assert/strict")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")
const frontend = path.resolve(__dirname, "../../web/expense-report")
const localRequire = createRequire(path.join(frontend, "package.json"))
const React = localRequire("react")
const Renderer = localRequire("react-test-renderer")
const { act } = React
global.IS_REACT_ACT_ENVIRONMENT = true
const frames = new Map(), timers = new Map(), nodes = new Map(), requests = [], sources = []
let sequence = 0
class Element {
  constructor() { this.style = { overflow: "", paddingRight: "", setProperty(name, value) { this[name] = value } }; this.dataset = {}; this.attributes = {}; this.isConnected = true; this.open = false; this.clientWidth = 390; this.presentations = 0 }
  focus() { document.activeElement = this }
  setAttribute(name, value) { this.attributes[name] = value }
  addEventListener() {}
  removeEventListener() {}
  showModal() { assert.equal(this.attributes.autofocus, "", "Native autofocus targets the stationary host before any moving content"); this.open = true; this.presentations++ }
  close() { this.open = false }
  getClientRects() { return [{}] }
  closest() { return null }
}
const opener = new Element()
const document = { activeElement: opener, body: new Element(), documentElement: new Element() }
const viewport = { height: 800, offsetTop: 0, addEventListener() {}, removeEventListener() {} }
const window = { innerWidth: 390, innerHeight: 800, scrollX: 0, scrollY: 240, visualViewport: viewport,
  addEventListener() {}, removeEventListener() {}, getComputedStyle: () => ({ paddingRight: "0px" }),
  scrollTo(x, y) { this.scrollX = x; this.scrollY = y }, matchMedia: () => ({ matches: false }),
  setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id }, clearTimeout: id => timers.delete(id) }
const exported = { exports: {} }
const output = localRequire("esbuild").buildSync({
  stdin: { contents: 'export { AskBookieBotPanel } from "./ask-bookiebot-panel"; export { AppWorkGuardProvider, useAppWorkGuard } from "./app-work-guard";', resolveDir: path.join(frontend, "src"), loader: "tsx" },
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", loader: { ".css": "empty" },
  external: ["react", "react/jsx-runtime", "react-dom"],
}).outputFiles[0].text
vm.runInNewContext(output, { module: exported, exports: exported.exports, require: name => name === "react-dom" ? { createPortal: children => children } : localRequire(name),
  window, document, HTMLElement: Element, Element, AbortController, Error, setTimeout, clearTimeout,
  requestAnimationFrame: fn => { const id = ++sequence; frames.set(id, fn); return id }, cancelAnimationFrame: id => frames.delete(id),
  fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
})
const { AskBookieBotPanel, AppWorkGuardProvider, useAppWorkGuard } = exported.exports
const controls = {}
let work
function Probe() { work = useAppWorkGuard(); return null }
function App() {
  const [open, setOpen] = React.useState(false), [month, setMonth] = React.useState("2026-09"), [mode, setMode] = React.useState("current")
  Object.assign(controls, { setOpen, setMonth, setMode })
  return React.createElement(AppWorkGuardProvider, null,
    React.createElement(Probe), React.createElement(AskBookieBotPanel, { open, onClose: () => setOpen(false), month, mode, onShowSource: source => sources.push(source) }))
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
const frame = async () => act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); await flush() })
const finishClose = async () => act(async () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.fn()); await flush() })
const response = (changes = {}) => ({ ok: true, json: async () => ({ answer: "You have $300 left.", month: "2026-09", mode: "current", sources: ["overview"], generatedAt: "Today", ...changes }) })
async function main() {
  let tree
  await act(async () => { tree = Renderer.create(React.createElement(App), { createNodeMock: element => {
    const key = `${element.type}:${element.props.className ?? element.props.id ?? ""}`
    if (!nodes.has(key)) nodes.set(key, new Element())
    return nodes.get(key)
  } }); await flush() })
  const dialog = () => nodes.get("dialog:bb-ask-dialog")
  const panel = () => tree.root.findByProps({ className: "bb-ask-panel-surface" })
  const textarea = () => tree.root.findByType("textarea")
  const text = () => JSON.stringify(tree.toJSON())
  const closeButton = () => tree.root.findByProps({ "aria-label": "Close Ask BookieBot" })
  assert.equal(requests.length, 0, "Mounting the persistent hidden panel never asks the model")
  assert.equal(dialog().open, false)
  assert.equal(tree.root.findAllByProps({ className: "bb-reimbursement-toggle" }).length, 0, "Embedded questions have no second collapsed heading")
  await act(async () => controls.setOpen(true)); await frame(); await frame()
  assert.equal(dialog().open, true)
  assert.equal(panel().props.opened, true)
  const heading = tree.root.findAllByType("h2").find(node => node.children.join("") === "Ask BookieBot")
  assert.equal(document.activeElement, nodes.get(`h2:${heading.props.id}`), "Title receives focus rather than the close icon or keyboard input")
  assert.equal(document.documentElement.style.overflow, "hidden")
  assert.equal(dialog().style["--bb-ask-viewport-height"], "800px")
  const firstControl = new Element(), middleControl = new Element(), lastControl = new Element()
  dialog().querySelectorAll = () => [firstControl, middleControl, lastControl]
  const tab = shiftKey => {
    let prevented = false
    tree.root.findByProps({ className: "bb-ask-dialog" }).props.onKeyDown({ key: "Tab", shiftKey,
      currentTarget: dialog(), preventDefault() { prevented = true } })
    return prevented
  }
  lastControl.focus(); assert.equal(tab(false), true); assert.equal(document.activeElement, firstControl)
  assert.equal(tab(true), true); assert.equal(document.activeElement, lastControl)
  middleControl.focus(); assert.equal(tab(false), false, "Ordinary in-panel focus navigation stays native")
  await act(async () => textarea().props.onChange({ target: { value: "Explain my money left" } }))
  assert.equal(work.dirty, true)
  await act(async () => tree.root.findByType("form").props.onSubmit({ preventDefault() {} }))
  assert.equal(requests.length, 1); assert.equal(work.pending, true)
  await act(async () => closeButton().props.onClick())
  assert.equal(panel().props.opened, false)
  assert.equal(dialog().open, true, "Native focus trap persists through the exit animation")
  assert.equal([...timers.values()][0].delay, 320, "Buffered fallback does not cut off a late final animation frame")
  assert.equal(requests[0].options.signal.aborted, false, "Closing does not cancel the in-flight read")
  const transitionEnd = event => act(async () => panel().props.onTransitionEnd(event))
  const surface = () => [...nodes.entries()].find(([key]) => key.includes("bb-ask-panel-surface"))[1]
  await transitionEnd({ target: new Element(), propertyName: "transform" })
  await transitionEnd({ target: surface(), propertyName: "opacity" })
  assert.equal(dialog().open, true, "Nested/unrelated transitions cannot close the modal early")
  await transitionEnd({ target: surface(), propertyName: "transform" })
  assert.equal(dialog().open, false); assert.equal(document.activeElement, opener)
  assert.equal(timers.size, 0, "Actual transform completion cancels the fallback timer")
  assert.equal(document.documentElement.style.overflow, "")
  await act(async () => { requests[0].resolve(response()); await flush() })
  assert.equal(work.pending, false)
  await act(async () => controls.setOpen(true)); await frame(); await frame()
  assert.equal(textarea().props.value, "Explain my money left")
  assert.ok(text().includes("You have $300 left."), "Hidden completion remains available when reopened")
  assert.equal(requests.length, 1)
  await act(async () => tree.root.findAllByType("button").find(node => node.children.join("") === "Headline totals").props.onClick())
  assert.deepEqual(sources, [], "Source navigation waits until the panel has closed")
  await finishClose(); assert.deepEqual(sources, ["overview"])
  await act(async () => controls.setMonth("2026-08"))
  assert.equal(textarea().props.value, ""); assert.equal(work.dirty, false)
  assert.ok(!text().includes("You have $300 left."))
  await act(async () => { controls.setOpen(true); controls.setMonth("2026-09") }); await frame(); await frame()
  await act(async () => textarea().props.onChange({ target: { value: "Another question" } }))
  await act(async () => tree.root.findByType("form").props.onSubmit({ preventDefault() {} }))
  await act(async () => controls.setMode("projected"))
  assert.equal(requests[1].options.signal.aborted, true, "Changing report scope cancels the old request")
  await act(async () => { requests[1].resolve(response()); await flush() })
  assert.equal(textarea().props.value, ""); assert.ok(!text().includes("You have $300 left."))
  let prevented = false
  await act(async () => tree.root.findByProps({ className: "bb-ask-dialog" }).props.onCancel({ preventDefault() { prevented = true } }))
  assert.equal(prevented, true); assert.equal(dialog().open, true)
  const presentations = dialog().presentations
  await act(async () => controls.setOpen(true))
  assert.equal(panel().props.opened, true, "Rapid reopen reverses immediately instead of waiting for another cold-entry frame")
  assert.equal(frames.size, 0)
  assert.equal(dialog().presentations, presentations, "Reversal does not repeat native autofocus")
  await transitionEnd({ target: surface(), propertyName: "transform" })
  await finishClose()
  assert.equal(dialog().open, true, "Rapid reopening cancels a stale close timer")
  await act(async () => tree.unmount())
  assert.equal(document.documentElement.style.overflow, "", "Unmount releases the page lock")
  assert.equal(timers.size, 0); assert.equal(frames.size, 0)
  console.log("Ask panel persistent scope, native-dialog motion, source routing and work-guard regressions passed")
}
main().catch(error => { console.error(error); process.exitCode = 1 })
