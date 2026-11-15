const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json')),ts=req('typescript');let serial=0;
const load=file=>{const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:req,Intl,Date,JSON,Error,structuredClone,crypto:{randomUUID:()=>`flow-command-${++serial}-123456`}});return exports};
const {billFlow,runBillFlow}=load('web/expense-report/src/bill-save-flow.ts'),{billReviewLines,currentReviewLines}=load('web/expense-report/src/bill-review.ts');
const clone=v=>JSON.parse(JSON.stringify(v));
const source={id:'2026-11:source',version:'v1',month:'2026-11',date:'2026-11-01',billPlanId:'loan',title:'Loan',amountCents:6000,fields:{amount:'60.00'},split:'',splitOptions:{payerCents:6000},capabilities:{update:true,split:true,cancel_split:true},reasons:{}};
const current={id:'loan',month:'2026-11',source,adopt:false,amountChanged:true,splitChanged:true,blockedReason:'',target:{amountCents:9000,method:'custom',payerCents:4321,partnerCents:4679,payerName:'Brian',partnerName:'Hannah'}};
const configuration={operation:'update',id:'loan',reviewVersion:'base-review',requestId:'base-confirmation-123456',applyCurrentCharge:true};
function server(change=current){
 const state={row:clone(change.source),virtual:change.adopt,reads:[],writes:[],saved:new Map(),lose:'',before:'',reject:false,shareDrift:false};
 if(change.adopt)state.row={...state.row,id:'2026-11:adopted',version:'adopt-v1'};
 state.request=async(url,body)=>{
  state.reads.push({url,body:body&&clone(body)});
  if(url.includes('/commands/')){const result=state.saved.get(url.split('/').at(-1));if(!result)throw Error('No saved request exists');return clone(result)}
  if(url==='/app/bills'&&!body)return {settingsVersion:'s2',bills:[{id:'loan',charge:{virtual:state.virtual,month:'2026-11',date:source.date,billAmountCents:6000,version:'charge-v2'}}]};
  if(url.includes('/charge?'))return {item:clone(state.row)};
  if(url==='/app/bills/review')return {review:{reviewVersion:'adopt-review',amountCents:6000,date:source.date,share:{method:'none'}}};
  if(url==='/app/transactions/review')return {review:{reviewVersion:'review-'+state.row.version,item:clone(state.row),after:{amount:((body.updates?.amount??state.row.amountCents)/100).toFixed(2)},share:body.operation==='split'?{method:body.method,payerCents:state.shareDrift?4322:change.target.payerCents,partnerCents:state.shareDrift?4678:change.target.partnerCents}:undefined}};
  if(state.before===body.operation){state.before='';throw Error('lost before writer')}
  const existing=state.saved.get(body.requestId);if(existing)return clone(existing);
  state.writes.push({url,body:clone(body)});
  const result=state.reject?{state:'done',success:false,detail:'Source guard rejected'}:{state:'done',success:true,...(url==='/app/bills'&&body.operation==='update'?{currentChange:change}:{} )};
  if(!state.reject){
   if(body.operation==='adopt')state.virtual=false;
   if(url==='/app/transactions'){
    if(body.operation==='update')state.row.amountCents=body.updates.amount;
    else{state.row.split=body.operation==='cancel_split'?'':body.method;state.row.splitOptions.payerCents=body.operation==='cancel_split'?state.row.amountCents:body.payerShareCents??change.target.payerCents;if(body.operation==='cancel_split')delete state.row.repayment;else state.row.repayment??={id:'new-allocation',direction:'incoming',accounting:'cash_v1',settledCents:0,clearedCents:0,pendingCents:0};}
    state.row.version+='-next';
   }
  }
  state.saved.set(body.requestId,clone(result));
  if(state.lose===body.operation){state.lose='';throw Error('lost acknowledgement')}
  return result;
 };return state;
}
(async()=>{
 let count=0;
 {
  const state=server(),flow=billFlow(configuration,current),snapshots=[];
  await runBillFlow(flow,state.request,s=>snapshots.push(clone(s)));
  assert.equal(flow.stage,'done');assert.equal(state.writes.length,3);assert.deepEqual(state.writes.map(w=>w.body.operation),['update','update','split']);
  assert.equal(state.writes[0].body.requestId,configuration.requestId);assert.equal(state.row.splitOptions.payerCents,4321);
  assert(snapshots.some(s=>s.pending?.body.operation==='split'&&!s.pending.result),'Every exact canonical confirmation persists before POST');count++;
 }
 {
  const state=server(),flow=billFlow({...configuration,applyCurrentCharge:false});await runBillFlow(flow,state.request,()=>{});
  assert.equal(state.writes.length,1);assert(!state.reads.some(r=>r.url.includes('/charge?')),'No-op/type-only future rules have no charge detour');count++;
 }
 for(const operation of ['update','split']){
  const state=server();state.lose=operation;let stored;
  const flow=billFlow(undefined,current);await assert.rejects(runBillFlow(flow,state.request,s=>stored=clone(s)),/lost acknowledgement/);
  const id=stored.pending.body.requestId;await runBillFlow(stored,state.request,s=>stored=clone(s),{recover:true});
  assert.equal(stored.stage,'done');assert.equal(state.writes.filter(w=>w.body.requestId===id).length,1);assert(state.reads.some(r=>r.url.endsWith('/commands/'+id)));count++;
 }
 {
  const state=server(),original=state.request;let reads=0,stored;state.request=async(url,body)=>{if(url.includes('/charge?')&&++reads===2)throw Error('temporary read failure');return original(url,body)};
  await assert.rejects(runBillFlow(billFlow(undefined,current),state.request,s=>stored=clone(s)),/temporary read failure/);assert(stored.pending.result.success,'The amount receipt is persisted before the failed read');
  await runBillFlow(stored,state.request,s=>stored=clone(s),{recover:true});assert.equal(stored.stage,'done');assert.equal(state.writes.length,2);assert(!state.reads.some(r=>r.url.includes('/commands/')),'A persisted result consumes recovery mode before the new split command');count++;
 }
 {
  const state=server(),original=state.request;let reads=0,stored;state.request=async(url,body)=>{if(url.includes('/charge?')&&++reads===3)throw Error('between-stage read failure');return original(url,body)};
  await assert.rejects(runBillFlow(billFlow(undefined,current),state.request,s=>stored=clone(s)),/between-stage read failure/);assert.equal(stored.stage,'split');assert(!stored.pending&&!stored.failed);
  await runBillFlow(stored,state.request,s=>stored=clone(s),{recover:true});assert.equal(stored.stage,'done');assert.equal(state.writes.length,2,'Resume continues the remaining approved split without repeating the completed amount');count++;
 }
 {
  const state=server();state.before='update';let stored;
  await assert.rejects(runBillFlow(billFlow(undefined,current),state.request,s=>stored=clone(s)),/lost before/);
  const frozen=clone(stored.pending.body);await assert.rejects(runBillFlow(stored,state.request,s=>stored=clone(s),{recover:true}),/No saved/);assert.equal(state.writes.length,0);
  await runBillFlow(stored,state.request,s=>stored=clone(s),{recover:true,retry:true});assert.deepEqual(state.writes[0].body,frozen);count++;
 }
 {
  const change={...current,adopt:true,source:{...source,id:'',version:'virtual-v1'}},state=server(change),flow=billFlow(configuration,change);
  await runBillFlow(flow,state.request,()=>{});assert.equal(flow.stage,'done');assert.equal(state.writes.filter(w=>w.body.operation==='adopt').length,1);assert.equal(state.writes.length,4);count++;
 }
 {
  const state=server(),flow=billFlow(undefined,current);state.row.amountCents=7000;
  await assert.rejects(runBillFlow(flow,state.request,()=>{}),/charge changed/);assert.equal(state.writes.length,0);count++;
 }
 {
  const original={...source,split:'equal',repayment:{id:'a',direction:'incoming',accounting:'cash_v1',settledCents:0,clearedCents:0,pendingCents:0}};
  const change={...current,source:original},state=server(change);state.row.repayment.pendingCents=100;
  await assert.rejects(runBillFlow(billFlow(undefined,change),state.request,()=>{}),/charge changed/);assert.equal(state.writes.length,0);count++;
 }
 {
  const state=server();await assert.rejects(runBillFlow(billFlow(configuration,current),state.request,()=>{throw Error('storage unavailable')}),/storage/);assert.equal(state.writes.length,0);count++;
 }
 {
  const state=server(),change={...current,amountChanged:false,source:{...source,amountCents:9000}},flow=billFlow(undefined,change);state.row.amountCents=9000;state.shareDrift=true;
  await assert.rejects(runBillFlow(flow,state.request,()=>{}),/split shares changed/);assert.equal(state.writes.length,0);count++;
 }
 {
  const state=server(),flow=billFlow(undefined,current);state.reject=true;
  await assert.rejects(runBillFlow(flow,state.request,()=>{}),/guard rejected/);assert(flow.failed);assert(!flow.pending);await assert.rejects(runBillFlow(flow,state.request,()=>{}),/guard rejected/);assert.equal(state.writes.length,1);count++;
 }
 {
  const change={...current,source:{...source,split:'custom',repayment:{id:'old',direction:'incoming',accounting:'cash_v1',settledCents:0,clearedCents:0,pendingCents:0}},amountChanged:false,target:{...current.target,amountCents:6000,method:'none',payerCents:6000,partnerCents:0}},state=server(change),flow=billFlow(undefined,change);
  await runBillFlow(flow,state.request,()=>{});assert.equal(flow.stage,'done');assert.deepEqual(state.writes.map(w=>w.body.operation),['cancel_split']);assert(!state.row.repayment);count++;
 }
 {
  const state=server(),original=state.request;state.request=async(url,body)=>{const result=await original(url,body);if(body?.operation==='split'&&url==='/app/transactions')state.row.repayment.pendingCents=1;return result};
  const flow=billFlow(undefined,current);await assert.rejects(runBillFlow(flow,state.request,()=>{}),/charge changed/);assert(flow.failed);assert.equal(state.writes.length,2,'An unexpected receipt after a completed split stops the flow without replaying it');count++;
 }
 {
  const base={name:'Service',type:'subscription',amountCents:6000,cadence:'monthly',pullDay:1,pullMonths:[],category:'static_bills_subscriptions_needs',account:'Checking',splitMethod:'none',payerBasisPoints:10000,effectiveFrom:'2026-11',active:true};
  const after={...base,name:'Utility',type:'fixed',amountCents:9000,cadence:'quarterly',pullDay:22,pullMonths:[2,5,8,11],category:'bills_utilities',account:'Savings',splitMethod:'equal'};
  const lines=clone(billReviewLines(base,after,'update'));assert.deepEqual(lines.map(l=>l.label),['Name','Type','Recurring amount','Repeats','Payment day','First billing month','Budget category','Account','Recurring split','Applies from']);
  assert(lines.some(l=>l.label==='Type'&&l.before==='Subscription'&&l.after==='Fixed bill'));assert.equal(billReviewLines(base,{...base,type:'fixed'},'update').length,2,'Unchanged fields do not dominate the review');
  assert(currentReviewLines(current).some(l=>l.label==='Recorded split'));count++;
 }
 console.log(count+' single-review flow/recovery/source/permission/storage/model cases passed');
})().catch(error=>{console.error(error);process.exitCode=1});
