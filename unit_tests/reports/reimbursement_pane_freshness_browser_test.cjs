// Actual native bundle: pane paint/scroll ownership, folding and page freshness.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const data=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_SHARED_BALANCE_FIXTURE,'utf8'));
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-reimbursement-pane-shots';fs.mkdirSync(output,{recursive:true});
async function press(page,node){await node.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await node.press('Enter');await page.waitForTimeout(500)}
(async()=>{let cases=0;for(const engine of engines){const browser=await engine.launch({headless:true});try{for(const[width,height,dark]of[[382,657,false],[867,480,true],[382,657,true],[951,648,false]]){
 const state=structuredClone(data.initial.brian);let release,hold=true,fail=false,reads=0;
 const{page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{request:async route=>{
  if(new URL(route.request().url()).pathname!=='/app/reimbursements')return false;
  assert.equal(route.request().method(),'GET','No financial writes in pane checks');reads++;
  if(hold)await new Promise(resolve=>release=resolve);
  await route.fulfill(fail?{status:503,json:{error:'Isolated refresh failure'}}:{json:state});return true;
 }});
 try{
  await tap(page,page.getByRole('button',{name:'Shared',exact:true}));await page.locator('.bb-page[data-screen=shared]').waitFor();assert.match(await page.locator('.bb-brand-status').innerText(),/Not updated yet/);
  hold=false;release();const stamp=page.locator('.bb-brand-status time');await stamp.waitFor();const first=await stamp.getAttribute('datetime');assert(!Number.isNaN(Date.parse(first)));
  const row=page.locator('.sr-row-main').filter({hasText:'PG&E'}),base=await row.evaluate(el=>getComputedStyle(el).backgroundColor);await press(page,row);
  const detail=page.locator('.sr-detail-host[data-open=true]');await detail.locator('.rp-person-name').waitFor();
  const wide=width>800;
  assert.equal(await detail.evaluate(el=>Boolean(el.closest('.sr-list'))),!wide,'Wide details are outside the list paint/scroll clip; compact details stay inline');
  assert.equal(await row.evaluate((el,base)=>getComputedStyle(el).backgroundColor!==base,base),wide,'Highlight only the selected open-DUO row');
  if(!wide)await detail.locator('.rp-person-name').scrollIntoViewIfNeeded();
  assert(await detail.locator('.rp-person-name').evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+Math.min(8,r.width/2),r.y+r.height/2);return el.contains(hit)}),'The actual right/inline heading paints and accepts hits');
  if(wide){const before=await detail.boundingBox();await page.locator('.sr-list').evaluate(el=>el.scrollTop=el.scrollHeight);const after=await detail.boundingBox();assert(Math.abs(before.y-after.y)<1,'Left scrolling cannot move the detail pane');assert(after.x>width/2&&after.x+after.width<=width);}
  await press(page,detail.getByRole('button',{name:'Record received',exact:true}));const input=detail.locator('input[inputmode=decimal]').filter({visible:true});await input.fill('12.34');await input.evaluate(el=>el.__retainedDraft=true);
  await page.setViewportSize({width:wide?382:867,height:wide?657:480});await page.waitForTimeout(500);assert.equal(await input.inputValue(),'12.34');assert(await input.evaluate(el=>el.__retainedDraft),'Folding retains the same input DOM and controller');
  await page.setViewportSize({width,height});await page.waitForTimeout(500);assert.equal(await input.inputValue(),'12.34');
  await press(page,detail.getByRole('button',{name:'Cancel',exact:true}));await press(page,row);
  fail=true;const beforeFailed=await stamp.getAttribute('datetime');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByRole('alert').waitFor();assert.equal(await stamp.getAttribute('datetime'),beforeFailed,'Failed refresh retains the last success time');
  fail=false;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(300);assert.equal(await page.getByRole('alert').count(),0);assert.notEqual(await stamp.getAttribute('datetime'),first);
  await page.screenshot({path:output+'/'+engine.name()+'-'+width+'-'+dark+'.png'});assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert(reads>=3);cases++;console.log('PASS native pane ownership/highlight/draft/freshness',engine.name(),width,dark);
 }finally{release?.();await page.close()}
 }}finally{await browser.close()}}console.log(cases+' native reimbursement pane/freshness cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
