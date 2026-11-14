// Real shipped UI and canonical API shapes; no production financial writes.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap:nativeTap,engines}=require('./duo_layout_browser_test.cjs');
const virtual=process.env.VIRTUAL_ONLY==='1';
const base={id:'loan',name:'Student Loan',type:virtual?'subscription':'fixed',amountCents:6000,cadence:'monthly',pullDay:1,pullMonths:[],category:'static_bills_subscriptions_needs',account:'Checking',active:true,effectiveFrom:'0001-01',effectiveUntil:'9999-12',earliestEffectiveMonth:'2026-12',splitMethod:'none',payerBasisPoints:10000,version:'v1',nextDate:'2026-12-01',needsSetup:false,charge:{available:true,recorded:!virtual,virtual,amountCents:virtual?0:6000,month:'2026-11',date:'2026-11-01',version:'cv1'}};
async function fitCurrent(page){if((await page.viewportSize()).width<800)return;const view=await page.evaluate(()=>{const host=document.querySelector('.bb-bills-editor'),r=host.getBoundingClientRect(),nav=document.querySelector('.bb-navigation-pane').getBoundingClientRect(),buttons=[...host.querySelectorAll('.bi-editor-footer button')].filter(n=>!n.closest('[inert]')&&getComputedStyle(n).visibility!=='hidden').map(n=>n.getBoundingClientRect().toJSON());return {host:r.toJSON(),nav:nav.toJSON(),buttons,scroll:[host.scrollHeight,host.clientHeight]}});assert(view.buttons.every(b=>b.bottom<view.nav.y-6&&b.x>=view.host.x-1&&b.right<=view.host.right+1),'Current charge footer fits above the dock: '+JSON.stringify(view));assert(view.scroll[0]<=view.scroll[1]+1,'Current charge fits without scrolling: '+JSON.stringify(view))}
async function shot(page,name){if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.BOOKIEBOT_SCREENSHOT_DIR}/${name}.png`,fullPage:true})}}
async function tap(page,button){await button.evaluate(n=>n.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForTimeout(100);await nativeTap(page,button);await page.waitForTimeout(510)}
(async()=>{let count=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch();try{for(const dark of (virtual?[false]:[false,true]))for(const width of [320,382,867,951].filter(w=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
  const openHeight=Number(process.env.ONLY_HEIGHT||648);
  const commands=[],transactionCommands=[],reviews=[],saved=new Map();let revision=0,lose=false,loseBill=false,unreceived=null;
  const bills=[structuredClone(base),{...structuredClone(base),id:'water',name:'Water',charge:{...base.charge,recorded:false,amountCents:6000,date:'2026-11-22'},pullDay:22,earliestEffectiveMonth:'2026-11'}];
  let row={id:'2026-11:loan-source',actionId:'loan-source',month:'2026-11',date:'2026-11-01',version:'row-0',title:'Student Loan',location:'',person:'Brian',kind:'payment',category:'static_bills_subscriptions_needs',categoryLabel:'Needs',amountCents:6000,fields:{amount:'60.00'},split:'',editableFields:['amount'],capabilities:{update:true,split:true,cancel_split:true},reasons:{},splitOptions:{custom:true,payerName:'Brian',partnerName:'Hannah',incomePayerCents:3884,payerBasisPoints:10000}};
  const {page,errors,unexpected}=await fixture(browser,width,width>=800?openHeight:669,dark,false,false,width===951?84:0,{
   bills:async route=>{const req=route.request(),url=new URL(req.url()),reply=value=>route.fulfill({json:value});if(req.method()==='GET'){
    if(url.pathname.includes('/commands/'))return reply(saved.get(url.pathname.split('/').pop()));
    if(url.pathname.endsWith('/charge'))return reply({transaction:{month:row.month,id:row.id,date:row.date},item:row});
    return reply({month:'2026-11',today:'2026-11-13',settingsVersion:'sv-'+revision,ownerName:'Brian',partnerName:'Hannah',incomeBasisPoints:6473,splitsEnabled:true,bills});
   }
   const body=req.postDataJSON(),before=bills.find(b=>b.id===body.id),after={...before,...body.bill,amountCents:Math.round(Number(body.bill?.amount||60)*100)};
   if(url.pathname.endsWith('/review')){reviews.push(body);return reply({review:body.operation==='adopt'?{operation:'adopt',name:before.name,amountCents:6000,reviewVersion:'rv-'+revision}:{operation:body.operation,before,after,effectiveFrom:body.bill.effectiveFrom,reviewVersion:'rv-'+revision}})}
   assert(body.requestId&&body.reviewVersion);commands.push(body);if(body.operation==='adopt')before.charge={...before.charge,virtual:false,recorded:true,amountCents:6000};else before.nextChange=after;revision++;const result={state:'done',success:true,detail:'Recurring settings saved.'};saved.set(body.requestId,result);if(loseBill){loseBill=false;return route.abort('failed')}return reply(result);
   },transactions:async route=>{const req=route.request(),url=new URL(req.url()),reply=value=>route.fulfill({json:value});if(req.method()==='GET'){
    if(url.pathname.includes('/commands/')){const result=saved.get(url.pathname.split('/').pop());return result?reply(result):route.fulfill({status:404,json:{error:'No saved request exists.'}})}
    return reply({items:[row],total:1,nextOffset:null,categories:[],persons:[],month:'2026-11'});
   }
   const body=req.postDataJSON(),after={...row.fields,...(body.updates?{amount:(body.updates.amount/100).toFixed(2)}:{})},share=body.operation==='split'?{method:body.method,payerCents:Math.round(row.amountCents*.6473),partnerCents:row.amountCents-Math.round(row.amountCents*.6473)}:undefined;
   if(url.pathname.endsWith('/review')){reviews.push(body);return reply({review:{operation:body.operation,item:row,after,share,reviewVersion:'trv-'+revision}})}
   assert(body.requestId&&body.reviewVersion);assert.equal(body.version,row.version);if(lose&&process.env.LOST_BEFORE==='1'){lose=false;unreceived=body;return route.abort('failed')}if(unreceived){assert.deepEqual(body,unreceived,'Retry keeps the exact original request and ID');unreceived=null}transactionCommands.push(body);
   if(body.operation==='update')row={...row,amountCents:body.updates.amount,fields:after};else row={...row,split:body.method,splitOptions:{...row.splitOptions,payerBasisPoints:6473}};
   row={...row,version:'row-'+(++revision)};const result={state:'done',success:true,detail:'Charge updated.'};saved.set(body.requestId,result);if(lose){lose=false;return route.abort('failed')}return reply(result);
   }
  });
  await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));
  const txGeometry=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,width:r.width}};return {left:box('.bb-recorded-search'),right:box('.bb-recorded-graph-reveal')}});
  await tap(page,page.getByRole('button',{name:'Settings',exact:true}));
  const top=page.locator('.bb-settings-masthead-title');assert.equal(await top.locator('h1').innerText(),'Settings');assert.equal(await page.locator('.bb-report-brand:visible').count(),0,'No brand in Settings');
  const glass=await page.evaluate(()=>{const style=s=>{const n=document.querySelector(s),c=getComputedStyle(n);return {height:c.height,bg:c.backgroundColor,shadow:c.boxShadow,radius:c.borderRadius}};return [style('.bb-settings-masthead-title .bb-glass-control'),style('.bb-shell-header-actions .bb-glass-control')]});assert.deepEqual(glass[0],glass[1],'Back uses the same glass surface');
  await tap(page,page.getByRole('button',{name:'Manage bills & subscriptions',exact:true}));assert.equal(await top.locator('h1').innerText(),'Bills');
  const panel=page.locator('main[aria-label="Bills"]'),loan=panel.locator('.bb-bills-row').filter({hasText:'Student Loan'}),water=panel.locator('.bb-bills-row').filter({hasText:'Water'});
  if(width>=800){const geo=await panel.evaluate(p=>{const box=s=>{const r=p.querySelector(s).getBoundingClientRect();return {x:r.x,width:r.width}};return {left:box('.bb-bills-list'),right:box('.bb-bills-editor')}});for(const side of ['left','right'])for(const key of ['x','width'])assert(Math.abs(geo[side][key]-txGeometry[side][key])<1,`Bills ${side} ${key} matches Transactions`)}
  await tap(page,loan);await panel.getByRole('textbox',{name:'Recurring amount',exact:true}).fill('70.00');
  await tap(page,water);assert.equal(await panel.getByRole('textbox',{name:'Name',exact:true}).inputValue(),'Water','Any row can switch the editor in either pose');
  await panel.getByRole('textbox',{name:'Recurring amount',exact:true}).fill('65.00');await tap(page,panel.getByRole('button',{name:'Review',exact:true}));assert(await panel.getByRole('heading',{name:'Review bill',exact:true}).isVisible(),'An unrecorded upcoming charge needs no already-hit prompt');assert.equal(reviews.at(-1).bill.effectiveFrom,'2026-11','Eligible current month is inclusive');assert.equal(commands.length,0);await tap(page,panel.getByRole('button',{name:'Back',exact:true}));
  await tap(page,loan);assert.equal(await panel.getByRole('textbox',{name:'Recurring amount',exact:true}).inputValue(),'70.00','Switching retains the draft');
  await tap(page,loan);assert.equal(await panel.locator('.bb-bills-editor').getAttribute('data-open'),'false','Parent row toggles the editor closed');
  await tap(page,loan);await panel.getByRole('textbox',{name:'Recurring amount',exact:true}).fill('70.00');
  const host=panel.locator('.bb-bills-editor');await host.evaluate(n=>window.__billWorkspace=n);
  await tap(page,panel.getByRole('button',{name:/^Recurring split/}));
  await page.waitForTimeout(80);
  await panel.getByRole('textbox',{name:"Brian's share percentage",exact:true}).fill('30.25');await tap(page,panel.getByRole('button',{name:'Split by income',exact:true}));
  assert.equal(await panel.getByRole('textbox',{name:"Brian's share percentage",exact:true}).inputValue(),'64.73');
  await page.setViewportSize({width:width<800?867:382,height:width<800?openHeight:669});await page.waitForTimeout(540);assert(await host.evaluate(n=>window.__billWorkspace===n),'Folding retains the same workspace');assert.equal(await panel.getByRole('textbox',{name:"Brian's share percentage",exact:true}).inputValue(),'64.73');
  await page.setViewportSize({width,height:width>=800?openHeight:669});await page.waitForTimeout(540);
  await shot(page,`recurring-split-${engine.name()}-${width}-${dark?'dark':'light'}`);
  await tap(page,panel.getByRole('button',{name:'Use split',exact:true}));
  await shot(page,`recurring-config-${engine.name()}-${width}-${dark?'dark':'light'}`);
  const beforeReview=reviews.length;await tap(page,panel.getByRole('button',{name:'Review',exact:true}));assert(await panel.getByRole('heading',{name:'Review bill',exact:true}).isVisible());assert.equal(reviews.length,beforeReview+1,'Recurring review precedes the post-save question');
  assert.equal(reviews.at(-1).bill.effectiveFrom,'2026-12');assert.equal(commands.length,0);assert.equal(transactionCommands.length,0);
  assert((await panel.getByRole('definition').allTextContents()).some(t=>t.includes('December 2026 onward')));
  await tap(page,panel.getByRole('button',{name:'Confirm',exact:true}));assert.equal(commands.length,1);assert.equal(transactionCommands.length,0,'Recurring save leaves the recorded charge untouched');assert.equal(row.amountCents,6000);
  assert(await panel.getByRole('heading',{name:'Update November too?',exact:true}).isVisible());await tap(page,panel.getByRole('button',{name:'Keep November as is',exact:true}));
  // The saved rule is complete before opting into a separately reviewed charge.
  await tap(page,loan);await panel.getByRole('textbox',{name:'Recurring amount',exact:true}).fill('80.00');
  await tap(page,panel.getByRole('button',{name:'Review',exact:true}));if(virtual)loseBill=true;await tap(page,panel.getByRole('button',{name:'Confirm',exact:true}));
  if(virtual){await panel.getByRole('button',{name:'Check saved status',exact:true}).waitFor();await page.reload();if(!await page.getByRole('button',{name:'Manage bills & subscriptions',exact:true}).isVisible())await tap(page,page.getByRole('button',{name:'Settings',exact:true}));await tap(page,page.getByRole('button',{name:'Manage bills & subscriptions',exact:true}));await tap(page,panel.getByRole('button',{name:'Check saved status',exact:true}))}
  await panel.getByRole('heading',{name:'Update November too?',exact:true}).waitFor();assert.equal(transactionCommands.length,0);await tap(page,panel.getByRole('button',{name:'Review charge',exact:true}));
  if(virtual){await panel.getByRole('heading',{name:'Recorded charge',exact:true}).waitFor();await tap(page,panel.getByRole('button',{name:'Review',exact:true}));assert.equal(commands.filter(c=>c.operation==='adopt').length,0,'Adoption is separately reviewed');await tap(page,panel.getByRole('button',{name:'Confirm',exact:true}));assert.equal(commands.filter(c=>c.operation==='adopt').length,1)}
  await panel.getByRole('heading',{name:'This month’s charge',exact:true}).waitFor();await page.waitForTimeout(540);await fitCurrent(page);assert.equal(transactionCommands.length,0,'Recurring save never silently edits an existing charge');assert.equal(await page.locator('.bb-page').getAttribute('data-screen'),'settings');
  assert.equal(await panel.getByRole('textbox',{name:'Amount',exact:true}).inputValue(),'80.00');
  await tap(page,panel.getByRole('button',{name:'Review change',exact:true}));lose=true;await tap(page,panel.getByRole('button',{name:'Confirm update',exact:true}));
  await panel.getByRole('button',{name:'Check saved status',exact:true}).waitFor();if(virtual){await page.reload();if(!await page.getByRole('button',{name:'Manage bills & subscriptions',exact:true}).isVisible())await tap(page,page.getByRole('button',{name:'Settings',exact:true}));await tap(page,page.getByRole('button',{name:'Manage bills & subscriptions',exact:true}))}await tap(page,panel.getByRole('button',{name:'Check saved status',exact:true}));if(process.env.LOST_BEFORE==='1'){assert.equal(transactionCommands.length,0,'An unreceived confirmation has no writer');await fitCurrent(page);await tap(page,panel.getByRole('button',{name:'Retry same confirmation',exact:true}))}
  await panel.getByRole('heading',{name:'Edit split',exact:true}).waitFor();await page.waitForTimeout(540);await fitCurrent(page);assert.equal(transactionCommands.length,1,'Recovery cannot repeat an amount writer');
  await tap(page,panel.getByRole('button',{name:'Review split',exact:true}));
  await page.setViewportSize({width:width<800?867:382,height:width<800?openHeight:669});await page.waitForTimeout(540);assert(await panel.getByRole('heading',{name:'Review split',exact:true}).isVisible(),'Current-charge review survives folding');await fitCurrent(page);
  await tap(page,panel.getByRole('button',{name:'Confirm split',exact:true}));await panel.getByRole('heading',{name:'This month is up to date',exact:true}).waitFor();
  assert.equal(transactionCommands.length,2);assert.equal(row.amountCents,8000);assert.equal(row.split,'income');assert.equal(new Set(transactionCommands.map(c=>c.requestId)).size,2);
  if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:`${process.env.BOOKIEBOT_SCREENSHOT_DIR}/bills-recurring-${engine.name()}-${width}-${dark?'dark':'light'}.png`,fullPage:true})}
  await tap(page,panel.getByRole('button',{name:'Close',exact:true}));await tap(page,page.getByRole('button',{name:'Back',exact:true}));assert.equal(await top.locator('h1').innerText(),'Settings');
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.close();count++;console.log('PASS recurring Bills',engine.name(),width,dark?'dark':'light',virtual?'virtual/reload':'recorded');
 }}finally{await browser.close()}
}console.log(`${count} recurring Bills workspace cases passed`)
})().catch(error=>{console.error(error);process.exitCode=1});
