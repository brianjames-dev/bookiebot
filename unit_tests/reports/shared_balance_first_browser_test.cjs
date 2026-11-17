// Shipped bundle + real isolated canonical snapshots from test_shared_balance_first.py.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines,report}=require('./duo_layout_browser_test.cjs');
assert(process.env.BOOKIEBOT_SHARED_BALANCE_FIXTURE,'Generate the canonical fixture first');
const data=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_SHARED_BALANCE_FIXTURE,'utf8'));
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-shared-balance-shots';fs.mkdirSync(output,{recursive:true});
async function settle(page){await page.waitForTimeout(500);await page.waitForFunction(()=>![...document.querySelectorAll('.sr-balance-first')].some(el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect.getTiming().iterations!==Infinity)));}
async function press(page,button){await button.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await tap(page,button);await settle(page);}
;(async()=>{let count=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{for(const [width,height,dark]of [[382,657,false],[867,480,true],[382,657,true],[867,609,false],[951,648,false]].filter(([w])=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
   for(const owner of ['brian','hannah'].filter(owner=>!process.env.ONLY_OWNER||owner===process.env.ONLY_OWNER)){
    let phase='initial',retry=false;const writes=[],name=owner==='brian'?'Brian':'Hannah';
    const f=await fixture(browser,width,height,dark,false,false,0,{config:{ownerName:name},report:()=>({...report,ownerName:name}),request:async route=>{
     const req=route.request();if(new URL(req.url()).pathname!=='/app/reimbursements')return false;
     if(req.method()==='GET'){await route.fulfill({json:data[phase][owner]});return true;}
     const body=req.postDataJSON();writes.push(body);
     assert(body.requestId);assert.equal(body.note,'');
     if(body.operation==='offset'){
      assert.equal(phase,'initial');assert.deepEqual([...body.entries].sort((a,b)=>a.allocationId.localeCompare(b.allocationId)),[...data.offsetCommand.entries].sort((a,b)=>a.allocationId.localeCompare(b.allocationId)));phase='offset';
     }else{
      assert.equal(body.operation,owner==='brian'?'receive_all':'report_all');assert.equal(body.expectedState,data.offset[owner].resetState);
      if(!retry){retry=true;await route.fulfill({status:503,json:{error:'Isolated lost acknowledgement'}});return true;}
      assert.deepEqual(body,writes[writes.length-2],'Uncertain retry preserves the exact financial command');phase=owner==='brian'?'received':'pending';
     }
     await route.fulfill({json:data[phase][owner]});return true;
    }});
    const {page,errors,unexpected}=f;
    try{
     await page.evaluate(name=>localStorage.setItem('bookiebot:duo-layout:'+name.toLowerCase(),'true'),name);await page.reload();await page.locator('.bb-metrics-grid').waitFor();
     await tap(page,page.getByRole('button',{name:'Shared',exact:true}));await page.locator('.sr-balance-first').waitFor();await settle(page);
     await page.emulateMedia({reducedMotion:'no-preference'});
     assert.equal(await page.locator('.bb-report-header h1').innerText(),'Reimbursements');
     assert.equal(await page.getByRole('heading',{name:'Reimbursements',exact:true}).count(),1);
     assert.equal(await page.locator('.sr-row-main').count(),6);assert.equal(await page.locator('.sr-row-main .bb-transaction-icon').count(),6);
     assert.equal(await page.locator('.sr-summary-sides').evaluate(el=>getComputedStyle(el).display),'grid');
     assert.equal(await page.locator('.sr-hero>strong').first().evaluate(el=>getComputedStyle(el).fontSize),height<=550?'38px':'42px');
     if(width>800){const dock=await page.locator('.bb-navigation-pane').boundingBox(),more=await page.locator('.sr-more>summary').boundingBox();assert(more.y+more.height<=dock.y-5,'Summary actions fit above the dock');}
     await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${dark?'dark':'light'}-${owner}-summary.png`)});
     await press(page,page.locator('.sr-row-main').filter({hasText:'PG&E'}));
     const detail=page.locator('.sr-detail-host[data-open=true]');await detail.getByRole('heading',{name:'Reimbursement',exact:true}).waitFor();
     assert.match(await detail.innerText(),/Purchase total.*\$107.28/s);
     if(width>800){const rect=await detail.boundingBox(),overlay=await page.locator('.bb-page').first().evaluate(el=>parseFloat(getComputedStyle(el).getPropertyValue('--bb-duo-overlay'))||0);assert(rect.x>width*.48,'Detail belongs to usable right pane');assert(rect.x+rect.width<=width-overlay-16,'Native status strip remains unused');}
     await press(page,detail.getByRole('button',{name:'Record received',exact:true}).or(detail.getByRole('button',{name:'Record sent payment',exact:true})));
     await detail.locator('input[inputmode=decimal]').fill('12.34');await detail.locator('input[maxlength="200"]').fill('Retained partial payment draft');
     await press(page,detail.getByRole('button',{name:'Close reimbursement details'}));
     await press(page,page.locator('.sr-row-main').filter({hasText:'PG&E'}));
     assert.equal(await detail.locator('input[inputmode=decimal]').count(),1,'Closing details keeps the visited payment editor mounted');
     assert.equal(await detail.locator('input[inputmode=decimal]').inputValue(),'12.34','Closing/reopening retains partial payment');
     assert.equal(await detail.locator('input[maxlength="200"]').inputValue(),'Retained partial payment draft');
     await press(page,page.locator('.sr-row-main').filter({hasText:'Target'}));await press(page,page.locator('.sr-row-main').filter({hasText:'PG&E'}));
     assert.equal(await detail.locator('input[inputmode=decimal]').inputValue(),'12.34','Selecting another expense retains the original draft');
     const originalDate=await detail.locator('input[type=date]').inputValue();
     await page.setViewportSize({width:width<800?867:382,height:width<800?480:657});await settle(page);
     assert.equal(await detail.locator('input[type=date]').inputValue(),originalDate,'Individual payment draft survives folding');
     await page.setViewportSize({width,height});await settle(page);await press(page,detail.getByRole('button',{name:'Cancel',exact:true}));await press(page,detail.getByRole('button',{name:'Close reimbursement details'}));
     await press(page,page.getByRole('button',{name:'Offset & settle',exact:true}));assert.equal(writes.length,0,'Review is read only');
     assert.match(await page.locator('.sr-editor[data-stage=offset]').innerText(),/\$85.25/);
     await press(page,page.getByRole('button',{name:'Confirm offset',exact:true}));assert.equal(writes.length,1);
     await page.locator('.sr-editor[data-stage=payment]').waitFor();assert.match(await page.locator('.sr-editor[data-stage=payment]').innerText(),/\$514.07/);
     const paymentDate=await page.locator('.sr-date input').inputValue();
     await page.setViewportSize({width:width<800?867:382,height:width<800?480:657});await settle(page);assert.equal(await page.locator('.sr-date input').inputValue(),paymentDate);
     await page.setViewportSize({width,height});await settle(page);
     await press(page,page.getByRole('button',{name:owner==='brian'?'Confirm received':'Record sent',exact:true}));
     await page.getByRole('button',{name:'Retry this record',exact:true}).waitFor();await press(page,page.getByRole('button',{name:'Retry this record',exact:true}));
     await page.getByRole('heading',{name:owner==='brian'?'Balances updated':'Payment reported',exact:true}).waitFor();await press(page,page.getByRole('button',{name:'View reimbursements',exact:true}));
     assert.equal(writes.length,3);
     assert.equal(await page.locator('.sr-row-main').count(),owner==='brian'?6:4,owner==='brian'?'Current-month settled activity replaces active scope':'Pending sent amounts stay outstanding');
     assert.match(await page.locator('.sr-scope').innerText(),owner==='brian'?/activity/:/Outstanding/);
     await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${dark?'dark':'light'}-${owner}-result.png`)});
     if(owner==='hannah'){
      let confirmed=false;const recipient=await fixture(browser,width,height,dark,false,false,0,{request:async route=>{
       if(new URL(route.request().url()).pathname!=='/app/reimbursements')return false;
       if(route.request().method()==='POST'){const body=route.request().postDataJSON();assert.equal(body.operation,'receive_all');assert.equal(body.expectedState,data.pending.brian.resetState);assert(!confirmed);confirmed=true;}
       await route.fulfill({json:confirmed?data.received.brian:data.pending.brian});return true;
      }});
      try{const p=recipient.page;await tap(p,p.getByRole('button',{name:'Shared',exact:true}));await p.locator('.sr-balance-first').waitFor();await settle(p);
       await press(p,p.getByRole('button',{name:'Record received',exact:true}));assert(!confirmed,'Recipient review is read only');
       assert.match(await p.locator('.sr-editor[data-stage=payment]').innerText(),/\$514.07/);
       await press(p,p.getByRole('button',{name:'Confirm received',exact:true}));assert(confirmed,'One recipient confirmation settles the reported lump payment');
       await p.getByRole('heading',{name:'Balances updated',exact:true}).waitFor();await press(p,p.getByRole('button',{name:'View reimbursements',exact:true}));assert.equal(await p.locator('.sr-row-main').count(),6);
       assert.deepEqual(recipient.errors,[]);assert.deepEqual(recipient.unexpected,[]);
      }finally{await recipient.page.close()}
     }
     assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
     count++;console.log('PASS Balance first real offset, cash/pending, safe retry, fold, native rows',engine.name(),width,dark,owner);
    }catch(error){await page.screenshot({path:path.join(output,'failure.png')});throw error}finally{await page.close()}
   }
  }}finally{await browser.close()}
 }
 console.log(count+' Balance first native cases passed; screenshots '+output);
})().catch(error=>{console.error(error);process.exitCode=1});
