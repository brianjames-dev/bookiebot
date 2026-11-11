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
const assets=path.join(root,'src/bookiebot/reports/assets');
const css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(assets,'expense-report-app.js'),'utf8');
const baseline=process.env.BOOKIEBOT_DUO_BASELINE;
const html=(dark,old)=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${old?fs.readFileSync(path.join(baseline,'expense-report-app.css'),'utf8'):css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-app-config" type="application/json">${JSON.stringify({ownerName:'Brian',reportUrl:'/app/expenses/data',logoutUrl:'/app/logout'})}</script><script>localStorage.setItem('bookiebot-expense-report-theme','${dark?'dark':'light'}');localStorage.setItem('bookiebot:duo-layout:brian','true');localStorage.setItem('bookiebot-report-view:v1:brian',JSON.stringify({version:1,mode:'projected',chartId:'category'}));</script><script type="module">${old?fs.readFileSync(path.join(baseline,'expense-report-app.js'),'utf8'):js}</script></body></html>`;
async function fixture(browser,width,height,dark,old=false,pressure=false){
 const page=await browser.newPage({viewport:{width,height},hasTouch:true,isMobile:true,reducedMotion:'reduce'}),errors=[],unexpected=[];
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
;(async()=>{
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch({headless:true});
  try{
   for(const dark of [false,true]){
    for(const [width,height,safe] of [[382,657],[466,678],[867,669],[951,648],[867,553],[867,553,58]]){
     const {page,errors,unexpected}=await fixture(browser,width,height,dark);
     if(safe){await page.evaluate(()=>document.querySelector('.bb-app-shell').style.setProperty('--bb-duo-nav-bottom','58px','important'));await page.waitForTimeout(100);}
     const m=await geometry(page);console.log('PASS geometry',engine.name(),dark?'dark':'light',width,height,JSON.stringify({compareGap:m.compare.y-m.metrics.bottom,fold:m.band.x,ringHeight:m.chart.height}));
     assert.equal(m.scroll[0],width,'horizontal overflow');
     if(width<800){
      assert.equal(m.duo,undefined);assert.equal(m.legend,null);
      assert.equal(m.compare.y-m.metrics.bottom,14,'main comparison gap');
      if(baseline){const before=await fixture(browser,width,height,dark,true),b=await geometry(before.page);for(const key of ['header','month','tools','mode','metrics','compare','band','title','dots','nav','summary','chart'])assert.deepEqual(m[key],b[key],'closed main geometry '+key);await before.page.close();}
     }else{
      assert.equal(m.duo,'true');assert.equal(m.scroll[1],height,'static unfolded page');
      assert(Math.abs(m.band.x-475.5)<1,'physical fold');assert(Math.abs(m.nav.cx-475.5)<1,'physical nav center');assert.equal(m.nav.width,360);assert.equal(m.nav.height,54);
      assert(Math.abs(m.mode.right+14-m.tools.x)<1,'mode left of tools');assert(Math.abs(m.month.cy-m.title.cy)<1,'aligned headings');assert(Math.abs(m.title.cy-m.dots.cy)<1,'inline notches');
      assert(Math.abs(m.legend.bottom-m.compare.bottom)<1,'matched content bottoms');assert.equal(m.nav.y-m.compare.bottom,16,'nav clearance');assert(m.compare.y-m.metrics.bottom>=10,'comparison keeps its vertical breathing room');
      for(const card of m.cards)assert(card.last<=card.bottom+1,'metric content fits');
      assert(m.chart.height>=40,'visible ring space');assert(m.sectors.length>0,'native ring is rendered');
      for(const sector of m.sectors)assert(sector.top>=m.chart.y-1&&sector.bottom<=m.chart.bottom+1,'ring fits');
      assert.equal(await page.locator('.bb-duo-category-list li').count(),10,'all category rows');
      await page.getByRole('button',{name:'Current',exact:true}).click();await page.getByRole('combobox',{name:'Category mix filter'}).selectOption('needs');
      await page.setViewportSize({width:382,height:657});assert.equal(await page.getByRole('button',{name:'Current',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await page.getByRole('combobox',{name:'Category mix filter'}).inputValue(),'needs');
      await page.setViewportSize({width,height});await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),height);
      assert.equal(await page.locator('.bb-chart-carousel-slide[aria-hidden="false"]').getAttribute('aria-label'),'Category Mix','folding preserves the selected chart');
     }
     if(width>=800)await page.getByRole('combobox',{name:'Category mix filter'}).selectOption('all');
     if(process.env.BOOKIEBOT_DUO_SHOTS&&(width===867&&height===669||width===382))await page.screenshot({path:path.join(process.env.BOOKIEBOT_DUO_SHOTS,`duo-${engine.name()}-${dark?'dark':'light'}-${width}.png`),fullPage:true});
     if(width===867&&height===669){
      for(const title of ['Burn Rate','Calendar','Bills & Utilities','Category Mix']){
       const marker=page.getByRole('button',{name:'Show '+title,exact:true});
       const point=await marker.evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};});
       await page.touchscreen.tap(point.x,point.y);
       await page.locator('.bb-chart-carousel[data-settling="false"]').waitFor();
       assert.equal(await page.locator('.bb-chart-carousel-slide[aria-hidden="false"]').getAttribute('aria-label'),title);
       assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),height,'all chart pages stay static');
      }
      await page.getByRole('button',{name:'Compare spending',exact:true}).click();
      await page.locator('.bb-comparison-card[data-open="true"]').waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),height);
      await page.getByRole('button',{name:'Collapse comparison',exact:true}).click();
      await page.getByRole('button',{name:'Ask BookieBot',exact:true}).click();await page.getByRole('button',{name:'Close Ask BookieBot',exact:true}).click();
      await page.getByRole('button',{name:'Settings',exact:true}).click();
      const preference=page.getByRole('switch',{name:'Duo landscape layout',exact:true});await preference.click();assert.equal(await preference.getAttribute('aria-checked'),'false');await preference.click();
      await page.getByRole('button',{name:'Back',exact:true}).click();await page.locator('.bb-app-shell[data-duo-overview="true"]').waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),height);
      const pressureCase=await fixture(browser,width,height,dark,false,true),pressurePage=pressureCase.page;await pressurePage.locator('.bb-category-overflow').waitFor();await pressurePage.waitForTimeout(200);
      const over=await geometry(pressurePage);assert.equal(over.scroll[1],height,'pressure page stays static');assert(over.chart.height>=40,'pressure ring retains space');
      const overlap=await pressurePage.evaluate(()=>{const plot=document.querySelector('.bb-category-chart-box').getBoundingClientRect(),legend=document.querySelector('.bb-duo-category-list').getBoundingClientRect(),footer=document.querySelector('.bb-category-overflow').getBoundingClientRect();return plot.bottom<=legend.top+1&&legend.bottom<=footer.top+1;});assert(overlap,'ring, complete category list and pressure footer have separate rows');
      await pressurePage.setViewportSize({width:867,height:553});
      await pressurePage.evaluate(()=>document.querySelector('.bb-app-shell').style.setProperty('--bb-duo-nav-bottom','58px','important'));await pressurePage.waitForTimeout(200);
      const compactOver=await geometry(pressurePage);assert.equal(compactOver.scroll[1],553);assert(compactOver.chart.height>=60,'Dense cash/ESPP and pressure keep a readable ring above the home indicator: '+compactOver.chart.height);
      for(const card of compactOver.cards)assert(card.last<=card.bottom+1,'Dense compact metrics remain visible');
      for(const scope of ['needs','wants','savings']){await pressurePage.getByRole('combobox',{name:'Category mix filter'}).selectOption(scope);await pressurePage.waitForTimeout(100);const scoped=await geometry(pressurePage);assert.equal(scoped.scroll[1],553);assert(scoped.chart.height>=60,'Dense scoped ring remains readable: '+scope+' '+scoped.chart.height);}
      assert.deepEqual(pressureCase.errors,[]);assert.deepEqual(pressureCase.unexpected,[]);await pressurePage.close();
      console.log('PASS dialogs, navigation, preference and pressure',engine.name(),dark?'dark':'light');
     }
     assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.close();
    }
   }
  }finally{await browser.close();}
 }
 console.log('Duo production layout, exact closed/main parity, rotation and sample-data guards pass');
})().catch(e=>{console.error(e);process.exit(1)});
