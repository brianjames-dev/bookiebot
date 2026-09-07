const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { createRequire } = require("node:module")
const req = createRequire(path.resolve("web/expense-report/package.json"))
const ts = req("typescript")
const React = req("react")
const TestRenderer = req("react-test-renderer")

// Real Recharts publishes new Pie data to its store after rendering. During
// that render a shape can still receive a sector from the previous dataset.
// The fixed-size, non-portal test surface avoids needing a browser DOM while
// preserving the actual Pie selector, render, and animation lifecycle.
let nextFrame = 0
let now = 0
const frames = new Map()
global.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
global.cancelAnimationFrame = id => frames.delete(id)
global.window = {
  requestAnimationFrame: global.requestAnimationFrame,
  cancelAnimationFrame: global.cancelAnimationFrame,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
}
const Recharts = req("recharts")
const source = fs.readFileSync("web/expense-report/src/report-app.tsx", "utf8")
const file = ts.createSourceFile("report-app.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set(["money", "formatMoney", "CategoryMixPieSurface"])
const declarations = file.statements.filter(statement => {
  if (ts.isFunctionDeclaration(statement)) return names.has(statement.name?.text)
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => names.has(item.name.getText(file)))
})
assert.equal(declarations.length, names.size)
const compiled = ts.transpileModule(declarations.map(node => node.getText(file)).join("\n") + "\nexports.Surface = CategoryMixPieSurface", {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText

let animate = false
const observed = []
const runtime = {
  exports: {}, require: req, memo: React.memo,
  ResponsiveContainer: ({ children }) => children,
  PieChart: props => React.createElement(Recharts.PieChart, { ...props, width: 400, height: 320, compact: true }),
  Pie: props => React.createElement(Recharts.Pie, { ...props, zIndex: 0, isAnimationActive: animate }),
  Cell: Recharts.Cell,
  Sector: props => { observed.push(props); return React.createElement(Recharts.Sector, props) },
  ChartTooltip: () => null, ChartTooltipContent: () => null,
  // Force each requested dataset through the production component. Its memo
  // comparison is tested separately and is unrelated to stale sector identity.
  areCategoryMixPieSurfacePropsEqual: () => false,
  PIE_METRIC_START_ANGLE: 0, PIE_METRIC_END_ANGLE: 360, PIE_METRIC_PADDING_ANGLE: 1,
}
vm.runInNewContext(compiled, runtime)
const { Surface } = runtime.exports
const layout = { margin: { top: 0, right: 0, bottom: 0, left: 0 }, cx: 200, cy: 160, innerRadius: 70, outerRadius: 120, showLabels: false }
const food = { key: "food", label: "Food", amount: 100, percentage: 25, color: "#123456" }
const wants = { key: "wants", label: "Wants", amount: 200, percentage: 50, color: "#456789" }
const left = { key: "left", label: "Left", amount: 100, percentage: 25, color: "#789abc" }
const calls = []
const onInspect = item => calls.push(item)
const propsFor = data => ({ data, layout, onInspect })
let staleSectors = 0
let shiftedSectors = 0

function advance(ms = 40) {
  now += ms
  const pending = [...frames.values()]
  frames.clear()
  TestRenderer.act(() => { for (const callback of pending) callback(now) })
}

function assertCurrentTargets(sectors, data) {
  for (const sector of sectors) {
    const expected = data.find(item => item.key === sector.payload?.key)
    if (!expected) {
      staleSectors++
      assert.notEqual(sector.role, "button", "Removed sectors cannot open the new row at their old index")
      assert.notEqual(sector.tabIndex, 0)
      assert.equal(typeof sector.onClick, "undefined")
      assert.equal(typeof sector.onKeyDown, "undefined")
      continue
    }
    if (data[sector.index]?.key !== expected.key) shiftedSectors++
    assert.equal(sector["aria-label"], `Inspect ${expected.label}, $${expected.amount.toFixed(2)}`)
    assert.equal(sector.role, "button")
    assert.equal(sector.tabIndex, 0)
    sector.onClick()
    assert.equal(calls.pop(), expected, "Click uses the current amount and matching category identity")
    for (const key of ["Enter", " "]) {
      let prevented = false
      sector.onKeyDown({ key, preventDefault() { prevented = true } })
      assert.equal(prevented, true)
      assert.equal(calls.pop(), expected)
    }
    sector.onKeyDown({ key: "Escape", preventDefault() { throw new Error("Unrelated keys must be left alone") } })
    assert.equal(calls.length, 0)
  }
}

for (animate of [false, true]) {
  staleSectors = 0
  shiftedSectors = 0
  let renderer
  try {
    TestRenderer.act(() => { renderer = TestRenderer.create(React.createElement(Surface, propsFor([food, wants, left]))) })
    for (let frame = 0; frame < 20; frame++) advance()
    // A disappeared Left slice, a shifted surviving category, the empty case,
    // and rapid repeated mode-like updates all exercise a different stale set.
    const projectedWants = { ...wants, amount: 350 }
    const datasets = [
      [food, wants], [projectedWants], [], [food, wants, left],
      ...Array.from({ length: 20 }, (_, index) => index % 2 ? [food, wants, left] : [projectedWants]),
    ]
    for (const data of datasets) {
      observed.length = 0
      assert.doesNotThrow(() => TestRenderer.act(() => renderer.update(React.createElement(Surface, propsFor(data)))),
        "Changing Current/Projected or category filters must not throw while old sectors are rendered")
      advance(16)
      assertCurrentTargets(observed, data)
    }
    assert.ok(staleSectors > 0, "Regression must observe removed sectors before Recharts synchronizes data")
    assert.ok(shiftedSectors > 0, "Regression must observe matching categories with obsolete array indices")
  } finally {
    if (renderer) TestRenderer.act(() => renderer.unmount())
    frames.clear()
  }
}
console.log("Real Recharts mode/filter transitions retain safe category identity and keyboard drilldowns")
