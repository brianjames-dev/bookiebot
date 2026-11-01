const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module')
const req=createRequire(path.resolve('web/expense-report/package.json')),ts=req('typescript')
const runtime={exports:{},require:req,Intl,Date}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/bill-comparison.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,runtime)
const {comparisonItems,priorBillAverage,loadBillSelection,saveBillSelection,billPreferenceKey}=runtime.exports
const plain=value=>JSON.parse(JSON.stringify(value)),saved=new Map(),storage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)}
assert.deepEqual(plain(loadBillSelection('Brian',['water'],storage)),['water'])
saveBillSelection(' Brian ',['water','rent'],storage)
assert.deepEqual(plain(loadBillSelection('brian',['new-bill'],storage)),['water','rent'],'New bills stay off and absent saved bills retain their IDs')
assert.deepEqual(plain(loadBillSelection('Hannah',['power'],storage)),['power'],'Owner choices never leak')
saveBillSelection('Brian',[],storage)
assert.deepEqual(plain(loadBillSelection('Brian',['power'],storage)),[],'An explicit empty selection stays empty')
saved.set(billPreferenceKey('Brian'),'{broken')
assert.deepEqual(plain(loadBillSelection('Brian',['power'],storage)),['power'])
const blocked={getItem(){throw Error('blocked')},setItem(){throw Error('blocked')}}
assert.deepEqual(plain(loadBillSelection('Brian',['water'],blocked)),['water']);saveBillSelection('Brian',['water'],blocked)
const water={key:'water',label:'Water',currentAmount:50,averageAmount:40,deltaAmount:10,history:[{month:7,label:'Jul',amount:30},{month:8,label:'Aug',amount:50},{month:9,label:'Sep',amount:null}]}
const event=(label,amount,projectedOnly,extra={})=>({kind:'bill',label,amount,projectedOnly,day:15,group:'bills_utilities',...extra})
const events=[event('Water',60,true,{amountEstimated:true}),event('Xfinity',61.5,true,{kind:'subscription'}),event('Xfinity',5,false,{kind:'subscription'}),event('Pay',3000,false,{kind:'income'})]
const current=comparisonItems([water],events,9,false),projected=comparisonItems([water],events,9,true)
assert.equal(current.find(i=>i.key==='bill_water').currentAmount,0)
assert.equal(projected.find(i=>i.key==='bill_water').currentAmount,60)
assert.equal(projected.find(i=>i.key==='bill_water').history.at(-1).amount,null,'An estimate never becomes a recorded chart point')
assert.equal(comparisonItems([],events,9,false).find(i=>i.label==='Water').key,current.find(i=>i.label==='Water').key,'A chosen bill keeps its ID when its first historical payment becomes available')
const sub=projected.find(i=>i.label==='Xfinity')
assert.equal(sub.currentAmount,66.5);assert.deepEqual(plain(sub.history),[{month:9,label:'Sep',amount:5}],'Subscriptions only show a known current-month point')
assert.equal(current.length,2,'Exclude income and deduplicate scheduled bill labels')
assert.equal(water.currentAmount,50,'Report inputs are immutable')
assert.equal(priorBillAverage(water,8),30);assert.equal(priorBillAverage(water,9),40);assert.equal(priorBillAverage(water,7),null)
console.log('Bill comparison: owner-scoped storage, empty/absent/new choices, blocked storage, mode totals, immutable recorded history, current-only subscriptions and month-specific averages passed')
