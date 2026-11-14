// Native animation interruption and terminal paint state; no financial writes.
const assert=require('node:assert/strict');
const {fixture,engines,routes,panel,enter,press}=require('./bill_pane_fit_browser_test.cjs');
(async()=>{let cases=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{for(const c of [{width:867,height:553,dark:false,rail:0},{width:951,height:648,dark:true,rail:84}].filter(c=>!process.env.ONLY_WIDTH||c.width===Number(process.env.ONLY_WIDTH))){
  const {page,errors,unexpected}=await fixture(browser,c.width,c.height,c.dark,false,false,c.rail,routes([]));
  try{
   await page.emulateMedia({reducedMotion:'no-preference'});await enter(page);await press(panel(page).locator('.bb-bills-row').first());
   await panel(page).locator('.bb-bills-row').nth(1).evaluate(n=>n.click());await page.waitForTimeout(60);
   const before=await panel(page).locator('[data-bill-slot]').evaluateAll(nodes=>nodes.map(n=>{for(const a of n.getAnimations()){a.pause();a.currentTime=160}return {id:n.dataset.billSlot,x:new DOMMatrixReadOnly(getComputedStyle(n).transform).m41}}));
   assert.equal(before.length,2);assert(before.every(n=>Math.abs(n.x)>10),'Both paused panes have an intermediate presentation position');
   await panel(page).locator('.bb-bills-row').first().evaluate(n=>n.click());await page.waitForTimeout(30);
   const restarted=await panel(page).locator('[data-bill-slot]').evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.billSlot,from:new DOMMatrixReadOnly(n.getAnimations()[0].effect.getKeyframes()[0].transform).m41})));
   for(const n of restarted)assert(Math.abs(n.from-before.find(p=>p.id===n.id).x)<.5,'Reversal starts at the visible position: '+JSON.stringify({before,restarted}));
   const coverage=await panel(page).locator('.bb-bill-editor-workspace').evaluate(root=>{const base=root.getBoundingClientRect(),spans=[...root.querySelectorAll('[data-bill-slot]')].map(n=>{for(const a of n.getAnimations()){a.pause();a.currentTime=160}const r=n.getBoundingClientRect();return {left:r.left-base.left,right:r.right-base.left}}).sort((a,b)=>a.left-b.left);let right=0;for(const s of spans){if(s.left>right+1)return false;right=Math.max(right,s.right)}return right>=base.width-1});
   assert(coverage,'Reversing panes move together and cover the whole pane, without a blank strip');
   await panel(page).locator('[data-bill-slot]').evaluateAll(nodes=>nodes.forEach(n=>n.getAnimations().forEach(a=>a.play())));
   await page.waitForTimeout(500);
   await panel(page).locator('.bb-bills-editor[data-open=true]').evaluate(n=>window.__outgoingBill=n);
   await panel(page).locator('.bb-bills-row').nth(1).evaluate(n=>n.click());await page.waitForTimeout(500);
   assert.equal(await page.evaluate(()=>window.__outgoingBill.style.visibility),'hidden','Finished outgoing panes are hidden before removal, never reset visibly to the origin');
   const paint=await panel(page).locator('.bb-bill-editor-workspace').evaluate(n=>({base:getComputedStyle(n).backgroundColor,surface:getComputedStyle(n.querySelector('.bi-editor')).backgroundColor}));
   assert.equal(paint.base,paint.surface,'A persistent opaque material covers compositor handoffs');assert.notEqual(paint.base,'rgba(0, 0, 0, 0)');
   await panel(page).getByRole('textbox',{name:'Name',exact:true}).fill('Continuity draft');await page.setViewportSize({width:382,height:740});await page.waitForTimeout(500);assert.equal(await panel(page).getByRole('textbox',{name:'Name',exact:true}).inputValue(),'Continuity draft');
   await page.setViewportSize({width:c.width,height:c.height});await page.waitForTimeout(500);assert.equal(await panel(page).locator('[data-bill-slot]').count(),1);assert.equal(await panel(page).getByRole('textbox',{name:'Name',exact:true}).inputValue(),'Continuity draft');
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS bill selection continuity',engine.name(),c.width,c.height);cases++;
  }catch(error){await page.screenshot({path:'/private/tmp/bookiebot-bill-continuity-failure.png'});throw error}finally{await page.close()}
 }}finally{await browser.close()}
}console.log(cases+' bill selection continuity cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
