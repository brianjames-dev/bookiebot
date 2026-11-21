// Actual backend invoice/repayment payload from test_shared_bill_updates.py.
// Generate locally with BOOKIEBOT_SHARED_BILL_BROWSER_FIXTURE set; no live data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
assert(process.env.BOOKIEBOT_SHARED_BILL_BROWSER_FIXTURE,'Generate the isolated backend fixture first');
const data=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_SHARED_BILL_BROWSER_FIXTURE,'utf8'));
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-shared-updates-shots';fs.mkdirSync(output,{recursive:true});
async function settle(page){await page.waitForFunction(()=>![...document.querySelectorAll('.bi-step-viewport,.bb-bills-editor')].some(el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect.getTiming().iterations!==Infinity)));}
;(async()=>{let count=0;
 for(const engine of engines){const browser=await engine.launch({headless:true});try{
  for(const dark of [false,true])for(const [width,height]of [[382,657],[867,480]]){
   const read=body=>route=>{assert.equal(route.request().method(),'GET','Inspecting the future-cycle fixture never mutates money');return route.fulfill({json:body})};
   const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{config:{ownerName:'Hannah'},
    report:()=>data.report,transactions:read(data.transactions),bills:read(data.bills),
    months:{currentMonth:'2026-12',months:[{value:'2026-12',label:'December 2026'}],coverage:{status:'complete',unavailableYears:[]}}});
   await page.evaluate(()=>localStorage.setItem('bookiebot:duo-layout:hannah','true'));
   await page.reload();await page.locator('.bb-metrics-grid').waitFor();
   await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));
   const cue=page.locator('.sp-cue').filter({hasText:'Due'});await cue.waitFor();
   assert.equal(await page.locator('.sp-cue').count(),1,'One actual paid row carries the remaining debt; no duplicate disclosure');
   const row=cue.locator('xpath=ancestor::*[contains(@class,"bb-daily-transaction")][1]');
   assert((await row.locator('.sp-money-slot').textContent()).includes('10.00'));
   assert((await cue.textContent()).includes((data.remainingCents/100).toFixed(2)));
   await cue.click();const details=page.getByRole('region',{name:'Split repayment details',exact:true}).filter({visible:true});
   await details.getByRole('button',{name:'Close',exact:true}).waitFor();await settle(page);
   assert(await details.getByRole('button',{name:'Edit split',exact:true}).isDisabled(),'Hannah cannot edit the payer’s invoice split');
   await page.setViewportSize({width:width<800?867:382,height:width<800?480:657});await page.waitForTimeout(520);
   assert.equal(await page.locator('.sp-cue').count(),1);
   await page.setViewportSize({width,height});await page.waitForTimeout(520);
   await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${dark?'dark':'light'}.png`),fullPage:true});
   const close=details.getByRole('button',{name:'Close',exact:true});await close.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForTimeout(100);
   await tap(page,close);await settle(page);
   await tap(page,page.getByRole('button',{name:'Settings',exact:true}));await tap(page,page.getByRole('button',{name:'Bills',exact:true}));
   const water=page.locator('.bb-bills-row').filter({has:page.locator('.bb-bills-row-text strong',{hasText:/^Water$/})});
   await water.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForTimeout(100);await tap(page,water);await settle(page);
   const editor=page.locator('.bb-bills-editor[data-open=true]');await editor.getByRole('heading',{name:'Shared bill',exact:true}).waitFor();
   assert((await editor.textContent()).includes('10.00'));assert((await editor.textContent()).includes((data.remainingCents/100).toFixed(2)));
   assert.equal(await editor.getByRole('textbox').count(),0);assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
   await page.close();count++;console.log('PASS real new-invoice partial cash, one Due row, readonly Bills and folds',engine.name(),width,dark?'dark':'light');
  }
 }finally{await browser.close();}}
 console.log(`${count} actual-backend shared-bill native cases passed; screenshots ${output}`);
})().catch(error=>{console.error(error);process.exit(1)});
