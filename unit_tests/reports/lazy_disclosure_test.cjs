const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")
const req = createRequire(path.resolve("web/expense-report/package.json"))
const React = req("react"), { act, create } = req("react-test-renderer"), ts = req("typescript")
global.IS_REACT_ACT_ENVIRONMENT = true
let serial = 0, reduced = false
const timers = new Map()
const window = {
  matchMedia: () => ({ matches: reduced }),
  setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id },
  clearTimeout(id) { timers.delete(id) },
}
const runtime = { exports: {}, require: req, window }
vm.runInNewContext(ts.transpileModule(fs.readFileSync("web/expense-report/src/components/ui/motion.tsx", "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, runtime)
const { CollapsibleContent } = runtime.exports
let builds = 0
function Rows() { builds++; return React.createElement("table", null, React.createElement("tbody", null,
  Array.from({ length: 1500 }, (_, id) => React.createElement("tr", { key: id }, React.createElement("td", null, id))))) }
let renderer
const render = (open, lazy = true) => {
  const element = React.createElement(CollapsibleContent, { open, lazy, id: "rows" }, React.createElement(Rows))
  act(() => { if (renderer) renderer.update(element); else renderer = create(element) })
}
const content = () => renderer.root.findByProps({ className: "bb-details-content" })
const rowCount = () => renderer.root.findAllByType("tr").length
const transition = (targetMatches = true, propertyName = "grid-template-rows") => act(() => {
  const currentTarget = {}; content().props.onTransitionEnd({ target: targetMatches ? currentTarget : {}, currentTarget, propertyName })
})
const flush = () => act(() => { const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.callback()) })

render(false)
assert.equal(builds, 0, "Initially collapsed rows do no rendering work")
assert.equal(rowCount(), 0)
render(true)
assert.equal(rowCount(), 1500, "The complete list mounts on demand without truncation")
assert.equal(content().props.inert, false)
render(false)
assert.equal(rowCount(), 1500, "Rows remain mounted while exit animates")
assert.equal(content().props.inert, true)
assert.equal([...timers.values()][0].delay, 320)
transition(false)
transition(true, "color")
assert.equal(rowCount(), 1500, "Child/unrelated transitions cannot remove rows early")
render(true)
assert.equal(timers.size, 0, "A rapid reopen cancels the pending unmount")
flush()
assert.equal(rowCount(), 1500)
render(false)
transition()
assert.equal(rowCount(), 0, "Completed exit releases the hidden subtree")
assert.equal(timers.size, 0)
render(true)
render(false)
flush()
assert.equal(rowCount(), 0, "Fallback cleanup works when transitionend never arrives")
reduced = true
render(true)
render(false)
assert.equal([...timers.values()][0].delay, 0, "Reduced motion never waits for an animation")
flush()
assert.equal(rowCount(), 0)
render(false, false)
assert.equal(rowCount(), 1500, "Existing form disclosures still retain their mounted state by default")
act(() => renderer.unmount())
assert.equal(timers.size, 0)
console.log("Lazy disclosure: complete rows, preserved exit, rapid reversal, reduced motion and fallback passed")
