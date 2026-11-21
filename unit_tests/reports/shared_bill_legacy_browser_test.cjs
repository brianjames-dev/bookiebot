// Shipped components: one legacy shared row per bill, original current-cycle
// shares independent of future defaults, and settled cash in both DUO poses.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-shared-legacy-shots';fs.mkdirSync(output,{recursive:true});
const facts=[['Rent',300000,100000,1,'active'],['Water',9000,3000,18,'pending'],['PG&E',15000,5000,22,'pending'],['Recology',12000,4000,20,'pending']];
const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
const bills=facts.map(([name,total,share,day,status])=>({id:'shared:'+name,type:name==='Rent'?'fixed':'variable',name,
 amountCents:0,cadence:name==='Recology'?'quarterly':'monthly',pullDay:day,pullMonths:name==='Recology'?[2,5,8,11]:[],category:name==='Rent'?'rent':'bills_utilities',account:'',active:true,effectiveFrom:'2026-01',effectiveUntil:'2026-12',splitMethod:'none',payerBasisPoints:10000,version:name+'-view',nextDate:`2026-11-${String(day).padStart(2,'0')}`,needsSetup:false,earliestEffectiveMonth:'2026-11',
 nextChange:{id:'shared:'+name,type:name==='Rent'?'fixed':'variable',name,active:true,amountCents:90000,cadence:'monthly',pullDay:day,pullMonths:[],category:name==='Rent'?'rent':'bills_utilities',account:'',splitMethod:'equal',payerBasisPoints:5000,effectiveFrom:'2026-12',effectiveUntil:'9999-12',needsSetup:false},
 charge:{available:true,month:'2026-11',amountCents:share,billAmountCents:share,date:`2026-11-${String(day).padStart(2,'0')}`,recorded:true,status:day===1?'paid':'confirmed'},prediction:null,readOnly:true,
 sharing:{id:name,revision:status==='active'?2:1,status,role:'member',payerName:'Hannah',memberName:'Brian',state:{purchaseTotalCents:total,payerShareCents:total-share,memberShareCents:share,receivedCents:share,remainingCents:0,clearedCents:0,repaymentStatus:'settled',paymentStatus:day===1?'paid':'confirmed',paymentDate:`2026-11-${String(day).padStart(2,'0')}`,predicted:false,allocationIds:['original-'+name],month:'2026-11'}}}));
async function settle(page){await page.waitForFunction(()=>![...document.querySelectorAll('.bb-bills-editor[data-open=true]')].some(el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect.getTiming().iterations!==Infinity)));}
;(async()=>{let count=0;
 for(const engine of engines){const browser=await engine.launch({headless:true});try{
  for(const dark of [false,true])for(const [width,height] of [[382,657],[867,480]]){
   let posts=0;const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{bills:async route=>{
    if(route.request().method()!=='GET'){posts++;throw Error('Inspecting legacy shared bills must not mutate anything');}
    return route.fulfill({json:{month:'2026-11',today:'2026-11-16',ownerName:'Brian',partnerName:'Hannah',settingsVersion:'legacy-view',splitsEnabled:true,bills}});
   }});
   await tap(page,page.getByRole('button',{name:'Settings',exact:true}));
   await tap(page,page.getByRole('button',{name:'Bills',exact:true}));
   await page.locator('.bb-bills-row').first().waitFor();assert.equal(await page.locator('.bb-bills-row').count(),4);
   assert(!await page.locator('.bb-bills-list').getByText('Finish setup',{exact:true}).count());
   for(const [name,total,share,,status] of facts){
    const row=page.locator('.bb-bills-row').filter({has:page.locator('.bb-bills-row-text strong',{hasText:new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')})});
    assert.equal(await row.locator('.bb-bills-row-amount').textContent(),money(share),name+' keeps its November share');
    assert((await row.textContent()).includes(status==='pending'?'Invitation':'Shared'));
    await row.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForTimeout(100);
    try{await tap(page,row)}catch(error){console.error(name,width,await row.evaluate(el=>{const r=el.getBoundingClientRect();return {box:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML,scrollY,innerHeight}}));throw error}
    await settle(page);const editor=page.locator('.bb-bills-editor[data-open=true]');
    await editor.getByRole('heading',{name:'Shared bill',exact:true}).waitFor();
    assert((await editor.locator('.bb-shared-bill-name').textContent()).includes('Nov 2026'),'Invoice details identify their original November cycle');
    assert((await editor.locator('.bb-settings-note').first().textContent()).includes('from Dec 2026'),'Future defaults are labelled separately from the recorded invoice');
    const value=async label=>editor.locator('.bb-shared-bill-facts > div').filter({has:page.locator('dt',{hasText:new RegExp('^'+label+'$')})}).locator('dd').textContent();
    assert.equal(await value('Bill total'),money(total));assert.equal(await value('Received by Hannah'),money(share));assert.equal(await value('Remaining to repay'),money(0));
    assert.equal(await editor.getByRole('textbox').count(),0);
    if(width>=800){const box=await editor.evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight}));assert(box.scroll<=box.height+1,'Open shared editor fits '+name);}
    if(name==='Rent'){
     await page.setViewportSize({width:width<800?867:382,height:width<800?480:657});await page.waitForTimeout(520);
     assert.equal(await value('Received by Hannah'),money(share));
     await page.setViewportSize({width,height});await page.waitForTimeout(520);
     await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${dark?'dark':'light'}-rent.png`),fullPage:true});
    }
    const close=editor.getByRole('button',{name:'Close',exact:true});if(width<800){await close.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForTimeout(100);}
    await tap(page,close);await settle(page);
   }
   assert.equal(posts,0);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
   await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${dark?'dark':'light'}.png`),fullPage:true});
   await page.close();count++;console.log('PASS legacy shared bill rows, current shares, settled receipts and folds',engine.name(),width,dark?'dark':'light');
  }
 }finally{await browser.close();}}
 console.log(`${count} legacy shared-bill native cases passed; screenshots ${output}`);
})().catch(error=>{console.error(error);process.exit(1)});
