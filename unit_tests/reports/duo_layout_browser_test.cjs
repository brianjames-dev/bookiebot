// Production-bundle read-only fixtures. A prior main asset directory enables
// exact closed-phone geometry comparison during release verification.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'));
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright');
const report=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`import json
from unit_tests.reports.test_income_projection import build,income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture income','7200'))))))`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString());
Object.assign(report,{ownerName:'Brian',year:2026,month:10,monthLabel:'October 2026'});
const expenses=[['rent','Rent',1450],['bills_utilities','Bills & Utilities',200],['static_bills_subscriptions_needs','Subscriptions (Needs)',120],['subscriptions_wants','Subscriptions (Wants)',80],['need_expenses','Other Needs',180],['grocery','Groceries',520],['gas','Gas',120],['food','Eating out',610],['shopping','Shopping',800]];
for(const mode of ['current','projected']){
 const view=report.modeViews[mode];
 Object.assign(view.metrics,{monthlyIncome:7200,totalExpenses:4080,amountSaved:820,savingsMinimum:720,savingsIdeal:1440,incomeAfterExpenses:2300});
 view.categoryBudgets={needs:3600,wants:2160,savings:1440};
 view.categoryBalances={raw:{needs:1010,wants:670,savings:620},remaining:{needs:1010,wants:670,savings:620},deficits:{needs:0,wants:0,savings:0},transfers:[],totalOverspend:0};
 view.breakdown=expenses.map(([key,label,amount])=>({key,label,amount,percentage:amount/72,color:'hsl(var(--chart-1))'}));
 view.savingsInvesting=undefined;
}
const pressureReport=structuredClone(report);
for(const view of Object.values(pressureReport.modeViews)){
 view.metrics.totalExpenses=7080;view.metrics.incomeAfterExpenses=-700;view.metrics.monthlyIncome=7600;view.metrics.amountSaved=1220;
 view.savingsInvesting={cashSaved:820,esppContribution:400,estimatedEsppContribution:200};
 view.breakdown.find(row=>row.key==='rent').amount=4450;
 view.categoryBalances={raw:{needs:-1990,wants:670,savings:620},remaining:{needs:-700,wants:0,savings:0},deficits:{needs:1990,wants:0,savings:0},totalOverspend:700,transfers:[{from:'wants',to:'needs',amount:670},{from:'savings',to:'needs',amount:620}]};
}
const assets=process.env.BOOKIEBOT_DUO_ASSETS||path.join(root,'src/bookiebot/reports/assets');
const css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(assets,'expense-report-app.js'),'utf8');
const baseline=process.env.BOOKIEBOT_DUO_BASELINE;
// Hold mobile emulation at 1× during pose changes; explicit viewport cases below exercise zoom-coordinate guards.
const html=(dark,old)=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"><style>${old?fs.readFileSync(path.join(baseline,'expense-report-app.css'),'utf8'):css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-app-config" type="application/json">${JSON.stringify({ownerName:'Brian',reportUrl:'/app/expenses/data',logoutUrl:'/app/logout'})}</script><script>localStorage.setItem('bookiebot-expense-report-theme','${dark?'dark':'light'}');localStorage.setItem('bookiebot:duo-layout:brian','true');localStorage.setItem('bookiebot-report-view:v1:brian',JSON.stringify({version:1,mode:'projected',chartId:'category'}));</script><script type="module">${old?fs.readFileSync(path.join(baseline,'expense-report-app.js'),'utf8'):js}</script></body></html>`;
async function fixture(browser,width,height,dark,old=false,pressure=false,safeRight=0){
 const page=await browser.newPage({viewport:{width,height},hasTouch:true,isMobile:true,reducedMotion:'reduce'}),errors=[],unexpected=[];
 await page.addInitScript(()=>{
  const native=window.visualViewport;if(!native)return;
  const proxy=new EventTarget();let override={};
  for(const key of ['height','width','offsetTop','offsetLeft','pageTop','pageLeft','scale'])Object.defineProperty(proxy,key,{get:()=>override[key]??native[key]});
  for(const name of ['resize','scroll'])native.addEventListener(name,()=>proxy.dispatchEvent(new Event(name)));
  Object.defineProperty(window,'visualViewport',{get:()=>proxy});
  window.__testVisualViewport=values=>{override=values||{};proxy.dispatchEvent(new Event('resize'));proxy.dispatchEvent(new Event('scroll'));};
 });
 if(safeRight)await page.addInitScript(inset=>{
  const native=window.getComputedStyle;
  window.getComputedStyle=function(el,...args){
   const style=native.call(this,el,...args);
   return el.tagName==='SPAN'&&el.style.paddingRight.includes('safe-area-inset-right')
    ?new Proxy(style,{get:(target,key)=>key==='paddingRight'?inset+'px':typeof target[key]==='function'?target[key].bind(target):target[key]}) :style;
  };
 },safeRight);
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url()),name=url.pathname;
  if(url.origin!=='https://bookie.test'||request.method()!=='GET'){unexpected.push(request.method()+' '+url);return route.abort();}
  if(name==='/app/expenses')return route.fulfill({contentType:'text/html',body:html(dark,old)});
  if(/^\/app\/assets\/category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,path.basename(name)),'utf8')});
  let value;
  if(name==='/app/expenses/data')value=page.url().includes('pressure=1')?pressureReport:report;
  else if(name==='/app/expenses/months')value={currentMonth:'2026-10',months:[{value:'2026-09',label:'September 2026'},{value:'2026-10',label:'October 2026'}],coverage:{status:'complete',unavailableYears:[]}};
  else if(name==='/app/expenses/comparison')value={selectedMonth:'2026-10',baselineMonth:'2026-09',baselineKind:'selected-month',mode:url.searchParams.get('mode'),throughDay:10,shortMonthAdjusted:false,selected:{spending:4080,complete:false},baseline:{spending:4500,complete:false},changeAmount:-420,changePercent:-9.3,status:'partial',coverageNote:'Synthetic comparison'};
  else if(name==='/app/reconciliation')value={enabled:true,checkedAt:null,items:[]};
  else if(name==='/app/transactions')value={items:Array.from({length:24},(_,i)=>({id:'fixture-'+i,actionId:'fixture-'+i,version:'fixture-v1',month:'2026-10',date:'2026-10-'+String(i+1).padStart(2,'0'),title:'Fixture purchase '+i,location:'Fixture',person:'Brian',kind:'expense',category:'food',categoryLabel:'Food',amountCents:1000,split:'',fields:{},editableFields:[],capabilities:{},reasons:{}})),total:24,nextOffset:null,categories:[],persons:[],month:'2026-10'};
  else if(name==='/app/reimbursements')value={enabled:true,ownerKey:'brian',currency:'USD',allocations:[],events:[],resets:[],resetState:'fixture'};
  else if(name==='/app/goals')value={goals:[]};
  else if(name==='/app/notifications')value={enabled:false,preferences:{weekly:true,upcoming:false,showAmounts:false,hour:10}};
  else if(name==='/app/widgets/settings')value={connections:[],scriptUrl:'/app/widgets/script',setupInstructionsUrl:'/app/widgets/help'};
  else if(name==='/app/version')value={version:'fixture-version'};
  else if(name.includes('avatar'))return route.fulfill({contentType:'image/png',body:fs.readFileSync(path.join(root,'assets/avatars/avatar7.png'))});
  else {unexpected.push(request.method()+' '+url);return route.fulfill({status:404,json:{error:'Unknown fixture'}});}
  return route.fulfill({json:value});
 });
 await page.goto('https://bookie.test/app/expenses'+(pressure?'?pressure=1':''));await page.locator('.bb-metrics-grid').waitFor();await page.waitForTimeout(200);
 return {page,errors,unexpected};
}
async function geometry(page){return page.evaluate(()=>{
 const q=s=>document.querySelector(s),box=s=>{const r=q(s).getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,cx:r.x+r.width/2,cy:r.y+r.height/2};};
 return {scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],duo:q('.bb-app-shell').dataset.duoOverview,header:box('.bb-report-header'),month:box('.bb-report-header h1'),tools:box('.bb-shell-header-actions'),mode:box('.bb-projection-control'),metrics:box('.bb-metrics-grid'),compare:box('.bb-comparison-card'),band:box('.bb-chart-carousel-band'),title:box('.bb-chart-carousel-title'),dots:box('.bb-chart-carousel-indicators'),nav:box('.bb-navigation-pane'),summary:box('.bb-category-mix-summary'),chart:box('.bb-category-chart-box'),legend:q('.bb-duo-category-list')?box('.bb-duo-category-list'):null,cards:[...document.querySelectorAll('.bb-metric-card')].map(x=>({bottom:x.getBoundingClientRect().bottom,last:x.lastElementChild.getBoundingClientRect().bottom})),sectors:[...document.querySelectorAll('.bb-category-pie-surface path.recharts-sector')].map(x=>x.getBoundingClientRect().toJSON())};
 });}
async function tap(page,button){
 await button.waitFor({state:'visible'});
 const point=await button.evaluate(el=>{
  const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
  return {x,y,hit:document.elementFromPoint(x,y)?.closest('button')===el};
 });
 assert(point.hit,'native touch point reaches the intended button');
 await page.touchscreen.tap(point.x,point.y);
}
async function heldFold(page){
 await page.emulateMedia({reducedMotion:'no-preference'});
 // Reproduce a native layout transition that never delivers pointercancel.
 await page.evaluate(()=>{
  const pane=document.querySelector('.bb-navigation-pane'),button=pane.querySelector('[data-nav-screen="transactions"]'),r=button.getBoundingClientRect();
  window.__heldNav=pane;pane.setPointerCapture=()=>{};
  button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:91,pointerType:'touch',clientX:r.x+r.width/2,clientY:r.y+r.height/2}));
 });
 await page.waitForTimeout(160);
 assert.equal(await page.locator('.bb-navigation-pane').getAttribute('data-glass-contact'),'true','held finger activates the glass');
 await page.setViewportSize({width:382,height:657});await page.waitForTimeout(550);
 assert.equal(await page.evaluate(()=>window.__heldNav.isConnected),false,'fold rebuilds the fixed glass layer');
 assert.notEqual(await page.locator('.bb-navigation-pane').getAttribute('data-glass-contact'),'true','fold cancels the held contact');
 assert.equal(await page.locator('[data-nav-screen="overview"]').getAttribute('data-state'),'active','fold restores the committed selection, not the drag preview');
 for(const [label,screen] of [['Transactions','transactions'],['Shared','shared'],['Savings','savings'],['Reconcile','reconcile'],['Overview','overview']]){
  await tap(page,page.getByRole('button',{name:label,exact:true}));
  await page.locator(`.bb-app-shell[data-screen="${screen}"]`).waitFor();
  assert.equal(await page.locator(`[data-nav-screen="${screen}"]`).getAttribute('aria-current'),'page','folded navigation remains interactive');
 }
 await page.setViewportSize({width:867,height:669});await page.waitForTimeout(550);
 await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));await page.locator('.bb-app-shell[data-screen="transactions"]').waitFor();
 await page.setViewportSize({width:382,height:657});await page.waitForTimeout(550);
 assert.equal(await page.locator('[data-nav-screen="transactions"]').getAttribute('aria-current'),'page','folding retains the selected tab');
 await tap(page,page.getByRole('button',{name:'Overview',exact:true}));await page.locator('.bb-app-shell[data-screen="overview"]').waitFor();
 await page.setViewportSize({width:867,height:669});await page.waitForTimeout(550);
 await page.emulateMedia({reducedMotion:'reduce'});
}
async function scrolledFold(page){
 const atBottom=async expected=>{
  try {await page.waitForFunction(y=>Math.abs(document.querySelector('.bb-navigation-pane').getBoundingClientRect().bottom-y)<1,expected,{timeout:2000});}
  catch(error){console.error('Viewport anchor mismatch',expected,await page.evaluate(()=>({scrollY,innerHeight,visual:[visualViewport.height,visualViewport.offsetTop],bottom:document.querySelector('.bb-navigation-pane').getBoundingClientRect().bottom,anchor:document.querySelector('.bb-bottom-navigation').getAttribute('style'),body:document.body.getAttribute('style')})));throw error;}
 };
 for(let cycle=0;cycle<2;cycle++){
  await page.setViewportSize({width:382,height:657});await page.waitForTimeout(100);
  await page.evaluate(()=>document.querySelector('.bb-page').scrollTo(0,420));await page.waitForTimeout(100);
  assert(await page.evaluate(()=>document.querySelector('.bb-page').scrollTop>200 && window.scrollY===0),'exercise a scrolled closed report');
  const bottom=()=>page.locator('.bb-navigation-pane').evaluate(el=>el.getBoundingClientRect().bottom);
  await atBottom(645);
  assert(Math.abs(await bottom()-645)<1,'closed dock follows the viewport after folding a scrolled page');
  // Native visual geometry can settle later than the layout viewport. Send
  // only visualViewport events, with no window resize or pointer cancellation.
  await page.evaluate(()=>window.__testVisualViewport({height:360,offsetTop:20,scale:1}));await page.waitForTimeout(100);
  await atBottom(645);
  assert(Math.abs(await bottom()-645)<1,'stale visual viewport readings cannot move the dock off the screen bottom');
  await page.evaluate(()=>window.__testVisualViewport(null));await page.waitForTimeout(100);
  await atBottom(645);
  assert(Math.abs(await bottom()-645)<1,'late visual viewport restoration cannot strand the dock mid-screen');
  await page.evaluate(()=>window.__testVisualViewport({height:156,offsetTop:0,scale:4.2}));await atBottom(645);
  await page.evaluate(()=>window.__testVisualViewport(null));await atBottom(645);
  await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));await page.locator('.bb-app-shell[data-screen="transactions"]').waitFor();
  await tap(page,page.getByRole('button',{name:'Overview',exact:true}));await page.locator('.bb-app-shell[data-screen="overview"]').waitFor();
  await page.setViewportSize({width:867,height:669});await page.locator('.bb-app-shell[data-duo-overview="true"]').waitFor();await page.waitForTimeout(100);
  await atBottom(657);
  assert(Math.abs(await bottom()-657)<1,'unfolded dock returns to its right-page bottom');
 }
}
async function isolatedViewport(page){
 await page.setViewportSize({width:382,height:657});await page.waitForTimeout(100);
 await page.evaluate(()=>{document.querySelector('.bb-page').scrollTo(0,0);window.__dockViewport=document.querySelector('.bb-navigation-viewport');});
 assert(await page.locator('.bb-navigation-viewport').evaluate(el=>el.parentElement===document.body),'dock viewport is outside the scrollable page');
 await page.setViewportSize({width:867,height:669});await page.locator('.bb-app-shell[data-duo-overview="true"]').waitFor();
 await page.setViewportSize({width:382,height:657});await page.waitForTimeout(100);
 assert(await page.locator('.bb-navigation-viewport').evaluate(el=>el===window.__dockViewport),'fold/unfold keeps the same viewport surface');
 // Model the page-local containing block that a post-fold rendering layer can
 // retain. The toolbar must remain viewport-owned despite page transforms.
 await page.locator('.bb-page.bb-app-shell').evaluate(el=>{el.style.transform='translateZ(0)';el.style.height='100dvh';});
 for(const y of [0,200,420,100,0]){
  await page.evaluate(y=>document.querySelector('.bb-page').scrollTo(0,y),y);await page.waitForTimeout(100);
  await page.waitForFunction(()=>Math.abs(document.querySelector('.bb-navigation-pane').getBoundingClientRect().bottom-645)<1,null,{timeout:2000});
 }
 await page.locator('.bb-page.bb-app-shell').evaluate(el=>{el.style.removeProperty('transform');el.style.removeProperty('height');});
 assert.equal(await page.locator('.bb-navigation-pane').evaluate(el=>el.closest('.bb-page')),null,'page layout cannot become the dock ancestor');
 await page.evaluate(()=>document.querySelector('.bb-page').scrollTo(0,0));await page.waitForTimeout(100);
}
async function pageScrollLifecycle(page){
 await page.setViewportSize({width:382,height:657});await page.waitForTimeout(100);
 const surface=page.locator('.bb-page');
 await surface.evaluate(el=>el.scrollTo(0,240));await page.waitForTimeout(100);
 await page.evaluate(()=>window.scrollTo(0,500));
 assert.equal(await page.evaluate(()=>window.scrollY),0,'Duo document cannot become the content scroll owner');
 assert.equal(await surface.evaluate(el=>el.scrollTop),240);
 await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));
 await page.locator('.bb-app-shell[data-screen="transactions"]').waitFor();
 assert.equal(await surface.evaluate(el=>el.scrollTop),0,'new tab starts at its own position');
 await tap(page,page.getByRole('button',{name:'Overview',exact:true}));
 await page.locator('.bb-app-shell[data-screen="overview"]').waitFor();
 assert.equal(await surface.evaluate(el=>el.scrollTop),240,'returning restores the content scroll position');
 await page.getByRole('button',{name:'Ask BookieBot',exact:true}).click();
 await page.waitForFunction(()=>document.documentElement.dataset.bbModalScrollLock==='true');
 assert.equal(await surface.evaluate(el=>getComputedStyle(el).overflowY),'hidden','Message locks the content surface');
 // Model native focus scrolling while the dialog owns the keyboard.
 await surface.evaluate(el=>el.scrollTop=0);
 await page.getByRole('button',{name:'Close Ask BookieBot',exact:true}).click();
 await page.waitForFunction(()=>document.documentElement.dataset.bbModalScrollLock!=='true');
 assert.equal(await surface.evaluate(el=>el.scrollTop),240,'closing Message restores the actual content position');
 await surface.evaluate(el=>el.scrollTo(0,0));
 await page.getByRole('button',{name:'Explain Income',exact:true}).click();
 await page.locator('.bb-details-dialog[open]').waitFor();
 assert.equal(await surface.evaluate(el=>getComputedStyle(el).overflowY),'hidden','metric inspection locks the same content surface');
 await page.locator('.bb-details-dialog[open] .bb-details-dialog-close').click();
 await page.waitForFunction(()=>document.documentElement.dataset.bbModalScrollLock!=='true');
 assert.equal(await surface.evaluate(el=>el.scrollTop),0);
 if(page.context().browser().browserType().name()==='chromium'){
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:20,y:520}]});
  for(const y of [470,400,320,230,130]){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:20,y}]});await page.waitForTimeout(25);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(500);
  assert(await surface.evaluate(el=>el.scrollTop>100),'native touch panning moves the Duo content');
  assert.equal(await page.evaluate(()=>scrollY),0,'native touch panning never scrolls the document');
  assert(Math.abs(await page.locator('.bb-navigation-pane').evaluate(el=>el.getBoundingClientRect().bottom)-645)<1,'dock stays pinned after native touch momentum');
  await cdp.detach();
 }
 await surface.evaluate(el=>el.scrollTo(0,0));
 await page.setViewportSize({width:867,height:669});await page.waitForTimeout(100);
 await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));
 await page.locator('.bb-app-shell[data-screen="transactions"]').waitFor();
 await page.setViewportSize({width:382,height:657});await page.waitForTimeout(100);
 assert(await surface.evaluate(el=>el.scrollHeight>el.clientHeight+500),'Transactions has a real long content surface');
 for(let cycle=0;cycle<2;cycle++){
  await surface.evaluate(el=>el.scrollTo(0,300));
  await page.setViewportSize({width:867,height:669});await page.waitForTimeout(100);
  await page.setViewportSize({width:382,height:657});await page.waitForTimeout(100);
  const beforeScroll=await surface.evaluate(el=>el.scrollTop);
  await surface.evaluate(el=>el.scrollBy({top:200,behavior:'instant'}));await page.waitForTimeout(100);
  const afterScroll=await surface.evaluate(el=>el.scrollTop);
  assert(afterScroll-beforeScroll>150,'Transactions keeps scrolling after the fold: '+beforeScroll+' -> '+afterScroll);
  assert.equal(await page.evaluate(()=>scrollY),0);
  assert(Math.abs(await page.locator('.bb-navigation-pane').evaluate(el=>el.getBoundingClientRect().bottom)-645)<1,'Transactions dock stays pinned after folding and scrolling');
 }
 await tap(page,page.getByRole('button',{name:'Overview',exact:true}));
 await page.setViewportSize({width:867,height:669});await page.waitForTimeout(100);
 console.log('PASS content scroll restoration, Message/metric locks, native pan and long Transactions folds');
}
async function bottomScroll(page){
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.setViewportSize({width:382,height:657});await page.waitForTimeout(200);
 await page.evaluate(()=>document.querySelector('.bb-page').scrollTo(0,0));await page.waitForTimeout(200);
 const height=await page.evaluate(()=>document.documentElement.scrollHeight);
 const contentHeight=await page.locator('.bb-page').evaluate(el=>el.scrollHeight);
 assert(contentHeight>657,'the native page scroller contains the entire closed report');
 await page.evaluate(()=>{
  window.__dockPositionWrites=0;
  window.__dockObserver=new MutationObserver(records=>window.__dockPositionWrites+=records.length);
  window.__dockObserver.observe(document.querySelector('.bb-bottom-navigation'),{attributes:true,attributeFilter:['style']});
 });
 for(let i=0;i<8;i++){
  await page.evaluate(()=>document.querySelector('.bb-page').scrollTo(0,document.querySelector('.bb-page').scrollHeight));await page.waitForTimeout(60);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),height,'repeated bottom scrolling never grows blank document space');
  assert.equal(await page.locator('.bb-page').evaluate(el=>el.scrollHeight),contentHeight,'repeated bottom scrolling never grows blank content space');
 }
 // iOS rubber-band scrolling can briefly report a position beyond the real
 // document end. Reproduce that coordinate pair without growing the fixture.
 const elastic=await page.evaluate(async()=>{
  const root=document.querySelector('.bb-app-shell'),rect=root.getBoundingClientRect.bind(root),descriptor=Object.getOwnPropertyDescriptor(window,'scrollY');
  Object.defineProperty(window,'scrollY',{configurable:true,get:()=>window.pageYOffset+120});
  root.getBoundingClientRect=()=>{const r=rect();return {...r.toJSON(),top:r.top-120,bottom:r.bottom-120};};
  try{window.dispatchEvent(new Event('scroll'));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return document.documentElement.scrollHeight;}
  finally{Object.defineProperty(window,'scrollY',descriptor);root.getBoundingClientRect=rect;window.dispatchEvent(new Event('scroll'));}
 });
 assert.equal(elastic,height,'elastic overscroll cannot extend the document through the dock');
 await page.evaluate(()=>document.querySelector('.bb-page').scrollTo(0,0));await page.waitForTimeout(100);
 await page.evaluate(()=>{
  window.__dockFrames=[];window.__sampleDock=true;
  const sample=()=>{window.__dockFrames.push(document.querySelector('.bb-navigation-pane').getBoundingClientRect().bottom);if(window.__sampleDock)requestAnimationFrame(sample)};requestAnimationFrame(sample);
 });
 if(page.context().browser().browserType().name()==='webkit')await page.evaluate(()=>document.querySelector('.bb-page').scrollBy({top:450,behavior:'smooth'}));
 else {await page.mouse.move(100,300);await page.mouse.wheel(0,450);}
 await page.waitForTimeout(550);
 const result=await page.evaluate(()=>{window.__sampleDock=false;window.__dockObserver.disconnect();return {writes:window.__dockPositionWrites,frames:window.__dockFrames,height:document.documentElement.scrollHeight,y:document.querySelector('.bb-page').scrollTop,documentY:scrollY};});
 assert(result.y>0,'browser-native scrolling moves the closed report');
 assert.equal(result.documentY,0,'folded content scrolling never moves the document');
 assert.equal(result.height,657,'the document stays one viewport tall despite long content');
 assert.equal(result.height,height,'native scrolling keeps a finite document');
 assert.equal(result.writes,0,'ordinary Y scrolling performs no navbar position writes');
 assert(result.frames.length>=5&&result.frames.every(y=>Math.abs(y-645)<1),'the dock stays at the viewport bottom throughout native scrolling and compact animation');
 await page.setViewportSize({width:867,height:669});await page.waitForTimeout(100);
 await page.emulateMedia({reducedMotion:'reduce'});
}
;(async()=>{
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch({headless:true});
  try{
   for(const dark of [false,true]){
    for(const [width,height,safe,safeRight] of [[382,657],[466,678],[867,669],[951,648],[867,669,0,84],[951,648,0,84],[867,553],[867,553,58],[867,480]]){
     const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,safeRight);
     if(safe){await page.evaluate(()=>document.querySelectorAll('.bb-app-shell').forEach(el=>el.style.setProperty('--bb-duo-nav-bottom','58px','important')));await page.waitForTimeout(100);}
     const m=await geometry(page);console.log('PASS geometry',engine.name(),dark?'dark':'light',width,height,JSON.stringify({compareGap:m.compare.y-m.metrics.bottom,fold:m.band.x,ringHeight:m.chart.height}));
     assert.equal(m.scroll[0],width,'horizontal overflow');
     if(width<800){
      assert.equal(m.duo,undefined);assert.equal(m.legend,null);
      assert.equal(m.compare.y-m.metrics.bottom,14,'main comparison gap');
      if(baseline){const before=await fixture(browser,width,height,dark,true),b=await geometry(before.page);for(const key of ['header','month','tools','mode','metrics','compare','band','title','dots','nav','summary','chart'])assert.deepEqual(m[key],b[key],'closed main geometry '+key);await before.page.close();}
     }else{
      assert.equal(m.duo,'true');assert.equal(m.scroll[1],height,'static unfolded page');
      const usable=867,fold=475.5;
      assert(Math.abs(m.band.x-fold)<1,'physical fold, including an already-excluded safe area');
      assert(Math.abs(m.nav.cx-(fold+usable)/2)<1,'nav centered within the usable right half');assert.equal(m.nav.width,347.5);assert.equal(m.nav.height,54);
      assert(Math.abs(m.tools.right-(usable-35))<1,'one normal right inset, with no double native-strip reservation');
      assert(Math.abs(m.legend.right-m.tools.right)<1,'chart content aligns with header tools');
      assert.equal(height-m.nav.bottom,safe||12,'same bottom inset as the closed dock');
      assert(Math.abs(m.mode.right+14-m.tools.x)<1,'mode left of tools');assert(Math.abs(m.month.cy-m.title.cy)<1,'aligned headings');assert(Math.abs(m.title.cy-m.dots.cy)<1,'inline notches');
      assert(m.dots.y>=m.mode.bottom,'header controls and chart markers have separate touch areas');
      assert.equal(m.compare.y-m.metrics.bottom,height<=520?8:14,'comparison spacing');assert(Math.abs(m.nav.y-m.legend.bottom-(height<=520?12:16))<1,'chart clears the dock');
      assert(m.metrics.y<=130&&m.summary.y<=130,'both content columns close the former top gap');
      for(const card of m.cards)assert(card.last<=card.bottom+1,'metric content fits');
      assert(m.chart.height>=40,'visible ring space');assert(m.sectors.length>0,'native ring is rendered');
      for(const sector of m.sectors)assert(sector.top>=m.chart.y-1&&sector.bottom<=m.chart.bottom+1,'ring fits');
      assert.equal(await page.locator('.bb-duo-category-list li').count(),10,'all category rows');
      await page.getByRole('button',{name:'Current',exact:true}).click();await page.getByRole('combobox',{name:'Category mix filter'}).selectOption('needs');
      await page.setViewportSize({width:382,height:657});assert.equal(await page.getByRole('button',{name:'Current',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.getByRole('combobox',{name:'Category mix filter'}).inputValue(),'needs');
      await page.setViewportSize({width,height});await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),height);
      assert.equal(await page.locator('.bb-chart-carousel-slide[aria-hidden="false"]').getAttribute('aria-label'),'Category Mix','folding preserves the selected chart');
      const before=await geometry(page);
      await tap(page,page.getByRole('button',{name:'Compare spending',exact:true}));
      await page.locator('.bb-comparison-card[data-open="true"]').waitFor();
      await page.locator('.bb-comparison-change').waitFor();
      const after=await geometry(page);
      for(const key of ['x','y','width'])assert.equal(after.metrics[key],before.metrics[key],'expanded summary retains its position and width');
      assert(after.metrics.height<=before.metrics.height,'summary yields height for comparison');
      for(const card of after.cards)assert(card.last<=card.bottom+1,'every metric/progress row remains inside its frame');
      assert(await page.locator('.bb-metrics-grid').evaluate(el=>[...el.querySelectorAll('button')].every(button=>{const r=button.getBoundingClientRect();return r.width>=44&&r.height>=44;})),'expanded summary preserves 44px touch controls');
      if(height<=610)assert(await page.locator('.bb-comparison-months .bb-month-trigger > span').evaluate(el=>el.getBoundingClientRect().height<=22),'compact month names never break mid-word');
      assert(Math.abs(after.compare.y-after.metrics.bottom-(height<=520?8:14))<1,'comparison expands below the four frames');
      assert(after.compare.right<fold,'expanded comparison stays in the left half');
      assert(after.compare.height>48,'comparison uses its normal expanded height');
      assert.deepEqual(after.band,before.band,'comparison leaves the chart page in place');
      assert.equal(await page.locator('.bb-chart-carousel-band').isVisible(),true,'chart remains visible beside comparison');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),height,'the entire unfolded page stays static');
      assert(await page.locator('.bb-overview-summary').evaluate(el=>{
       const limit=el.getBoundingClientRect(),metrics=el.querySelector('.bb-metrics-grid'),card=el.querySelector('.bb-comparison-card');
       el.scrollTop=9999;
       return el.scrollTop===0&&el.scrollHeight<=el.clientHeight+1&&card.getBoundingClientRect().bottom<=limit.bottom+1&&metrics.scrollHeight<=metrics.clientHeight+1;
      }),'expanded cards and complete comparison fit without scroll or clipping');
      if(process.env.BOOKIEBOT_DUO_SHOTS&&width===867&&height===669&&!safeRight)await page.screenshot({path:path.join(process.env.BOOKIEBOT_DUO_SHOTS,`comparison-${engine.name()}-${dark?'dark':'light'}.png`),fullPage:true});
      await page.setViewportSize({width:382,height:657});await page.locator('.bb-comparison-card[data-open="true"]').waitFor();
      await page.setViewportSize({width,height});await page.locator('.bb-app-shell[data-duo-overview="true"]').waitFor();
      await tap(page,page.getByRole('button',{name:'Collapse comparison',exact:true}));
      await page.locator('.bb-comparison-card[data-open="false"]').waitFor();
      await page.waitForTimeout(50);
      assert.equal(await page.locator('.bb-overview-summary').evaluate(el=>el.scrollTop),0,'collapse returns the short left column to its resting position');
     }
     if(width>=800)await page.getByRole('combobox',{name:'Category mix filter'}).selectOption('all');
     if(process.env.BOOKIEBOT_DUO_SHOTS&&(width===867&&height===669||width===382))await page.screenshot({path:path.join(process.env.BOOKIEBOT_DUO_SHOTS,`duo-${engine.name()}-${dark?'dark':'light'}-${width}.png`),fullPage:true});
     if(width===867&&height===669&&!safeRight){
      await heldFold(page);
      await scrolledFold(page);
      await bottomScroll(page);
      await pageScrollLifecycle(page);
      for(const title of ['Burn Rate','Calendar','Bills & Utilities','Category Mix']){
       const marker=page.getByRole('button',{name:'Show '+title,exact:true});
       await tap(page,marker);
       await page.locator(`.bb-chart-carousel-slide[aria-hidden="false"][aria-label="${title}"]`).waitFor();
       await page.locator('.bb-chart-carousel[data-settling="false"]').waitFor();
       assert.equal(await page.locator('.bb-chart-carousel-slide[aria-hidden="false"]').getAttribute('aria-label'),title);
       assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),height,'all chart pages stay static');
      }
      await page.getByRole('button',{name:'Compare spending',exact:true}).click();
      await page.locator('.bb-comparison-card[data-open="true"]').waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),height);
      await page.getByRole('button',{name:'Collapse comparison',exact:true}).click();
      await page.getByRole('button',{name:'Ask BookieBot',exact:true}).click();await page.getByRole('button',{name:'Close Ask BookieBot',exact:true}).click();
      await page.getByRole('button',{name:'Settings',exact:true}).click();
      const preference=page.getByRole('switch',{name:'Duo landscape layout',exact:true});await preference.click();assert.equal(await preference.getAttribute('aria-checked'),'false');
      assert.notEqual(await page.evaluate(()=>getComputedStyle(document.documentElement).overflowY),'hidden','preference off restores ordinary document scrolling');
      await page.evaluate(()=>window.scrollTo(0,200));assert(await page.evaluate(()=>scrollY>0),'ordinary document can scroll again');
      await preference.click();assert.equal(await page.evaluate(()=>scrollY),0,'enabling Duo returns ownership to the content surface');
      await page.getByRole('button',{name:'Back',exact:true}).click();await page.locator('.bb-app-shell[data-duo-overview="true"]').waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),height);
      const pressureCase=await fixture(browser,width,height,dark,false,true),pressurePage=pressureCase.page;await pressurePage.locator('.bb-category-overflow').waitFor();await pressurePage.waitForTimeout(200);
      const over=await geometry(pressurePage);assert.equal(over.scroll[1],height,'pressure page stays static');assert(over.chart.height>=40,'pressure ring retains space');
      const overlap=await pressurePage.evaluate(()=>{const plot=document.querySelector('.bb-category-chart-box').getBoundingClientRect(),legend=document.querySelector('.bb-duo-category-list').getBoundingClientRect(),footer=document.querySelector('.bb-category-overflow').getBoundingClientRect();return plot.bottom<=legend.top+1&&legend.bottom<=footer.top+1;});assert(overlap,'ring, complete category list and pressure footer have separate rows');
      await pressurePage.setViewportSize({width:867,height:553});
      await pressurePage.evaluate(()=>document.querySelectorAll('.bb-app-shell').forEach(el=>el.style.setProperty('--bb-duo-nav-bottom','58px','important')));await pressurePage.waitForTimeout(200);
      const compactOver=await geometry(pressurePage);assert.equal(compactOver.scroll[1],553);assert(compactOver.chart.height>=60,'Dense cash/ESPP and pressure keep a readable ring above the home indicator: '+compactOver.chart.height);
      for(const card of compactOver.cards)assert(card.last<=card.bottom+1,'Dense compact metrics remain visible');
      for(const scope of ['needs','wants','savings']){await pressurePage.getByRole('combobox',{name:'Category mix filter'}).selectOption(scope);await pressurePage.waitForTimeout(100);const scoped=await geometry(pressurePage);assert.equal(scoped.scroll[1],553);assert(scoped.chart.height>=60,'Dense scoped ring remains readable: '+scope+' '+scoped.chart.height);}
      assert.deepEqual(pressureCase.errors,[]);assert.deepEqual(pressureCase.unexpected,[]);await pressurePage.close();
      console.log('PASS dialogs, navigation, preference and pressure',engine.name(),dark?'dark':'light');
     }
     if(width===382)await isolatedViewport(page);
     assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.close();
    }
   }
  }finally{await browser.close();}
 }
 console.log('Duo production layout, exact closed/main parity, rotation and sample-data guards pass');
})().catch(e=>{console.error(e);process.exit(1)});
