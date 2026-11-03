const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
const ts=req('typescript'),React=req('react'),{act,create}=req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT=true
const source=fs.readFileSync(path.join(root,'web/expense-report/src/report-app.tsx'),'utf8')
const file=ts.createSourceFile('report-app.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const names=new Set(['money','formatMoney','HIGHLIGHTS_LAYOUT','highlightLabelMeasure','highlightTextWidth','fitHighlightLabel','HighlightAxisLabel','HighlightValue','HighlightThumbnail','HighlightFloatingThumbnail','HighlightsPlot','TopExpensesChart','MerchantChart','topExpenseHeatColor','expenseEntryItemLabel','TOP_EXPENSE_HEAT_COLORS','MERCHANT_BAR_COLOR'])
const declarations=file.statements.filter(node=>ts.isFunctionDeclaration(node)?names.has(node.name?.text):ts.isVariableStatement(node)&&node.declarationList.declarations.some(d=>names.has(d.name.getText(file))))
assert.equal(declarations.length,names.size,'Exercise every production renderer/helper rather than a copy')
const code=ts.transpileModule(declarations.map(node=>node.getText(file)).join('\n')+'\nexports.api={TopExpensesChart,MerchantChart,HighlightAxisLabel,HighlightValue,HighlightThumbnail,HighlightFloatingThumbnail,fitHighlightLabel}',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020}}).outputText
const surface=({children})=>React.createElement('div',null,children)
let coordinate={x:160,y:20},chartWidth=288,measurements=0
const context={exports:{},require:req,useMemo:React.useMemo,useRef:React.useRef,
 document:{createElement:()=>({getContext:()=>({measureText:value=>{measurements++;return{width:[...value].length*7}}})})},
 useChartWidth:()=>chartWidth,useActiveTooltipCoordinate:()=>coordinate,
 ChartContainer:surface,ResponsiveContainer:surface,BarChart:surface,Bar:surface,Cell:()=>null,CartesianGrid:()=>null,XAxis:()=>null,YAxis:()=>null,LabelList:()=>null,ChartTooltip:()=>null}
vm.runInNewContext(code,context)
const api=context.exports.api,h=React.createElement
const render=element=>{let result;act(()=>{result=create(element)});return result}
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node?.children?text(node.children):''
const entries=Object.freeze(Array.from({length:12},(_,i)=>Object.freeze({category:'Food',item:`Purchase ${i+1}`,amount:120-i,date:'11/2/2026'})))
let renderer=render(h(api.TopExpensesChart,{entries}))
const plot=()=>renderer.root.findAllByType(surface).find(node=>node.props.layout==='vertical')
assert.equal(plot().props.data.length,8,'Only the approved eight expenses are plotted')
assert.deepEqual(Array.from(plot().props.data,row=>[row.label,row.amount]),entries.slice(0,8).map(row=>[row.item,row.amount]))
assert.equal(entries.length,12,'The source payload retains every transaction')
assert.equal(renderer.root.findByProps({className:'bb-highlight-plot'}).props.style['--bb-highlight-plot-height'],'258px')
assert.equal(renderer.root.findAllByType(surface).find(node=>node.props.barSize).props.barSize,20)
const occurrences=Object.freeze([{label:'Coffee company',count:3,amount:17.25}])
act(()=>renderer.update(h(api.MerchantChart,{data:occurrences})))
assert.equal(plot().props.data.length,1)
assert.equal(plot().props.data[0],occurrences[0],'Counts and totals come directly from the report')
act(()=>renderer.update(h(api.MerchantChart,{data:[]})))
assert.equal(plot().props.data.length,0,'An empty refresh cannot retain old chart values')
act(()=>renderer.unmount())

renderer=render(h(api.HighlightAxisLabel,{x:90,y:20,width:80,payload:{value:'Whole Foods'}}))
assert.equal(text(renderer.toJSON()),'Whole Foods','Names that fit remain complete')
const previousMeasurements=measurements
act(()=>renderer.update(h(api.HighlightAxisLabel,{x:90,y:48,width:80,payload:{value:'Whole Foods'}})))
assert.equal(measurements,previousMeasurements,'Moving a label does not remeasure the text')
act(()=>renderer.update(h(api.HighlightAxisLabel,{x:90,y:48,width:28,payload:{value:'Whole Foods'}})))
assert.equal(text(renderer.toJSON()),'Who…','Long names fit their actual label column')
act(()=>renderer.unmount())
renderer=render(h(api.HighlightValue,{x:'20',y:'30',width:'40',height:'20',value:274.52,kind:'amount'}))
assert.equal(text(renderer.toJSON()),'$274.52')
assert.equal(renderer.toJSON().props.x,69)
assert.equal(renderer.toJSON().props.y,40)
act(()=>renderer.update(h(api.HighlightValue,{value:12,kind:'count'})))
assert.equal(text(renderer.toJSON()),'12×')
act(()=>renderer.unmount())

renderer=render(h(api.HighlightThumbnail,{active:true,kind:'amount',payload:[{payload:{label:'A very long complete merchant name',amount:274.52,color:'green'}}]}))
assert.ok(text(renderer.toJSON()).includes('A very long complete merchant name$274.52Expense amount'))
assert.equal(renderer.toJSON().props.style['--bb-highlight-thumb-width'],'200px')
act(()=>renderer.update(h(api.HighlightThumbnail,{active:true,kind:'count',payload:[{payload:{label:'Cafe',count:1,amount:4.75}}]})))
assert.ok(text(renderer.toJSON()).includes('1occurrenceTotal spent$4.75'))
act(()=>renderer.update(h(api.HighlightThumbnail,{active:true,kind:'count',payload:[{payload:{label:'Cafe',count:12,amount:92.60}}]})))
assert.ok(text(renderer.toJSON()).includes('12occurrencesTotal spent$92.60'))
act(()=>renderer.update(h(api.HighlightThumbnail,{active:false,kind:'count',payload:[]})))
assert.equal(renderer.toJSON(),null,'Inactive/empty tooltips expose no stale content')
act(()=>renderer.unmount())

renderer=render(h(api.HighlightFloatingThumbnail,{kind:'amount'}))
for(chartWidth of [240,288,358,736,1240])for(const x of [0,20,92,chartWidth/2,chartWidth-1]){
 coordinate={x,y:20}
 act(()=>renderer.update(h(api.HighlightFloatingThumbnail,{kind:'amount'})))
 const position=renderer.root.findByType(context.ChartTooltip).props.position
 assert.ok(position.x>=8&&position.x+200<=chartWidth-8,'200px thumbnail fits the whole chart, including its label column')
}
const retainedX=renderer.root.findByType(context.ChartTooltip).props.position.x
coordinate=undefined
act(()=>renderer.update(h(api.HighlightFloatingThumbnail,{kind:'amount'})))
assert.equal(renderer.root.findByType(context.ChartTooltip).props.position.x,retainedX,'Dismissal retains the last anchor while fading')
act(()=>renderer.unmount())
console.log('Approved Highlights: eight real rows, immutable data, exact labels/counts/money, sparse refresh, cached fitting and bounded retained 200px thumbnails passed')
