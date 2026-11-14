// Real shipped components, native touch and isolated financial endpoints.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap:nativeTap,engines}=require('./duo_layout_browser_test.cjs');
const base={id:'pge',name:'PG&E',type:'variable',amountCents:null,cadence:'monthly',pullDay:22,pullMonths:[],category:'bills_utilities',account:'Checking',active:true,effectiveFrom:'0001-01',effectiveUntil:'9999-12',earliestEffectiveMonth:'2026-11',splitMethod:'none',payerBasisPoints:10000,version:'v1',nextDate:'2026-11-22',needsSetup:false,charge:{available:true,recorded:false,amountCents:0,month:'2026-11',date:'2026-11-22',version:'charge-v1'}};
async function tap(page,button){await button.scrollIntoViewIfNeeded();await nativeTap(page,button)}
const settle=page=>page.waitForTimeout(680);
async function geometry(page){return page.evaluate(()=>{
 const rect=selector=>{const el=document.querySelector(selector),r=el?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};
 return {brand:rect('.bb-report-brand'),word:rect('.bb-wordmark'),avatar:rect('.bb-app-avatar'),header:rect('.bb-page>.bb-report-header'),title:rect('.bb-report-header:not([hidden]) h1'),settings:rect('main[aria-label="Settings"]>.bb-settings-heading h1'),main:rect('main[aria-label="Settings"]'),section:rect('main[aria-label="Settings"]>.bb-settings-section')};
})}
;(async()=>{let cases=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch();try{for(const dark of [false,true])for(const width of [320,382,867].filter(w=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
 const commands=[],reviews=[];const bills=[structuredClone(base),{...structuredClone(base),id:'icloud',name:'iCloud Storage',type:'subscription',amountCents:299,category:'subscriptions_wants'}];
 const {page,errors,unexpected}=await fixture(browser,width,669,dark,false,false,0,{bills:async route=>{
  const request=route.request();if(request.method()==='GET')return route.fulfill({json:{month:'2026-11',today:'2026-11-13',settingsVersion:'sv1',ownerName:'Brian',partnerName:'Hannah',incomeBasisPoints:6473,splitsEnabled:true,bills}});
  const body=request.postDataJSON(),before=bills.find(b=>b.id===body.id);if(request.url().endsWith('/review')){reviews.push(body);return route.fulfill({json:{review:{operation:body.operation,reviewVersion:'rv1',before,after:{...before,...body.bill,amountCents:body.bill?.amount?Math.round(Number(body.bill.amount)*100):null},effectiveFrom:body.bill?.effectiveFrom}}})}
  commands.push(body);return route.fulfill({json:{state:'done',success:true,detail:'Bill saved.'}});
 }});
 await settle(page);const overview=await geometry(page);
 await tap(page,page.getByRole('button',{name:'Settings',exact:true}));await page.locator('main[aria-label="Settings"]:visible').waitFor();await settle(page);
 const settings=await geometry(page);assert.equal(await page.locator('.bb-report-brand:visible').count(),0);assert.equal(await page.locator('.bb-settings-masthead-title h1').innerText(),'Settings');
 assert(Math.abs(settings.main.x-overview.title.x)<1,'Settings content starts at the Overview inset');
 assert(await page.getByRole('button',{name:'Back',exact:true}).isVisible(),'Settings exposes its contextual glass Back');
 assert(settings.section.x>=settings.main.x-.5,'Cards do not bleed outside the content inset');
 await tap(page,page.getByRole('button',{name:'Manage bills & subscriptions',exact:true}));const panel=page.locator('main[aria-label="Bills"]');await panel.locator('.bb-bills-row').first().waitFor();
 const pge=panel.locator('.bb-bills-row').filter({hasText:'PG&E'}),icloud=panel.locator('.bb-bills-row').filter({hasText:'iCloud Storage'});
 assert.equal(await pge.locator('.bb-transaction-icon').getAttribute('data-merchant'),'pge','Reuse the actual company logo resolver');
 assert.notEqual(await icloud.locator('.bb-transaction-icon').getAttribute('data-merchant'),'fallback');
 if(width<800){assert.equal(await panel.locator('.bb-bills').evaluate(el=>getComputedStyle(el).paddingBottom),'0px','No duplicate dock clearance in the list');}
 await tap(page,pge);await settle(page);await panel.getByRole('combobox',{name:'Type',exact:true}).selectOption('fixed');await panel.getByRole('textbox',{name:'Recurring amount',exact:true}).fill('98.43');await panel.getByRole('textbox',{name:'Name',exact:true}).fill('PG&E fixed');
 if(width>=800){
  const retained=await panel.locator('.bb-bill-editor-workspace').evaluate(el=>(window.__billEditor=el,true));assert(retained);
  await tap(page,icloud);await settle(page);assert.equal(await panel.getByRole('textbox',{name:'Name',exact:true}).inputValue(),'iCloud Storage');
  await tap(page,pge);await settle(page);assert.equal(await panel.getByRole('textbox',{name:'Name',exact:true}).inputValue(),'PG&E fixed');assert.equal(await panel.getByRole('combobox',{name:'Type',exact:true}).inputValue(),'fixed');
  assert(await panel.locator('.bb-bill-editor-workspace').evaluate(el=>el===window.__billEditor),'Changing bills retains the workspace while bill surfaces crossfade');
 }
 const reviewButton=panel.getByRole('button',{name:'Review',exact:true});await reviewButton.scrollIntoViewIfNeeded();await tap(page,reviewButton);
 // A native double-tap must not spill through to confirmation while the review
 // slides into the former button's location, even with an instant API response.
 const confirm=panel.getByRole('button',{name:'Confirm',exact:true});await confirm.waitFor({state:'visible'});assert(await confirm.isDisabled(),'Confirm is unavailable during the review transition');
 const box=await confirm.boundingBox();await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);assert.equal(commands.length,0,'Review plus rapid repeat never writes');await settle(page);
 assert.equal(reviews.at(-1).bill.type,'fixed');assert((await panel.getByRole('definition').allTextContents()).some(s=>s.includes('$98.43')),'Review displays the requested recurring amount');assert((await panel.locator('.bi-step-review:not([inert]) .sp-flow-context').last().innerText()).includes('Fixed bill'),'The reviewed bill type is visible');
 if(width>=800){await tap(page,icloud);await settle(page);await tap(page,pge);await settle(page);assert(await panel.getByRole('heading',{name:'Review bill',exact:true}).isVisible(),'Returning to another bill retains the prepared review');}
 await page.setViewportSize({width:width<800?867:382,height:669});await settle(page);assert.equal(commands.length,0,'Folding is presentation only');assert(await confirm.isVisible());await page.setViewportSize({width,height:669});await settle(page);
 if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.BOOKIEBOT_SCREENSHOT_DIR}/bill-refinement-${engine.name()}-${width}-${dark?'dark':'light'}.png`,fullPage:true})}
 await tap(page,confirm);await panel.locator('.bb-bills-editor[data-open="false"]').waitFor({state:'attached'});assert.equal(commands.length,1,'A separate explicit confirmation writes exactly once');
 assert.equal(commands[0].reviewVersion,'rv1');assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.close();cases++;
 }}finally{await browser.close()}}
 console.log(`${cases} Bills refinement browser cases passed`)
})().catch(error=>{console.error(error);process.exitCode=1});
