const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {createRequire} = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const ts = req('typescript')
const vm = require('node:vm')
const runtime = {exports:{}, Date}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/report-activity.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,runtime)
const {reportActivity,activitySummary,activityDay} = runtime.exports
const report={year:2026,month:9,ownerName:'Brian',dailyEntries:[
 {date:'9/3/2026',category:'Food',amount:15.20,item:'Lunch'},
 {date:'2026-09-03',category:'Food',amount:4.10,item:'Tea'},
 {date:'',category:'Grocery',amount:12,item:'Undated'},
]}
const events=[
 {kind:'bill',group:'utilities',label:'Water',amount:50,day:3,projectedOnly:false},
 {kind:'subscription',group:'subscriptions_wants',label:'Music',amount:10,day:3,projectedOnly:false},
 {kind:'bill',group:'utilities',label:'Power',amount:80,day:25,projectedOnly:true},
 {kind:'income',group:'income',label:'Pay',amount:2000,day:3,projectedOnly:false},
]
const current=reportActivity(report,events,false), projected=reportActivity(report,events,true)
assert.equal(current.length,5)
assert.equal(projected.length,6)
assert.equal(current.filter(x=>x.category==='Food').length,2)
assert.equal(current.find(x=>x.item==='Music').category,'Subs (Wants)')
assert.equal(current.find(x=>x.item==='Music').status,'scheduled','Elapsed subscription is not proof of recorded payment')
assert.equal(current.find(x=>x.item==='Water').dateSource,'scheduled','Paid bill day comes from its schedule')
assert.equal(current.find(x=>x.item==='Undated').day,null)
assert.equal(current.filter(x=>x.day===3).length,4)
assert.deepEqual(JSON.parse(JSON.stringify(activitySummary(current))), {recorded:81.3,scheduled:10,total:91.3})
assert.equal(activitySummary(projected).scheduled,10)
assert.equal(projected.find(x=>x.item==='Power').status,'recorded','Bill amount is recorded even when its scheduled date is later')
assert.equal(activityDay('2/30/2026',2026,2),null)
assert.equal(activityDay('9/3/2025',2026,9),null)
assert.equal(activityDay('9/3',2026,9),3)
assert.equal(activityDay('2026-09-03',2026,9),3)
assert.equal(new Set(projected.map(x=>x.id)).size,projected.length)
console.log('Report drilldown and scheduled/recorded distinctions passed')
