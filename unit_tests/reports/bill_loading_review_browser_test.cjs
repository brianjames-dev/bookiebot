// Shipped app: delayed reads, variable invitation acceptance and compact creation review.
// Synthetic requests only; no live financial writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-bill-loading-review-shots';fs.mkdirSync(output,{recursive:true});
const base={id:'shared:utility',type:'variable',name:'PG&E',amountCents:null,cadence:'monthly',pullDay:22,pullMonths:[],category:'bills_utilities',account:'',active:true,effectiveFrom:'2026-01',effectiveUntil:'9999-12',splitMethod:'custom',payerBasisPoints:6473,version:'utility-view',nextDate:'2026-11-22',needsSetup:false,earliestEffectiveMonth:'2026-11',
 charge:{available:true,month:'2026-11',amountCents:5364,billAmountCents:5364,date:'2026-11-22',recorded:true,status:'confirmed',canConfirmAmount:false},readOnly:true,
 sharing:{id:'utility',revision:1,status:'pending',role:'member',payerName:'Hannah',memberName:'Brian',state:{purchaseTotalCents:15208,payerShareCents:9844,memberShareCents:5364,receivedCents:5364,remainingCents:0,repaymentStatus:'settled',paymentStatus:'confirmed',paymentDate:'2026-11-22',predicted:false,allocationIds:['original-invoice'],month:'2026-11'}}};
async function settle(page){await page.waitForFunction(()=>![...document.querySelectorAll('.bb-bills-editor[data-open=true]')].some(el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect.getTiming().iterations!==Infinity)));}
async function press(page,button){await button.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForTimeout(60);await tap(page,button);await settle(page);}
;(async()=>{let cases=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{for(const [width,height,dark]of [[320,740,false],[382,657,true],[867,480,false],[951,648,true]].filter(([w])=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
   let reads=0,accepts=0,release;const held=new Promise(resolve=>release=resolve),bill=structuredClone(base),requests=[];
   const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{bills:async route=>{
    const req=route.request(),url=new URL(req.url()),body=req.method()==='POST'?req.postDataJSON():null;
    const reply=json=>route.fulfill({json});requests.push({path:url.pathname,fresh:url.searchParams.get('fresh'),method:req.method()});
    if(!body){reads++;if(reads===1)await held;return reply({month:'2026-11',today:'2026-11-16',settingsVersion:'view-'+accepts,ownerName:'Brian',partnerName:'Hannah',incomeBasisPoints:6473,splitsEnabled:true,bills:[bill]})}
    if(url.pathname==='/app/bills/sharing/review')return reply({review:{action:body.action,reviewVersion:'accept-review',payerName:'Hannah',memberName:'Brian',name:'PG&E',bill:{type:'variable',amountCents:null,cadence:'monthly',pullDay:22,splitMethod:'custom',effectiveFrom:'2026-12'},currentCharge:{month:'2026-11',amountCents:15208,date:'2026-11-22'}}});
    if(url.pathname==='/app/bills/sharing'){assert.equal(body.action,'accept');assert.equal(body.reviewVersion,'accept-review');accepts++;bill.sharing.status='active';return reply({status:'active',id:'utility',revision:2})}
    assert.equal(url.pathname,'/app/bills/review','Creation review must not instantiate a financial change');assert.equal(body.operation,'create');
    return reply({review:{operation:'create',reviewVersion:'create-review',before:null,after:{...bill,...body.bill,id:'new-fixture',amountCents:Math.round(Number(body.bill.amount)*100),readOnly:false,sharing:null,charge:{available:false,month:'2026-11'}},effectiveFrom:body.bill.effectiveFrom}});
   }});
   try{
    await page.emulateMedia({reducedMotion:'no-preference'});
    await tap(page,page.getByRole('button',{name:'Settings',exact:true}));await tap(page,page.getByRole('button',{name:'Bills',exact:true}));
    const main=page.getByRole('main',{name:'Bills',exact:true}),spinner=main.locator('.bb-report-loading-spinner');await spinner.waitFor();
    assert(await page.locator('.bb-settings-masthead-title button').isEnabled(),'Reading Bills must not grey or lock the Back/title capsule');
    assert.equal(await page.locator('.bb-settings-masthead-title .bb-glass-control').evaluate(el=>getComputedStyle(el).opacity),'1');
    assert.equal(await spinner.evaluate(el=>getComputedStyle(el).animationName),'bb-pull-spin','Bills uses the same actual Overview spinner');
    await page.screenshot({path:path.join(output,`${engine.name()}-${width}-loading.png`)});release();
    await main.locator('.bb-bills-row').waitFor();assert.equal(await spinner.count(),0);
    await tap(page,page.locator('.bb-settings-masthead-title button'));await tap(page,page.getByRole('button',{name:'Bills',exact:true}));
    assert.equal(reads,1,'The mounted list reopens immediately without reading Sheets again');
    await press(page,main.locator('.bb-bills-row'));
    let editor=main.locator('.bb-bills-editor[data-open=true]');assert((await editor.innerText()).includes('$152.08'));
    await press(page,editor.getByRole('button',{name:'Review',exact:true}));
    const review=editor.locator('.bi-step-review[aria-hidden=false]');await review.getByRole('heading',{name:'Accept shared bill',exact:true}).waitFor();
    assert((await review.innerText()).includes('Nov 2026 bill total'));assert((await review.innerText()).includes('$152.08'));
    assert((await review.innerText()).includes('Entered monthly'));assert(!(await review.innerText()).includes('Amount needed'));
    await page.screenshot({path:path.join(output,`${engine.name()}-${width}-invitation.png`)});
    await press(page,review.getByRole('button',{name:'Confirm',exact:true}));
    await page.waitForFunction(()=>!document.querySelector('.bb-bills-editor[data-open=true]'));assert.equal(accepts,1);
    assert.equal(await main.locator('.bb-bills-row').count(),1);assert(!await main.getByText('Invitation',{exact:true}).count());
    assert(requests.some(r=>r.path==='/app/bills'&&r.fresh==='1'),'Acceptance explicitly reads fresh Bills');
    await press(page,main.getByRole('button',{name:'Add bill',exact:true}));editor=main.locator('.bb-bills-editor[data-open=true]');
    await editor.getByRole('textbox',{name:'Name',exact:true}).fill('World of Warcraft');
    await editor.getByRole('textbox',{name:'Recurring amount',exact:true}).fill('14.99');
    await editor.getByRole('textbox',{name:'Payment day',exact:true}).fill('6');
    await editor.getByRole('combobox',{name:'Budget category',exact:true}).selectOption('subscriptions_wants');
    await press(page,editor.getByRole('button',{name:'Review',exact:true}));
    const changes=editor.locator('.bi-step-review[aria-hidden=false]>.bi-review-changes');
    if(width<800)await page.waitForFunction(()=>{const heading=document.querySelector('.bb-bills-editor[data-open=true] .bi-step-review[aria-hidden=false] h2'),header=document.querySelector('.bb-settings-masthead-title');return heading.getBoundingClientRect().top>=header.getBoundingClientRect().bottom+8});
    const geometry=await changes.evaluate(el=>{const box=n=>n.getBoundingClientRect().toJSON();return {height:el.getBoundingClientRect().height,width:el.getBoundingClientRect().width,columns:getComputedStyle(el).gridTemplateColumns,fields:Object.fromEntries([...el.children].map(n=>[n.dataset.reviewField,box(n)])),values:[...el.querySelectorAll('dd')].map(n=>({width:n.clientWidth,scroll:n.scrollWidth,text:n.textContent}))}});
    assert.equal(geometry.columns.split(' ').length,2);assert(Math.abs(geometry.fields.Type.y-geometry.fields['Recurring amount'].y)<1,'Short type/amount values share one review row');
    assert(Math.abs(geometry.fields.Repeats.y-geometry.fields['Payment day'].y)<1,'Cadence/day share one review row');
    assert(geometry.fields.Name.width>geometry.width*.95,'Names keep the full editor width');
    assert(geometry.height<350,'All setup values fit in a concise review: '+JSON.stringify(geometry));
    assert(geometry.values.every(v=>v.scroll<=v.width+1),'Reviewed values remain readable: '+JSON.stringify(geometry));
    await page.screenshot({path:path.join(output,`${engine.name()}-${width}-create-review.png`)});
    await page.setViewportSize({width:width<800?867:382,height:width<800?480:657});await page.waitForTimeout(520);
    assert.equal(await editor.locator('[data-review-field=Name]').innerText(),'Name\nWorld of Warcraft');
    assert((await editor.innerText()).includes('$14.99'));assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
    cases++;console.log('PASS Bills native loading, retained list, variable invite and compact creation review',engine.name(),width);
   }catch(error){release();console.error(engine.name(),width,await page.evaluate(()=>({scrollY,scroll:[...document.querySelectorAll('*')].filter(el=>el.scrollTop>0).map(el=>({class:el.className,top:el.scrollTop})),heading:document.querySelector('.bb-bills-editor[data-open=true] .bi-step-review h2')?.getBoundingClientRect().toJSON(),header:document.querySelector('.bb-settings-masthead-title')?.getBoundingClientRect().toJSON()})));await page.screenshot({path:path.join(output,'failure.png')});throw error}finally{await page.close()}
  }}finally{await browser.close()}
 }
 console.log(cases+' Bills loading/review native cases passed; screenshots '+output);
})().catch(error=>{console.error(error);process.exitCode=1});
