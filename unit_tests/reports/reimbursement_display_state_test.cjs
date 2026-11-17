// Display-only inverses must match canonical results without changing write data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),root=path.resolve(__dirname,'../../web/expense-report'),req=createRequire(root+'/package.json'),ts=req('typescript'),modules=new Map();
function load(file){if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);const require=name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)+'.ts'):req(name);vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require});return exports}
const {inverseDisplay,applyDisplayChange,pendingDisplay,reimbursementDisplay}=load(root+'/src/reimbursement-display-state.ts');
const {displayTransaction,displayListing}=load(root+'/src/transaction-display-state.ts');
const {clearAppResources}=load(root+'/src/app-resource-state.ts');
const cases=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_QUEUED_UNDO_FIXTURE,'utf8'));
const plain=x=>JSON.parse(JSON.stringify(x)),financial=s=>s.allocations.map(({id,settledCents,clearedCents,outstandingCents,status})=>({id,settledCents,clearedCents,outstandingCents,status}));
for(const [kind,phases]of Object.entries(cases)){
 const before=JSON.stringify(phases.saved.brian),local=applyDisplayChange(phases.saved.brian,inverseDisplay(phases.saved.brian,phases.undo));
 assert.deepEqual(plain(financial(local)),financial(phases.completed.brian),kind+' paints before the HTTP response');
 assert.equal(JSON.stringify(phases.saved.brian),before,'Canonical writer data is immutable');
 for(const owner of ['brian','hannah'])assert.deepEqual(plain(financial(pendingDisplay(phases.queued[owner]))),financial(phases.completed[owner]),kind+' survives refresh for '+owner);
 const stale=structuredClone(phases.saved.brian);stale.allocations[0].version++;
 assert.equal(applyDisplayChange(stale,inverseDisplay(phases.saved.brian,phases.undo)),stale,'Stale patches cannot overwrite a changed version');
 const allocation=local.allocations[0],original=phases.saved.brian.allocations.find(a=>a.id===allocation.id);
 const row={id:'purchase',month:allocation.expenseDate.slice(0,7),date:allocation.expenseDate,category:'shopping',amountCents:allocation.grossCents,displayAmountCents:original.grossCents-original.settledCents,repayment:{...original,id:original.id},capabilities:{split:true,delete:true}};
 const shown=displayTransaction(row,local);assert.equal(shown.displayAmountCents,allocation.grossCents-allocation.settledCents);assert.equal(shown.repayment.outstandingCents,allocation.outstandingCents);assert.equal(shown.capabilities.split,false);
 const listing={items:[row],total:1,nextOffset:null,totalAmountCents:row.displayAmountCents,days:[{date:row.date,month:row.month,totalCents:row.displayAmountCents,needsCents:0,wantsCents:row.displayAmountCents,count:1}]};
 const view=displayListing(listing,local);assert.equal(view.totalAmountCents,shown.displayAmountCents);assert.equal(view.days[0].wantsCents,shown.displayAmountCents);assert.equal(view.items.length,1);
 if(kind==='payment'){
  const event=phases.saved.brian.events.find(e=>e.status==='confirmed');
  const receipt={...row,id:'receipt',canonicalAllocationId:allocation.id,canonicalEventId:event.id,repayment:undefined,amountCents:event.amountCents,displayAmountCents:event.amountCents};
  assert.equal(displayTransaction({...receipt,canonicalEventId:'newer-unknown'},local).displayAmountCents,receipt.amountCents,'An older resource cannot remove a new receipt it has not seen')
  assert.equal(displayTransaction(receipt,local),null,'Only the exact reversed receipt disappears');
  const filtered={...listing,items:[row],repaymentRows:[{id:receipt.id,allocationId:allocation.id,eventId:event.id,cashKind:'receipt',date:receipt.date,month:receipt.month,category:'shopping',amountCents:receipt.amountCents,index:10}],repaymentListRows:[]};
  assert.equal(displayListing(filtered,local).total,1,'Graph-window removals cannot change a different day-filter count');
 }
 const legacy={...local,allocations:local.allocations.map(a=>({...a,accounting:'legacy_net'}))};assert.equal(displayTransaction(row,legacy),row,'Legacy net cash cannot be recalculated as gross less repayments')
 const newer={...row,repayment:{...row.repayment,version:allocation.version+1}};assert.equal(displayTransaction(newer,local),newer,'An older shared snapshot never rolls back a newer transaction revision');
}
let updates=0;const stop=reimbursementDisplay.subscribe('Brian',()=>updates++);reimbursementDisplay.publish('brian',cases.payment.saved.brian);assert.equal(updates,1);assert.equal(reimbursementDisplay.read('Brian'),cases.payment.saved.brian);assert.equal(reimbursementDisplay.read('Hannah'),null);clearAppResources();assert.equal(updates,2);assert.equal(reimbursementDisplay.read('brian'),null);stop();
console.log('Immediate, durable, cross-tab display inverses, graph totals, pagination, guards and owner cleanup passed');
