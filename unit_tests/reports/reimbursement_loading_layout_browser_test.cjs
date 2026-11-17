// Fast display reads, complete active rows and compact utilities in shipped UI.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const data=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_SHARED_BALANCE_FIXTURE,'utf8'));
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-reimbursements-loading-shots';fs.mkdirSync(output,{recursive:true});
async function press(page,node){await node.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await node.waitFor({state:'visible'});await page.waitForFunction(el=>!el.disabled&&!el.closest('[inert]'),await node.elementHandle());await node.press('Enter');await page.waitForTimeout(500)}
const visible=node=>node.filter({visible:true});
(async()=>{let count=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{for(const [width,height,dark,reduced]of [[382,657,false,false],[867,480,true,false],[382,657,true,true],[951,648,false,false]].filter(([w])=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
  const state=structuredClone(data.initial.brian),seed=state.allocations.find(a=>a.id==='pge'),current=seed.expenseDate.slice(0,7),writes=[];
  for(let i=0;i<18;i++)state.allocations.push({...seed,id:'extra-'+i,item:'Active extra '+i,location:'',expenseDate:i<12?current+'-01':`2026-${String(i-11).padStart(2,'0')}-01`});
  for(let i=0;i<9;i++)state.allocations.push({...seed,id:'settled-'+i,item:'Older settled '+i,expenseDate:`2025-${String(i+1).padStart(2,'0')}-01`,settledCents:seed.partnerShareCents,outstandingCents:0,status:'settled'});
  seed.projectedVersion=seed.version-1;state.projectionPending=true;
  const expected=state.allocations.filter(a=>a.outstandingCents>0).length;
  let displayReads=0,recoveries=0,release,failDisplay=false,holdRecovery=true;
  const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{request:async route=>{
   const req=route.request(),url=new URL(req.url());if(url.pathname!=='/app/reimbursements')return false;
   if(req.method()!=='GET'){writes.push(req.postDataJSON());throw Error('No financial writes in loading/layout checks')}
   if(url.searchParams.get('snapshot')==='1'){displayReads++;if(failDisplay){await route.fulfill({status:503,json:{error:'Isolated display read failed'}});return true;}}
   else{recoveries++;if(holdRecovery)await new Promise(resolve=>release=resolve);else{state.projectionPending=false;seed.projectedVersion=seed.version;}}
   await route.fulfill({json:state});return true;
  }});
  try{
   await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
   await tap(page,page.getByRole('button',{name:'Shared',exact:true}));
   assert(displayReads>=1,'The initial display uses a fast SQL-only snapshot');
   const rows=page.locator('.sr-row-main');await rows.first().waitFor();assert.equal(await rows.count(),expected,'All active expenses across every month appear together');
   await page.waitForFunction(()=>document.querySelector('.sr-balance-first')?.dataset.refreshing==='true');assert.equal(recoveries,1,'Pending projection starts one recovery after display');
   assert.equal(await page.locator('.sr-detail-native').count(),0,'Never-opened editors are not built during list loading');
   assert(await rows.evaluateAll(nodes=>nodes.every(el=>!el.disabled&&getComputedStyle(el).opacity==='1')),'Readable rows stay full color and selectable during background verification');
   assert.equal(await page.getByRole('button',{name:/Load all (expenses|months)/}).count(),0);
   const extra=rows.filter({hasText:'Active extra 0'});await press(page,extra);
   let detail=page.locator('.sr-detail-host[data-open=true]');assert.equal(await detail.getByRole('button',{name:'Record received',exact:true}).isDisabled(),true,'Financial actions wait for the read');
   await press(page,extra);assert.equal(await page.locator('.sr-detail-native').count(),1,'The first visited editor is retained instead of rebuilding every row');
   release();await page.waitForFunction(()=>document.querySelector('.sr-balance-first')?.dataset.refreshing==='false');assert.equal(recoveries,1);
   await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(200);assert.equal(recoveries,1,'The same pending revision cannot repeat automatic Sheets recovery');
   holdRecovery=false;await press(page,page.getByRole('button',{name:'Refresh',exact:true}));assert.equal(recoveries,2,'Explicit recovery retains the existing full-read endpoint');
   await page.waitForFunction(()=>document.querySelector('.sr-balance-first')?.dataset.refreshing==='false');assert.equal(await rows.count(),expected);
   const tools=page.locator('.sr-summary-tools'),history=tools.getByRole('button',{name:'History',exact:true}),more=tools.getByRole('button',{name:'More options',exact:true});
   const h=await history.boundingBox(),m=await more.boundingBox();assert(Math.abs(h.y-m.y)<1&&m.x-h.x-h.width<=9,'History and More options share one compact native toolbar');
   if(width<800){await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(100);const title=await page.locator('.bb-report-header h1').boundingBox(),hero=await page.locator('.sr-hero>.sr-eyebrow').boundingBox();assert(hero.y-title.y-title.height>=-1&&hero.y-title.y-title.height<=16,'Balance begins close to the main title without overlap');}
   else{const pane=await page.locator('.sr-right').boundingBox(),hero=await page.locator('.sr-hero>.sr-eyebrow').boundingBox(),nav=await page.locator('.bb-navigation-pane').boundingBox();assert(hero.y-pane.y<=5,'No extra top gap in the open balance pane');assert(m.y+m.height<nav.y-4,'Utilities fit above the glass nav');}
   await press(page,more);assert.equal(await more.getAttribute('aria-expanded'),'true');await page.getByRole('button',{name:'Reset balances',exact:true}).waitFor();assert.equal(writes.length,0);await press(page,more);
   await press(page,history);assert.equal(await tools.getByRole('button',{name:'Back',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Load all months',exact:true}).count(),1,'Older settled history remains intentionally paged');await press(page,tools.getByRole('button',{name:'Back',exact:true}));
   await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${dark?'dark':'light'}-summary.png`)});
   await press(page,extra);detail=page.locator('.sr-detail-host[data-open=true]');await press(page,detail.getByRole('button',{name:'Record received',exact:true}));
   await visible(detail.locator('input[inputmode=decimal]')).fill('12.34');await visible(detail.locator('input[maxlength="200"]')).fill('Keep this draft');
   await page.setViewportSize({width:width>800?382:867,height:width>800?657:480});await page.waitForTimeout(500);assert.equal(await visible(detail.locator('input[inputmode=decimal]')).inputValue(),'12.34');await page.setViewportSize({width,height});await page.waitForTimeout(500);
   await press(page,extra);await press(page,extra);assert.equal(await visible(detail.locator('input[maxlength="200"]')).inputValue(),'Keep this draft');
   await press(page,detail.getByRole('button',{name:'Cancel',exact:true}));await press(page,extra);
   failDisplay=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByRole('alert').waitFor();assert.equal(await rows.count(),expected,'A failed refresh retains every previously loaded active expense');
   failDisplay=false;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(300);assert.equal(await page.getByRole('alert').count(),0);assert.equal(recoveries,2);assert.equal(writes.length,0);
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);count++;console.log('PASS fast reimbursement snapshot/full active list/compact tools/lazy drafts/recovery',engine.name(),width,dark,reduced);
  }catch(e){await page.screenshot({path:path.join(output,'failure.png')});throw e}finally{if(release)release();await page.close()}
 }}finally{await browser.close()}
}console.log(count+' reimbursement loading/layout cases passed; screenshots '+output)})().catch(e=>{console.error(e);process.exitCode=1});
