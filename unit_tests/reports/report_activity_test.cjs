const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {createRequire} = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json'))
const ts = req('typescript')
const vm = require('node:vm')
const runtime = {exports:{}, Date}
vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/report-activity.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,runtime)
const {reportActivity,activitySummary,activityDay,activityMatchesCategory} = runtime.exports
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

const loan = {kind:'bill',group:'static_bills_subscriptions_needs',label:'Student Loan',amount:59.96,day:12,projectedOnly:true,amountEstimated:true}
const fixedForecast = reportActivity(report,[loan],true).find(x=>x.item==='Student Loan')
assert.equal(fixedForecast.category,'Static Bills & Subscriptions')
assert.equal(fixedForecast.status,'scheduled')
assert.equal(fixedForecast.amount,59.96)
assert.equal(reportActivity(report,[loan],false).some(x=>x.item==='Student Loan'),false)
const actualLoan = {...loan,amount:119.92,amountEstimated:false}
const fixedActual = reportActivity(report,[actualLoan],false).find(x=>x.item==='Student Loan')
assert.equal(fixedActual.status,'recorded','Actual fixed bill remains itemized before its scheduled due day')
assert.equal(fixedActual.dateSource,'scheduled')
assert.equal(fixedActual.amount,119.92)
assert.equal(reportActivity(report,[{...loan,kind:'subscription',amountEstimated:false}],true).find(x=>x.item==='Student Loan').status,'scheduled')
const staticActivity = reportActivity(report,[actualLoan,{...loan,kind:'subscription',label:'Xfinity',amount:65.99,projectedOnly:false}],false)
for (const label of ['Subs (Needs)','Static Bills & Subscriptions']) {
  const matches = staticActivity.filter(entry=>activityMatchesCategory(entry,{key:loan.group,label}))
  assert.equal(matches.length,2,'Old and current report labels both retain all static-category entries')
  assert.equal(activitySummary(matches).total,185.91)
  assert.equal(activityMatchesCategory({...fixedActual,category:'Subs (Needs)'},{key:loan.group,label}),true,'Saved entry labels remain compatible')
}
assert.equal(activityMatchesCategory(fixedActual,{key:'bills_utilities',label:'Bills & Utilities'}),false)
assert.equal(activityMatchesCategory(current.find(x=>x.item==='Lunch'),{key:'food',label:'Food'}),true)
console.log('Report drilldown and scheduled/recorded distinctions passed')
