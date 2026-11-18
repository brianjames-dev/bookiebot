// Retained app resume: visibility only, same document/editor, late scroll-only
// viewport events. Desktop engines cannot recreate iOS's native stale origin;
// observe the in-place fixed-box reattachment and real resulting geometry.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const snapshot=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_REFINEMENT_FIXTURE,'utf8')).initial;
const out='/private/tmp/bookiebot-retained-foreground';fs.mkdirSync(out,{recursive:true});
const settle=page=>page.waitForTimeout(400);
async function chrome(page){return page.evaluate(()=>{
 const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return [r.x,r.y,r.width,r.height]};
 return {page:box('.bb-page'),brand:box('.bb-shell-masthead'),title:box('.bb-report-header'),tools:box('.bb-shell-header-actions'),dock:box('.bb-navigation-pane')};
})}
(async()=>{let count=0;for(const engine of engines){const browser=await engine.launch({headless:true});try{for(const [width,height]of [[951,669],[382,657]]){
 const {page,errors,unexpected}=await fixture(browser,width,height,true,false,false,0,{request:async route=>{if(new URL(route.request().url()).pathname!=='/app/reimbursements')return false;assert.equal(route.request().method(),'GET');await route.fulfill({json:snapshot});return true;}});
 try{
  for(const tab of ['Overview','Transactions','Shared']){
   await tap(page,page.getByRole('button',{name:tab,exact:true}));await settle(page);
   if(tab==='Transactions'){await page.getByRole('searchbox').fill('Fixture');await page.getByRole('searchbox').blur()}
   const reference=await chrome(page);
   await page.evaluate(()=>{
    const canvas=document.querySelector('.bb-page');window.__retainedCanvas=canvas;
    window.__retainedSearch=canvas.querySelector('input[type=search]');window.__positionChanges=[];
    window.__positionObserver=new MutationObserver(records=>{window.__positionChanges.push(...records.map(record=>record.oldValue))});
    window.__positionObserver.observe(canvas,{attributes:true,attributeFilter:['style'],attributeOldValue:true});
    window.__lifecycle=[];window.__onShow=()=>window.__lifecycle.push('pageshow');window.__onHide=()=>window.__lifecycle.push('pagehide');
    window.addEventListener('pageshow',window.__onShow);window.addEventListener('pagehide',window.__onHide);
    Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));
   });await page.waitForTimeout(80);
   await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'))});await settle(page);
   assert.deepEqual(await chrome(page),reference,'Foreground return keeps full viewport geometry in '+tab);
   assert(await page.evaluate(()=>window.__positionChanges.some(style=>style?.includes('position: absolute'))),'The actual fixed positioning box is rebuilt even with zero reported offsets');
   assert(await page.evaluate(()=>window.__retainedCanvas===document.querySelector('.bb-page')),'The canvas DOM is retained');
   assert.deepEqual(await page.evaluate(()=>window.__lifecycle),[],'No page navigation/bfcache lifecycle is used');
   if(tab==='Transactions'){assert(await page.evaluate(()=>window.__retainedSearch===document.querySelector('.bb-page input[type=search]')));assert.equal(await page.getByRole('searchbox').inputValue(),'Fixture')}
   // The OS can report its restored pan after the original 300ms settle window,
   // with no resize. Replay that event, not a synthetic page reload/pageshow.
   await page.evaluate(()=>{
    const native=window.scrollTo.bind(window);window.__rootRepairs=0;
    window.scrollTo=(...args)=>{window.__rootRepairs++;window.__testVisualViewport({},'scroll');native(...args)};
    window.__testVisualViewport({offsetTop:82,offsetLeft:0},'scroll');window.__nativeScrollTo=native;
   });await settle(page);
   assert.equal(await page.evaluate(()=>window.visualViewport.offsetTop),0,'Late scroll-only pan is repaired');assert.equal(await page.evaluate(()=>window.__rootRepairs),1,'No viewport-scroll feedback loop');
   assert.deepEqual(await chrome(page),reference);
   await page.evaluate(()=>{window.scrollTo=window.__nativeScrollTo;window.__positionObserver.disconnect();window.removeEventListener('pageshow',window.__onShow);window.removeEventListener('pagehide',window.__onHide)});
   count++;console.log('PASS retained foreground, zero offsets, same DOM and late scroll-only pan',engine.name(),width,height,tab);
  }
  // Retain the current view while the phone folds in the background as well.
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'))});
  await page.setViewportSize(width===951?{width:382,height:657}:{width:951,height:669});
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'))});await settle(page);
  assert.equal(await page.locator('.bb-page').evaluate(el=>el.getBoundingClientRect().top),0);
  await page.screenshot({path:out+'/'+engine.name()+'-'+width+'-returned.png'});assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 }catch(error){await page.screenshot({path:out+'/failure-'+engine.name()+'-'+width+'.png',fullPage:true});throw error}finally{await page.close()}
 }}finally{await browser.close()}}console.log(count+' retained-app foreground browser cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
