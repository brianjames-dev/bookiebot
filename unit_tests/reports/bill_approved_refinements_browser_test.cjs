// Actual shipped bundle, native browser hit testing, isolated bill reads/reviews.
// No financial confirmation is sent by this presentation regression.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,engines,routes,panel,enter,press}=require('./bill_pane_fit_browser_test.cjs');
const active=page=>panel(page).locator('.bb-bills-editor[data-open=true]');
async function gesture(page,{distance=300,selector='.bb-bills-toolbar',cancel=false}={}){
 await page.evaluate(({distance,selector,cancel})=>{
  const target=document.querySelector(selector),touch=y=>({identifier:77,target,clientX:20,clientY:y,pageX:20,pageY:y});
  const send=(type,y)=>{const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{touches:{value:type==='touchend'||type==='touchcancel'?[]:[touch(y)]},changedTouches:{value:[touch(y)]}});target.dispatchEvent(event)};
  send('touchstart',100);send('touchmove',100+distance);send(cancel?'touchcancel':'touchend',100+distance);
 },{distance,selector,cancel});
 await page.waitForTimeout(700);
}
async function sample(page,duration=760){
 await page.evaluate(duration=>{window.__billSamples=(async()=>{const frames=[],start=performance.now();while(performance.now()-start<duration){await new Promise(requestAnimationFrame);frames.push({time:performance.now()-start,slots:[...document.querySelectorAll('[data-bill-slot]')].map(n=>({id:n.dataset.billSlot,open:n.dataset.open,opacity:Number(getComputedStyle(n).opacity),transform:getComputedStyle(n).transform,height:n.getBoundingClientRect().height,moving:n.dataset.billMoving,anchor:document.querySelector(`[data-bill-id="${n.dataset.billSlot}"]`)?.dataset.editorAnchor,animations:n.getAnimations().map(a=>({duration:a.effect.getTiming().duration,easing:a.effect.getTiming().easing,keys:a.effect.getKeyframes().map(f=>Object.keys(f))}))}))})}return frames})()},duration);
}
async function shot(page,name){if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.BOOKIEBOT_SCREENSHOT_DIR}/${name}.png`})}}
(async()=>{let count=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{for(const config of [{width:382,height:740,dark:true,rail:0},{width:320,height:740,dark:false,rail:0},{width:951,height:648,dark:true,rail:84},{width:867,height:553,dark:false,rail:0}].filter(c=>!process.env.ONLY_WIDTH||c.width===Number(process.env.ONLY_WIDTH))){
  const {width,height,dark,rail}=config,reviews=[];let reads=0;
  const billRoute=routes(reviews).bills;
  const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,rail,{bills:route=>{if(route.request().method()==='GET')reads++;return billRoute(route)}});
  try{
   await page.emulateMedia({reducedMotion:'no-preference'});await enter(page);const main=panel(page),wide=width>=800,otherReads=[];
   page.on('request',r=>{if(['/app/widgets/settings','/app/notifications'].includes(new URL(r.url()).pathname))otherReads.push(r.url())});
   const capsule=page.locator('.bb-settings-masthead-title .bb-glass-control');
   assert.equal(await capsule.count(),1);assert.equal(await capsule.locator('button').count(),1,'One surface and one button, no nested glass');
   assert.equal(await capsule.locator('button').getAttribute('aria-label'),'Back');assert.equal((await capsule.innerText()).trim(),'Bills');
   const chrome=await capsule.evaluate(n=>{const c=getComputedStyle(n),button=n.querySelector('button'),r=n.getBoundingClientRect();return {height:r.height,radius:c.borderRadius,buttonRadius:getComputedStyle(button).borderRadius,background:c.backgroundColor}});
   assert.equal(chrome.height,44);assert.notEqual(chrome.background,'rgba(0, 0, 0, 0)');
   const add=main.getByRole('button',{name:'Add bill',exact:true});
   assert(await add.isEnabled());assert.notEqual(await add.evaluate(n=>getComputedStyle(n).backgroundColor),'rgba(0, 0, 0, 0)','Add is a framed button');
   assert.equal(await main.locator('.bb-bills-refresh').count(),wide?1:0,'Toolbar refresh is open-DUO only');
   await press(main.locator('.bb-bills-row').first());
   assert.equal(await active(page).getByRole('heading',{name:'Edit bill',exact:true}).count(),1);
   assert.equal(await active(page).locator('.bb-bill-edit-heading p').count(),0,'No duplicate merchant or month subtitle');
   assert.equal(await active(page).locator('.bb-bill-edit-heading button').innerText(),'','Stop is icon only');
   assert.equal(await active(page).getByText('Applies from',{exact:true}).count(),0);
   const splitStyle=await active(page).locator('.bb-bills-split-action').evaluate(n=>{const r=n.getBoundingClientRect(),p=n.parentElement.getBoundingClientRect(),c=getComputedStyle(n);return {width:r.width,parentWidth:p.width,height:r.height,topBorder:c.borderTopWidth,bottomBorder:c.borderBottomWidth}});
   assert(Math.abs(splitStyle.width-splitStyle.parentWidth)<1,'Recurring split spans the form');assert.equal(splitStyle.height,46);assert.equal(splitStyle.topBorder,'0px');assert.equal(splitStyle.bottomBorder,'1px');
   const oldSlot=await active(page).getAttribute('data-bill-slot');
   await sample(page);await main.locator('.bb-bills-row').nth(1).evaluate(n=>n.click());const frames=await page.evaluate(()=>window.__billSamples);
   if(wide){
    const cross=frames.filter(f=>f.slots.length===2);
    assert(cross.length>8,'Both bill surfaces remain mounted through the crossfade');
    assert(cross.some(f=>f.time>400&&f.slots.every(s=>s.moving==='true')),'The fade remains visibly in progress beyond 400 ms');
    assert(cross.filter(f=>f.time>100&&f.time<450).every(f=>f.slots.every(s=>s.opacity>0&&s.opacity<1)),'Outgoing and incoming fade together');
    assert(cross.every(f=>f.slots.every(s=>s.transform==='none')),'Bill selection never slides');
    const animations=cross.flatMap(f=>f.slots.flatMap(s=>s.animations));
    assert(animations.length>0&&animations.every(a=>a.duration===600&&a.easing==='cubic-bezier(0.45, 0, 0.55, 1)'),'Selection uses the deliberate 600 ms easing');
    assert.equal(frames.at(-1).slots.length,1,'Outgoing surfaces are removed after fading');
    const geometry=await main.evaluate(n=>{const list=n.querySelector('.bb-bills-list'),rows=n.querySelector('.bb-bills-rows'),host=n.querySelector('[data-open=true]'),nav=document.querySelector('.bb-navigation-pane'),box=e=>e.getBoundingClientRect().toJSON(),s=getComputedStyle(rows);return {list:box(list),rows:box(rows),host:box(host),nav:box(nav),scrollWidth:s.scrollbarWidth,scrollColor:s.scrollbarColor,document:document.documentElement.scrollWidth,viewport:innerWidth}});
    assert(Math.abs(geometry.rows.right-geometry.list.right-8)<1,'Scroll track uses Transactions’ outer 8px gutter');assert.equal(geometry.scrollWidth,'thin');assert.equal(geometry.document,geometry.viewport);
    await main.locator('.bb-bills-rows').evaluate(n=>n.scrollTop=400);assert(await main.locator('.bb-bills-rows').evaluate(n=>n.scrollTop)>0);assert.equal(await active(page).evaluate(n=>n.getBoundingClientRect().y),geometry.host.y,'Only left rows scroll');await main.locator('.bb-bills-rows').evaluate(n=>n.scrollTop=0);
    const before=reads;await press(main.getByRole('button',{name:'Refresh bills',exact:true}));assert.equal(reads,before+1);await gesture(page);assert.equal(reads,before+1,'Open DUO cannot trigger a second pull refresh');
   }else{
    const simultaneous=frames.filter(f=>f.slots.length===2&&f.slots.every(s=>s.height>2));assert(simultaneous.length>2,'Both rows collapse/expand concurrently');
    const heights=simultaneous.map(f=>f.slots.find(s=>s.id===oldSlot).height);assert(Math.max(...heights)-Math.min(...heights)>20,'Previous editor visibly collapses while next opens');
    assert(simultaneous.every(f=>f.slots.every(s=>s.anchor==='true')),'Each transitioning editor retains its own parent anchor');
    assert.equal(frames.at(-1).slots.length,1);await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(120);
    const before=reads;await gesture(page,{distance:160});assert.equal(reads,before,'A short pull does not refresh');await gesture(page);assert.equal(reads,before+1,'Closed Bills uses the native pull module');
    const draft=await active(page).getByRole('textbox',{name:'Name',exact:true}).inputValue();assert.equal(draft,'A long quarterly bill name that must stay inside the editor','Refreshing retains the current draft');
   }
   assert.deepEqual(otherReads,[],'Refreshing Bills does not reload hidden widget/notification settings');
   // In-editor forward/back progression remains the native 440ms slide.
   await active(page).getByRole('button',{name:/^Recurring split/}).evaluate(n=>n.click());await page.waitForTimeout(90);
   const slide=await active(page).evaluate(n=>[...n.querySelectorAll('.bi-step-viewport[data-moving=true]')].flatMap(v=>[...v.querySelectorAll(':scope>.bi-step-pane')].map(p=>({transform:getComputedStyle(p).transform,duration:p.getAnimations()[0]?.effect.getTiming().duration}))));
   assert(slide.some(s=>s.duration===440&&s.transform!=='none'),'Slides are reserved for editor steps');await page.waitForTimeout(490);
   await active(page).getByRole('textbox',{name:"Brian's share percentage",exact:true}).fill('12.345');
   await active(page).evaluate(n=>window.__activeBill=n);await page.setViewportSize({width:wide?382:951,height:wide?740:648});await page.waitForTimeout(520);
   assert(await active(page).evaluate(n=>n===window.__activeBill),'Folding preserves the active editor instance');assert.equal(await active(page).getByRole('textbox',{name:"Brian's share percentage",exact:true}).inputValue(),'12.345','Raw invalid split input survives folding');
   await page.setViewportSize({width,height});await page.waitForTimeout(520);assert(await active(page).evaluate(n=>n===window.__activeBill));
   assert(await add.isEnabled(),'Add stays available within the split editor');await add.evaluate(n=>n.click());await page.waitForTimeout(690);
   await active(page).getByRole('textbox',{name:'Name',exact:true}).fill('Retained new bill');await add.evaluate(n=>n.click());await page.waitForTimeout(50);
   assert.equal(await active(page).getByRole('textbox',{name:'Name',exact:true}).inputValue(),'Retained new bill','Repeated Add keeps its current draft');
   await main.locator('.bb-bills-row').first().evaluate(n=>n.click());await page.waitForTimeout(690);await add.evaluate(n=>n.click());await page.waitForTimeout(690);assert.equal(await active(page).getByRole('textbox',{name:'Name',exact:true}).inputValue(),'Retained new bill');
   await shot(page,`bills-approved-${engine.name()}-${width}-${height}`);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
   console.log('PASS approved Bills',engine.name(),width,height,dark?'dark':'light');count++;
  }catch(error){await page.screenshot({path:'/private/tmp/bookiebot-bills-approved-failure.png'});throw error}finally{await page.close()}
 }}finally{await browser.close()}
}console.log(`${count} approved Bills presentation cases passed`)
})().catch(error=>{console.error(error);process.exitCode=1});
