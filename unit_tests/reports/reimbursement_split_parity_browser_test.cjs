// Real shipped controls, native paint and isolated commands in both DUO poses.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines,report}=require('./duo_layout_browser_test.cjs');
const data=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_SHARED_BALANCE_FIXTURE,'utf8'));
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-reimbursement-split-shots';fs.mkdirSync(output,{recursive:true});
const visible=node=>node.filter({visible:true}),settle=page=>page.waitForTimeout(500);
async function press(page,node){await node.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await node.waitFor({state:'visible'});await page.waitForFunction(el=>!el.disabled&&!el.closest('[inert]'),await node.elementHandle());await node.press('Enter');await settle(page)}
const css=(node,props)=>node.evaluate((el,props)=>Object.fromEntries(props.map(p=>[p,getComputedStyle(el)[p]])),props);
async function slide(page,node,reduced){
 await page.evaluate(()=>{window.__splitFrames=(async()=>{const frames=[],start=performance.now();while(performance.now()-start<600){await new Promise(requestAnimationFrame);const nodes=[...document.querySelectorAll('.sr-detail-host[data-open=true] .bi-step-viewport[data-moving=true]')].filter(el=>!el.closest('[inert]'));frames.push(nodes.map(el=>[...el.children].flatMap(p=>p.getAnimations().map(a=>a.effect.getTiming()))));}return frames})();});
 await node.press('Enter');const frames=await page.evaluate(()=>window.__splitFrames);
 assert(frames.every(frame=>frame.length<=1),'Only one scene slides');if(reduced)assert(frames.every(frame=>!frame.length));else{assert(frames.some(frame=>frame.length===1));assert(frames.flat(2).every(a=>a.duration===440&&a.easing==='cubic-bezier(0.22, 0.8, 0.25, 1)'));}await settle(page);
}
function transaction(item,income){return {id:'native:'+item.id,actionId:'native',version:'native-v1',month:'2026-10',date:'2026-10-20',title:item.item,location:item.item,person:item.payerPerson,kind:'expense',category:'shopping',categoryLabel:'Shopping',amountCents:item.grossCents,split:'equal',fields:{},editableFields:[],capabilities:{split:true},reasons:{},splitOptions:{custom:true,payerName:item.payerOwner==='brian'?'Brian':'Hannah',partnerName:item.partnerOwner==='brian'?'Brian':'Hannah',payerBasisPoints:5000,payerCents:item.payerShareCents,incomePayerCents:income},repayment:{id:'ref',version:1,accounting:'cash_v1',direction:'incoming',payerName:item.payerOwner==='brian'?'Brian':'Hannah',partnerName:item.partnerOwner==='brian'?'Brian':'Hannah',grossCents:item.grossCents,payerShareCents:item.payerShareCents,partnerShareCents:item.partnerShareCents,settledCents:0,clearedCents:0,outstandingCents:item.partnerShareCents,pendingCents:0,method:'equal',canEdit:true,editReason:''}}}
(async()=>{let count=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{for(const [width,height,dark,reduced,owner]of [[382,657,false,false,'brian'],[867,480,true,false,'hannah'],[382,657,true,true,'hannah'],[951,648,false,false,'brian']].filter(([w])=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
  const state=structuredClone(data.initial[owner]),id=owner==='brian'?'pge':'costco',source=state.allocations.find(a=>a.id===id),original=structuredClone(source),income=state.splitOptions[id].incomePayerCents,reference=transaction(source,income),name=owner==='brian'?'Brian':'Hannah',writes=[];let lost=false;
  const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{config:{ownerName:name},report:()=>({...report,ownerName:name}),transactions:async route=>route.fulfill({json:{items:[reference],total:1,nextOffset:null,categories:[],persons:[],month:reference.month,snapshotVersion:'native',totalAmountCents:reference.amountCents,days:[{date:reference.date,month:reference.month,count:1,totalCents:reference.amountCents,needsCents:0,wantsCents:reference.amountCents}]}}),request:async route=>{
   const req=route.request();if(new URL(req.url()).pathname!=='/app/reimbursements')return false;
   if(req.method()==='POST'){const body=req.postDataJSON();writes.push(body);assert.equal(body.operation,'edit_split');assert.equal(body.method,'income');assert.equal(body.payerShareCents,income);assert.equal(body.grossCents,original.grossCents);assert.equal(body.version,original.version);assert.equal(body.allocationId,id);assert(body.requestId);
    if(!lost){lost=true;source.payerShareCents=income;source.partnerShareCents=source.grossCents-income;source.outstandingCents=source.partnerShareCents;source.method='income';source.version++;source.projectedVersion=source.version;state.resetState='after-split';await route.fulfill({status:503,json:{error:'Isolated lost acknowledgement'}});return true;}
    assert.deepEqual(body,writes[0],'Retry uses exactly the original reviewed command');
   }await route.fulfill({json:state});return true;
  }});
  try{
   await page.evaluate(name=>localStorage.setItem('bookiebot:duo-layout:'+name.toLowerCase(),'true'),name);await page.reload();await page.locator('.bb-metrics-grid').waitFor();await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
   await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));await page.locator('.sp-cue').waitFor();await press(page,page.locator('.sp-cue'));await press(page,visible(page.getByRole('button',{name:'Edit split',exact:true})));
   const tx=visible(page.locator('.sp-management')),orbStyle=await css(tx.locator('.bs-orb-vessel').first(),['width','height','borderRadius','backgroundColor']),incomeStyle=await css(tx.locator('.bs-income-reset'),['width','height','paddingTop','borderRadius','backgroundColor']),sliderStyle=await css(tx.locator('.bs-slider input'),['height','minHeight','appearance','marginTop','paddingTop']);
   const buttonStyle=await css(tx.getByRole('button',{name:'Review split',exact:true}),['minHeight','fontSize','borderRadius','backgroundColor']);
   await press(page,tx.getByRole('button',{name:'Cancel',exact:true}));await tap(page,page.getByRole('button',{name:'Shared',exact:true}));
   const row=page.locator('.sr-row-main').filter({hasText:source.item}),group=row.locator('..'),chevron=row.locator('.sr-row-chevron');
   const closedStyle=await css(row,['backgroundColor','borderBottomWidth','paddingRight']);assert.equal(closedStyle.borderBottomWidth,'0px');assert.equal(await group.evaluate(el=>getComputedStyle(el).borderBottomWidth),'1px');
   if(width<800&&!reduced){
    await page.evaluate(id=>{const row=[...document.querySelectorAll('.sr-row-main')].find(el=>el.textContent.includes(id)),group=row.parentElement;window.__dividerFrames=(async()=>{const frames=[],start=performance.now();while(performance.now()-start<440){await new Promise(requestAnimationFrame);frames.push(group.getBoundingClientRect().height-row.getBoundingClientRect().height);}return frames})();},source.item);
   }
   await press(page,row);const native=page.locator('.sr-detail-host[data-open=true] .sr-detail-native');
   assert.equal(await native.getByRole('heading',{name:'Reimbursement',exact:true}).count(),0);assert.equal(await native.getByRole('button',{name:'Close reimbursement details'}).count(),0);
   assert.deepEqual(await css(row,['backgroundColor','borderBottomWidth','paddingRight']),closedStyle,'Selection adds no tint or pinned divider');
   assert.equal(await chevron.evaluate(el=>getComputedStyle(el).width),'16px');assert.match(await chevron.evaluate(el=>getComputedStyle(el).transform),/matrix\(-1, 0, 0, -1/);
   assert.deepEqual(await css(native.getByRole('button',{name:'Edit split',exact:true}),['minHeight','fontSize','borderRadius','backgroundColor']),buttonStyle,'Edit split is the actual native filled button');
   if(width<800){const rects=await group.evaluate(el=>({group:el.getBoundingClientRect().toJSON(),panel:el.querySelector('.sr-detail-native').getBoundingClientRect().toJSON(),row:el.querySelector('.sr-row-main').getBoundingClientRect().toJSON()}));assert(rects.group.bottom>=rects.panel.bottom+7,'Divider ends below the editor');assert(rects.group.bottom>rects.row.bottom+150);if(!reduced){const samples=await page.evaluate(()=>window.__dividerFrames);assert(samples.some(n=>n>10&&n<samples.at(-1)-10),'The bottom divider moves with the expansion');}}
   await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${owner}-details.png`)});
   await slide(page,native.getByRole('button',{name:'Edit split',exact:true}),reduced);
   const split=visible(native.locator('.sp-management'));
   assert.deepEqual(await css(split.locator('.bs-orb-vessel').first(),['width','height','borderRadius','backgroundColor']),orbStyle);
   assert.deepEqual(await css(split.locator('.bs-income-reset'),['width','height','paddingTop','borderRadius','backgroundColor']),incomeStyle);
   assert.deepEqual(await css(split.locator('.bs-slider input'),['height','minHeight','appearance','marginTop','paddingTop']),sliderStyle);
   const geometry=await split.evaluate(el=>{const b=s=>el.querySelector(s).getBoundingClientRect(),a=b('.bs-orb:first-child'),z=b('.bs-orb:last-child'),income=b('.bs-income-reset');return {a:a.toJSON(),z:z.toJSON(),income:income.toJSON(),shares:b('.bs-shares').toJSON(),slider:b('.bs-slider').toJSON()}});
   assert(Math.abs((geometry.a.x+geometry.a.width/2+geometry.z.x+geometry.z.width/2)/2-(geometry.income.x+geometry.income.width/2))<1,'Income button is between the circles');assert(geometry.shares.y>=geometry.a.bottom-2);assert(geometry.slider.y>=geometry.shares.bottom-2);
   await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${owner}-split.png`)});
   await press(page,split.locator('.bs-income-reset'));assert.equal(await split.locator('input[type=range]').inputValue(),String(income));assert.equal(writes.length,0);
   await press(page,row);await press(page,row);assert.equal(await split.locator('input[type=range]').inputValue(),String(income));
   await slide(page,split.getByRole('button',{name:'Review split',exact:true}),reduced);assert.equal(writes.length,0);assert.match(await split.innerText(),/By income/);
   await page.setViewportSize({width:width>800?382:867,height:width>800?657:480});await settle(page);assert.equal(await split.getAttribute('data-review'),'true');await page.setViewportSize({width,height});await settle(page);
   await slide(page,split.getByRole('button',{name:'Back',exact:true}),reduced);assert.equal(await split.locator('input[type=range]').inputValue(),String(income));await slide(page,split.getByRole('button',{name:'Review split',exact:true}),reduced);
   await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${owner}-review.png`)});
   await press(page,split.getByRole('button',{name:'Confirm split',exact:true}));await page.getByRole('button',{name:'Retry this record',exact:true}).waitFor();assert.equal(writes.length,1);assert.equal(await native.getAttribute('data-detail-mode'),'split','An unknown save cannot invent completion');
   await press(page,page.getByRole('button',{name:'Retry this record',exact:true}));assert.equal(writes.length,2);await native.locator('.rp-balance').waitFor();
   if(!reduced){await group.waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('.sr-detail-host[data-open=true]')?.closest('.sr-row-group')?.dataset.feedback==='animating');assert(await native.locator('.bi-money-change').evaluateAll(nodes=>nodes.some(el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect.getTiming().duration===1200))),'Native number reels animate after returning to details');
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(120);assert.equal(await group.getAttribute('data-feedback'),'animating','A fresh read of the same revision cannot cut feedback short');}
   await page.waitForTimeout(reduced?50:2000);assert.match(await native.innerText(),/By income/);assert.equal(source.expenseDate,original.expenseDate);assert.equal(source.grossCents,original.grossCents);assert.equal(source.settledCents,0);assert.equal(state.events.length,data.initial[owner].events.length);
   await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${owner}-saved.png`)});
   await press(page,native.getByRole('button',{name:'Cancel',exact:true}));assert.equal(await row.getAttribute('aria-expanded'),'false');assert.equal(await chevron.evaluate(el=>getComputedStyle(el).transform),'none');
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);count++;console.log('PASS native reimbursement split/row/review/retry/feedback/fold',engine.name(),width,owner,reduced);
  }catch(e){await page.screenshot({path:path.join(output,'failure.png')});throw e}finally{await page.close()}
 }}finally{await browser.close()}
}console.log(count+' native reimbursement split parity cases passed; screenshots '+output)})().catch(e=>{console.error(e);process.exitCode=1});
