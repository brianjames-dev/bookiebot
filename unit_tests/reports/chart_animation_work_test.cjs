const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const {createRequire} = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const ts = req('typescript'), React = req('react'), Renderer = req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
let nextFrame=0, now=0, reduced=false
const frames=new Map(), listeners=new Set()
global.requestAnimationFrame=callback=>{frames.set(++nextFrame,callback);return nextFrame}
global.cancelAnimationFrame=id=>frames.delete(id)
global.window={requestAnimationFrame:global.requestAnimationFrame,cancelAnimationFrame:global.cancelAnimationFrame,
  matchMedia:()=>({get matches(){return reduced},addEventListener(_event,listener){listeners.add(listener)},removeEventListener(_event,listener){listeners.delete(listener)}})}
const Recharts=req('recharts')
let sectorMounts=0, barMounts=0
const sectors=[], bars=[]
function ObservedSector(props){React.useEffect(()=>{sectorMounts++},[]);sectors.push(props);return StablePieSector(props)}
function ObservedBar(props){React.useEffect(()=>{barMounts++},[]);const node=stableBarShape(props);if(node)bars.push(node.props);return node}
const helperSource=fs.readFileSync('web/expense-report/src/chart-animation.tsx','utf8')
const helperRuntime={exports:{},require:req}
vm.runInNewContext(ts.transpileModule(helperSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020}}).outputText,helperRuntime)
const {stablePieAnimation,stableBarAnimation,stableBarShape,StablePieSector,pieSectorPath}=helperRuntime.exports
// Compare the lean path with Recharts itself, including full-circle clamps,
// large arcs, reverse sweeps, solid wedges and offset/noninteger layouts.
const tokens=d=>(d??'').match(/[MLAZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi)??[]
for(const startAngle of [-360,-137.25,0,22.5,350])for(const span of [-360,-220,-.001,0,.001,179,181,359.999,360])for(const innerRadius of [0,72]){
 const geometry={cx:200.12345,cy:160.98765,innerRadius,outerRadius:122.56789,startAngle,endAngle:startAngle+span}
 const original=Recharts.Sector(geometry)
 assert.deepEqual(Array.from(tokens(pieSectorPath(geometry))),tokens(original?.props.d),'Lean sector path preserves the original SVG geometry')
}
for(const [x,y,width,height] of [[10,20,15,30],[10,20,-15,30],[10,20,15,-30],[10,20,-15,-30]]){
 const node=stableBarShape({x,y,width,height,radius:[2,2,2,2],fill:'red'})
 assert.equal(node.type,'rect');assert.equal(node.props.x,Math.min(x,x+width));assert.equal(node.props.y,Math.min(y,y+height))
 assert.equal(node.props.width,Math.abs(width));assert.equal(node.props.height,Math.abs(height));assert.equal(node.props.rx,2)
}
assert.equal(stableBarShape({x:1,y:2,width:20,height:1,radius:[2,2,2,2]}).props.rx,.5,'Thin growing bars retain the original circular corner clamp')
for(const invalid of [{width:0},{height:0},{x:NaN}])assert.equal(stableBarShape({x:1,y:1,width:10,height:20,...invalid}),null)
const defaultPie=req('recharts/lib/polar/Pie').defaultPieProps.animationInterpolateFn
const defaultBar=req('recharts/lib/cartesian/Bar').defaultBarProps.animationInterpolateFn
const plain=value=>JSON.parse(JSON.stringify(value))
const geometry=rows=>plain(rows.map(({animationGeometry,...row})=>({...row,...animationGeometry})))
const pieA={startAngle:0,endAngle:100,paddingAngle:1,midAngle:50,payload:{key:'a'}}
const pieB={startAngle:101,endAngle:359,paddingAngle:1,midAngle:230,payload:{key:'b'}}
const rectA={x:10,y:60,width:20,height:40,stackedBarStart:100,value:40,originalDataIndex:0}
const rectB={x:40,y:20,width:20,height:80,stackedBarStart:100,value:80,originalDataIndex:1}
for(const [optimized,original,first,second,layouts] of [
  [stablePieAnimation,defaultPie,pieA,pieB,['centric','radial']],
  [stableBarAnimation,defaultBar,rectA,rectB,['horizontal','vertical']],
])for(const layout of layouts){
 for(const items of [null,[],[{status:'added',next:first},{status:'added',next:second}],
   [{status:'matched',prev:first,next:second},{status:'added',next:first}],
   [{status:'removed',prev:first},{status:'matched',prev:second,next:first}]]){
  for(const t of [0,.001,.1,.35,.5,.9,.999,1]){
   assert.deepEqual(geometry(optimized(items,t,layout)),plain(original(items,t,layout)),'Every interpolated coordinate matches the original Recharts animation')
  }
 }
 const snapshot=optimized([{status:'matched',prev:first,next:second}],.37,layout)[0]
 const current=geometry([snapshot])[0]
 for(const t of [0,.1,.5,1])assert.deepEqual(geometry(optimized([{status:'matched',prev:snapshot,next:first}],t,layout)),
  plain(original([{status:'matched',prev:current,next:first}],t,layout)),'Interrupted animations resume from the visible geometry')
}

const source=fs.readFileSync('web/expense-report/src/report-app.tsx','utf8')
const file=ts.createSourceFile('report-app.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const names=new Set(['money','formatMoney','useMediaQuery','CategoryMixPieSurface','DailySpendingChart',
  'NEEDS_BAR_COLOR','WANTS_BAR_COLOR','DAILY_SPENDING_BAR_RADIUS','DAILY_SPENDING_GRID_COLOR','DAILY_SPENDING_BOUNDARY_COLOR',
  'dailySpendingAxis','dailySpendingBreakAmount','dailySpendingChartRows','dailySpendingVisualAmount','dailySpendingActualAmount',
  'dailySpendingAxisTickLabel','dailySpendingYAxisDomain','dailySpendingYAxisTicks','dailySpendingTickRange','dailySpendingCursorFill'])
const declarations=file.statements.filter(node=>ts.isFunctionDeclaration(node)?names.has(node.name?.text):ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>names.has(d.name.getText(file))))
assert.equal(declarations.length,names.size)
const compiled=ts.transpileModule(declarations.map(node=>node.getText(file)).join('\n')+'\nexports.Pie=CategoryMixPieSurface; exports.Daily=DailySpendingChart',{
 compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
const runtime={exports:{},require:req,window:global.window,memo:React.memo,useState:React.useState,useEffect:React.useEffect,
 categoryRingAnimation:helperRuntime.exports.categoryRingAnimation,stableBarAnimation,stableBarShape:props=>React.createElement(ObservedBar,props),
 ResponsiveContainer:({children})=>children,ChartContainer:({children})=>children,
 PieChart:props=>React.createElement(Recharts.PieChart,{...props,width:400,height:320,compact:true}),
 Pie:props=>React.createElement(Recharts.Pie,{...props,zIndex:0,isAnimationActive:props.isAnimationActive??true}),
 BarChart:props=>React.createElement(Recharts.BarChart,{...props,width:400,height:320,compact:true}),
 Bar:props=>React.createElement(Recharts.Bar,{...props,zIndex:0,isAnimationActive:props.isAnimationActive??true}),
 CartesianGrid:props=>React.createElement(Recharts.CartesianGrid,{...props,zIndex:0}),
 XAxis:props=>React.createElement(Recharts.XAxis,{...props,zIndex:0}),YAxis:props=>React.createElement(Recharts.YAxis,{...props,zIndex:0}),
 Cell:Recharts.Cell,StablePieSector:ObservedSector,ChartTooltip:()=>null,ChartTooltipContent:()=>null,DailySpendingTooltipContent:()=>null,
 areCategoryMixPieSurfacePropsEqual:()=>false,PIE_METRIC_START_ANGLE:0,PIE_METRIC_END_ANGLE:360,PIE_METRIC_PADDING_ANGLE:1}
vm.runInNewContext(compiled,runtime)
function advance(ms=16){now+=ms;const pending=[...frames.values()];frames.clear();Renderer.act(()=>pending.forEach(callback=>callback(now)))}
function settle(){for(let i=0;i<45;i++)advance()}
const layout={margin:{top:0,right:0,bottom:0,left:0},cx:200,cy:160,innerRadius:70,outerRadius:120,showLabels:false}
const food={key:'food',label:'Food',amount:100,percentage:25,color:'#123456'}
const wants={key:'wants',label:'Wants',amount:200,percentage:50,color:'#456789'}
const left={key:'left',label:'Left',amount:100,percentage:25,color:'#789abc'}
const calls=[],onInspect=item=>calls.push(item)
for(const initialReduced of [false,true]){
 reduced=initialReduced;let tree
 try{
  Renderer.act(()=>{tree=Renderer.create(React.createElement(runtime.exports.Pie,{data:[food,wants,left],layout,onInspect}))});settle()
  Renderer.act(()=>tree.update(React.createElement(runtime.exports.Pie,{data:[{...food,amount:150},left],layout,onInspect})))
  advance();advance();sectorMounts=0;sectors.length=0;settle()
  assert.equal(sectorMounts,0,'Pie reuses mounted SVG shapes throughout its original animation')
  if(!reduced){assert.ok(sectors.length>20,'Original slice motion runs on phone as well as desktop');assert.ok(new Set(sectors.map(s=>s.endAngle)).size>10,'Slices visibly morph through intermediate angles')}
  else assert.equal(sectors.length,0,'Reduce Motion shows final geometry without an animation')
  Renderer.act(()=>tree.update(React.createElement(runtime.exports.Pie,{data:[{...wants,amount:350}],layout,onInspect})))
  advance();const target=tree.root.findAllByType(ObservedSector).find(n=>n.props.role==='button');target.props.onClick();assert.equal(calls.pop().amount,350)
  reduced=true;Renderer.act(()=>[...listeners].forEach(listener=>listener()));advance();advance();sectors.length=0;settle();assert.equal(sectors.length,0,'Changing Reduce Motion stops ongoing geometry updates')
 }finally{if(tree)Renderer.act(()=>tree.unmount());frames.clear()}
 assert.equal(listeners.size,0)
}
for(const initialReduced of [false,true]){
 reduced=initialReduced;let tree
 const base={total:100,filter:'all',detailsOpen:false,detailsId:'daily',onToggleDetails(){},onInspectDay(){}}
 const all=[{label:'1',amount:100,needsAmount:40,wantsAmount:60},{label:'2',amount:80,needsAmount:50,wantsAmount:30}]
 try{
  Renderer.act(()=>{tree=Renderer.create(React.createElement(runtime.exports.Daily,{...base,data:all}))});settle()
  Renderer.act(()=>tree.update(React.createElement(runtime.exports.Daily,{...base,filter:'wants',data:all.map(row=>({...row,amount:row.wantsAmount,needsAmount:0}))})))
  advance();advance();barMounts=0;bars.length=0;settle()
  assert.equal(barMounts,0,'Daily bars retain their shapes while growing/moving')
  if(!reduced){assert.ok(bars.length>20,'Daily Spending keeps its original growth animation');assert.ok(new Set(bars.map(b=>b.height)).size>10)}
  else assert.equal(bars.length,0)
 }finally{if(tree)Renderer.act(()=>tree.unmount());frames.clear()}
 assert.equal(listeners.size,0)
}
console.log('Original pie/bar interpolation matches at every sampled frame; SVG shapes stay mounted, interruption/inspection and Reduce Motion stay safe')
