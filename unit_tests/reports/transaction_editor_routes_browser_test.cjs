// Every editor route uses the shipped UI. Review responses/data are isolated;
// any confirmation or other financial write fails this test.
const assert=require('node:assert/strict');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const row={id:'2026-10:routes',actionId:'routes',version:'v1',month:'2026-10',date:'2026-10-20',title:'Household supplies',location:'Target',person:'Brian (BofA)',kind:'expense',category:'shopping',categoryLabel:'Shopping',amountCents:10000,displayAmountCents:10000,split:'equal',fields:{date:'2026-10-20',item:'Household supplies',location:'Target',person:'Brian (BofA)',amount:'100.00'},editableFields:['item','location','person','amount'],capabilities:{update:true,split:true,delete:true,move:true,cancel_split:true,undo:false},reasons:{},splitOptions:{custom:true,payerName:'Brian',partnerName:'Hannah',payerBasisPoints:5000,payerCents:5000,incomePayerCents:5731},repayment:{id:'allocation-routes',version:1,accounting:'cash_v1',direction:'incoming',payerName:'Brian',partnerName:'Hannah',grossCents:10000,payerShareCents:5000,partnerShareCents:5000,settledCents:0,clearedCents:0,outstandingCents:5000,pendingCents:0,method:'equal',canEdit:true,editReason:''}};
const widths={closed:382,open:867},height=740;
const root=page=>page.getByRole('region',{name:'Edit transaction',exact:true});
const detail=page=>page.getByRole('region',{name:'Split repayment details',exact:true});
const wide=page=>page.locator('.bb-page').evaluate(el=>el.dataset.duoLandscape==='true');
async function settled(page){await page.waitForTimeout(500)}
async function prepare(page,target){
 if(target==='repayment')return page.locator('.sp-cue');
 const shared=detail(page).getByRole('button',{name:'Edit split',exact:true});if(target==='split'&&await shared.isVisible())return shared;
 const access=page.getByRole('button',{name:'Show actions for Target',exact:true});
 const isWide=await wide(page);if(isWide){await access.press('Enter');await settled(page)}else await access.press('ArrowLeft');
 return page.getByRole('button',{name:(target==='update'?(isWide?'Edit':'Update'):target==='split'?'Split':'Delete')+' Target',exact:true})
}
async function scene(page,target){await(await prepare(page,target)).press('Enter')}
async function sample(page,keep=false){await page.evaluate(keep=>{
 const host=()=>document.querySelector('.bb-page').dataset.duoLandscape==='true'?document.querySelector('.bb-duo-transaction-workspace'):document.querySelector('.bi-selected-row[data-editing="true"]>.bi-expansion');
 const initial=host(),initialFrame=initial?.querySelector('.bi-editor-scenes>.bi-step-viewport');
 window.__routeFrames=(async()=>{const frames=[],start=performance.now();while(performance.now()-start<650){await new Promise(requestAnimationFrame);const h=host(),f=h?.querySelector('.bi-editor-scenes>.bi-step-viewport'),motions=[...(h?.querySelectorAll('.bi-step-viewport[data-moving="true"]')??[])].filter(v=>!v.closest('[inert]'));
 frames.push({time:performance.now()-start,wide:document.querySelector('.bb-page').dataset.duoLandscape==='true',same:!keep||h===initial&&f===initialFrame,open:h?.dataset.open,height:h?.getBoundingClientRect().height??0,width:h?.getBoundingClientRect().width??0,panes:[...(h?.querySelectorAll('.bi-step-viewport')??[])].filter(v=>!v.closest('[inert]')).map(v=>({height:v.getBoundingClientRect().height,width:v.getBoundingClientRect().width,content:v.querySelector(':scope>.bi-step-pane[aria-hidden="false"]')?.offsetHeight,summary:v.querySelector('.sp-summary')?.getBoundingClientRect().height})),moving:motions.length,slides:motions.flatMap(v=>[...v.children].flatMap(p=>p.getAnimations().filter(a=>a.effect.getKeyframes().some(k=>'transform'in k)).map(a=>({duration:a.effect.getTiming().duration,easing:a.effect.getTiming().easing})))),scroll:[...document.querySelectorAll('.bi-step-viewport')].map(e=>e.scrollLeft)});
 }return frames})();
 },keep)}
const frames=page=>page.evaluate(()=>window.__routeFrames);
function noPan(samples){assert(samples.every(s=>s.scroll.every(x=>Math.abs(x)<1)),'Editor focus never pans a slide viewport')}
function oneSlide(samples,reduced,label){noPan(samples);assert(samples.every(s=>s.same),label+': retains the outer workspace');assert(samples.every(s=>s.moving<=1),label+': only one slide layer moves: '+JSON.stringify(samples));if(reduced)assert(samples.every(s=>s.moving===0),label+': reduced motion');else{assert(samples.some(s=>s.moving===1),label+': visible slide');const slides=samples.flatMap(s=>s.slides);assert(slides.length,label+': actual transform animations');assert(slides.every(s=>s.duration===440&&s.easing==='cubic-bezier(0.22, 0.8, 0.25, 1)'),label+': one shared duration/easing: '+JSON.stringify(slides))}}
async function transition(page,target,reduced,label){const trigger=await prepare(page,target);await sample(page,true);await trigger.press('Enter');oneSlide(await frames(page),reduced,label)}
async function fold(page,to){await sample(page);await page.setViewportSize({width:widths[to],height});await page.waitForFunction(to=>(document.querySelector('.bb-page').dataset.duoLandscape==='true')===(to==='open'),to);const samples=await frames(page),after=samples.filter(s=>s.wide===(to==='open'));assert(after.length);noPan(after);assert(after.every(s=>s.height>20),'A selected editor stays present during folding: '+JSON.stringify(after));if(to==='closed'){
 // Available width/text wrapping change during folding too. At every frame
 // the expansion must fit its current content, rather than grow from zero.
 assert(after.every(s=>s.open==='true'),'Folding does not replay row opening');assert(after.every(s=>s.height>=s.panes[0]?.content-.5),'Folded editor stays fully expanded around its current content: '+JSON.stringify(after));
 }assert(after.at(-1).panes.every(p=>Math.abs(p.height-p.content)<=1),'Nested viewports settle to their actual content height');return samples}
(async()=>{let cases=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{
   for(const start of ['closed','open'].filter(s=>!process.env.ONLY_LAYOUT||s===process.env.ONLY_LAYOUT))for(const variant of [{dark:false,reduced:false},{dark:true,reduced:false},{dark:true,reduced:true}].filter(v=>(!process.env.ONLY_MOTION||!v.reduced)&&(!process.env.ONLY_REDUCED||v.reduced))){
    const {dark,reduced}=variant,reviews=[];
    const {page,errors,unexpected}=await fixture(browser,widths[start],height,dark,false,false,0,{transactions:async route=>{const request=route.request(),url=new URL(request.url());if(request.method()==='GET')return route.fulfill({json:{items:[row],total:1,nextOffset:null,categories:['shopping'],persons:['Brian (BofA)'],month:row.month,snapshotVersion:'v1',totalAmountCents:10000,days:[{date:row.date,month:row.month,count:1,totalCents:10000,needsCents:0,wantsCents:10000}]}});if(url.pathname==='/app/transactions/review'){const body=request.postDataJSON();reviews.push(body);return route.fulfill({json:{review:{item:row,operation:body.operation,after:{...row.fields,...body.updates,...(body.updates?.amount?{amount:(body.updates.amount/100).toFixed(2)}:{})},reviewVersion:'isolated-route-review',share:body.operation==='split'?{method:body.method,payerCents:body.payerShareCents??5731,partnerCents:10000-(body.payerShareCents??5731),payerName:'Brian',partnerName:'Hannah'}:undefined}}})}throw Error('No financial writes allowed in route/fold tests')}});
    page.setDefaultTimeout(12000);try{
     await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));await page.locator('.sp-cue').waitFor();await scene(page,'update');await settled(page);
     // An Eulerian cycle covers all 12 directed routes, including revisits of
     // repayment summary and split inside a previously mounted outer scene.
     const route=['update','split','repayment','split','delete','split','update','delete','repayment','delete','update','repayment','update'];
     const covered=new Set();for(let i=1;i<route.length;i++){const from=route[i-1],to=route[i];await transition(page,to,reduced,from+' → '+to);covered.add(from+'>'+to);if(to==='repayment')await detail(page).getByRole('button',{name:'Edit split',exact:true}).waitFor();else assert.equal(await root(page).getAttribute('data-operation'),to)}assert.equal(covered.size,12);
     // Re-enter a retained summary as Split, then a retained Update review as
     // Update. Their inner scenes must start at the requested view rather
     // than sliding a second time inside the already moving outer surface.
     await scene(page,'repayment');await settled(page);await scene(page,'update');await settled(page);await transition(page,'split',reduced,'Revisit repayment summary as Split');
     await scene(page,'update');await settled(page);await page.getByRole('textbox',{name:'Amount',exact:true}).fill('95.00');await page.getByRole('button',{name:'Review change',exact:true}).press('Enter');await page.getByRole('button',{name:'Confirm update',exact:true}).waitFor();await settled(page);await scene(page,'repayment');await settled(page);
     await transition(page,'update',reduced,'Revisit reviewed Update as Edit');
     // All four editor states survive both fold directions. Controlled field
     // text, invalid split input, and reviewed commands retain their identity.
     for(const target of ['update','split','delete','repayment']){
      await scene(page,target);await settled(page);
      if(target==='update')await page.getByRole('textbox',{name:'Amount',exact:true}).fill('94.25');
      if(target==='split')await page.getByRole('textbox',{name:"Brian's share amount",exact:true}).fill('12.345');
      const before=await wide(page);await fold(page,before?'closed':'open');await fold(page,before?'open':'closed');
      if(target==='update')assert.equal(await page.getByRole('textbox',{name:'Amount',exact:true}).inputValue(),'94.25');
      if(target==='split'){assert.equal(await page.getByRole('textbox',{name:"Brian's share amount",exact:true}).inputValue(),'12.345');assert(await page.getByRole('button',{name:'Review split',exact:true}).isDisabled());await page.getByRole('textbox',{name:"Brian's share amount",exact:true}).fill('40.00')}
      if(target==='repayment')await detail(page).getByRole('button',{name:'Edit split',exact:true}).waitFor();else assert.equal(await root(page).getAttribute('data-operation'),target);
      if(target!=='repayment'){
       await page.getByRole('button',{name:target==='split'?'Review split':target==='delete'?'Review deletion':'Review change',exact:true}).press('Enter');await page.getByRole('button',{name:'Confirm '+target,exact:true}).waitFor();await settled(page);await fold(page,await wide(page)?'closed':'open');await page.getByRole('button',{name:'Confirm '+target,exact:true}).waitFor();assert.equal(reviews.at(-1).operation,target);await page.getByRole('button',{name:'Back',exact:true}).press('Enter');await settled(page);
       if(target==='update')assert.equal(await page.getByRole('textbox',{name:'Amount',exact:true}).inputValue(),'94.25');if(target==='split')assert.equal(await page.getByRole('textbox',{name:"Brian's share amount",exact:true}).inputValue(),'40.00');
      }
     }
     // Fold mid-slide, then immediately verify subsequent editor routes still
     // use a single native slide with no retained offscreen transforms.
     await scene(page,'update');await settled(page);await page.getByRole('textbox',{name:'Amount',exact:true}).fill('93.75');await scene(page,'repayment');if(!reduced)await page.waitForTimeout(65);const wasWide=await wide(page);await fold(page,wasWide?'closed':'open');await detail(page).getByRole('button',{name:'Edit split',exact:true}).waitFor();await sample(page,true);await detail(page).getByRole('button',{name:'Edit split',exact:true}).press('Enter');oneSlide(await frames(page),reduced,'After mid-slide fold: reimbursement → Split');
     await page.getByRole('textbox',{name:"Brian's share amount",exact:true}).fill('41.00');await page.getByRole('button',{name:'Review split',exact:true}).press('Enter');await page.getByRole('button',{name:'Confirm split',exact:true}).waitFor();await settled(page);await fold(page,wasWide?'open':'closed');await page.getByRole('button',{name:'Confirm split',exact:true}).waitFor();assert.equal(reviews.at(-1).payerShareCents,4100);await page.getByRole('button',{name:'Back',exact:true}).press('Enter');await settled(page);assert.equal(await page.getByRole('textbox',{name:"Brian's share amount",exact:true}).inputValue(),'41.00');
     assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert(reviews.every(r=>['split','update','delete'].includes(r.operation)));
     console.log('PASS editor routes/folds',engine.name(),start,dark?'dark':'light',reduced?'reduced':'motion',covered.size+' directed routes');cases++;
    }catch(error){await page.screenshot({path:'/private/tmp/bookiebot-editor-routes-failure.png'});throw error}finally{await page.close()}
   }
  }finally{await browser.close()}
 }
 console.log('PASS editor route/fold cases:',cases);
})().catch(error=>{console.error(error);process.exitCode=1});
