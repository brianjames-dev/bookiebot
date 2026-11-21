// Shipped bundle, isolated reads/reviews only. Assert intrinsic fit, real hit
// testing and independent scroll ownership rather than just hidden overflow.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const base={id:'pge',name:'PG&E',type:'variable',amountCents:null,cadence:'monthly',pullDay:22,pullMonths:[],category:'bills_utilities',account:'Checking',active:true,effectiveFrom:'0001-01',effectiveUntil:'9999-12',earliestEffectiveMonth:'2026-11',splitMethod:'income',payerBasisPoints:6473,version:'v1',nextDate:'2026-11-22',needsSetup:false,charge:{available:true,recorded:false,amountCents:0,month:'2026-11',date:'2026-11-22',version:'c1'}};
const quarterly={...base,id:'quarterly',name:'A long quarterly bill name that must stay inside the editor',type:'fixed',amountCents:9843,cadence:'quarterly',pullMonths:[2,5,8,11]};
const bills=[base,quarterly,...Array.from({length:28},(_,i)=>({...base,id:'fixed-'+i,name:'Fixed bill '+(i+1),type:'fixed',amountCents:1200,splitMethod:'none'}))];
function routes(reviews){return {bills:route=>{
 const req=route.request(),url=new URL(req.url());
 if(req.method()==='GET')return route.fulfill({json:{month:'2026-11',today:'2026-11-13',settingsVersion:'v1',ownerName:'Brian',partnerName:'Hannah',incomeBasisPoints:6473,splitsEnabled:true,bills}});
 assert(url.pathname.endsWith('/review'),'No financial confirmations');const body=req.postDataJSON();reviews.push(body);
 if(reviews.failNext){reviews.failNext=false;return route.fulfill({status:409,json:{error:'This bill changed while the review was being prepared. Check its settings and review the change again before saving.'}})}
 const before=bills.find(b=>b.id===body.id),after=body.bill?{...base,...body.bill,amountCents:body.bill.amount?Math.round(Number(body.bill.amount)*100):null}:body.operation==='delete'?{...before,active:false}:undefined;
 return route.fulfill({json:{review:{operation:body.operation,reviewVersion:'isolated-review',before,after,name:before?.name,amountCents:9843,effectiveFrom:body.bill?.effectiveFrom??body.effectiveFrom,share:{method:'income',payerCents:6371,partnerCents:3472}}}});
}}}
const panel=page=>page.locator('main[aria-label="Bills"]');
async function press(button){await button.scrollIntoViewIfNeeded();await button.press('Enter');await new Promise(resolve=>setTimeout(resolve,680))}
async function enter(page){await tap(page,page.getByRole('button',{name:'Settings',exact:true}));const manage=page.getByRole('button',{name:'Bills',exact:true});await manage.scrollIntoViewIfNeeded();await tap(page,manage);await panel(page).locator('.bb-bills-row').first().waitFor()}
async function scroll(page,element,engine){
 // Mobile WebKit does not expose mouse wheel input. Exercise its native
 // element scroller directly; Chromium also verifies real wheel ownership.
 if(engine.name()==='webkit')await element.evaluate(n=>n.scrollBy({top:650,behavior:'instant'}));
 else {await element.hover();await page.mouse.wheel(0,650)}
 await page.waitForTimeout(160);
}
async function fit(page,label){
 const editor=panel(page).locator('.bb-bills-editor[data-open=true]');
 const footer=editor.locator('.bi-editor-footer').filter({visible:true});
 await footer.getByRole('button').first().scrollIntoViewIfNeeded();
 const view=await editor.evaluate(host=>{
  const detail=host.closest('.bb-settings-detail'),box=host.getBoundingClientRect(),pane=detail.getBoundingClientRect();
  const visible=n=>!n.closest('[inert]')&&n.getBoundingClientRect().width>0;
  const fields=[...host.querySelectorAll('input,select,button')].filter(visible);
  return {inside:box.left>=pane.left-1&&box.right<=pane.right+1,
   fieldsFit:fields.every(n=>{const r=n.getBoundingClientRect();return r.left>=box.left-1&&r.right<=box.right+1}),
   footer:[...host.querySelectorAll('.bi-editor-footer button')].filter(visible).map(n=>n.getBoundingClientRect().height),
   overflow:document.documentElement.scrollWidth-innerWidth};
 });
 assert(view.inside&&view.fieldsFit&&view.overflow<=1,label+': inline editor fits the detail column '+JSON.stringify(view));
 assert(view.footer.length>=2&&view.footer.every(height=>height>=44),label+': preserve the footer touch targets');
}
async function shot(page,name){if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.BOOKIEBOT_SCREENSHOT_DIR+'/'+name+'.png'})}}
async function closedGeometry(page){return panel(page).evaluate(main=>{
 const host=main.querySelector('.bb-bills-editor'),editor=host.querySelector('.bi-editor'),row=main.querySelector('.bb-bills-row'),box=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
 return {row:box(row),host:box(host),editor:box(editor),fields:[...editor.querySelectorAll('input,select,.bi-editor-footer')].filter(n=>!n.closest('[inert]')).map(n=>({box:box(n),font:getComputedStyle(n).fontSize,padding:getComputedStyle(n).padding}))};
})}
module.exports={fixture,engines,routes,panel,enter,press};
if(require.main===module)(async()=>{let count=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{
   for(const config of [{width:867,height:669,dark:false,rail:0},{width:867,height:553,dark:true,rail:0,reduced:true},{width:951,height:648,dark:true,rail:84},{width:867,height:553,dark:false,rail:84},{width:867,height:480,dark:true,rail:0}].filter(c=>!process.env.ONLY_CLOSED&&(!process.env.ONLY_HEIGHT||c.height===Number(process.env.ONLY_HEIGHT)))){
    const {width,height,dark,rail,reduced}=config,reviews=[],{page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,rail,routes(reviews));
    try{await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});await enter(page);await press(panel(page).locator('.bb-bills-row').first());await fit(page,'Variable split');
     const detail=page.locator('.bb-settings-detail');
     await detail.evaluate(n=>n.scrollTop=0);
     const rowTop=await panel(page).locator('.bb-bills-row').first().evaluate(n=>n.getBoundingClientRect().top);
     await scroll(page,detail,engine);
     assert(await detail.evaluate(n=>n.scrollTop)>0,'The detail pane owns the open list and editor scroll');
     assert((await panel(page).locator('.bb-bills-row').first().evaluate(n=>n.getBoundingClientRect().top))<rowTop);
     await fit(page,'Scrolled inline editor');
     await press(panel(page).getByRole('button',{name:/^Recurring split/}));await fit(page,'Recurring split');
     await panel(page).getByRole('textbox',{name:"Brian's share percentage",exact:true}).fill('12.345');await page.waitForTimeout(80);await fit(page,'Invalid split');assert(await panel(page).getByRole('button',{name:'Use split',exact:true}).isDisabled());
     await panel(page).getByRole('textbox',{name:"Brian's share percentage",exact:true}).fill('42.25');await press(panel(page).getByRole('button',{name:'Split by income',exact:true}));assert.equal(await panel(page).getByRole('textbox',{name:"Brian's share percentage",exact:true}).inputValue(),'64.73');
     await shot(page,`bills-fit-${engine.name()}-${width}-${height}-${rail}-${dark?'dark':'light'}`);
     await press(panel(page).getByRole('button',{name:'Use split',exact:true}));
     reviews.failNext=true;await press(panel(page).getByRole('button',{name:'Review',exact:true}));assert(await panel(page).locator('.bb-bills-editor[data-open=true] [role=alert]').isVisible(),'Open review errors stay visible beside the editor');await fit(page,'Rejected review');await press(panel(page).getByRole('button',{name:'Review',exact:true}));await fit(page,'Retried configuration review');await press(panel(page).getByRole('button',{name:'Back',exact:true}));
     await press(panel(page).getByRole('button',{name:'Enter monthly amount',exact:true}));await panel(page).getByRole('textbox',{name:'Bill amount',exact:true}).fill('98.43');await fit(page,'Monthly amount');await press(panel(page).getByRole('button',{name:'Review',exact:true}));await fit(page,'Monthly review');await press(panel(page).getByRole('button',{name:'Back',exact:true}));await press(panel(page).getByRole('button',{name:'Cancel',exact:true}));
     await press(panel(page).getByRole('button',{name:'Stop bill',exact:true}));await fit(page,'Stop');await press(panel(page).getByRole('button',{name:'Review',exact:true}));await fit(page,'Stop review');await press(panel(page).getByRole('button',{name:'Back',exact:true}));await press(panel(page).getByRole('button',{name:'Cancel',exact:true}));await press(panel(page).getByRole('button',{name:'Cancel',exact:true}));
     await press(panel(page).locator('.bb-bills-row').nth(1));await fit(page,'Quarterly split');await panel(page).getByRole('combobox',{name:'Repeats',exact:true}).selectOption('yearly');await page.waitForTimeout(90);await fit(page,'Yearly split');await press(panel(page).getByRole('button',{name:'Review',exact:true}));await fit(page,'Configuration review');await press(panel(page).getByRole('button',{name:'Back',exact:true}));await press(panel(page).getByRole('button',{name:'Cancel',exact:true}));
     await press(panel(page).getByRole('button',{name:'Add bill',exact:true}));await panel(page).getByRole('textbox',{name:'Name',exact:true}).fill('New quarterly bill');await panel(page).getByRole('combobox',{name:'Type',exact:true}).selectOption('fixed');await panel(page).getByRole('textbox',{name:'Recurring amount',exact:true}).fill('123.45');await panel(page).getByRole('combobox',{name:'Repeats',exact:true}).selectOption('quarterly');await press(panel(page).getByRole('button',{name:/^Recurring split/}));await page.waitForTimeout(90);await fit(page,'New quarterly split');
     await panel(page).getByRole('textbox',{name:"Brian's share percentage",exact:true}).fill('12.345');const workspace=await panel(page).locator('.bi-editor-scenes').evaluate(n=>{window.__billFitWorkspace=n;return true});assert(workspace);await page.setViewportSize({width:382,height:740});await page.waitForTimeout(520);assert.equal(await panel(page).getByRole('textbox',{name:"Brian's share percentage",exact:true}).inputValue(),'12.345');await page.setViewportSize({width,height});await page.waitForTimeout(520);assert(await panel(page).locator('.bi-editor-scenes').evaluate(n=>n===window.__billFitWorkspace),'Folding retains the workspace');await fit(page,'Folded invalid new split');
     assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS open Bills fit',engine.name(),width,height,rail,dark?'dark':'light');count++;
    }catch(error){await page.screenshot({path:'/private/tmp/bookiebot-bills-fit-failure.png'});throw error}finally{await page.close()}
   }
   if(!process.env.ONLY_HEIGHT)for(const [width,dark] of [[382,false],[320,true]]){
    const {page,errors,unexpected}=await fixture(browser,width,740,dark,false,false,0,routes([]));let prior;
    try{await enter(page);await press(panel(page).locator('.bb-bills-row').first());await panel(page).locator('.bb-bills-editor').evaluate(n=>n.scrollIntoView({block:'start'}));const geometry=await closedGeometry(page);
     if(process.env.BOOKIEBOT_DUO_BASELINE){prior=await fixture(browser,width,740,dark,true,false,0,routes([]));await enter(prior.page);await press(panel(prior.page).locator('.bb-bills-row').first());await panel(prior.page).locator('.bb-bills-editor').evaluate(n=>n.scrollIntoView({block:'start'}));assert.deepEqual(geometry,await closedGeometry(prior.page),'Closed fields/spacing/layout stay unchanged')}
     const state=await panel(page).evaluate(main=>{const row=main.querySelector('.bb-bills-row'),host=main.querySelector('.bb-bills-editor'),line=getComputedStyle(host,'::after');return {border:getComputedStyle(row).borderBottomColor,line:line.content,height:line.height,bottom:line.bottom}});assert.equal(state.border,'rgba(0, 0, 0, 0)');assert.equal(state.line,'""');assert.equal(state.height,'1px');assert.equal(state.bottom,'0px');
     await press(panel(page).getByRole('button',{name:'Stop bill',exact:true}));await panel(page).locator('.bb-bills-row').first().evaluate(n=>n.scrollIntoView({block:'center'}));
     const clip=await panel(page).locator('.bb-bills-editor').evaluate(n=>{const r=n.getBoundingClientRect();return {x:Math.floor(r.x+r.width/2)-2,y:Math.floor(r.bottom)-2,width:4,height:4}});
     const pixels=await page.screenshot({clip});
     execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',"from PIL import Image; import io,sys; im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB'); bg=im.getpixel((0,0)); assert any(all(max(abs(a-b) for a,b in zip(im.getpixel((x,y)),bg))>8 for x in range(im.width)) for y in range(1,im.height)), 'The horizontal divider must paint above the retained scene background'"],{input:pixels});
     await shot(page,`bills-divider-${engine.name()}-${width}-${dark?'dark':'light'}`);await press(panel(page).getByRole('button',{name:'Cancel',exact:true}));
     await page.evaluate(()=>{window.__dividerFrames=(async()=>{const result=[],start=performance.now();while(performance.now()-start<620){await new Promise(requestAnimationFrame);const main=document.querySelector('main[aria-label="Bills"]'),host=main.querySelector('.bb-bills-editor'),row=main.querySelector('.bb-bills-row'),present=!!host?.querySelector('.bi-editor-scenes');result.push({present,border:getComputedStyle(row).borderBottomColor,line:host&&getComputedStyle(host,'::after').content,height:host?.getBoundingClientRect().height??0})}return result})();});await panel(page).getByRole('button',{name:'Cancel',exact:true}).press('Enter');const samples=await page.evaluate(()=>window.__dividerFrames);assert(samples.filter(s=>s.present).every(s=>s.border==='rgba(0, 0, 0, 0)'&&s.line==='""'),'Divider follows the closing expansion');assert(!samples.at(-1).present&&samples.at(-1).height<1&&samples.at(-1).border!=='rgba(0, 0, 0, 0)','The row divider returns after closing');assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS closed Bills divider',engine.name(),width);count++;
    }finally{await page.close();if(prior)await prior.page.close()}
   }
  }finally{await browser.close()}
 }
 console.log('PASS Bills fit/divider cases:',count);
})().catch(error=>{console.error(error);process.exitCode=1});
