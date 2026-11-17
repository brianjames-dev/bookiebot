// Native shipped components; all financial phases come from isolated SQL tests.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap,engines,report}=require('./duo_layout_browser_test.cjs');
const data=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_QUEUED_UNDO_FIXTURE,'utf8'));
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-queued-undo-shots';fs.mkdirSync(output,{recursive:true});
const pause=page=>page.waitForTimeout(500);
(async()=>{let count=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){const browser=await engine.launch({headless:true});try{for(const [width,height,dark] of [[382,657,true],[951,669,false]].filter(([w])=>!process.env.ONLY_WIDTH||w===+process.env.ONLY_WIDTH)){for(const kind of ['payment','offset','reset']){
 const phases=data[kind];let phase='initial',releaseSave,releaseRefresh,holdSave=true,holdRefresh=false;const writes=[],phones=[];
 for(const owner of ['brian','hannah']){
  const name=owner==='brian'?'Brian':'Hannah';
  const phone=await fixture(browser,width,height,dark,false,false,0,{config:{ownerName:name},report:()=>({...report,ownerName:name}),request:async route=>{
   const req=route.request(),url=new URL(req.url());if(url.pathname!=='/app/reimbursements')return false;
   if(req.method()==='GET'){if(holdRefresh&&owner==='brian'&&!url.search){holdRefresh=false;await new Promise(resolve=>releaseRefresh=resolve)}await route.fulfill({json:phases[phase][owner]});return true}
   const {requestId,...body}=req.postDataJSON();assert(requestId);writes.push(body);
   if(body.operation==='queue_undo'){assert.deepEqual(body,phases.undo);phase='queued'}else{assert.deepEqual(body,phases.command);if(holdSave)await new Promise(resolve=>releaseSave=resolve);phase='saved'}
   await route.fulfill({json:phases[phase][owner]});return true;
  }});
  phones.push(phone);await tap(phone.page,phone.page.getByRole('button',{name:'Shared',exact:true}));await phone.page.locator('.sr-balance-first').waitFor();await pause(phone.page);await phone.page.emulateMedia({reducedMotion:'no-preference'});
 }
 const [{page,errors,unexpected},hannah]=phones,tag=`${engine.name()}-${width}-${kind}`,popup=page.locator('.sr-native-toast .bi-undo-popup');
 try{
  if(kind==='reset'){await tap(page,page.getByRole('button',{name:'Reimbursement options',exact:true}));await tap(page,page.getByRole('button',{name:'Reset balances',exact:true}));await pause(page)}
  else{await tap(page,page.getByRole('button',{name:kind==='offset'?'Offset & settle':'Record received',exact:true}));await pause(page)}
  const confirm=page.getByRole('button',{name:kind==='reset'?'Confirm reset to $0.00':kind==='offset'?'Confirm offset':'Confirm received',exact:true});await tap(page,confirm);
  await page.waitForFunction(()=>document.querySelector('button[data-saving=true]'));
  assert.equal(await confirm.getAttribute('aria-busy'),'true');assert.equal(await confirm.locator('.bb-report-loading[data-compact=true]').count(),1);assert.equal(await confirm.locator('.bb-saving-label').evaluate(el=>getComputedStyle(el).visibility),'hidden');
  releaseSave();await popup.waitFor();await pause(page);assert.equal(await popup.getAttribute('data-pending'),'true');assert.equal(await popup.locator('.bi-undo-time').count(),0);assert.equal(await page.getByText('Recorded. Expense sheets are still syncing.',{exact:true}).count(),0);
  assert.equal(await popup.locator('button').filter({hasText:'Undo'}).isEnabled(),true);assert.equal(await page.locator('.bi-undo-overlay').getAttribute('data-modal'),'false');
  await tap(page,popup.getByRole('button',{name:'Undo',exact:true}));await page.getByText('Undo queued',{exact:false}).waitFor();await pause(page);assert.equal(writes.length,2);assert.equal(await popup.getByRole('button',{name:'Undo',exact:true}).count(),0);
  await page.reload();await tap(page,page.getByRole('button',{name:'Shared',exact:true}));await page.getByText('Undo queued',{exact:false}).waitFor();await pause(page);
  // Both phones recover the same durable job from a fast SQL snapshot.
  await hannah.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await hannah.page.getByText('Undo queued',{exact:false}).waitFor();
  const rows=page.locator('.sr-row-main');assert(await rows.count()>0);assert.equal(await rows.first().isEnabled(),true,'Queued work must not freeze inspection');await tap(page,rows.first());await pause(page);
  await page.setViewportSize({width:width<800?951:382,height:width<800?669:657});await pause(page);await page.setViewportSize({width,height});await pause(page);assert.equal(await popup.getAttribute('data-pending'),'true');
  await page.screenshot({path:output+'/'+tag+'-queued.png'});
  phase='completed';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await hannah.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('Undone',{exact:true}).waitFor();await hannah.page.getByText('Undone',{exact:true}).waitFor();
  assert.equal(writes.length,2,'Refresh, folds and polling never repeat financial commands');
  await tap(page,popup.getByRole('button',{name:'Dismiss undo',exact:true}));await pause(page);
  if(width>800){
   // Refresh belongs only to the open layout and uses the native rotating arrow.
   holdRefresh=true;const refresh=page.getByRole('button',{name:'Refresh reimbursements',exact:true});assert.deepEqual(await refresh.evaluate(el=>{const s=getComputedStyle(el);return [s.width,s.height,s.borderStyle,s.backgroundColor]}),['44px','44px','none','rgba(0, 0, 0, 0)']);await tap(page,refresh);await page.waitForFunction(()=>document.querySelector('.sr-refresh-spinning'));assert.equal(await refresh.getAttribute('aria-busy'),'true');assert.equal(await refresh.locator('svg').evaluate(el=>getComputedStyle(el).animationName),'sr-refresh-turn');releaseRefresh();await pause(page);
  }else {
   assert.equal(await page.getByRole('button',{name:'Refresh reimbursements',exact:true}).count(),0);
   holdRefresh=true;
   await page.evaluate(()=>{
    document.querySelector('.bb-page[data-duo-enabled=true]').scrollTop=0;
    const target=document.querySelector('.sr-balance-first'),touch=y=>({identifier:77,target,clientX:20,clientY:y,pageX:20,pageY:y});
    for(const [type,y] of [['touchstart',100],['touchmove',400],['touchend',400]]){const e=new Event(type,{bubbles:true,cancelable:true});Object.defineProperties(e,{touches:{value:type==='touchend'?[]:[touch(y)]},changedTouches:{value:[touch(y)]}});target.dispatchEvent(e)}
   });
   await page.waitForFunction(()=>document.querySelector('[data-refreshing=true]'));
   assert(releaseRefresh,'Closed pull-to-refresh invokes the existing registry');releaseRefresh();await pause(page);
  }
  for(const phone of phones){assert.deepEqual(phone.errors,[]);assert.deepEqual(phone.unexpected,[])}count++;console.log('PASS queued responsive Undo, both phones, refresh/fold and native spinner',tag);
 }catch(error){await page.screenshot({path:output+'/failure-'+tag+'.png',fullPage:true});throw error}finally{releaseSave?.();releaseRefresh?.();for(const phone of phones)await phone.page.close()}
 }}}finally{await browser.close()}}console.log(count+' native queued Undo cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
