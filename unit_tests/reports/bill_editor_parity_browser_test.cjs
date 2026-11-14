// Compare the shipped Bills UI with the real Transactions editor in the same
// browser. Only synthetic GETs and read-only review responses are allowed.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const row={id:'2026-10:parity',actionId:'parity',version:'v1',month:'2026-10',date:'2026-10-20',title:'Household supplies',location:'Target',person:'Brian',kind:'expense',category:'shopping',categoryLabel:'Shopping',amountCents:10000,split:'',fields:{item:'Household supplies',location:'Target',person:'Brian',amount:'100.00'},editableFields:['item','location','person','amount'],capabilities:{update:true,split:true,delete:true,move:true},reasons:{}};
const bill={id:'pge',name:'PG&E',type:'variable',amountCents:null,cadence:'monthly',pullDay:22,pullMonths:[],category:'bills_utilities',account:'Checking',active:true,effectiveFrom:'0001-01',effectiveUntil:'9999-12',earliestEffectiveMonth:'2026-11',splitMethod:'income',payerBasisPoints:6473,version:'v1',nextDate:'2026-11-22',needsSetup:false,charge:{available:true,recorded:false,amountCents:0,month:'2026-11',date:'2026-11-22',version:'charge-v1'}};
const subscription={...bill,id:'music',name:'Music',type:'subscription',amountCents:1200,category:'subscriptions_wants',charge:{...bill.charge,available:true,virtual:true,date:'2026-11-01'}};
const widths=[{width:320,dark:false,reduced:false},{width:382,dark:true,reduced:false},{width:382,dark:true,reduced:true},{width:867,dark:false,reduced:false},{width:867,dark:true,reduced:false},{width:867,dark:true,reduced:true}];
const host=page=>page.locator('.bb-bills-editor');
const activeEditor=page=>host(page).locator('.bi-editor-scene').filter({visible:true}).locator('.bi-editor');
async function settle(page){await page.waitForTimeout(680)}
async function press(button){await button.scrollIntoViewIfNeeded();await button.press('Enter')}
async function sample(page){await page.evaluate(()=>{
 const host=document.querySelector('.bb-bills-editor'),workspace=host.querySelector('.bi-editor-scenes');
 window.__billFrames=(async()=>{const frames=[],start=performance.now();while(performance.now()-start<620){await new Promise(requestAnimationFrame);const h=document.querySelector('.bb-bills-editor'),w=h.querySelector('.bi-editor-scenes'),motions=[...h.querySelectorAll('.bi-step-viewport[data-moving="true"]')].filter(v=>!v.closest('[inert]'));
  frames.push({same:host===h&&workspace===w,open:h.querySelector('.bi-expansion')?.dataset.open,height:h.querySelector('.bi-expansion')?.getBoundingClientRect().height??0,order:getComputedStyle(h).order,wide:document.querySelector('.bb-bills').dataset.wide,pan:[...h.querySelectorAll('.bi-step-viewport')].map(v=>v.scrollLeft),moving:motions.length,slides:motions.flatMap(v=>[...v.children].flatMap(p=>p.getAnimations().filter(a=>a.effect.getKeyframes().some(k=>'transform'in k)).map(a=>({duration:a.effect.getTiming().duration,easing:a.effect.getTiming().easing})))),viewports:[...h.querySelectorAll('.bi-step-viewport')].filter(v=>!v.closest('[inert]')).map(v=>({height:v.getBoundingClientRect().height,content:v.querySelector(':scope>.bi-step-pane[aria-hidden="false"]')?.offsetHeight}))});
 }return frames})();
 })}
const frames=page=>page.evaluate(()=>window.__billFrames);
function checkFrames(samples,reduced,label){
 assert(samples.every(s=>s.same),label+': retain the mounted workspace');
 assert(samples.every(s=>s.open==='true'&&s.height>20),label+': never close/reopen the expansion');
 assert(samples.every(s=>s.pan.every(x=>Math.abs(x)<1)),label+': no horizontal focus pan');
 assert(samples.every(s=>s.moving<=1),label+': a single slide owner');
 if(reduced)assert(samples.every(s=>s.moving===0),label+': reduced motion settles immediately');
 else {const slides=samples.flatMap(s=>s.slides);assert(slides.length,label+': visible slide');assert(slides.every(s=>s.duration===440&&s.easing==='cubic-bezier(0.22, 0.8, 0.25, 1)'),label+': native slide duration/easing')}
 assert(samples.at(-1).viewports.every(v=>Math.abs(v.height-v.content)<1),label+': heights settle to the actual content');
}
async function transition(page,button,reduced,label){await button.scrollIntoViewIfNeeded();await sample(page);await button.press('Enter');checkFrames(await frames(page),reduced,label)}
async function fold(page,width){
 await sample(page);await page.setViewportSize({width,height:740});await page.waitForFunction(w=>document.querySelector('.bb-bills').dataset.wide===String(w>=800),width);
 const samples=await frames(page),after=samples.filter(s=>s.wide===String(width>=800));
 assert(after.length&&after.every(s=>s.same&&s.open==='true'&&s.height>20),'Folding keeps the same open editor');
 assert(after.every(s=>s.pan.every(x=>Math.abs(x)<1)),'Folding does not pan the slide viewport');
 assert(after.at(-1).viewports.every(v=>Math.abs(v.height-v.content)<1),'Folded heights fit the current content');
}
async function styles(editor,inputName){return editor.evaluate((el,name)=>{
 const active=selector=>[...el.querySelectorAll(selector)].find(n=>!n.closest('[inert]'));
 const values=(node,props)=>{const s=getComputedStyle(node);return Object.fromEntries(props.map(p=>[p,s[p]]))};
 const input=[...el.querySelectorAll('input')].find(n=>!n.closest('[inert]')&&n.closest('label')?.textContent.startsWith(name));
 return {panel:values(el,['padding','backgroundColor','borderRadius']),label:values(input.closest('label'),['fontSize','lineHeight','rowGap','minHeight']),input:values(input,['fontSize','lineHeight','height','padding','borderBottomWidth','borderBottomColor','borderRadius','backgroundColor']),select:values(active('.bi-select select'),['fontSize','lineHeight','height','padding','borderBottomWidth','borderRadius']),chevron:values(active('.bi-select>svg'),['width','height','color']),fields:values(active('.bi-fields'),['rowGap']),columns:values(active('.bi-secondary-fields'),['columnGap']),footer:values(active('.bi-editor-footer'),['columnGap','marginTop','justifyContent']),cancel:values(active('.bi-cancel'),['fontSize','minHeight','padding','borderWidth','backgroundColor','color','borderRadius']),primary:values(active('.bi-primary'),['fontSize','minHeight','padding','borderWidth','backgroundColor','color','borderRadius'])};
 },inputName)}
(async()=>{let cases=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{
   for(const config of widths.filter(c=>!process.env.ONLY_WIDTH||c.width===Number(process.env.ONLY_WIDTH))){
    const {width,dark,reduced}=config,reviews=[];
    const {page,errors,unexpected}=await fixture(browser,width,740,dark,false,false,0,{
     transactions:route=>{assert.equal(route.request().method(),'GET','No transaction writes');return route.fulfill({json:{items:[row],total:1,nextOffset:null,categories:['shopping'],persons:['Brian'],month:row.month,snapshotVersion:'v1',totalAmountCents:10000,days:[{date:row.date,month:row.month,count:1,totalCents:10000,needsCents:0,wantsCents:10000}]}})},
     bills:route=>{const req=route.request(),url=new URL(req.url());if(req.method()==='GET')return route.fulfill({json:{month:'2026-11',today:'2026-11-13',settingsVersion:'v1',ownerName:'Brian',partnerName:'Hannah',incomeBasisPoints:6473,splitsEnabled:true,bills:[bill,subscription]}});
      assert(url.pathname.endsWith('/review'),'No financial confirmations');const body=req.postDataJSON();reviews.push(body);
      const after=body.bill?{...bill,...body.bill,amountCents:body.bill.amount?Math.round(Number(body.bill.amount)*100):null}:body.operation==='delete'?{...bill,active:false}:undefined;
      return route.fulfill({json:{review:{operation:body.operation,reviewVersion:'read-only-review',after,before:after?bill:undefined,name:body.id==='music'?'Music':'PG&E',amountCents:body.operation==='amount'?9843:1200,effectiveFrom:body.bill?.effectiveFrom??body.effectiveFrom,share:{method:'income',payerCents:6371,partnerCents:3472}}}});
     }
    });
    page.setDefaultTimeout(12000);try{
     await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
     await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));
     const action=page.getByRole('button',{name:'Show actions for Target',exact:true});await action.waitFor();await action.press(width>=800?'Enter':'ArrowLeft');await settle(page);
     await press(page.getByRole('button',{name:(width>=800?'Edit':'Update')+' Target',exact:true}));await settle(page);
     const native=await styles(page.getByRole('region',{name:'Edit transaction',exact:true}),'Item');
     await press(page.getByRole('region',{name:'Edit transaction',exact:true}).getByRole('button',{name:'Cancel',exact:true}));await settle(page);
     await tap(page,page.getByRole('button',{name:'Settings',exact:true}));await tap(page,page.getByRole('button',{name:'Manage bills & subscriptions',exact:true}));
     const panel=page.locator('main[aria-label="Bills"]');await panel.locator('.bb-bills-row').first().waitFor();
     await press(panel.locator('.bb-bills-row').first());await settle(page);
     assert.equal(await host(page).locator('.bi-editor-scenes').count(),1,'Bills uses the retained native editor workspace');
     const actual=await styles(activeEditor(page),'Name');
     for(const key of ['label','input','select','chevron','cancel','primary'])assert.deepEqual(actual[key],native[key],`Bills retains native ${key} styling`);
     for(const key of ['backgroundColor','borderRadius'])assert.equal(actual.panel[key],native.panel[key],`Bills retains the native ${key} surface`);
     assert.equal(actual.panel.padding,'16px','The approved roomier Bills inset is shared by both poses');
     const guide=await host(page).locator('.bi-expansion').evaluate(el=>{const s=getComputedStyle(el,'::before');return {display:s.display,left:s.left}});
     assert.equal(guide.display,width>=800?'none':'block');if(width<800)assert.equal(guide.left,'4px');
     await panel.getByRole('textbox',{name:'Name',exact:true}).fill('PG&E draft');
     await panel.getByRole('spinbutton',{name:'Payment day',exact:true}).fill('23');
     await transition(page,panel.getByRole('button',{name:/^Recurring split/}),reduced,'Settings → recurring split');
     await panel.getByRole('textbox',{name:"Brian's share percentage",exact:true}).fill('12.345');
     await fold(page,width>=800?382:867);await fold(page,width);
     assert.equal(await panel.getByRole('textbox',{name:"Brian's share percentage",exact:true}).inputValue(),'12.345');
     assert(await panel.getByRole('button',{name:'Use split',exact:true}).isDisabled(),'Invalid split draft survives folds');
     await panel.getByRole('textbox',{name:"Brian's share percentage",exact:true}).fill('42.25');await transition(page,panel.getByRole('button',{name:'Use split',exact:true}),reduced,'Recurring split → settings');
     await transition(page,panel.getByRole('button',{name:'Enter monthly amount',exact:true}),reduced,'Settings → monthly amount');
     await panel.getByRole('textbox',{name:'Amount paid',exact:true}).fill('98.43');
     await transition(page,panel.getByRole('button',{name:'Review',exact:true}),reduced,'Monthly amount → review');
     await fold(page,width>=800?382:867);await fold(page,width);
     await panel.getByRole('button',{name:'Record amount',exact:true}).waitFor();assert.equal(reviews.at(-1).amount,'98.43');
     await transition(page,panel.getByRole('button',{name:'Back',exact:true}),reduced,'Monthly review → amount');
     assert.equal(await panel.getByRole('textbox',{name:'Amount paid',exact:true}).inputValue(),'98.43');
     await transition(page,panel.getByRole('button',{name:'Cancel',exact:true}),reduced,'Monthly amount → settings');
     assert.equal(await panel.getByRole('textbox',{name:'Name',exact:true}).inputValue(),'PG&E draft');assert.equal(await panel.getByRole('spinbutton',{name:'Payment day',exact:true}).inputValue(),'23');
     await transition(page,panel.getByRole('button',{name:/^Recurring split/}),reduced,'Settings → saved split');
     assert.equal(await panel.getByRole('textbox',{name:"Brian's share percentage",exact:true}).inputValue(),'42.25');await transition(page,panel.getByRole('button',{name:'Use split',exact:true}),reduced,'Saved split → settings');
     await transition(page,panel.getByRole('button',{name:'Review',exact:true}),reduced,'Settings → review');
     assert.equal(reviews.at(-1).bill.payerBasisPoints,4225);
     const backIcon=await panel.getByRole('button',{name:'Back',exact:true}).locator('svg').evaluate(el=>({width:getComputedStyle(el).width,height:getComputedStyle(el).height}));
     assert.deepEqual(backIcon,{width:native.chevron.width,height:native.chevron.height},'Review Back keeps the native small icon sizing');
     await fold(page,width>=800?382:867);await fold(page,width);
     await transition(page,panel.getByRole('button',{name:'Back',exact:true}),reduced,'Review → settings');
     assert((await panel.getByRole('button',{name:/^Recurring split/}).innerText()).includes('42.25'));
     await transition(page,panel.getByRole('button',{name:'Stop bill',exact:true}),reduced,'Settings → stop');
     await transition(page,panel.getByRole('button',{name:'Review',exact:true}),reduced,'Stop → review');
     await transition(page,panel.getByRole('button',{name:'Back',exact:true}),reduced,'Stop review → stop');
     await transition(page,panel.getByRole('button',{name:'Cancel',exact:true}),reduced,'Stop → settings');
     // Fold in the middle of a mode slide, then verify the next route/review.
     await press(panel.getByRole('button',{name:'Enter monthly amount',exact:true}));if(!reduced)await page.waitForTimeout(60);
     await fold(page,width>=800?382:867);await fold(page,width);
     await transition(page,panel.getByRole('button',{name:'Cancel',exact:true}),reduced,'After fold → settings');
     if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await host(page).scrollIntoViewIfNeeded();await page.screenshot({path:process.env.BOOKIEBOT_SCREENSHOT_DIR+`/bill-native-${engine.name()}-${width}-${dark?'dark':'light'}-${reduced?'reduced':'motion'}.png`})}
     const anchor=await host(page).evaluate(el=>getComputedStyle(el).order);await sample(page);await press(panel.getByRole('button',{name:'Cancel',exact:true}));
     const closing=await frames(page);assert(closing.filter(s=>s.height>0).every(s=>s.order===anchor),'Closing retains the selected row anchor until the surface is removed');assert(closing.at(-1).height<1,'Closing fully collapses the inline editor');
     await press(panel.locator('.bb-bills-row').filter({hasText:'Music'}));await settle(page);
     assert.equal(await panel.getByRole('button',{name:'Edit this charge / split',exact:true}).count(),0);
     await transition(page,panel.getByRole('button',{name:'Review',exact:true}),reduced,'Settings → recurring review');
     await transition(page,panel.getByRole('button',{name:'Back',exact:true}),reduced,'Recurring review → settings');
     assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert(reviews.every(r=>['update','delete','amount','adopt'].includes(r.operation)));
     console.log('PASS Bills native parity',engine.name(),width,dark?'dark':'light',reduced?'reduced':'motion');cases++;
    }catch(error){await page.screenshot({path:'/private/tmp/bookiebot-bill-editor-parity-failure.png'});throw error}finally{await page.close()}
   }
  }finally{await browser.close()}
 }
 console.log('PASS Bills native editor cases:',cases);
})().catch(error=>{console.error(error);process.exitCode=1});
