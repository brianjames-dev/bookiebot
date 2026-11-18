// Real list scroll owners, retained rows/editors and app-switch/fold lifecycles.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const base=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_REFINEMENT_FIXTURE,'utf8')).initial;
const state={...base,events:[],resets:[],undoJobs:[],projectionPending:false,allocations:Array.from({length:40},(_,i)=>({...base.allocations[0],id:'scroll-'+i,item:'Expense '+String(i).padStart(2,'0'),expenseDate:'2026-10-10',grossCents:2000,payerShareCents:1000,partnerShareCents:1000,settledCents:0,clearedCents:0,outstandingCents:1000,status:'outstanding',method:'equal'}))};
const out='/private/tmp/bookiebot-scrolled-canvas';fs.mkdirSync(out,{recursive:true});
const pause=page=>page.waitForTimeout(450);
async function remember(page,wide){return page.evaluate(wide=>{
 const page=document.querySelector('.bb-page'),shared=page.dataset.screen==='shared',list=page.querySelector(shared?'.sr-list':'.bb-recorded-results'),port=wide?list:page,top=port.getBoundingClientRect().top;
 const row=[...list.querySelectorAll(shared?'.sr-row-group':'.bb-daily-day-group')].find(el=>el.getBoundingClientRect().bottom>top+1);
 window.__visibleFoldRow=row;window.__foldOffset=row.getBoundingClientRect().top-top;
 return {text:row.textContent,offset:window.__foldOffset,y:port.scrollTop};
 },wide)}
async function checkAnchor(page,wide){const result=await page.evaluate(wide=>{const p=document.querySelector('.bb-page'),list=p.querySelector(p.dataset.screen==='shared'?'.sr-list':'.bb-recorded-results'),port=wide?list:p;return {connected:window.__visibleFoldRow.isConnected,offset:window.__visibleFoldRow.getBoundingClientRect().top-port.getBoundingClientRect().top,expected:window.__foldOffset}},wide);assert(result.connected);assert(Math.abs(result.offset-result.expected)<2,JSON.stringify(result));}
(async()=>{let count=0;for(const engine of engines){const browser=await engine.launch({headless:true});try{for(const tab of ['Transactions','Shared'])for(const [width,height]of [[951,669],[867,480]]){
 const f=await fixture(browser,382,657,true,false,false,0,{request:async route=>{if(new URL(route.request().url()).pathname!=='/app/reimbursements')return false;assert.equal(route.request().method(),'GET');await route.fulfill({json:state});return true}});
 const {page,errors,unexpected}=f,tag=engine.name()+'-'+tab+'-'+width+'-'+height,list=page.locator(tab==='Shared'?'.sr-list':'.bb-recorded-results');
 try{
  await tap(page,page.getByRole('button',{name:tab,exact:true}));await list.waitFor();await pause(page);
  await page.locator('.bb-page').evaluate(el=>el.scrollTop=1000);await pause(page);await remember(page,false);
  await page.setViewportSize({width,height});await pause(page);await checkAnchor(page,true);
  const frame=await page.locator('.bb-page').evaluate(el=>{el.scrollTop=2000;return {y:el.scrollTop,head:el.querySelector('.bb-shell-masthead').getBoundingClientRect().top,overflow:getComputedStyle(el).overflow}});
  assert.equal(frame.y,0,'Open canvas cannot retain a second scroll position');assert.equal(frame.head,0);assert.equal(frame.overflow,'clip');
  await list.evaluate(el=>el.scrollTop=800);await pause(page);await remember(page,true);
  await page.setViewportSize({width:382,height:657});await pause(page);await checkAnchor(page,false);
  await page.setViewportSize({width,height});await pause(page);await checkAnchor(page,true);
  await page.evaluate(()=>{window.__motionStops=0;new MutationObserver(records=>{window.__motionStops+=records.filter(r=>r.oldValue?.includes('overflow: clip')).length}).observe(document.querySelector('.bb-page'),{attributes:true,attributeFilter:['style'],attributeOldValue:true,subtree:true});window.dispatchEvent(new Event('pagehide'));Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'))});
  await page.setViewportSize({width:382,height:657});await pause(page);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))});await pause(page);await checkAnchor(page,false);
  await page.setViewportSize({width,height});await pause(page);await checkAnchor(page,true);
  assert(await page.evaluate(()=>window.__motionStops)>0,'Resume cancels the actual scroll surface’s retained motion');
  const nav=await page.locator('.bb-navigation-pane').boundingBox();assert(nav.y+nav.height<=height&&nav.y+nav.height>=height-70);assert.equal(await page.locator('.bb-page').evaluate(el=>el.scrollTop),0);
  await page.screenshot({path:out+'/'+tag+'.png'});assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);count++;console.log('PASS scrolled rows, locked canvas, background fold and motion recovery',tag);
 }catch(error){await page.screenshot({path:out+'/failure-'+tag+'.png',fullPage:true});throw error}finally{await page.close()}
 }}finally{await browser.close()}}console.log(count+' native scrolled-canvas cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
