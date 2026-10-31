const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const {createRequire} = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const ts = req('typescript'), React = req('react'), {act, create} = req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
const compile = source => ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020}}).outputText
const helper = {exports: {}}
vm.runInNewContext(compile(fs.readFileSync('web/expense-report/src/burn-rate-tooltip.ts', 'utf8')), helper)
const {burnRateBalance, burnRateTooltipCorner, positionBurnRateTooltip} = helper.exports
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
  const p = burnRateTooltipCorner(plot, tooltip, diagonal, selectedX)
  assert.ok(p.x >=61 && p.y >=23 && p.x+184<=335 && p.y+102<=277)
  const selected = diagonal.reduce((a,b)=>Math.abs(a.x-selectedX)<Math.abs(b.x-selectedX)?a:b)
  assert.ok(!(selected.x>p.x-8 && selected.x<p.x+192 && selected.y>p.y-8 && selected.y<p.y+110), 'Prefer a corner away from the selected node')
}
assert.equal(burnRateTooltipCorner(plot, tooltip, [], undefined, 3).corner, 3, 'Near-tied placements retain the prior corner')
assert.equal(burnRateTooltipCorner(plot, tooltip, [], undefined).corner, 0, 'Initial empty geometry prefers top-left')

// Exercise the DOM adapter too: chart-local matrix, cached samples, direct placement.
let reads=0, curve='initial', chartWidth=360
const matrix={a:1,b:0,c:0,d:1,e:0,f:0}
const line={getCTM:()=>matrix,getAttribute:()=>curve,getTotalLength:()=>270,getPointAtLength:at=>{reads++;return {matrixTransform:m=>({x:60+at*m.a,y:35+at*.6+m.f})}}}
const clip={x:{baseVal:{value:58}},y:{baseVal:{value:20}},width:{baseVal:{value:280}},height:{baseVal:{value:260}}}
const chart={getBoundingClientRect:()=>({width:chartWidth,height:300}),querySelector:selector=>selector==='clipPath rect'?clip:line}
const portal={parentElement:{querySelector:()=>chart},style:{},dataset:{}}
const node={getBoundingClientRect:()=>tooltip,dataset:{inspectedDay:'13'}}
positionBurnRateTooltip(portal,node,150)
assert.match(portal.style.transform,/^translate\([\d.]+px, [\d.]+px\)$/)
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
