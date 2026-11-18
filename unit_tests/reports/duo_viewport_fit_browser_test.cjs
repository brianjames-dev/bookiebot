// Real built app + a controlled native-host model replaying the user's measured
// 867x587 viewport / 951x669 window. This verifies the recovery/state contract;
// desktop WebKit does not reproduce the iOS standalone host bug itself.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const snapshot=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_REFINEMENT_FIXTURE,'utf8')).initial;
const out='/private/tmp/bookiebot-native-viewport-fit';fs.mkdirSync(out,{recursive:true});
const wait=page=>page.waitForTimeout(500);
const row={id:'2026-10:viewport',actionId:'viewport',version:'v1',month:'2026-10',date:'2026-10-20',title:'Household supplies',location:'Target',person:'Brian',kind:'expense',category:'shopping',categoryLabel:'Shopping',amountCents:10000,split:'',fields:{date:'2026-10-20',item:'Household supplies',location:'Target',person:'Brian',amount:'100.00'},editableFields:['item','location','person','amount'],capabilities:{update:true,split:false,delete:true,move:false},reasons:{}};
async function geometry(page){return page.evaluate(()=>{
 const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [r.x,r.y,r.width,r.height]};
 return {page:box('.bb-page'),head:box('.bb-shell-masthead'),tools:box('.bb-shell-header-actions'),dock:box('.bb-navigation-pane'),height:innerHeight};
})}
(async()=>{let cases=0;for(const engine of engines){const browser=await engine.launch({headless:true});try{for(const tab of ['Overview','Transactions','Shared']){
 let recovered=false,armed=false;
 const {page,errors,unexpected}=await fixture(browser,867,669,true,false,false,0,{
  init:async page=>{
   await page.exposeFunction('__nativeFitRestored',async()=>{if(armed){armed=false;await page.setViewportSize({width:867,height:669});recovered=true}});
   await page.addInitScript(()=>{
    Object.defineProperty(navigator,'standalone',{configurable:true,value:true});
    Object.defineProperty(window,'outerWidth',{get:()=>951});Object.defineProperty(window,'outerHeight',{get:()=>669});
    // The user's Screen API stayed on the closed display. It is diagnostic
    // evidence only, and must not become the app's canvas height/width.
    Object.defineProperty(window,'screen',{value:{width:457,height:678,availWidth:457,availHeight:678,orientation:{type:'landscape-secondary',angle:270}}});
   });
  },
  transactions:async route=>{assert.equal(route.request().method(),'GET','No financial writes');await route.fulfill({json:{items:[row],total:1,nextOffset:null,categories:['shopping'],persons:['Brian'],month:'2026-10',snapshotVersion:'v1'}})},
  request:async route=>{if(new URL(route.request().url()).pathname!=='/app/reimbursements')return false;assert.equal(route.request().method(),'GET');await route.fulfill({json:snapshot});return true},
 });
 try{
  await tap(page,page.getByRole('button',{name:tab,exact:true}));await wait(page);
  if(tab==='Transactions'){
   await page.getByRole('button',{name:'Show actions for Target',exact:true}).click();await wait(page);
   await page.getByRole('button',{name:'Edit Target',exact:true}).click();await wait(page);
   await page.getByRole('textbox',{name:'Amount',exact:true}).fill('94.00');await page.getByRole('textbox',{name:'Amount',exact:true}).blur();
  }
  const before=await geometry(page);
  await page.evaluate(()=>{
   window.__fitCanvas=document.querySelector('.bb-page');window.__fitInput=document.querySelector('input[aria-label="Amount"]');window.__fitChanges=[];window.__fitSawPaint=false;
   const meta=document.querySelector('meta[name="viewport"]');window.__fitOriginal=meta.content;
   new MutationObserver(()=>{
    window.__fitChanges.push(meta.content);
    if(meta.content.includes('viewport-fit=auto'))requestAnimationFrame(()=>{window.__fitSawPaint=true});
    if(meta.content===window.__fitOriginal&&window.__fitChanges.length>=2){if(!window.__fitSawPaint)throw Error('Native fit did not survive a frame');void window.__nativeFitRestored()}
   }).observe(meta,{attributes:true,attributeFilter:['content']});
   Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.setViewportSize({width:867,height:587});armed=true;
  const firstFit=await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));return document.querySelector('meta[name="viewport"]').content});
  assert(firstFit.includes('viewport-fit=auto'),'Begin native recovery before yielding the foreground event to a paint/timer on '+tab);
  await page.waitForFunction(()=>window.__fitChanges.length===2);for(let i=0;!recovered&&i<20;i++)await page.waitForTimeout(50);assert(recovered,JSON.stringify({errors,state:await page.evaluate(()=>({changes:window.__fitChanges,sawPaint:window.__fitSawPaint,content:document.querySelector('meta[name="viewport"]').content}))}));
  await wait(page);assert.deepEqual(await geometry(page),before,'Reclaim the lost height without changing normal chrome on '+tab);
  const state=await page.evaluate(()=>({same:window.__fitCanvas===document.querySelector('.bb-page'),inputSame:!window.__fitInput||window.__fitInput===document.querySelector('input[aria-label="Amount"]'),content:document.querySelector('meta[name="viewport"]').content,original:window.__fitOriginal,changes:window.__fitChanges.length,scroll:document.querySelector('.bb-page').scrollTop}));
  assert(state.same&&state.inputSame,'Retain the canvas and editor DOM');assert.equal(state.content,state.original);assert.equal(state.changes,2);assert.equal(state.scroll,0);
  if(tab==='Transactions')assert.equal(await page.getByRole('textbox',{name:'Amount',exact:true}).inputValue(),'94.00','Retain unsaved editor draft');
  // A subsequent healthy return must neither flash nor reparse the viewport.
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'))});await wait(page);
  assert.equal(await page.evaluate(()=>window.__fitChanges.length),2);
  await page.screenshot({path:out+'/'+engine.name()+'-'+tab+'.png'});assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);cases++;console.log('PASS native-fit dimensions, committed reset, retained draft and healthy return',engine.name(),tab);
 }catch(error){await page.screenshot({path:out+'/failure-'+engine.name()+'-'+tab+'.png',fullPage:true});throw error}finally{await page.close()}
 }}finally{await browser.close()}}console.log(cases+' built-app native-fit contract cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
