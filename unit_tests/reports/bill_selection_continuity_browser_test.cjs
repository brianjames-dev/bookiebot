// Native animation interruption and terminal paint state; no financial writes.
const assert=require('node:assert/strict');
const {fixture,engines,routes,panel,enter,press}=require('./bill_pane_fit_browser_test.cjs');
(async()=>{let cases=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{for(const c of [{width:867,height:553,dark:false,rail:0},{width:951,height:648,dark:true,rail:84}].filter(c=>!process.env.ONLY_WIDTH||c.width===Number(process.env.ONLY_WIDTH))){
  const {page,errors,unexpected}=await fixture(browser,c.width,c.height,c.dark,false,false,c.rail,routes([]));
  try{
   await page.emulateMedia({reducedMotion:'no-preference'});await enter(page);await press(panel(page).locator('.bb-bills-row').first());
   const active=panel(page).locator('.bb-bills-editor[data-open=true]');
   await active.getByRole('textbox',{name:'Name',exact:true}).fill('First draft');
   await active.evaluate(node=>window.__firstBill=node);
   await panel(page).locator('.bb-bills-row').nth(1).evaluate(n=>n.click());
   await page.waitForFunction(()=>document.querySelectorAll('[data-bill-slot]').length===2);
   assert(await page.evaluate(()=>window.__firstBill.isConnected&&window.__firstBill.inert),'The outgoing editor stays mounted through its inline collapse');
   await panel(page).locator('.bb-bills-row').first().evaluate(n=>n.click());
   assert(await active.evaluate(node=>node===window.__firstBill),'Reversing the collapse retains the draft DOM');
   assert.equal(await active.getByRole('textbox',{name:'Name',exact:true}).inputValue(),'First draft');
   await page.waitForFunction(()=>document.querySelectorAll('[data-bill-slot]').length===1);
   assert(await page.getByRole('navigation',{name:'Settings categories'}).isVisible());
   await panel(page).getByRole('textbox',{name:'Name',exact:true}).fill('Continuity draft');await page.setViewportSize({width:382,height:740});await page.waitForTimeout(500);assert.equal(await panel(page).getByRole('textbox',{name:'Name',exact:true}).inputValue(),'Continuity draft');
   await page.setViewportSize({width:c.width,height:c.height});await page.waitForTimeout(500);assert.equal(await panel(page).locator('[data-bill-slot]').count(),1);assert.equal(await panel(page).getByRole('textbox',{name:'Name',exact:true}).inputValue(),'Continuity draft');
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS bill selection continuity',engine.name(),c.width,c.height);cases++;
  }catch(error){await page.screenshot({path:'/private/tmp/bookiebot-bill-continuity-failure.png'});throw error}finally{await page.close()}
 }}finally{await browser.close()}
}console.log(cases+' bill selection continuity cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
