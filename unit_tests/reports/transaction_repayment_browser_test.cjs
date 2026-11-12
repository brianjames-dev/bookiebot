// Actual shipped bundle against isolated API responses; no real financial writes.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const make=(id,date,outgoing=false)=>({id:'2026-10:'+id,actionId:id,month:'2026-10',version:'v1-'+id,date,title:'Household supplies with a very long descriptive name',location:id==='owed'?'Target':'Whole Foods',person:'Brian (BofA)',kind:'expense',category:'shopping',categoryLabel:'Shopping',amountCents:10000,displayAmountCents:outgoing?0:10000,contextOnly:outgoing,split:'equal',fields:{date,item:'Household supplies with a very long descriptive name',location:'Target',person:'Brian (BofA)',amount:'100.00'},editableFields:outgoing?[]:['item','amount','location','person'],capabilities:{update:!outgoing,move:!outgoing,delete:!outgoing,split:!outgoing,cancel_split:!outgoing,undo:false},reasons:{},splitOptions:{custom:true,payerName:'Brian',partnerName:'Hannah',payerBasisPoints:5000,payerCents:5000,incomePayerCents:5731},repayment:{id,version:1,accounting:'cash_v1',direction:outgoing?'outgoing':'incoming',payerName:outgoing?'Hannah':'Brian',partnerName:outgoing?'Brian':'Hannah',grossCents:10000,payerShareCents:5000,partnerShareCents:5000,settledCents:0,clearedCents:0,outstandingCents:5000,pendingCents:0,method:'equal',canEdit:!outgoing,editReason:outgoing?'Only the original payer can edit this split.':''}});
const amount=locator=>locator.evaluate(el=>el.querySelector('.bi-money-change')?.getAttribute('data-value')??el.textContent);
const shape=async page=>page.getByRole('region',{name:'Split repayment details',exact:true}).evaluate(root=>{
 const summary=root.querySelector(':scope>.bi-step-viewport>.bi-step-edit'),edit=root.querySelector('.sp-management>.bi-step-viewport>.bi-step-edit'),footer=summary.querySelector('.sp-summary-footer');
 return {summary:summary.getBoundingClientRect().height,edit:edit.getBoundingClientRect().height,bottoms:[...footer.querySelectorAll('button')].map(b=>summary.getBoundingClientRect().bottom-b.getBoundingClientRect().bottom),overflow:root.scrollWidth-root.clientWidth};
});
(async()=>{let count=0;const closedWidth=Number(process.env.CLOSED_WIDTH||382),openWidth=Number(process.env.OPEN_WIDTH||867),height=Number(process.env.REPAYMENT_HEIGHT||669);
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{
   for(const dark of [false,true])for(const wide of [false,true]){
    let rows=[make('owed','2026-10-20'),make('due','2026-10-19',true)],reviews=[],commands=[],saved=false,loseResponse=false,lastResult;
    const {page,errors,unexpected}=await fixture(browser,wide?openWidth:closedWidth,height,dark,false,false,0,{transactions:async route=>{
     const request=route.request(),url=new URL(request.url()),body=request.postDataJSON(),reply=json=>route.fulfill({json});
     if(url.pathname==='/app/transactions/review'){
      reviews.push(body);const item=rows.find(row=>row.id===body.id);assert.equal(body.version,item.version);
      const payerCents=body.method==='income'?5731:body.method==='fronted'?0:body.method==='equal'?5000:body.payerShareCents;
      return reply({review:{item,after:item.fields,reviewVersion:'review-'+reviews.length,operation:body.operation,share:{method:body.method,payerCents,partnerCents:item.amountCents-payerCents,payerName:'Brian',partnerName:'Hannah'}}});
     }
     if(url.pathname==='/app/transactions'&&request.method()==='POST'){
      commands.push(body);
      const old=rows[0],payerCents=body.method==='income'?5731:body.payerShareCents;
      rows=[{...old,version:'v'+(commands.length+1),split:body.method,splitOptions:{...old.splitOptions,payerCents},repayment:{...old.repayment,version:commands.length+1,method:body.method,payerShareCents:payerCents,partnerShareCents:10000-payerCents,outstandingCents:10000-payerCents}},rows[1]];saved=true;
      const result={state:'done',success:true,summary:{operation:'split',title:old.title,date:old.date,category:'Shopping',location:old.location,person:old.person,amountCents:10000,before:old.fields,after:old.fields,share:{method:body.method,payerCents,partnerCents:10000-payerCents,payerName:'Brian',partnerName:'Hannah'}}};
      lastResult=result;if(loseResponse){loseResponse=false;return route.abort();}return reply(result);
     }
     if(url.pathname.startsWith('/app/transactions/commands/'))return reply(lastResult);
     if(url.pathname==='/app/transactions'&&request.method()==='GET'){
      const days=rows.map(row=>({date:row.date,month:row.month,count:1,totalCents:row.contextOnly?0:row.displayAmountCents,needsCents:0,wantsCents:row.contextOnly?0:row.displayAmountCents}));
      return reply({items:rows,total:rows.length,nextOffset:null,month:'2026-10',categories:['shopping'],persons:['Brian (BofA)'],days,totalAmountCents:10000,snapshotVersion:'snapshot-'+saved});
     }
     throw Error('Unexpected isolated request '+url.pathname);
    }});
    await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));
    const cue=page.locator('.sp-cue[data-split-entry="2026-10:owed"]');await cue.waitFor();
    const initial=await cue.evaluate(el=>{const row=el.closest('.bb-daily-transaction'),meta=row.querySelector('.bb-daily-transaction-meta'),name=row.querySelector('.bb-daily-transaction-name'),price=row.querySelector('.sp-money-slot');return {gap:meta.getBoundingClientRect().y-name.getBoundingClientRect().bottom,pillY:el.getBoundingClientRect().y,priceY:price.getBoundingClientRect().y,metaY:meta.getBoundingClientRect().y,height:row.getBoundingClientRect().height,color:getComputedStyle(el).color,width:row.scrollWidth-row.clientWidth};});
    assert(initial.pillY>initial.priceY);assert(Math.abs(initial.pillY-initial.metaY)<3);assert(initial.gap<5);assert.equal(initial.width,0);
    await cue.click();const detail=page.getByRole('region',{name:'Split repayment details',exact:true}).filter({visible:true});await detail.getByRole('button',{name:'Edit split',exact:true}).waitFor();
    assert.equal(await detail.getByRole('button',{name:'Close',exact:true}).count(),1);assert.equal(await detail.getByRole('dialog').count(),0);
    if(!wide){const geometry=await shape(page);assert(Math.abs(geometry.summary-geometry.edit)<.1,JSON.stringify(geometry));assert(Math.abs(geometry.bottoms[0]-geometry.bottoms[1])<.1);assert.equal(geometry.overflow,0);}
    if(wide){assert.equal(await detail.locator('.sp-summary-footer').evaluate(el=>el.getBoundingClientRect().bottom<=el.closest('.bb-duo-pane-content').getBoundingClientRect().bottom+1),true,'Repayment footer fits above the dock');assert.equal(await page.locator('.bb-recorded-results .sp-detail').count(),0);assert.equal(await page.locator('.bb-recorded-graph-reveal').getAttribute('aria-hidden'),'true');}
    await detail.getByRole('button',{name:'Edit split',exact:true}).click();
    await detail.getByRole('button',{name:'Split by income',exact:true}).click();
    assert.equal(await detail.getByRole('textbox',{name:"Brian's share amount",exact:true}).inputValue(),'57.31');
    // Folding must retain uncommitted text and validation exactly.
    await detail.getByRole('textbox',{name:"Brian's share amount",exact:true}).fill('12.345');
    await page.setViewportSize({width:wide?closedWidth:openWidth,height});
    await page.waitForTimeout(80);
    let active=page.getByRole('region',{name:'Split repayment details',exact:true}).filter({visible:true});
    assert.equal(await active.getByRole('textbox',{name:"Brian's share amount",exact:true}).inputValue(),'12.345');
    assert.equal(await active.getByRole('button',{name:'Review split',exact:true}).isDisabled(),true);
    await active.getByRole('textbox',{name:"Brian's share amount",exact:true}).fill('40.00');
    await active.getByRole('button',{name:'Review split',exact:true}).click();await active.getByRole('button',{name:'Confirm split',exact:true}).waitFor();
    assert.equal(commands.length,0);assert.equal(reviews.at(-1).payerShareCents,4000);
    await active.getByRole('button',{name:'Confirm split',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.sp-cue').textContent.includes('60.00'));
    await page.waitForFunction(()=>document.querySelector('.bb-transactions').dataset.savePhase==='idle');
    await page.waitForTimeout(60);
    active=page.getByRole('region',{name:'Split repayment details',exact:true}).filter({visible:true});
    assert.equal(await amount(active.locator('.rp-balance-amount')),'$60.00');assert.equal(await amount(page.locator('.sp-cue').first()),'$60.00');
    assert.equal(commands.length,1);assert.equal(commands[0].payerShareCents,4000);assert.match(commands[0].requestId,/^[\w-]+$/);
    if(dark){
     await page.emulateMedia({reducedMotion:'no-preference'});
     await active.getByRole('button',{name:'Edit split',exact:true}).click();await page.waitForTimeout(480);
     const editorSignature=await active.locator('.sp-management').evaluate(el=>({width:el.getBoundingClientRect().width,edit:el.querySelector('.bi-step-edit').getBoundingClientRect().height,input:getComputedStyle(el.querySelector('input[type="text"]')).fontSize}));
     await active.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForTimeout(480);await active.getByRole('button',{name:'Close',exact:true}).click();await page.waitForTimeout(400);
     const access=page.getByRole('button',{name:'Show actions for Target',exact:true});
     if(wide){await access.press('ArrowLeft');await page.getByRole('button',{name:'Split Target',exact:true}).click();}
     else{await access.click();await page.getByRole('button',{name:'Split Target',exact:true}).click();}
     active=page.getByRole('region',{name:'Split repayment details',exact:true});await page.waitForTimeout(500);
     const directSignature=await active.locator('.sp-management').evaluate(el=>({width:el.getBoundingClientRect().width,edit:el.querySelector('.bi-step-edit').getBoundingClientRect().height,input:getComputedStyle(el.querySelector('input[type="text"]')).fontSize}));
     assert.deepEqual(directSignature,editorSignature,'Direct row and repayment entry use identical split UI');
     await active.getByRole('button',{name:'Split by income',exact:true}).click();await active.getByRole('button',{name:'Review split',exact:true}).click();await page.waitForTimeout(480);
     await page.locator('.bb-transactions').evaluate(root=>root.addEventListener('click',()=>{root.__feedback=(async()=>{const samples=[],start=performance.now();let started=false;while(performance.now()-start<6500){await new Promise(requestAnimationFrame);const detail=root.querySelector('.sp-detail[data-entry-id="2026-10:owed"]'),viewport=detail?.querySelector(':scope>.bi-step-viewport'),balance=detail?.querySelector('.rp-balance-amount'),line=detail?.querySelector('.bi-change-strike'),phase=root.dataset.savePhase;started ||= phase!=='idle';samples.push({t:performance.now()-start,phase,moving:viewport?.dataset.moving,left:viewport?.scrollLeft,value:balance?.querySelector('.bi-money-change')?.dataset.value??balance?.textContent,money:root.querySelectorAll('.bi-money-change[data-change-state="money"]').length,strike:line?new DOMMatrix(getComputedStyle(line).transform).m11:0});if(started&&phase==='idle')break}return samples})()},{once:true}));
     await active.getByRole('button',{name:'Confirm split',exact:true}).click();
     const samples=await page.locator('.bb-transactions').evaluate(root=>root.__feedback),rolling=samples.find(s=>s.phase==='animating'),quiet=samples.find(s=>s.phase==='returning'&&s.moving==='false');
     assert(rolling&&quiet&&rolling.t-quiet.t>=160,'Native return slide settles before the feedback pause');
     assert(samples.filter(s=>s.phase==='returning').every(s=>s.value==='$60.00'&&s.money===0),'Old balance stays until after the return slide and pause');
     assert(samples.some(s=>s.money>=3)&&samples.some(s=>s.strike>.5),'Real money reels and old split label strikethrough animate');
     assert(samples.every(s=>Math.abs(s.left??0)<1),'Focus never pans the slide viewport');
     assert.equal(samples.at(-1).phase,'idle');assert.equal(await amount(active.locator('.rp-balance-amount')),'$42.69');
     await page.emulateMedia({reducedMotion:'reduce'});
    }
    if(dark&&wide){
     await active.getByRole('button',{name:'Edit split',exact:true}).click();await active.getByRole('textbox',{name:"Brian's share amount",exact:true}).fill('30.00');await active.getByRole('button',{name:'Review split',exact:true}).click();loseResponse=true;
     await active.getByRole('button',{name:'Confirm split',exact:true}).click();await page.getByRole('button',{name:'Check saved status',exact:true}).waitFor();
     assert.equal(await active.getByRole('button',{name:'Back',exact:true}).isDisabled(),true);
     await page.setViewportSize({width:openWidth,height});active=page.getByRole('region',{name:'Split repayment details',exact:true});
     await page.getByRole('button',{name:'Check saved status',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.sp-cue').querySelector('.bi-money-change')?.dataset.value==='$70.00');await page.waitForFunction(()=>document.querySelector('.bb-transactions').dataset.savePhase==='idle');
     assert.equal(commands.length,3,'Status recovery never repeats a split command');assert.equal(await amount(active.locator('.rp-balance-amount')),'$70.00');
    }
    await active.getByRole('button',{name:'Close',exact:true}).click();
    const due=page.locator('.sp-cue[data-direction="send"]');await due.click();active=page.getByRole('region',{name:'Split repayment details',exact:true}).filter({visible:true});
    assert.match(await active.locator('.rp-person-name').textContent(),/You owe Hannah/);assert.equal(await active.getByRole('button',{name:'Edit split',exact:true}).isDisabled(),true);assert.match(await active.locator('.rp-payment-summary').textContent(),/Repaid by you\$0.00/);
    await active.getByRole('button',{name:'Close',exact:true}).click();
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
    if(process.env.BOOKIEBOT_DUO_SHOTS){fs.mkdirSync(process.env.BOOKIEBOT_DUO_SHOTS,{recursive:true});await cue.click();await page.waitForTimeout(500);await page.screenshot({path:process.env.BOOKIEBOT_DUO_SHOTS+`/repayment-${engine.name()}-${dark?'dark':'light'}-${wide?'folded':'unfolded'}.png`});}
    if(dark){
     if(await cue.getAttribute('aria-expanded')!=='true')await cue.click();
     active=page.getByRole('region',{name:'Split repayment details',exact:true});await active.getByRole('button',{name:'Edit split',exact:true}).click();await active.getByRole('textbox',{name:"Brian's share amount",exact:true}).fill('100.00');await active.getByRole('button',{name:'Review split',exact:true}).click();await active.getByRole('button',{name:'Confirm split',exact:true}).click();
     await cue.waitFor({state:'detached'});assert.equal(await amount(active.locator('.rp-balance-amount')),'$0.00');
     assert.equal(await amount(page.locator('.bi-selected-row[data-entry-id="2026-10:owed"] .bb-daily-transaction-money,.bi-selected-row[data-entry-id="2026-10:owed"] .bb-daily-day-total')),'$100.00','Changing a split never changes confirmed cash paid');
     await active.getByRole('button',{name:'Close',exact:true}).click();
    }
    await page.close();count++;console.log('PASS repayment',engine.name(),dark?'dark':'light',wide?'wide-to-closed':'closed-to-wide');
   }
  }finally{await browser.close()}
 }
 console.log('PASS actual bundle repayment cases:',count);
})().catch(error=>{console.error(error);process.exitCode=1});
