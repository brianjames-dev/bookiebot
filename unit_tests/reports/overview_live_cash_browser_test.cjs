// Both accounts consume real canonical SQL phases; report responses stay frozen.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const phases=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_OVERVIEW_FIXTURE,'utf8'));
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
const out='/private/tmp/bookiebot-overview-shots';fs.mkdirSync(out,{recursive:true});
(async()=>{let cases=0;for(const engine of engines){const browser=await engine.launch({headless:true});try{for(const owner of ['brian','hannah'])for(const [width,height,dark]of [[382,657,true],[951,669,false]]){
 let phase='initial',reads=0,comparisonReads=0;const base=phases.initial.reports[owner];
 const f=await fixture(browser,width,height,dark,false,false,0,{config:{ownerName:owner==='brian'?'Brian':'Hannah'},months:{currentMonth:'2026-11',months:[{value:'2026-10',label:'October 2026'},{value:'2026-11',label:'November 2026'}],coverage:{status:'complete',unavailableYears:[]}},init:page=>page.addInitScript(owner=>{const started=Date.now();Date.now=()=>started;localStorage.setItem('bookiebot:duo-layout:'+owner,'true');localStorage.setItem('bookiebot-report-view:v1:'+owner,JSON.stringify({version:1,mode:'current',chartId:'category'}))},owner),request:async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.pathname==='/app/expenses/data'){reads++;await route.fulfill({json:base});return true}
  if(url.pathname==='/app/reimbursements'){assert.equal(request.method(),'GET');await route.fulfill({json:phases[phase].snapshots[owner]});return true}
  if(url.pathname==='/app/expenses/comparison'){comparisonReads++;const mode=url.searchParams.get('mode')||'current';await route.fulfill({json:{selectedMonth:'2026-11',baselineMonth:'2026-10',baselineKind:'previous-month',mode,throughDay:17,shortMonthAdjusted:false,selected:{spending:phases.initial.comparison[owner][mode],complete:false,reimbursementBasis:base.reimbursementBasis},baseline:{spending:1000,complete:false},changeAmount:phases.initial.comparison[owner][mode]-1000,changePercent:0,status:'partial',coverageNote:'Isolated canonical comparison'}});return true}
  return false;
 }});
 const {page,errors,unexpected}=f,tag=engine.name()+'-'+owner+'-'+width;
 const metric=page.locator('.bb-metric-card').filter({has:page.locator('.bb-metric-label',{hasText:'Spent'})}).locator('.bb-metric-value .bb-fitted-amount-text');
 const readLedger=async()=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/app/reimbursements',{timeout:5000});await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await response;await page.waitForTimeout(120)};
 const check=async mode=>{await tap(page,page.getByRole('button',{name:mode==='current'?'Current':'Projected',exact:true}));const expected=phases[phase].reports[owner].modeViews[mode].metrics.totalExpenses;await page.waitForFunction(({expected})=>{const c=[...document.querySelectorAll('.bb-metric-card')].find(el=>el.querySelector('.bb-metric-label')?.textContent.includes('Spent'));return c?.querySelector('.bb-metric-value .bb-fitted-amount-text')?.textContent.replace(/\s/g,'')===expected.replace(/\s/g,'')},{expected:money(expected)});assert.equal((await metric.innerText()).replace(/\s/g,''),money(expected));};
 try{
  await tap(page,page.getByRole('button',{name:'Shared',exact:true}));await page.locator('.sr-balance-first').waitFor();await page.waitForTimeout(200);await tap(page,page.getByRole('button',{name:'Overview',exact:true}));
  for(const next of ['initial','payment','paymentUndo','offset','offsetUndo','billPayment','billUndo','reset','resetUndo']){
   phase=next;await readLedger();
   await check('current');await check('projected');
   if(next==='billPayment'){await page.setViewportSize({width:width<800?951:382,height:width<800?669:657});await page.waitForTimeout(350);await check('projected');await page.setViewportSize({width,height});await page.waitForTimeout(350);await page.screenshot({path:out+'/'+tag+'-live.png'})}
  }
  await tap(page,page.getByRole('button',{name:'Compare spending',exact:false}));await page.locator('.bb-comparison-amount').first().waitFor();const requests=comparisonReads;
  phase='billPayment';await readLedger();await check('projected');
  await page.waitForFunction(expected=>document.querySelector('.bb-comparison-amount .bb-fitted-amount-text')?.textContent.replace(/\s/g,'')===expected,money(phases.billPayment.comparison[owner].projected));
  assert.equal(comparisonReads,requests,'Live comparison updates reuse the original request');assert.equal(reads,1,'SQL display updates never reread the frozen sheet report');assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);cases++;console.log('PASS live Overview, modes, comparison and fold',tag);
 }catch(error){await page.screenshot({path:out+'/failure-'+tag+'.png',fullPage:true});throw error}finally{await page.close()}
 }}finally{await browser.close()}}console.log(cases+' native live Overview cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
