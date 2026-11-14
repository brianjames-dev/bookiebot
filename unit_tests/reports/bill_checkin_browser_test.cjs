// Actual shipped components; all bill/transaction writes stay in local fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,engines}=require('./duo_layout_browser_test.cjs');
const {enter,panel,press}=require('./bill_pane_fit_browser_test.cjs');
const base={id:'pge',name:'PG&E',type:'variable',amountCents:null,cadence:'monthly',pullDay:22,pullMonths:[],category:'bills_utilities',account:'Checking',active:true,effectiveFrom:'0001-01',effectiveUntil:'9999-12',earliestEffectiveMonth:'2026-11',splitMethod:'none',payerBasisPoints:10000,version:'v1',nextDate:'2026-11-22',needsSetup:false,checkInLeadDays:7,charge:{available:true,recorded:false,amountCents:0,month:'2026-11',date:'2026-11-22',version:'c1',status:'unconfirmed',canConfirmAmount:true}};
async function shot(page,label){if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.BOOKIEBOT_SCREENSHOT_DIR,label+'.png')})}}
async function fit(page){return panel(page).locator('.bb-bills-editor').evaluate(host=>{const r=host.getBoundingClientRect(),active=[...host.querySelectorAll('.bi-editor-footer button,input,select')].filter(n=>!n.closest('[inert]')&&n.getBoundingClientRect().width>0);return {height:r.height,scroll:host.scrollHeight,client:host.clientHeight,controls:active.map(n=>{const b=n.getBoundingClientRect();return {y:b.y,bottom:b.bottom,top:r.top,end:r.bottom,hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.closest('button,input,select')===n}})}})}
(async()=>{let count=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{for(const c of [{width:320,height:740,dark:true,rail:0,later:true},{width:382,height:740,dark:false,rail:0},{width:867,height:480,dark:true,rail:0},{width:951,height:648,dark:false,rail:84}].filter(c=>!process.env.ONLY_WIDTH||c.width===Number(process.env.ONLY_WIDTH))){
  let eligible=false,shown=false,claims=0,acks=0,preferenceWrites=0,amountWrites=0,transactionWrites=0;const bill=structuredClone(base),reviews=[];
  const snapshot=()=>({month:'2026-11',today:'2026-11-15',settingsVersion:'v1',ownerName:'Brian',partnerName:'Hannah',incomeBasisPoints:6473,splitsEnabled:true,bills:[bill]});
  const row=()=>({id:'2026-11:pge-action',actionId:'pge-action',month:'2026-11',date:'2026-11-22',version:'source-'+transactionWrites,title:'PG&E',location:'',person:'Brian',kind:'payment',category:'bills_utilities',categoryLabel:'Bills & utilities',amountCents:bill.charge.billAmountCents,fields:{amount:(bill.charge.billAmountCents/100).toFixed(2)},split:'',editableFields:['amount'],capabilities:{update:true,split:true},reasons:{}});
  let day;
  const {page,errors,unexpected}=await fixture(browser,c.width,c.height,c.dark,false,false,c.rail,{
   checkin:route=>{const req=route.request(),url=new URL(req.url()),body=req.postDataJSON(),bills=eligible?[{id:'pge',name:'PG&E',month:'2026-11',date:'2026-11-22',overdue:false}]:[];
    if(url.pathname.endsWith('/preferences')){assert.equal(body.id,'pge');assert.equal(body.leadDays,3);preferenceWrites++;bill.checkInLeadDays=3;return route.fulfill({json:body})}
    if(req.method()==='GET')return route.fulfill({json:{day,bills}});
    if(body.action==='shown'){shown=true;acks++;return route.fulfill({json:{day,shown:true}})}
    if(body.action==='release')return route.fulfill({json:{day,claimed:false}});
    assert.equal(body.action,'claim');claims++;return route.fulfill({json:{day,claimed:!shown,bills}})
   },
   bills:route=>{const req=route.request(),url=new URL(req.url());if(req.method()==='GET')return route.fulfill({json:url.pathname.endsWith('/charge')?{item:row(),transaction:{id:row().id,month:'2026-11',date:'2026-11-22'}}:snapshot()});const body=req.postDataJSON();assert.equal(body.operation,'amount');
    if(url.pathname.endsWith('/review')){reviews.push(body);return route.fulfill({json:{review:{operation:'amount',name:'PG&E',amountCents:12567,month:'2026-11',date:'2026-11-15',paymentDate:'2026-11-22',share:{method:'none',payerCents:12567,partnerCents:0},reviewVersion:'review-v1'}}})}
    assert(body.requestId&&body.reviewVersion);amountWrites++;eligible=false;bill.charge={...bill.charge,recorded:true,amountCents:12567,billAmountCents:12567,status:'confirmed',version:'c2'};return route.fulfill({json:{state:'done',success:true,detail:'Bill amount confirmed.'}})
   },
   transactions:route=>{const req=route.request(),url=new URL(req.url());if(req.method()==='GET')return route.fulfill({json:{items:[],total:0,nextOffset:null,categories:[],persons:[],month:'2026-10',snapshotVersion:'actual-only',days:[],totalAmountCents:0}});const body=req.postDataJSON();assert.equal(body.operation,'update');assert.equal(body.updates.amount,12678);
    if(url.pathname.endsWith('/review'))return route.fulfill({json:{review:{item:row(),operation:'update',after:{amount:'126.78'},reviewVersion:'canonical-review'}}});assert(body.requestId);transactionWrites++;bill.charge.amountCents=bill.charge.billAmountCents=12678;return route.fulfill({json:{state:'done',success:true}})
   }
  });
  try{
   day=await page.evaluate(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
   await enter(page);await press(panel(page).locator('.bb-bills-row'));eligible=true;await page.evaluate(()=>{window.dispatchEvent(new Event('bookiebot:transactions-changed'));document.dispatchEvent(new Event('visibilitychange'))});
   await page.waitForTimeout(1500);assert.equal(claims,0,'A dirty editor defers the check-in');assert.equal(await page.locator('.bb-bill-checkin[open]').count(),0);
   await press(panel(page).getByRole('button',{name:'Cancel',exact:true}));const popup=page.getByRole('dialog',{name:'Confirm upcoming bills',exact:true});await popup.waitFor();await page.waitForFunction(()=>document.querySelector('.bb-bill-checkin[open]'));
   assert.equal(claims,1);await page.waitForTimeout(80);assert.equal(acks,1,'Visibility is acknowledged only after the modal opens');
   const box=await popup.boundingBox();assert(box.x>=15&&box.y>=15&&box.x+box.width<=c.width-c.rail-14&&box.y+box.height<=c.height-14,'Prompt fits the usable viewport');await shot(page,`checkin-${engine.name()}-${c.width}`);
   if(c.later){await popup.getByRole('button',{name:'Later',exact:true}).click();await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))});await page.waitForTimeout(1500);assert.equal(claims,1);assert.equal(await page.locator('.bb-bill-checkin[open]').count(),0);assert.equal(amountWrites,0)}
   else{
    await popup.getByRole('button',{name:/PG&E/}).click();await panel(page).getByRole('textbox',{name:'Bill amount',exact:true}).waitFor();assert.equal(await panel(page).getByRole('textbox',{name:'Name',exact:true}).count(),0,'Direct handoff opens the monthly amount scene');
    await panel(page).getByRole('combobox',{name:'Amount check-in',exact:true}).selectOption('3');await page.waitForTimeout(100);assert.equal(preferenceWrites,1);
    await panel(page).getByRole('textbox',{name:'Bill amount',exact:true}).fill('125.67');await press(panel(page).getByRole('button',{name:'Review',exact:true}));assert.equal(amountWrites,0);assert.equal(reviews.length,1);await shot(page,`amount-review-${engine.name()}-${c.width}`);
    await page.setViewportSize({width:c.width>=800?382:867,height:c.width>=800?740:480});await page.waitForTimeout(550);assert.match(await panel(page).innerText(),/\$125.67/);
    await page.setViewportSize({width:c.width,height:c.height});await page.waitForTimeout(550);await press(panel(page).getByRole('button',{name:'Confirm amount',exact:true}));assert.equal(amountWrites,1);
    const clock=panel(page).getByRole('button',{name:'Scheduled PG&E',exact:true});await clock.waitFor();await press(clock);assert.match(await panel(page).innerText(),/Amount confirmed/);assert.match(await panel(page).innerText(),/Nov 22/);
    if(c.width>=800){const bounds=await fit(page);assert(bounds.scroll<=bounds.client+1&&bounds.controls.every(b=>b.y>=b.top-1&&b.bottom<=b.end+1&&b.hit),'Monthly details and footer fit without scrolling: '+JSON.stringify(bounds))}
    await shot(page,`scheduled-bill-${engine.name()}-${c.width}`);await press(panel(page).getByRole('button',{name:'Edit amount',exact:true}));const input=panel(page).getByRole('textbox',{name:/Amount/});await input.waitFor();await input.fill('126.78');await press(panel(page).getByRole('button',{name:'Review change',exact:true}));await press(panel(page).getByRole('button',{name:'Confirm update',exact:true}));await panel(page).getByRole('heading',{name:'This month is up to date',exact:true}).waitFor();assert.equal(transactionWrites,1,'Scheduled invoice correction uses the canonical writer without creating another split');await press(panel(page).getByRole('button',{name:'Close',exact:true}));await press(panel(page).getByRole('button',{name:'Scheduled PG&E',exact:true}));assert.match(await panel(page).locator('.bb-bills-month-amount').innerText(),/126.78/,'Reloaded scheduled details display the corrected amount');
   }
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS check-in/defer/autopay/native handoff',engine.name(),c.width,c.height);count++;
  }catch(error){await page.screenshot({path:'/private/tmp/bookiebot-checkin-failure.png'});throw error}finally{await page.close()}
 }}finally{await browser.close()}
}console.log(count+' native bill check-in cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
