// Actual shipped bundle, delayed read-only fixtures, both DUO poses/themes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const output=process.env.BOOKIEBOT_SCREENSHOT_DIR||'/private/tmp/bookiebot-loading-shots';fs.mkdirSync(output,{recursive:true});
function delayedReads(){
 const pending=new Map(),counts=new Map();let failTransactions=true;
 const hold=name=>{let release;const wait=new Promise(resolve=>release=resolve);pending.set(name,{wait,release});return()=>{pending.delete(name);release()}};
 return {hold,counts,releaseAll(){for(const {release}of pending.values())release();pending.clear()},async request(route){
  const req=route.request(),name=new URL(req.url()).pathname;
  assert.equal(req.method(),'GET','Loading UI checks never write financial or account data');
  counts.set(name,(counts.get(name)||0)+1);if(pending.has(name))await pending.get(name).wait;
  if(name==='/app/transactions'&&failTransactions){failTransactions=false;await route.fulfill({status:503,json:{error:'Fixture transaction read unavailable.'}});return true}
  if(name==='/app/transactions'){
   const day={date:'2026-10-12',month:'2026-10',count:1,totalCents:1000,needsCents:0,wantsCents:1000};
   await route.fulfill({json:{month:new URL(req.url()).searchParams.get('month')||'2026-10',items:[{id:'loading-fixture',actionId:'loading-fixture',version:'fixture',month:'2026-10',date:day.date,title:'Fixture purchase',location:'Fixture',person:'Brian',kind:'expense',category:'food',categoryLabel:'Food',amountCents:1000,split:'',fields:{},editableFields:[],capabilities:{},reasons:{}}],days:[day],listDays:[day],total:1,nextOffset:null,categories:[],persons:[],totalAmountCents:1000}});return true;
  }
  if(name==='/app/household'){await route.fulfill({json:{account:{id:'fixture-user',name:'Brian'},provider:'sheets',household:null}});return true}
  if(name==='/app/transfers'){await route.fulfill({json:{ownerName:'Brian',today:'2026-11-16',year:2026,settingsVersion:'transfers',transfers:[],goals:[]}});return true}
  if(name==='/app/widgets/script'){await route.fulfill({contentType:'text/javascript',body:'// BookieBot Home Screen widget · v1.5\nconst BOOKIEBOT_ORIGIN = "https://bookie.test";'});return true}
  return false;
 }};
}
async function press(page,button){await button.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));await tap(page,button)}
async function spinner(page,scope,label,compact=false){
 const status=scope.locator('.bb-report-loading').filter({hasText:label});await status.waitFor({timeout:3500});
 await status.evaluate(el=>el.scrollIntoView({block:'center',behavior:'instant'}));
 const ring=status.locator('.bb-report-loading-spinner'),svg=ring.locator('svg');
 const actual=await ring.evaluate(el=>{const style=getComputedStyle(el);return{width:parseFloat(style.width),height:parseFloat(style.height),animation:style.animationName,color:style.color,transform:style.transform}});
 assert.equal(actual.width,compact?20:52,label);assert.equal(actual.height,compact?20:52,label);assert.equal(actual.animation,'bb-pull-spin',label);
 assert.equal(await ring.getAttribute('aria-hidden'),'true');assert.equal(await status.getAttribute('role'),'status');
 const hidden=await status.locator('.sr-only').evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
 assert(hidden.width<=1&&hidden.height<=1,'Pending text stays accessible without a visible loading paragraph');
 assert.equal(await svg.locator('circle').getAttribute('stroke-dashoffset'),'25','Use the exact Overview ring');
 await page.waitForTimeout(160);assert.notEqual(await ring.evaluate(el=>getComputedStyle(el).transform),actual.transform,'The glyph visibly rotates in both engines');
 return status;
}
;(async()=>{let cases=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{for(const [width,height,dark]of [[382,657,false],[867,480,false],[382,657,true],[867,480,true]].filter(([w])=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
   const name=`${engine.name()}-${width}-${dark?'dark':'light'}`,reads=delayedReads();
   let releaseTransactions=reads.hold('/app/transactions'),releaseShared=reads.hold('/app/reimbursements'),releaseGoals=reads.hold('/app/goals');
   const {page,errors,unexpected,comparison}=await fixture(browser,width,height,dark,false,false,0,{request:reads.request});
   try{
    await page.emulateMedia({reducedMotion:'no-preference'});await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));
    const main=page.getByRole('main',{name:'Transactions',exact:true});
    let pending=await spinner(page,main,'Loading recorded transactions…');
    await page.screenshot({path:path.join(output,name+'-transactions.png')});
    await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await pending.locator('.bb-report-loading-spinner').evaluate(el=>getComputedStyle(el).animationName),'none');await page.emulateMedia({reducedMotion:'no-preference'});
    releaseTransactions();await main.getByRole('button',{name:'Try again',exact:true}).waitFor();assert.equal(await main.locator('.bb-report-loading').count(),0,'A failed read shows its actual recovery action');
    releaseTransactions=reads.hold('/app/transactions');await press(page,main.getByRole('button',{name:'Try again',exact:true}));pending=await spinner(page,main,'Loading recorded transactions…');
    await page.setViewportSize({width:width<800?867:382,height:width<800?480:657});await page.waitForTimeout(520);assert.equal(await pending.count(),1);await page.setViewportSize({width,height});await page.waitForTimeout(520);
    assert.equal(reads.counts.get('/app/transactions'),2,'Folding a pending read never refetches it');releaseTransactions();await main.locator('.bb-transaction-list .bb-daily-transaction').first().waitFor();assert.equal(await main.locator('.bb-report-loading').count(),0);
    const graphToggle=main.getByRole('button',{name:'Show spending graph',exact:true});if(await graphToggle.isVisible())await press(page,graphToggle);
    releaseTransactions=reads.hold('/app/transactions');await main.getByRole('combobox',{name:'Graph period',exact:true}).selectOption('3');pending=await spinner(page,main.locator('.bb-recorded-graph-status'),'Loading graph…');releaseTransactions();await pending.waitFor({state:'detached'});
    await tap(page,page.getByRole('button',{name:'Shared',exact:true}));const shared=page.getByRole('main',{name:'Shared',exact:true});pending=await spinner(page,shared,'Loading reimbursements…');releaseShared();await pending.waitFor({state:'detached'});
    await tap(page,page.getByRole('button',{name:'Savings',exact:true}));const savings=page.getByRole('main',{name:'Savings',exact:true});pending=await spinner(page,savings,'Loading your goals…');releaseGoals();await pending.waitFor({state:'detached'});
    await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));await main.waitFor();await page.waitForFunction(()=>document.querySelector('.bb-transactions').getAttribute('aria-busy')==='false');const list=main.locator('.bb-transaction-list'),before=await list.innerText();
    releaseTransactions=reads.hold('/app/transactions');const beforeReads=reads.counts.get('/app/transactions');const refresh=page.getByRole('button',{name:'Refresh Transactions',exact:true});assert(await refresh.isEnabled());await refresh.evaluate(el=>el.click());await page.waitForFunction(()=>document.querySelector('.bb-transactions').getAttribute('aria-busy')==='true');
    assert.equal(await list.innerText(),before,'A refresh retains the actual loaded rows');assert.equal(await main.locator('.bb-recorded-results>.bb-report-loading').count(),0);releaseTransactions();await page.waitForFunction(()=>document.querySelector('.bb-transactions').getAttribute('aria-busy')==='false');await page.waitForTimeout(150);const refreshReads=reads.counts.get('/app/transactions')-beforeReads;assert(refreshReads>=1&&refreshReads<=2,'A refresh retains bounded list/graph reads instead of starting a loading loop');
    await tap(page,page.getByRole('button',{name:'Overview',exact:true}));comparison.hold=true;await press(page,page.getByRole('button',{name:/Compare spending/}));pending=await spinner(page,page.locator('.bb-comparison-card'),'Comparing matching days…',true);assert(comparison.release);comparison.release();await pending.waitFor({state:'detached'});
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);cases++;console.log('PASS initial/list/graph/shared/savings/comparison spinners, error recovery, fold, refresh and reduced motion',name);
   }catch(error){await page.screenshot({path:path.join(output,name+'-failure.png')});throw error}finally{reads.releaseAll();await page.close()}
   const settingsReads=delayedReads();let releaseWidgets=settingsReads.hold('/app/widgets/settings'),releaseNotifications=settingsReads.hold('/app/notifications'),releaseHousehold=settingsReads.hold('/app/household');
   const settings=await fixture(browser,width,height,dark,false,false,0,{initialHash:'#settings',config:{householdEnabled:true},request:settingsReads.request});
   try{
    const page=settings.page;await page.emulateMedia({reducedMotion:'no-preference'});const main=page.getByRole('main',{name:'Settings',exact:true});
    let pending=await spinner(page,main,'Loading widgets…');await page.screenshot({path:path.join(output,name+'-widgets.png')});releaseWidgets();await pending.waitFor({state:'detached'});
    pending=await spinner(page,main,'Loading notification settings…',true);releaseNotifications();await pending.waitFor({state:'detached'});
    pending=await spinner(page,main,'Loading household…');releaseHousehold();await pending.waitFor({state:'detached'});
    let release=settingsReads.hold('/app/transfers');await press(page,main.getByRole('button',{name:'Manage savings transfers',exact:true}));const transfers=page.getByRole('main',{name:'Transfers',exact:true});pending=await spinner(page,transfers,'Loading transfers…');release();await pending.waitFor({state:'detached'});
    await press(page,page.locator('.bb-settings-masthead-title button'));release=settingsReads.hold('/app/widgets/script');await press(page,main.getByRole('button',{name:'Setup & widgets',exact:true}));const guide=page.getByRole('main',{name:'Widget setup',exact:true});pending=await spinner(page,guide,'Loading script…',true);assert(await guide.getByRole('button',{name:'Loading script…',exact:true}).isDisabled());release();await pending.waitFor({state:'detached'});await guide.getByRole('button',{name:'Copy script',exact:true}).waitFor();
    assert.deepEqual(settings.errors,[]);assert.deepEqual(settings.unexpected,[]);cases++;console.log('PASS Settings widgets/notifications/household/transfers/script spinners',name);
   }catch(error){await settings.page.screenshot({path:path.join(output,name+'-settings-failure.png')});throw error}finally{settingsReads.releaseAll();await settings.page.close()}
  }}finally{await browser.close()}
 }
 console.log(cases+' native shared-loading cases passed; screenshots '+output);
})().catch(error=>{console.error(error);process.exitCode=1});
