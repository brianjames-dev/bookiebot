const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json')),ts=req('typescript'),cache=new Map();
function load(file){if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;vm.runInNewContext(code,{exports,Intl,Date,require:name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)+'.ts'):req(name)});return exports;}
const {validRepayment,repaymentLabel}=load(path.resolve('web/expense-report/src/transaction-repayment-model.ts'));
const {displayedAmount,accountedAmount,recordedDays}=load(path.resolve('web/expense-report/src/recorded-transaction-view.ts'));
const details={id:'fixture',version:1,direction:'outgoing',accounting:'cash_v1',payerName:'Hannah',partnerName:'Brian',grossCents:10000,payerShareCents:4000,partnerShareCents:6000,settledCents:1000,clearedCents:500,outstandingCents:4500,pendingCents:500,method:'custom',canEdit:false,editReason:'Only the payer can edit.'};
assert(validRepayment(details));
for(const patch of [{grossCents:10001},{settledCents:-1},{outstandingCents:4501},{pendingCents:4501},{pendingCents:.5},{version:0},{version:NaN},{payerShareCents:Number.MAX_SAFE_INTEGER+1},{direction:'other'},{method:'unknown'},{accounting:'unknown'},{canEdit:'yes'},{editReason:undefined}])assert.equal(validRepayment({...details,...patch}),false,JSON.stringify(patch));
const row={id:'2026-10:context',month:'2026-10',date:'2026-10-01',title:'Purchase',location:'Target',person:'Brian',kind:'expense',category:'shopping',categoryLabel:'Shopping',fields:{},amountCents:10000,displayAmountCents:1000,contextOnly:true,repayment:details};
assert.equal(displayedAmount(row),1000);assert.equal(accountedAmount(row),0);assert.equal(accountedAmount({...row,contextOnly:false}),1000);assert.equal(accountedAmount({...row,contextOnly:false,displayAmountCents:undefined}),10000);
const groups=recordedDays([row],[],'2026-10');assert.equal(groups[0].entries[0].amount,10);assert.equal(groups[0].total,0,'Purchase context never enters fallback day totals');
assert.equal(repaymentLabel(row),'Custom split');
console.log('PASS repayment validation, confirmed cash, context totals and split labels');
