// Hold a real registered page refresh across app exit and a background fold.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const snapshot=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_REFINEMENT_FIXTURE,'utf8')).initial;
const transactions={items:Array.from({length:24},(_,i)=>({id:'row-'+i,actionId:'row-'+i,version:'v1',month:'2026-10',date:'2026-10-10',title:'Expense '+i,location:'Store',person:'Brian',kind:'expense',category:'shopping',categoryLabel:'Shopping',amountCents:1000,fields:{},editableFields:[],capabilities:{},reasons:{}})),total:24,nextOffset:null,categories:[],persons:[],month:'2026-10'};
(async()=>{let count=0;for(const engine of engines){const browser=await engine.launch({headless:true});try{for(const tab of ['Transactions','Shared']){
 let hold=false,release;
 const {page,errors,unexpected}=await fixture(browser,382,657,true,false,false,0,{request:async route=>{
  const url=new URL(route.request().url());if(!['/app/transactions','/app/reimbursements'].includes(url.pathname))return false;
  assert.equal(route.request().method(),'GET');if(hold&&url.pathname===(tab==='Shared'?'/app/reimbursements':'/app/transactions')&&!url.searchParams.has('snapshot')){hold=false;await new Promise(resolve=>release=resolve)}
  await route.fulfill({json:url.pathname==='/app/transactions'?transactions:snapshot});return true;
 }});
 try{
  await tap(page,page.getByRole('button',{name:tab,exact:true}));await page.locator(tab==='Shared'?'.sr-row-main':'.bb-daily-day-group').first().waitFor();await page.waitForTimeout(400);hold=true;
  await page.evaluate(()=>{const target=document.querySelector('.bb-report-header'),point=y=>({identifier:91,target,clientX:20,clientY:y});for(const [type,y]of [['touchstart',100],['touchmove',400],['touchend',400]]){const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{touches:{value:type==='touchend'?[]:[point(y)]},changedTouches:{value:[point(y)]}});target.dispatchEvent(event)}});
  await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh-space')?.dataset.phase==='refreshing');assert(release,'The real page refresh is held');
  assert.equal(await page.locator('.bb-pull-refresh-space').evaluate(el=>el.getBoundingClientRect().height),64);
  await page.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'))});
  await page.setViewportSize({width:951,height:669});await page.waitForTimeout(100);
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))});await page.waitForTimeout(400);
  assert.equal(await page.locator('.bb-pull-refresh-space').count(),0,'Open DUO removes the pull surface and its listeners');
  release();await page.waitForTimeout(500);assert.equal(await page.locator('.bb-pull-refresh-space').count(),0,'The late response cannot revive compact pull feedback');assert.equal(await page.locator('.bb-shell-masthead').evaluate(el=>el.getBoundingClientRect().top),0);
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);count++;console.log('PASS pending refresh, app exit and background fold',engine.name(),tab);
 }finally{release?.();await page.close()}
 }}finally{await browser.close()}}console.log(count+' native interrupted-refresh cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
