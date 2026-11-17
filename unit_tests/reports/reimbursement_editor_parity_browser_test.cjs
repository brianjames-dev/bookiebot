// Compare real rendered Transactions and Shared editors, not copied CSS values.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const data=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_SHARED_BALANCE_FIXTURE,'utf8'));
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-reimbursement-editor-shots';fs.mkdirSync(output,{recursive:true});
const row={id:'2026-10:parity',actionId:'parity',version:'v1',month:'2026-10',date:'2026-10-20',title:'Supplies',location:'Target',person:'Brian',kind:'expense',category:'shopping',categoryLabel:'Shopping',amountCents:10000,displayAmountCents:10000,split:'equal',fields:{item:'Supplies',location:'Target',person:'Brian',amount:'100.00'},editableFields:['item','location','person','amount'],capabilities:{update:true,split:true,delete:true,move:true,cancel_split:true},reasons:{},splitOptions:{custom:true,payerName:'Brian',partnerName:'Hannah',payerBasisPoints:5000,payerCents:5000,incomePayerCents:5731},repayment:{id:'native-parity',version:1,accounting:'cash_v1',direction:'incoming',payerName:'Brian',partnerName:'Hannah',grossCents:10000,payerShareCents:5000,partnerShareCents:5000,settledCents:0,clearedCents:0,outstandingCents:5000,pendingCents:0,method:'equal',canEdit:true,editReason:''}};
const visible=locator=>locator.filter({visible:true});
async function settle(page){await page.waitForTimeout(500)}
async function ready(page,node){await node.waitFor({state:'visible'});await page.waitForFunction(el=>!el.disabled&&!el.closest('[inert]'),await node.elementHandle());}
async function press(page,node){await node.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await ready(page,node);await node.press('Enter');await settle(page)}
const style=(node,props)=>node.evaluate((el,props)=>Object.fromEntries(props.map(p=>[p,getComputedStyle(el)[p]])),props);
const inputProps=['fontSize','lineHeight','height','paddingTop','paddingBottom','borderRadius','borderBottomWidth','backgroundColor','color','outlineWidth','outlineStyle'];
const buttonProps=['fontSize','minHeight','borderRadius','paddingLeft','paddingRight','color','backgroundColor'];
async function slide(page,node,reduced){
 await ready(page,node);
 await page.evaluate(()=>{window.__sharedFrames=(async()=>{const frames=[],start=performance.now();while(performance.now()-start<600){await new Promise(requestAnimationFrame);const host=document.querySelector('.sr-detail-host[data-open=true]'),moving=[...host.querySelectorAll('.bi-step-viewport[data-moving=true]')].filter(v=>!v.closest('[inert]'));
  frames.push({moving:moving.length,scroll:[...host.querySelectorAll('.bi-step-viewport')].map(v=>v.scrollLeft),animations:moving.flatMap(v=>[...v.children].flatMap(p=>p.getAnimations().filter(a=>a.effect.getKeyframes().some(k=>'transform'in k)).map(a=>a.effect.getTiming())))});}return frames})();});
 await node.press('Enter');const frames=await page.evaluate(()=>window.__sharedFrames);
 assert(frames.every(f=>f.moving<=1),'Only one native slide layer moves');assert(frames.every(f=>f.scroll.every(x=>Math.abs(x)<1)),'Focus never pans the editor');
 if(reduced)assert(frames.every(f=>!f.moving));else{assert(frames.some(f=>f.moving===1),'Native slide is visible');assert(frames.flatMap(f=>f.animations).every(a=>a.duration===440&&a.easing==='cubic-bezier(0.22, 0.8, 0.25, 1)'));}
 await settle(page);
}
(async()=>{let cases=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{for(const [width,height,dark,reduced]of [[382,657,false,false],[867,480,true,false],[382,657,true,true],[951,648,false,false]].filter(([w])=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
  const state=structuredClone(data.initial.brian),writes=[];
  const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{transactions:async route=>{assert.equal(route.request().method(),'GET','Transactions reference is read only');await route.fulfill({json:{items:[row],total:1,nextOffset:null,categories:['shopping'],persons:['Brian'],month:row.month,snapshotVersion:'parity',totalAmountCents:10000,days:[{date:row.date,month:row.month,count:1,totalCents:10000,needsCents:0,wantsCents:10000}]}})},request:async route=>{
   const req=route.request();if(new URL(req.url()).pathname!=='/app/reimbursements')return false;
   if(req.method()==='POST'){const body=req.postDataJSON();writes.push(body);assert.equal(body.operation,'receive');assert.equal(body.allocationId,'pge');assert.equal(body.amountCents,1234);assert.equal(body.note,'Native payment draft');assert(body.requestId);const a=state.allocations.find(a=>a.id==='pge');assert.equal(body.version,a.version);a.settledCents+=1234;a.outstandingCents-=1234;a.version++;a.projectedVersion=a.version;state.resetState='after-partial';}
   await route.fulfill({json:state});return true;
  }});
  try{
   await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
   await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));await page.getByRole('button',{name:'Show actions for Target',exact:true}).waitFor();
   const access=page.getByRole('button',{name:'Show actions for Target',exact:true});await access.press(width>800?'Enter':'ArrowLeft');await settle(page);
   await press(page,page.getByRole('button',{name:(width>800?'Edit':'Update')+' Target',exact:true}));
   const tx=visible(page.getByRole('region',{name:'Edit transaction',exact:true}));
   await tx.locator('input[inputmode=decimal]').evaluate(el=>el.focus({preventScroll:true}));
   const inputStyle=await style(tx.locator('input[inputmode=decimal]'),inputProps),primaryStyle=await style(tx.getByRole('button',{name:'Review change',exact:true}),buttonProps),cancelStyle=await style(tx.getByRole('button',{name:'Cancel',exact:true}),buttonProps);
   await press(page,tx.getByRole('button',{name:'Cancel',exact:true}));await press(page,page.locator('.sp-cue'));
   const repayment=visible(page.getByRole('region',{name:'Split repayment details',exact:true}));
   const allocationStyle=await style(repayment.locator('.rp-avatar').first(),['width','height','fontSize','backgroundColor']),shareStyle=await style(repayment.locator('.rp-share strong').first(),['fontSize','fontWeight','lineHeight']),balanceStyle=await style(repayment.locator('.rp-balance-amount'),['fontSize','fontWeight','lineHeight']);
   await tap(page,page.getByRole('button',{name:'Shared',exact:true}));await press(page,page.locator('.sr-row-main').filter({hasText:'PG&E'}));
   const detail=page.locator('.sr-detail-host[data-open=true]'),native=detail.locator('.sr-detail-native');
   assert.equal(await native.count(),1,'Shared uses the native Transactions editor surface');
   if(width>800){
    assert.equal(await page.locator('.sr-right').getAttribute('inert'),'','The inactive balance summary is inert');
    assert.equal(await page.locator('.sr-right .bi-step-pane').first().evaluate(el=>getComputedStyle(el).visibility),'hidden','Nested motion panes cannot repaint the inactive balance summary');
    const heading=native.getByRole('heading',{name:'Reimbursement',exact:true});
    assert(await heading.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+Math.min(8,r.width/2),r.y+r.height/2);return r.y>=0&&r.bottom<innerHeight&&el.contains(hit)}),'The reimbursement heading paints in the usable right pane');
   }
   assert.deepEqual(await style(native.locator('.rp-avatar').first(),['width','height','fontSize','backgroundColor']),allocationStyle);
   assert.deepEqual(await style(native.locator('.rp-share strong').first(),['fontSize','fontWeight','lineHeight']),shareStyle);
   assert.deepEqual(await style(native.locator('.rp-balance-amount'),['fontSize','fontWeight','lineHeight']),balanceStyle);
   await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${dark?'dark':'light'}-detail.png`)});
   await slide(page,native.getByRole('button',{name:'Record received',exact:true}),reduced);
   const amount=visible(native.locator('input[inputmode=decimal]'));
   await amount.evaluate(el=>el.focus({preventScroll:true}));
   assert.deepEqual(await style(amount,inputProps),inputStyle,'Payment input is the native Transactions field');
   assert.deepEqual(await style(native.getByRole('button',{name:'Confirm received record',exact:true}),buttonProps),primaryStyle);
   assert.deepEqual(await style(native.getByRole('button',{name:'Cancel',exact:true}),buttonProps),cancelStyle);
   await amount.fill('12.34');await visible(native.locator('input[maxlength="200"]')).fill('Native payment draft');
   await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${dark?'dark':'light'}-payment.png`)});
   await press(page,native.getByRole('button',{name:'Close reimbursement details'}));await press(page,page.locator('.sr-row-main').filter({hasText:'PG&E'}));assert.equal(await visible(detail.locator('input[inputmode=decimal]')).inputValue(),'12.34');
   await page.setViewportSize({width:width>800?382:867,height:width>800?657:480});await settle(page);assert.equal(await visible(detail.locator('input[inputmode=decimal]')).inputValue(),'12.34');await page.setViewportSize({width,height});await settle(page);
   await slide(page,native.getByRole('button',{name:'Cancel',exact:true}),reduced);assert.equal(writes.length,0);
   await slide(page,native.getByRole('button',{name:'Edit split',exact:true}),reduced);await slide(page,native.getByRole('button',{name:'Cancel',exact:true}),reduced);
   await slide(page,native.getByRole('button',{name:'History (0)',exact:true}),reduced);await slide(page,native.getByRole('button',{name:'Back',exact:true}),reduced);
   await slide(page,native.getByRole('button',{name:'Record received',exact:true}),reduced);await visible(native.locator('input[inputmode=decimal]')).fill('12.34');await visible(native.locator('input[maxlength="200"]')).fill('Native payment draft');
   await visible(native.locator('input[inputmode=decimal]')).fill('9999');await press(page,native.getByRole('button',{name:'Confirm received record',exact:true}));assert.equal(writes.length,0,'Native field styling preserves amount validation');await native.getByRole('alert').waitFor();
   await visible(native.locator('input[inputmode=decimal]')).fill('12.34');await press(page,native.getByRole('button',{name:'Confirm received record',exact:true}));assert.equal(writes.length,1);assert.equal(await native.getAttribute('data-detail-mode'),'summary');assert.match(await native.locator('.rp-balance-amount').innerText(),/41.30/);
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);cases++;console.log('PASS native reimbursement detail/fields/buttons/440ms slides/drafts/payment',engine.name(),width,dark,reduced);
  }catch(error){console.log(await page.evaluate(()=>({screen:document.querySelector('.bb-page').dataset.screen,selected:[...document.querySelectorAll('.sr-row-main')].map(el=>({text:el.textContent,expanded:el.getAttribute('aria-expanded')})),native:document.querySelectorAll('.sr-detail-native').length})));await page.screenshot({path:path.join(output,'failure.png')});throw error}finally{await page.close()}
 }}finally{await browser.close()}
}console.log(cases+' native reimbursement parity cases passed; screenshots '+output)})().catch(e=>{console.error(e);process.exitCode=1});
