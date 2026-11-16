// Production components, isolated identity and bill-membership fixtures only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap:nativeTap,engines}=require('./duo_layout_browser_test.cjs');
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-account-shared-shots';fs.mkdirSync(output,{recursive:true});
async function tap(page,button){if(await button.evaluate(el=>Boolean(el.closest('.bb-bills-editor'))&&el.closest('.bb-bills')?.getAttribute('data-wide')!=='true')){await button.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await page.waitForTimeout(80)}try{return await nativeTap(page,button)}catch(error){console.error(await button.evaluate(el=>{const r=el.getBoundingClientRect(),host=el.closest('.bb-bills-editor');return{button:el.textContent,box:r.toJSON(),hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML,host:host?.getBoundingClientRect().toJSON(),frames:[...(host?.querySelectorAll('.bb-bill-sharing,.bb-shared-bill-content,.bi-step-viewport,.bi-step-pane')??[])].map(n=>({class:n.className,hidden:n.getAttribute('aria-hidden'),r:n.getBoundingClientRect().toJSON(),scroll:n.scrollHeight,css:{display:getComputedStyle(n).display,height:getComputedStyle(n).height}}))}}));await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});throw error}}
const source={id:'rent-fixture',type:'fixed',name:'Rent',amountCents:20000,cadence:'monthly',pullDay:22,pullMonths:[],category:'rent',account:'Checking',active:true,effectiveFrom:'2026-11',effectiveUntil:'9999-12',splitMethod:'equal',payerBasisPoints:5000,version:'rent-v1',nextDate:'2026-11-22',needsSetup:false,earliestEffectiveMonth:'2026-11',charge:{available:true,month:'2026-11',amountCents:18000,billAmountCents:20000,status:'confirmed',recorded:true,virtual:false,date:'2026-11-22',version:'charge-v1'}};
const membership=(status='pending',role='payer')=>({id:'shared-rent',revision:status==='active'?2:1,status,role,payerName:role==='payer'?'Brian':'Hannah',memberName:role==='payer'?'Hannah':'Brian',state:{purchaseTotalCents:20000,payerShareCents:10000,memberShareCents:10000,receivedCents:2000,remainingCents:8000,repaymentStatus:'partial',paymentStatus:'confirmed',paymentDate:'2026-11-22',predicted:false,allocationIds:['fixture-allocation'],month:'2026-11'}});
const open=page=>page.locator('.bb-bills-editor[data-open=true]');
const settle=page=>page.waitForFunction(()=>![...document.querySelectorAll('.bb-bills-editor[data-open=true]')].some(el=>el.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect.getTiming().iterations!==Infinity)));
async function billsPage(page){await tap(page,page.getByRole('button',{name:'Settings',exact:true}));await tap(page,page.getByRole('button',{name:'Manage bills & subscriptions',exact:true}));await page.locator('.bb-bills-row').waitFor();}
;(async()=>{let count=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{
   for(const dark of [false,true])for(const [width,height]of [[382,657],[867,480]].filter(([w])=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
    const state={sharing:null,member:false,lose:true,revision:0};const saved=new Map(),commands=[],reviews=[];
    const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{bills:async route=>{
     const request=route.request(),url=new URL(request.url()),body=request.method()==='POST'?request.postDataJSON():null;
     const reply=value=>route.fulfill({json:value});
     if(request.method()==='GET'){
      if(url.pathname.includes('/sharing/commands/')){const value=saved.get(url.pathname.split('/').pop());return value?reply(value):route.fulfill({status:404,json:{error:'Not saved yet'}});}
      const value=state.member?{...source,id:'shared:shared-rent',readOnly:true,sharing:membership(state.sharing?.status||'pending','member'),account:'',amountCents:10000}: {...source,sharing:state.sharing};
      return reply({month:'2026-11',today:'2026-11-15',settingsVersion:'settings-'+state.revision,ownerName:'Brian',partnerName:'Hannah',incomeBasisPoints:6473,splitsEnabled:true,bills:state.empty?[]:[value]});
     }
     assert(url.pathname.startsWith('/app/bills/sharing'),'Sharing must not enter a financial writer: '+url.pathname);
     assert.equal(request.headers()['x-bookiebot-app'],'1');assert(!('owner' in body));
     if(url.pathname.endsWith('/review')){reviews.push(body);return reply({review:{action:body.action,reviewVersion:'share-review-'+state.revision,name:'Rent',payerName:state.member?'Hannah':'Brian',memberName:state.member?'Brian':'Hannah',bill:source}});}
     if(state.reject)return route.fulfill({status:409,json:{error:'This bill is no longer shared.',notApplied:true}});
     commands.push(body);assert(body.requestId&&body.reviewVersion);state.revision++;
     state.sharing=membership(body.action==='accept'?'active':'pending',state.member?'member':'payer');
     const result={id:'shared-rent',status:state.sharing.status,revision:state.revision};saved.set(body.requestId,result);
     if(state.lose){state.lose=false;return route.abort('failed')}return reply(result);
    }});
    await page.route('**/app/account',route=>route.fulfill({json:{id:'fixture-brian',name:'Brian',googleEnabled:true,google:{connected:false,email:null}}}));
    const portrait=page.getByRole('button',{name:'Talk to BookieBot',exact:true});
    assert.equal(await portrait.count(),1);const target=await portrait.boundingBox();assert(target.width>=44&&target.height>=44);
    assert.equal(await page.getByRole('button',{name:'Ask BookieBot',exact:true}).count(),0);
    await tap(page,portrait);await page.getByRole('heading',{name:'Talk to BookieBot',exact:true}).waitFor();await page.waitForTimeout(500);
    await tap(page,page.getByRole('button',{name:'Close Talk to BookieBot',exact:true}));await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Talk to BookieBot');
    await billsPage(page);assert.equal(await portrait.count(),1,'Settings retains exactly one portrait chat opener');
    await tap(page,page.locator('.bb-bills-row'));await tap(page,open(page).getByRole('button',{name:'Share bill',exact:true}));await settle(page);
    await open(page).getByRole('heading',{name:'Bill sharing',exact:true}).waitFor();
    assert.equal(commands.length,0);await tap(page,open(page).getByRole('button',{name:'Review invitation',exact:true}));
    await open(page).getByRole('heading',{name:'Share bill',exact:true}).waitFor();await settle(page);assert.equal(commands.length,0,'Review is read-only');
    await tap(page,open(page).getByRole('button',{name:'Confirm',exact:true}));await open(page).getByRole('button',{name:'Check saved change',exact:true}).waitFor();
    assert.equal(commands.length,1);const submitted=structuredClone(commands[0]);
    await page.setViewportSize({width:width<800?867:382,height:width<800?480:657});await page.waitForTimeout(520);
    assert.equal(commands.length,1,'Folding an unresolved sharing editor never resubmits');
    await tap(page,open(page).getByRole('button',{name:'Check saved change',exact:true}));await page.waitForFunction(()=>!document.querySelector('.bb-bills-editor[data-open=true]'));
    assert.equal(commands.length,1);assert.deepEqual(commands[0],submitted);
    state.member=true;state.sharing=membership('pending','member');await page.reload();await page.locator('.bb-metrics-grid').waitFor();
    await billsPage(page);await tap(page,page.locator('.bb-bills-row'));await settle(page);
    await open(page).getByRole('heading',{name:'Shared bill',exact:true}).waitFor();
    assert.equal(await open(page).getByRole('button',{name:'Stop bill',exact:true}).count(),0);
    assert.equal(await open(page).getByRole('textbox').count(),0,'Recipients cannot edit the payer’s plan');
    assert((await open(page).textContent()).includes('Remaining to repay'));
    await tap(page,open(page).getByRole('button',{name:'Review',exact:true}));await settle(page);assert.equal(commands.length,1);
    await tap(page,open(page).getByRole('button',{name:'Confirm',exact:true}));await page.waitForFunction(()=>!document.querySelector('.bb-bills-editor[data-open=true]'));
    assert.equal(commands.length,2);assert.equal(commands[1].action,'accept');
    await page.setViewportSize({width,height});await page.waitForTimeout(500);await tap(page,page.locator('.bb-bills-row'));await settle(page);
    const geometry=await open(page).evaluate(el=>{const r=el.getBoundingClientRect(),footer=el.querySelector('.bb-shared-bill-content:not([aria-hidden=true]) .bi-editor-footer')?.getBoundingClientRect();return{r:r.toJSON(),height:el.clientHeight,scroll:el.scrollHeight,footer:footer?.toJSON(),doc:document.documentElement.scrollHeight,viewport:innerHeight};});
    if(width>=800){assert(geometry.scroll<=geometry.height+1,'Shared editor fits without scrolling: '+JSON.stringify(geometry));assert(geometry.footer.bottom<=geometry.r.bottom+1);}
    await page.screenshot({path:path.join(output,`${engine.name()}-${width}-${dark?'dark':'light'}.png`),fullPage:true});
    await tap(page,open(page).getByRole('button',{name:'Close',exact:true}));await settle(page);
    // Reload after another device revoked the source. A definitive rejection
    // must release the obsolete journal instead of trapping the app forever.
    state.empty=true;state.reject=true;
    await page.evaluate(()=>sessionStorage.setItem('bookiebot:bill-sharing:brian',JSON.stringify({billId:'shared:gone',command:{action:'stop',shareId:'gone',requestId:'fixture-rejected-sharing',reviewVersion:'old'}})));
    await page.reload();await page.locator('.bb-metrics-grid').waitFor();
    await tap(page,page.getByRole('button',{name:'Settings',exact:true}));await tap(page,page.getByRole('button',{name:'Manage bills & subscriptions',exact:true}));
    await page.getByText('A bill-sharing change needs verification.',{exact:true}).waitFor();
    await tap(page,page.getByRole('button',{name:'Retry same confirmation',exact:true}));
    await page.getByText('This sharing change was not applied.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('bookiebot:bill-sharing:brian')),null);
    await tap(page,page.locator('.bb-bills-recovery').getByRole('button',{name:'Close',exact:true}));
    await tap(page,page.getByRole('button',{name:'Back',exact:true}));
    await page.getByRole('button',{name:'Link Google account',exact:true}).waitFor();
    await tap(page,portrait);await page.getByRole('heading',{name:'Talk to BookieBot',exact:true}).waitFor();await page.waitForTimeout(500);await tap(page,page.getByRole('button',{name:'Close Talk to BookieBot',exact:true}));await page.waitForTimeout(300);
    const dialogs=[];page.on('dialog',async dialog=>{dialogs.push(dialog.type());await dialog.dismiss()});
    let starts=0;await page.route('**/app/auth/google/start',route=>{const req=route.request();assert.equal(req.postDataJSON().action,'link');assert.equal(req.headers()['x-bookiebot-app'],'1');starts++;return route.fulfill({json:{url:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture'}})});
    await page.route('https://accounts.google.com/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Isolated Google sign-in fixture</h1>'}));
    await page.getByRole('button',{name:'Link Google account',exact:true}).scrollIntoViewIfNeeded();await tap(page,page.getByRole('button',{name:'Link Google account',exact:true}));await page.waitForURL('https://accounts.google.com/**');assert.equal(starts,1);
    assert.deepEqual(dialogs,[],'The completed Google start request must not trigger an unsaved-work warning');assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.close();count++;console.log('PASS portrait, accounts, sharing/recovery/fold',engine.name(),width,dark?'dark':'light');
   }
  }finally{await browser.close();}
 }
 console.log(`${count} account/shared-bill native cases passed; screenshots ${output}`);
})().catch(error=>{console.error(error);process.exit(1)});
