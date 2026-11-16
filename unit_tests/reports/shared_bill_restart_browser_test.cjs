// Actual isolated backend Stop/Restart payloads from test_shared_bill_restart.py.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
assert(process.env.BOOKIEBOT_SHARED_BILL_RESTART_FIXTURE,'Generate the isolated restart fixture first');
const data=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_SHARED_BILL_RESTART_FIXTURE,'utf8'));
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-shared-restart-shots';fs.mkdirSync(output,{recursive:true});
async function settle(page){await page.waitForFunction(()=>![...document.querySelectorAll('.bb-bills-editor')].some(el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect.getTiming().iterations!==Infinity)));}
async function press(page,button){await button.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForTimeout(60);await tap(page,button);await settle(page);}
;(async()=>{let count=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{for(const [width,height,dark]of [[382,657,false],[867,480,false],[382,657,true],[867,480,true]].filter(([w])=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
   let phase='stopped';const pages={},writes=[];
   try{for(const owner of ['Brian','Hannah']){
    const actor=data.actors[owner];
    const f=await fixture(browser,width,height,dark,false,false,0,{config:{ownerName:owner},report:()=>data.reports[actor],
     months:{currentMonth:'2026-11',months:[{value:'2026-11',label:'November 2026'}],coverage:{status:'complete',unavailableYears:[]}},
     bills:route=>{const req=route.request(),url=new URL(req.url());
      if(req.method()==='GET')return route.fulfill({json:data[phase][actor]});
      assert.equal(owner,'Brian','The recipient only inspects a shared bill');const body=req.postDataJSON();
      assert.equal(body.operation,'update');assert.equal(body.applyCurrentCharge,false);assert.equal(body.id,data.command.id);
      for(const field of ['name','type','amount','cadence','pullDay','pullMonths','category','account','effectiveFrom','splitMethod','payerBasisPoints'])assert.deepEqual(body.bill[field],data.command.bill[field],field);
      if(url.pathname.endsWith('/review'))return route.fulfill({json:{review:data.review}});
      assert.equal(url.pathname,'/app/bills');assert.equal(body.reviewVersion,data.review.reviewVersion);
      writes.push(body);phase='active';return route.fulfill({json:data.result});
     },transactions:route=>{assert.equal(route.request().method(),'GET');return route.fulfill({json:data.transactions[actor]})}});
    const page=f.page;pages[owner]=f;
    await page.route('**/app/account/changes',route=>route.fulfill({json:{revision:phase==='active'?1:0}}));
    await page.route('**/app/account',route=>route.fulfill({json:{id:'fixture-'+owner,name:owner,googleEnabled:false,google:{connected:false,email:null}}}));
    await page.evaluate(owner=>localStorage.setItem('bookiebot:duo-layout:'+owner.toLowerCase(),'true'),owner);await page.reload();await page.locator('.bb-metrics-grid').waitFor();
    await tap(page,page.getByRole('button',{name:'Settings',exact:true}));await tap(page,page.getByRole('button',{name:'Manage bills & subscriptions',exact:true}));
    await page.locator('.bb-bills-row').first().waitFor();await page.getByRole('combobox',{name:'Bill type',exact:true}).selectOption('ended');
    assert.equal(await page.locator('.bb-bills-row').count(),1);assert.equal(await page.locator('.bb-bills-row').getAttribute('data-bill-id'),data.ids[actor]);
   }
   const brian=pages.Brian.page,hannah=pages.Hannah.page;
   await press(brian,brian.locator('.bb-bills-row'));const editor=brian.locator('.bb-bills-editor[data-open=true]');
   await editor.getByRole('heading',{name:'Restart bill',exact:true}).waitFor();await press(brian,editor.getByRole('button',{name:'Review',exact:true}));
   const status=editor.locator('[data-review-field=Status]');assert.match(await status.innerText(),/Stopped.*Active/s);
   await brian.setViewportSize({width:width<800?867:382,height:width<800?480:657});await brian.waitForTimeout(520);
   assert.match(await status.innerText(),/Stopped.*Active/s);await brian.setViewportSize({width,height});await brian.waitForTimeout(520);
   await press(brian,editor.getByRole('button',{name:'Confirm',exact:true}));await brian.waitForFunction(()=>!document.querySelector('.bb-bills-editor[data-open=true]'));await brian.waitForTimeout(520);
   assert.equal(writes.length,1);assert.equal(await brian.locator('.bb-bills-row').count(),0,'Restart leaves the Ended list after closing');
   await hannah.evaluate(()=>window.dispatchEvent(new Event('focus')));await hannah.waitForFunction(()=>document.querySelectorAll('.bb-shell-bills .bb-bills-row').length===0);
   for(const owner of ['Brian','Hannah']){
    const {page,errors,unexpected}=pages[owner],actor=data.actors[owner];
    await page.getByRole('combobox',{name:'Bill type',exact:true}).selectOption('all');
    assert.equal(await page.locator('.bb-bills-row').count(),4,'The original four bills remain once each');
    const row=page.locator(`[data-bill-id="${data.ids[actor]}"]`);assert.equal(await row.count(),1);
    if(owner==='Hannah'){
     const expected=data.active[actor].bills.find(b=>b.id===data.ids[actor]).sharing.state;
     await press(page,row);const details=page.locator('.bb-bills-editor[data-open=true]');await details.getByRole('heading',{name:'Shared bill',exact:true}).waitFor();
     const fact=label=>details.locator('.bb-shared-bill-facts>div').filter({has:page.locator('dt',{hasText:label})}).locator('dd');
     assert.equal(await fact('Received by Brian').textContent(),new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(expected.receivedCents/100));
     assert.equal(await fact('Remaining to repay').textContent(),'$0.00');assert.equal(await details.getByRole('textbox').count(),0);
    }
    await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${dark?'dark':'light'}-${owner.toLowerCase()}.png`)});
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
   }
   count++;console.log('PASS actual shared Restart, both apps, one identity, original receipts and folding',engine.name(),width,dark?'dark':'light');
   }catch(error){for(const [owner,{page}]of Object.entries(pages))await page.screenshot({path:path.join(output,'failure-'+owner+'.png')});throw error}
   finally{await Promise.all(Object.values(pages).map(({page})=>page.close()))}
  }}finally{await browser.close()}
 }
 console.log(count+' two-app shared-bill restart native cases passed; screenshots '+output);
})().catch(error=>{console.error(error);process.exitCode=1});
