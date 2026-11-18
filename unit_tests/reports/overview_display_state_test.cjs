const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../../web/expense-report'),req=createRequire(root+'/package.json'),ts=req('typescript'),modules=new Map();
function load(file){if(modules.has(file))return modules.get(file);const exports={};modules.set(file,exports);let source=fs.readFileSync(file,'utf8');

 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>name.startsWith('.')?load([path.resolve(path.dirname(file),name)+'.ts',path.resolve(path.dirname(file),name)+'.tsx'].find(fs.existsSync)):req(name),Date,Intl});return exports}
const {displayOverview,overviewComparisonDelta}=load(root+'/src/overview-display-state.ts'),{pendingDisplay}=load(root+'/src/reimbursement-display-state.ts');
const fixtures=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_OVERVIEW_FIXTURE,'utf8')),plain=x=>JSON.parse(JSON.stringify(x)),sort=a=>plain(a).sort((a,b)=>(a.key??a.canonicalCashId??a.label??'').localeCompare(b.key??b.canonicalCashId??b.label??''));
for(const owner of ['brian','hannah'])for(const [name,phase]of Object.entries(fixtures)){
 const snapshot=pendingDisplay(phase.snapshots[owner]),expected=phase.reports[owner];
 for(const baselineName of ['initial','payment','offset','billPayment']){
  const base=fixtures[baselineName].reports[owner];
  // An older snapshot deliberately keeps the newer report's validated basis.
  if(Object.entries(base.reimbursementBasis.versions).some(([id,v])=>snapshot.allocations.find(a=>a.id===id)?.version<v)){
   const shown=displayOverview(base,snapshot);
   assert.deepEqual(plain(shown.modeViews),plain(base.modeViews),'An older SQL read must not roll a newer report backward');
   continue;
  }
  const unchanged=JSON.stringify(base),shown=displayOverview(base,snapshot),tag=owner+' '+baselineName+' -> '+name;
  assert.equal(JSON.stringify(base),unchanged,'Read projection cannot mutate its input');
  for(const mode of ['current','projected']){
   assert.deepEqual(plain(shown.modeViews[mode].metrics),expected.modeViews[mode].metrics,tag+' '+mode+' metrics');
   assert.deepEqual(plain(shown.modeViews[mode].categoryBalances),expected.modeViews[mode].categoryBalances,tag+' '+mode+' balances');
   assert.deepEqual(sort(shown.modeViews[mode].breakdown),sort(expected.modeViews[mode].breakdown),tag+' '+mode+' mix');
   assert.deepEqual(plain(shown.modeViews[mode].burnRate),expected.modeViews[mode].burnRate,tag+' '+mode+' burn');
   const comparisonDelta=overviewComparisonDelta(base.reimbursementBasis,snapshot,mode,17);
   if(phase.comparison)assert.equal(Math.round((fixtures[baselineName].comparison[owner][mode]+comparisonDelta)*100),Math.round(phase.comparison[owner][mode]*100),tag+' '+mode+' month comparison');
  }
  assert.deepEqual(plain(shown.utilityHistory),expected.utilityHistory,tag+' utility history');assert.deepEqual(plain(shown.billComparisonHistory),expected.billComparisonHistory,tag+' bill history');
  assert.deepEqual(sort(shown.calendarEvents),sort(expected.calendarEvents),tag+' calendar');
  assert.deepEqual(sort(shown.dailyEntries),sort(expected.dailyEntries),tag+' activity');
  assert.deepEqual(plain(shown.metrics),expected.metrics,tag+' top-level totals');
  assert.deepEqual(plain(displayOverview(shown,snapshot).metrics),plain(shown.metrics),tag+' repeated projection is idempotent');
  assert.equal(shown.metrics.amountSaved,base.metrics.amountSaved,'Repayment is not a savings transfer');
 }
 const mismatch=displayOverview(expected,{...snapshot,ownerKey:'another-household'});assert.equal(mismatch,expected);
}
console.log('Both-owner Overview cash, Current/Projected totals, category cascade, burn series, Calendar, activity, comparison and immutable/idempotent display passed');
