const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const {createRequire} = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const ts = req('typescript'), React = req('react'), {act, create} = req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
const compile = source => ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020}}).outputText
const helper = {exports: {}, window: {innerWidth:390,innerHeight:900}}
vm.runInNewContext(compile(fs.readFileSync('web/expense-report/src/burn-rate-tooltip.ts', 'utf8')), helper)
const {burnRateBalance, burnRateTooltipPlacement, positionBurnRateTooltip} = helper.exports
const plain = value => JSON.parse(JSON.stringify(value))
for (const [spent, limit, expected] of [
  [40, 100, {used:40, left:60, over:false, empty:false, excess:0}],
  [100, 100, {used:100, left:0, over:false, empty:false, excess:0}],
  [150, 100, {used:150, left:0, over:true, empty:false, excess:.5}],
  [350, 100, {used:350, left:0, over:true, empty:false, excess:1}],
  [0, 0, {used:0, left:0, over:false, empty:true, excess:0}],
  [10, 0, {used:10, left:0, over:true, empty:false, excess:1}],
  [-20, 100, {used:0, left:120, over:false, empty:false, excess:0}],
]) assert.deepEqual(plain(burnRateBalance(spent, limit)), expected)

const plot = {x:58, y:20, width:280, height:260}, tooltip = {width:184, height:102}
const diagonal = Array.from({length:90}, (_, i) => ({x:60+i*3, y:25+i*2.6}))
for (const selectedX of [60, 165, 327]) {
  const p = burnRateTooltipPlacement(plot, tooltip, diagonal, selectedX)
  assert.ok(p.x >=58 && p.y >=20 && p.x+184<=338 && p.y+102<=280)
  const selected = diagonal.reduce((a,b)=>Math.abs(a.x-selectedX)<Math.abs(b.x-selectedX)?a:b)
  assert.ok(!(selected.x>p.x-8 && selected.x<p.x+192 && selected.y>p.y-8 && selected.y<p.y+110), 'Prefer a corner away from the selected node')
}
const surrounding = {x:8,y:-120,width:340,height:530}
for (const selectedX of [60, 165, 327]) {
  const p = burnRateTooltipPlacement(plot, tooltip, diagonal, selectedX, surrounding)
  assert.ok(p.y+tooltip.height<=plot.y || p.y>=plot.y+plot.height, 'Use surrounding space to leave the entire plot visible')
  assert.ok(p.x>=8 && p.x+184<=348 && p.y>=-120 && p.y+102<=410)
  assert.deepEqual(plain(burnRateTooltipPlacement(plot, tooltip, diagonal, selectedX, surrounding, p)),plain(p),'Repeated measurements keep the same anchor')
}
// A short plot has no safe internal corner. Overflow must clear its center node.
const shortPlot={x:50,y:20,width:230,height:100}, center={x:165,y:70}
const escaped=burnRateTooltipPlacement(shortPlot,tooltip,[center],165,{x:8,y:-100,width:300,height:360})
assert.ok(escaped.y+102<=20 || escaped.y>=120)
assert.ok(Math.abs(escaped.x+92-center.x)<=1,'Center near the selected node rather than a distant fixed corner')
// Viewport intersections can rule out one outside edge; use the other instead.
const below=burnRateTooltipPlacement(shortPlot,tooltip,[center],165,{x:8,y:20,width:300,height:250})
assert.ok(below.y>=120)
const above=burnRateTooltipPlacement(shortPlot,tooltip,[center],165,{x:8,y:-140,width:300,height:260})
assert.ok(above.y+102<=20)
// A retained anchor can never win over selected-node clearance.
const moved=burnRateTooltipPlacement(shortPlot,tooltip,[center],165,surrounding,{x:60,y:20})
assert.ok(moved.y+102<=20 || moved.y>=120)

// Exercise the DOM adapter too: chart-local matrix, cached samples, direct placement.
let reads=0, curve='initial', chartWidth=360
const matrix={a:1,b:0,c:0,d:1,e:0,f:0}
const line={getCTM:()=>matrix,getAttribute:()=>curve,getTotalLength:()=>270,getPointAtLength:at=>{reads++;return {matrixTransform:m=>({x:60+at*m.a,y:35+at*.6+m.f})}}}
const clip={x:{baseVal:{value:58}},y:{baseVal:{value:20}},width:{baseVal:{value:280}},height:{baseVal:{value:260}}}
const chart={getBoundingClientRect:()=>({left:16,top:150,right:16+chartWidth,bottom:450,width:chartWidth,height:300}),querySelector:selector=>selector==='clipPath rect'?clip:line}
const page={getBoundingClientRect:()=>({left:0,top:16,right:390,bottom:590})}
const portal={parentElement:{querySelector:()=>chart,closest:()=>page},style:{},dataset:{}}
const node={offsetWidth:184,offsetHeight:102,dataset:{inspectedDay:'13'}}
positionBurnRateTooltip(portal,node,150)
assert.match(portal.style.transform,/^translate\(-?[\d.]+px, -?[\d.]+px\)$/)
assert.equal(portal.dataset.positionedDay,'13')
const cachedReads=reads
node.dataset.inspectedDay='14';positionBurnRateTooltip(portal,node,160)
assert.equal(reads,cachedReads,'Changing day does not resample unchanged line geometry')
assert.equal(portal.dataset.positionedDay,'14')
for(const change of [()=>curve='new',()=>chartWidth=390,()=>matrix.f=5]){const before=reads;change();positionBurnRateTooltip(portal,node,160);assert.ok(reads>before)}

const source=fs.readFileSync('web/expense-report/src/report-app.tsx','utf8')
const file=ts.createSourceFile('app.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const names=new Set(['money','formatMoney','BurnRateChart','BurnRateMonthBalance','BurnRateBalanceRail','burnRateDailyPaceLabel','BurnRateTooltipContent','BurnRateInfoButton','burnRateGradientStops','burnRateYAxisDomain','burnRatePointColor','renderBurnRateActiveDot'])
const declarations=file.statements.filter(s=>ts.isFunctionDeclaration(s)?names.has(s.name?.text):ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>names.has(d.name.getText(file))))
assert.equal(declarations.length,names.size)
const surface=({children})=>React.createElement('div',null,children)
const runtime={exports:{},require:req,useState:React.useState,useLayoutEffect:React.useLayoutEffect,useRef:React.useRef,useMediaQuery:()=>true,burnRateBalance,positionBurnRateTooltip,
  categoryMixPressure:()=>null,ChartContainer:surface,ResponsiveContainer:surface,ComposedChart:surface,Area:()=>null,CartesianGrid:()=>null,XAxis:()=>null,YAxis:()=>null,ReferenceLine:()=>null,Line:()=>null,ChartTooltip:()=>null}
vm.runInNewContext(compile(declarations.map(n=>n.getText(file)).join('\n')+'\nexports.Chart=BurnRateChart;exports.Tooltip=BurnRateTooltipContent;exports.Month=BurnRateMonthBalance'),runtime)
let view
const render=(Component,props)=>act(()=>{if(view)view.unmount();view=create(React.createElement(Component,props))})
const point={day:13,label:'13',dailySpend:400,actualSpend:1460,expectedSpend:1255.93,variance:204.07}
const burn={budget:2994.92,spent:2029.32,remaining:965.60,daysInMonth:31,elapsedDays:26,totalDifference:-482.55,dailyDifference:-18.56,status:'under',series:[point]}
render(runtime.exports.Chart,{burnRate:burn,categoryBalances:{},month:10})
let text=JSON.stringify(view.toJSON())
for(const expected of ['Available today','$482.55','Saving','$18.56','Through Oct 26','Month limit','$2,994.92','$2,029.32','$965.60'])assert.ok(text.includes(expected),expected)
for(const removed of ['Details','Allowed/day','Actual/day','bb-burn-rate-pill'])assert.ok(!text.includes(removed),removed)
const area=view.root.findByType(runtime.Area),lineView=view.root.findByType(runtime.Line)
assert.equal(area.props.baseValue,0);assert.equal(area.props.fillOpacity,.1);assert.equal(area.props.isAnimationActive,false)
assert.equal(lineView.props.strokeWidth,3);assert.equal(lineView.props.isAnimationActive,false)
assert.equal(lineView.props.stroke,'url(#burn-rate-variance-gradient)')

render(runtime.exports.Tooltip,{active:true,payload:[{payload:point}],monthName:'Feb',portal:{}})
text=JSON.stringify(view.toJSON())
for(const expected of ['Feb','13','$400.00',' spent','$204.07','over pace','$1,460.00','$1,255.93'])assert.ok(text.includes(expected),expected)
for(const removed of ['Through','to date','Day spent','Total Spent'])assert.ok(!text.includes(removed),removed)
const bar=view.root.findByProps({className:'bb-burn-day-bar'})
assert.deepEqual(bar.findAllByType('div').map(n=>n.props.className),['bb-burn-day-bar','bb-burn-pair bb-burn-pair-labels','bb-burn-balance-rail','bb-burn-pair bb-burn-pair-values'])
assert.equal(bar.findByProps({className:'bb-burn-balance-rail'}).props['data-over'],true)
assert.ok(Math.abs(parseFloat(bar.findByProps({className:'bb-burn-overfill'}).props.style.width)-204.07/1255.93*100)<.001)
render(runtime.exports.Tooltip,{active:true,payload:[{payload:{...point,variance:null,actualSpend:null,dailySpend:null}}],monthName:'Feb',portal:{}})
assert.equal(view.toJSON(),null,'Future points have no fabricated spending details')
render(runtime.exports.Month,{burnRate:{...burn,elapsedDays:0,spent:0,budget:0,remaining:0},monthName:'Feb'})
assert.ok(JSON.stringify(view.toJSON()).includes('Month not started'))
assert.equal(view.root.findByProps({className:'bb-burn-balance-rail'}).props['data-empty'],true)
render(runtime.exports.Month,{burnRate:{...burn,spent:3100,remaining:-105.08},monthName:'Feb'})
assert.ok(JSON.stringify(view.toJSON()).includes('-$105.08'),'Overspend stays signed in the monthly Left amount')
act(()=>view.unmount())
console.log('PASS: balance edge cases, day/month scopes, approved labels and shade, native line props, stable chart-local placement and cache')
