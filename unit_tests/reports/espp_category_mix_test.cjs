const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module')
const req=createRequire(require('node:path').resolve('web/expense-report/package.json')),ts=req('typescript')
const source=fs.readFileSync('web/expense-report/src/report-app.tsx','utf8')
const ast=ts.createSourceFile('report-app.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const React=req('react'),{renderToStaticMarkup}=req('react-dom/server')
const names=new Set(['money','formatMoney','formatPct','roundCurrency','amountRowsTotal','reportSpentTotal','categoryMixRows','categoryMixRollover','categoryMixTransferRows','categoryBudgetTotal','CategoryMixChart','areCategoryMixChartPropsEqual','categoryBalancesEqual','breakdownRowsEqual'])
const declarations=ast.statements.filter(node=>ts.isFunctionDeclaration(node)?names.has(node.name?.text):ts.isVariableStatement(node)&&node.declarationList.declarations.some(item=>names.has(item.name.getText(ast))))
assert.equal(declarations.length,names.size)
const passthrough=({children})=>React.createElement('div',null,children)
const runtime={exports:{},memo:React.memo,require:req,FittedAmount:({children,className})=>React.createElement('div',{className},children),useElementSize:()=>[null,{width:300,height:300}],useExpensePieLayout:()=>({cx:150,cy:150,innerRadius:100}),chartConfig:()=>({}),categoryMixPressure:()=>null,ChartContainer:passthrough,CategoryMixPieMotionHost:passthrough,CategoryMixPieSurface:()=>null,CategoryMixFilterControl:()=>null,CategoryMixPressureBar:()=>null,ModalDetails:passthrough,CATEGORY_BALANCE_LABELS:{needs:'Needs',wants:'Wants',savings:'Savings'},NEEDS_BAR_COLOR:'needs',WANTS_BAR_COLOR:'wants',CATEGORY_NEEDS_KEYS:new Set(['rent']),CATEGORY_WANTS_KEYS:new Set(['food']),SAVINGS_CATEGORY_COLOR:'cash',LEFT_CATEGORY_COLOR:'left'}
vm.runInNewContext(ts.transpileModule(declarations.map(node=>node.getText(ast)).join('\n')+'\nexports.rows=categoryMixRows;exports.Chart=CategoryMixChart;exports.headline=reportSpentTotal;exports.equal=areCategoryMixChartPropsEqual',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,runtime)
const rows=(...args)=>JSON.parse(JSON.stringify(runtime.exports.rows(...args)))
const data=[{key:'rent',label:'Rent',amount:500},{key:'food',label:'Eating out',amount:150}]
const sum=values=>values.reduce((total,row)=>total+row.amount,0)
const all=rows(data,6750,'all',1200,[],400)
assert.equal(sum(all),9000)
assert.equal(all.find(row=>row.key==='savings').amount,1200)
assert.equal(all.find(row=>row.key==='espp').amount,400)
assert.notEqual(all.find(row=>row.key==='savings').color,all.find(row=>row.key==='espp').color)
const saved=rows(data,200,'savings',1200,[],400)
assert.equal(sum(saved),1800)
assert.deepEqual(saved.map(row=>[row.key,row.amount]),[['left',200],['savings',1200],['espp',400]])
assert.ok(rows(data,200,'savings',1200,[],600,200).find(row=>row.key==='espp').label.includes('includes estimate'))
assert.ok(!rows(data,200,'needs',1200,[],400).some(row=>['savings','espp'].includes(row.key)))
assert.ok(!rows(data,200,'savings',1200,[],0).some(row=>row.key==='espp'))
assert.equal(rows(data,6750,'all',1200).find(row=>row.key==='savings').amount,1200,'All includes cash savings even without ESPP enrollment')
assert.ok(!rows(data,6750,'all',1200).some(row=>row.key==='espp'))
assert.equal(rows(data,200,'savings',1200).find(row=>row.key==='savings').label,'Saved')
console.log('Category Mix partitions full take-home once, separates cash/ESPP, and preserves category filters.')

// Execute the real chart header while replacing only chart drawing/menus.
// An unitemized sheet adjustment deliberately makes the authoritative expense
// total differ from the slices; All must still match the card/modal exactly.
const {Chart,headline,equal}=runtime.exports
const base={data:[...data,{key:'savings',label:'Legacy savings row',amount:999}],onInspect(){},onFilterChange(){},collapseKey:0,
  categoryBudgets:{needs:3000,wants:1000,savings:1000},categoryBalances:{raw:{needs:2500,wants:850,savings:200},remaining:{needs:2500,wants:850,savings:200},deficits:{needs:0,wants:0,savings:0},totalOverspend:0,transfers:[]}}
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value)
const displayed=props=>renderToStaticMarkup(React.createElement(Chart,props)).match(/class="bb-chart-total">([^<]+)/)[1]
for(const [cash,espp,estimated] of [[1200,undefined,0],[1200,0,0],[1200,400,0],[1200,600,200],[0,0,0],[-50,undefined,0]]) {
  for(const [projected,adjustment] of [[false,17.25],[true,38.75]]) {
    const allSpentTotal=headline({totalExpenses:650+adjustment,amountSaved:cash+(espp??0)})
    const props={...base,filter:'all',amountSaved:cash,espp,estimatedEspp:estimated,projected,allSpentTotal}
    assert.equal(displayed(props),money(650+adjustment+cash+(espp??0)),'All matches authoritative expenses plus Saved exactly once')
    assert.equal(displayed({...props,filter:'needs'}),'$500.00','Needs stays expense-only')
    assert.equal(displayed({...props,filter:'wants'}),'$150.00','Wants stays expense-only')
    assert.equal(displayed({...props,filter:'savings'}),money(Math.max(0,cash)+(espp??0)),'Saved retains its cash/ESPP breakdown')
    assert.equal(equal(props,{...props}),true)
    assert.equal(equal(props,{...props,allSpentTotal:allSpentTotal+1}),false,'A changed canonical expense total invalidates the header memo even when slices are unchanged')
  }
}
assert.equal(rows(base.data,0,'all',1200,[],400).filter(row=>row.key==='savings').length,1,'Legacy savings slices cannot duplicate recorded cash')
console.log('Category Mix All matches the canonical Spent headline across modes, cash/ESPP/estimates, zero/negative savings and memo refreshes.')

assert.equal(displayed({...base,filter:'wants',amountSaved:1200,espp:400,allSpentTotal:2250,
  categoryBalances:{...base.categoryBalances,transfers:[{from:'wants',to:'savings',amount:25}]}}),'$175.00','Filtered donor coverage remains included exactly as before')
