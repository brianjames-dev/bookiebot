const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const {createRequire} = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const ts = req('typescript'), React = req('react'), TestRenderer = req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
let nextFrame = 0, now = 0, compact = true, reduced = false
const frames = new Map(), listeners = new Map()
global.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
global.cancelAnimationFrame = id => frames.delete(id)
global.window = {
  requestAnimationFrame: global.requestAnimationFrame, cancelAnimationFrame: global.cancelAnimationFrame,
  matchMedia: query => ({get matches() {return query.includes('reduced-motion') ? reduced : compact},
    addEventListener(_event, listener) {if (!listeners.has(query)) listeners.set(query,new Set()); listeners.get(query).add(listener)},
    removeEventListener(_event, listener) {const group=listeners.get(query); group?.delete(listener); if (!group?.size) listeners.delete(query)},
  }),
}
const Recharts = req('recharts')
const source = fs.readFileSync('web/expense-report/src/report-app.tsx', 'utf8')
const file = ts.createSourceFile('report-app.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = new Set(['money', 'formatMoney', 'useMediaQuery', 'useChartTransition', 'CategoryMixPieSurface', 'DailySpendingChart',
  'NEEDS_BAR_COLOR', 'WANTS_BAR_COLOR', 'DAILY_SPENDING_BAR_RADIUS', 'DAILY_SPENDING_GRID_COLOR', 'DAILY_SPENDING_BOUNDARY_COLOR',
  'dailySpendingAxis', 'dailySpendingBreakAmount', 'dailySpendingChartRows', 'dailySpendingVisualAmount',
  'dailySpendingActualAmount', 'dailySpendingAxisTickLabel', 'dailySpendingYAxisDomain', 'dailySpendingYAxisTicks',
  'dailySpendingTickRange', 'dailySpendingCursorFill'])
const declarations = file.statements.filter(statement => ts.isFunctionDeclaration(statement)
  ? names.has(statement.name?.text)
  : ts.isVariableStatement(statement) && statement.declarationList.declarations.some(item => names.has(item.name.getText(file))))
const compiled = ts.transpileModule(declarations.map(node => node.getText(file)).join('\n') + '\nexports.Surface = CategoryMixPieSurface; exports.Daily = DailySpendingChart', {
  compilerOptions: {target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX},
}).outputText
const animations = [], observed = [], observedBars = []
const nodeMock = {animate(keyframes, options) {const animation = {keyframes, options, cancelled: false, cancel() {this.cancelled = true}}; animations.push(animation); return animation}}
const runtime = {
  exports: {}, window: global.window, require: req, memo: React.memo, useState: React.useState, useEffect: React.useEffect,
  useLayoutEffect: React.useLayoutEffect, useRef: React.useRef,
  ResponsiveContainer: ({children}) => children,
  PieChart: props => React.createElement(Recharts.PieChart, {...props, width: 400, height: 320, compact: true}),
  // Browser default is animated; the headless renderer otherwise treats auto as SSR.
  Pie: props => React.createElement(Recharts.Pie, {...props, zIndex: 0, isAnimationActive: props.isAnimationActive ?? true}),
  ChartContainer: ({children}) => children,
  BarChart: props => React.createElement(Recharts.BarChart, {...props, width:400, height:320, compact:true}),
  Bar: props => React.createElement(Recharts.Bar, {...props, zIndex:0, isAnimationActive:props.isAnimationActive ?? true,
    shape: shapeProps => {observedBars.push(shapeProps); return React.createElement(Recharts.Rectangle,shapeProps)}}),
  CartesianGrid: props => React.createElement(Recharts.CartesianGrid,{...props,zIndex:0}),
  XAxis: props => React.createElement(Recharts.XAxis,{...props,zIndex:0}),
  YAxis: props => React.createElement(Recharts.YAxis,{...props,zIndex:0}),
  DailySpendingTooltipContent: () => null,
  Cell: Recharts.Cell, Sector: props => {observed.push(props); return React.createElement(Recharts.Sector, props)},
  ChartTooltip: () => null, ChartTooltipContent: () => null,
  areCategoryMixPieSurfacePropsEqual: () => false,
  PIE_METRIC_START_ANGLE: 0, PIE_METRIC_END_ANGLE: 360, PIE_METRIC_PADDING_ANGLE: 1,
}
vm.runInNewContext(compiled, runtime)
const Surface = runtime.exports.Surface
const layout = {margin: {top: 0, right: 0, bottom: 0, left: 0}, cx: 200, cy: 160, innerRadius: 70, outerRadius: 120, showLabels: false}
const food = {key: 'food', label: 'Food', amount: 100, percentage: 25, color: '#123456'}
const wants = {key: 'wants', label: 'Wants', amount: 200, percentage: 50, color: '#456789'}
const left = {key: 'left', label: 'Left', amount: 100, percentage: 25, color: '#789abc'}
const calls = [], onInspect = item => calls.push(item)
const propsFor = data => ({data, layout, onInspect})
function advance(ms = 16) {now += ms; const pending = [...frames.values()]; frames.clear(); TestRenderer.act(() => pending.forEach(callback => callback(now)))}
function settle() {for (let i = 0; i < 45; i++) advance()}
for (const mode of [{compact:true,reduced:false}, {compact:false,reduced:false}, {compact:false,reduced:true}, {compact:true,reduced:true}]) {
  compact = mode.compact; reduced = mode.reduced; animations.length = 0
  let tree
  try {
    TestRenderer.act(() => {tree = TestRenderer.create(React.createElement(Surface, propsFor([food,wants,left])), {createNodeMock: node => node.props.className?.includes('bb-chart-motion-surface') ? nodeMock : null})})
    settle()
    TestRenderer.act(() => tree.update(React.createElement(Surface, propsFor([food,left]))))
    // New data should settle immediately on phones; advancing the old animation
    // interval must not regenerate the sectors on every frame.
    advance(); advance(); observed.length = 0
    settle()
    if (compact || reduced) assert.equal(observed.length, 0, 'Phone/reduced-motion pie must not rebuild SVG sectors throughout the animation')
    else assert.ok(observed.length > 20, 'Desktop keeps its existing sector morph')
    if (compact && !reduced) {
      assert.ok(animations.length >= 2, 'Initial phone plot and changed data use a browser opacity transition')
      assert.ok(animations.at(-1).options.duration <= 200, 'Phone feedback finishes promptly')
      assert.ok(animations.slice(0,-1).every(animation => animation.cancelled), 'New data cancels an older transition')
      const before = animations.length
      TestRenderer.act(() => tree.update(React.createElement(Surface, propsFor([{...food},{...left}]))))
      assert.equal(animations.length, before, 'Equivalent data/tooltip updates never restart the fade')
      TestRenderer.act(() => tree.update(React.createElement(Surface, propsFor([{...wants,amount:350}]))))
      assert.equal(animations.length, before + 1)
      const sector = tree.root.findAllByType(Recharts.Sector).find(node => node.props.role === 'button')
      sector.props.onClick(); assert.equal(calls.pop().amount, 350, 'Inspection uses current financial data immediately')
      reduced = true; TestRenderer.act(() => [...listeners.values()].flatMap(group => [...group]).forEach(listener => listener()))
      assert.ok(animations.at(-1).cancelled, 'Changing reduced-motion preference cancels an in-flight fade')
      assert.equal(animations.length, before + 1, 'Reduced motion starts no replacement animation')
    } else assert.equal(animations.length, 0, 'Desktop and reduced-motion views start no phone fade')
  } finally {if(tree) TestRenderer.act(() => tree.unmount()); frames.clear()}
  assert.ok(animations.every(animation => animation.cancelled), 'Unmount cancels remaining browser work')
  assert.equal(listeners.size, 0, 'Media listeners are released')
}
const Daily = runtime.exports.Daily
for (const mode of [{compact:true,reduced:false}, {compact:false,reduced:false}, {compact:false,reduced:true}]) {
  compact=mode.compact; reduced=mode.reduced; animations.length=0
  const base={total:100,filter:'all',detailsOpen:false,detailsId:'daily',onToggleDetails(){},onInspectDay(){}}
  const all=[{label:'1',amount:100,needsAmount:40,wantsAmount:60},{label:'2',amount:80,needsAmount:50,wantsAmount:30}]
  const wants=all.map(row=>({...row,amount:row.wantsAmount,needsAmount:0}))
  let tree
  try {
    TestRenderer.act(()=>{tree=TestRenderer.create(React.createElement(Daily,{...base,data:all}),{createNodeMock:node=>node.props.className?.includes('bb-chart-motion-surface')?nodeMock:null})});settle();settle();settle()
    TestRenderer.act(()=>tree.update(React.createElement(Daily,{...base,filter:'wants',data:wants})))
    advance();advance();observedBars.length=0;settle()
    if(compact||reduced)assert.equal(observedBars.length,0,'Phone/reduced-motion daily bars must not rebuild SVG geometry on animation frames')
    else assert.ok(observedBars.length>20,'Desktop daily bars retain their existing animation')
    if(compact&&!reduced)assert.ok(animations.length>=2,'Daily filter changes use the same browser fade')
    else assert.equal(animations.length,0)
  } finally {if(tree)TestRenderer.act(()=>tree.unmount());frames.clear()}
  assert.ok(animations.every(animation=>animation.cancelled));assert.equal(listeners.size,0)
}
console.log('Phone pie/daily updates settle once, browser fades cancel safely, desktop geometry animations and reduced motion retain their behavior')
