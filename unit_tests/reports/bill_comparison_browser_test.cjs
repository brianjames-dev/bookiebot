// Compiled app, synthetic reports, no live API or budget writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
const engines=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const report=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`import json
from unit_tests.reports.test_income_projection import build,income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture','5000'))))))`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}))
const utility=[['pge','PG&E',182.4],['water','Water',142.1],['recology','Recology',101.25]].map(([key,label,currentAmount])=>({key,label,currentAmount,averageAmount:120,deltaAmount:currentAmount-120,history:[{month:7,label:'Jul',amount:100},{month:8,label:'Aug',amount:140},{month:9,label:'Sep',amount:currentAmount}]}))
const all=[...utility,{key:'rent',label:'Rent',currentAmount:2100,averageAmount:2000,deltaAmount:100,history:[{month:7,label:'Jul',amount:2000},{month:8,label:'Aug',amount:2000},{month:9,label:'Sep',amount:2100}]}]
for(const data of [report,...Object.values(report.modeViews)]){
 data.utilityHistory=utility;data.billComparisonHistory=all
 data.calendarEvents=[{kind:'subscription',label:'Xfinity',amount:61.5,day:20,group:'static_bills_subscriptions_needs',projectedOnly:true},{kind:'subscription',label:'ChatGPT',amount:20,day:2,group:'subscriptions_wants',projectedOnly:false}]
}
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(assets,'expense-report-app.js'),'utf8')
const html=dark=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-report-data" type="application/json">${JSON.stringify(report)}</script><script src="/app.js"></script></body></html>`
;(async()=>{let cases=0
 for(const engine of [engines.chromium,engines.webkit]){const browser=await engine.launch({headless:true})
 try{for(const width of (process.env.BOOKIEBOT_BILL_QUICK?[390]:[320,390,768]))for(const dark of (process.env.BOOKIEBOT_BILL_QUICK?[true]:[false,true])){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,reducedMotion:'reduce',colorScheme:dark?'dark':'light'}),errors=[],traffic=[]
  page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.pathname==='/report')return route.fulfill({contentType:'text/html',body:html(dark)});if(url.pathname==='/app.js')return route.fulfill({contentType:'application/javascript',body:js});if(url.pathname.startsWith('/app/assets/company-logo-'))return route.fulfill({contentType:'image/png',body:fs.readFileSync(path.join(assets,path.basename(url.pathname)))});if(/^category-mix-layout-.*\.js$/.test(path.basename(url.pathname)))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,path.basename(url.pathname)),'utf8')});traffic.push(url.pathname);return route.abort()})
  const select=async name=>{await page.getByRole('button',{name:`Show ${name}`,exact:true}).click();await page.waitForFunction(name=>document.querySelector('.bb-chart-carousel-slide[aria-hidden="false"]')?.ariaLabel===name,name);await page.waitForTimeout(200)}
  await page.goto('https://bookie.test/report');await select('Bills & Utilities')
  const panel=page.locator('.bb-bills-analytics'),ribbon=panel.locator('.bb-bill-ribbon')
  assert.equal(await panel.locator('.bb-details-toggle').count(),0)
  assert.equal(await panel.locator('.bb-bill-pill').count(),4)
  assert.match(await panel.innerText(),/\$425.75/)
  const height=(await page.locator('.bb-chart-carousel-band').boundingBox()).height;assert.ok(height<600)
  const before=await panel.locator('.bb-chart-total').innerText()
  await page.getByRole('button',{name:'Highlight PG&E line',exact:true}).click()
  assert.equal(await page.getByRole('button',{name:'Highlight PG&E line',exact:true}).getAttribute('aria-pressed'),'true')
  assert.equal(await panel.locator('.recharts-line').count(),3);assert.equal(await panel.locator('.bb-bill-line-dim').count(),2);assert.equal(await panel.locator('.bb-chart-total').innerText(),before);assert.equal(await page.getByRole('dialog').count(),0)
  await page.waitForFunction(()=>[...document.querySelectorAll('.bb-bill-line-dim')].every(el=>Number(getComputedStyle(el).opacity)<=.301));
  await page.getByRole('button',{name:'Manage visible bills'}).click();const dialog=page.getByRole('dialog',{name:'Bills & utilities',exact:true});await dialog.waitFor()
  await page.getByRole('switch',{name:'Show Xfinity on graph',exact:true}).check();await page.getByRole('button',{name:'Cancel',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(await panel.locator('.bb-bill-pill').count(),4)
  await page.getByRole('button',{name:'Manage visible bills'}).click();await page.getByRole('switch',{name:'Show Xfinity on graph',exact:true}).check();await page.getByRole('button',{name:'Done',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(await panel.locator('.bb-bill-pill').count(),5)
  assert.equal(await page.locator('.bb-chart-carousel-band').evaluate(el=>el.getBoundingClientRect().height),height)
  await page.reload();await select('Bills & Utilities');assert.equal(await panel.locator('.bb-bill-pill').count(),5)
  const geometry=await ribbon.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,pill:el.querySelector('button').getBoundingClientRect().height,padding:parseFloat(getComputedStyle(el.querySelector('button')).paddingLeft),bottom:parseFloat(getComputedStyle(el.closest('.bb-chart-page')).paddingBottom)}))
  assert.equal(geometry.pill,32);assert.equal(geometry.padding,9);assert.equal(geometry.bottom,24)
  if(width<700){assert.ok(geometry.scroll>geometry.width);await ribbon.scrollIntoViewIfNeeded();const box=await ribbon.boundingBox();await page.mouse.move(box.x+box.width*.6,box.y+box.height/2);await page.mouse.wheel(220,0);await page.waitForTimeout(300);assert.ok(await ribbon.evaluate(el=>el.scrollLeft)>0);assert.equal(await page.locator('.bb-chart-carousel-slide[aria-hidden="false"]').getAttribute('aria-label'),'Bills & Utilities')}
  if(width===390&&dark&&engine.name()==='chromium'){
   await page.getByRole('button',{name:'Highlight all visible bills',exact:true}).click()
   await ribbon.evaluate(el=>{el.scrollLeft=el.scrollWidth});const box=await ribbon.boundingBox(),y=box.y+box.height/2,cdp=await page.context().newCDPSession(page),outer=await page.locator('.bb-chart-carousel').evaluate(el=>el.scrollLeft)
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:40,y}]})
   for(let i=1;i<=12;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:40+300*i/12,y}]});await page.waitForTimeout(16)}
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(350)
   assert.ok(await ribbon.evaluate(el=>el.scrollLeft)<10,'A native finger pan scrolls the ribbon back to its beginning')
   assert.ok(Math.abs(await page.locator('.bb-chart-carousel').evaluate(el=>el.scrollLeft)-outer)<1,'Panning through the ribbon edge never swipes to Calendar')
   assert.equal(await page.getByRole('button',{name:'Highlight all visible bills',exact:true}).getAttribute('aria-pressed'),'true','Native scrolling cannot accidentally highlight a pill')
  }
  await page.getByRole('button',{name:'Highlight Xfinity line',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Highlight Xfinity line',exact:true}).getAttribute('aria-pressed'),'true')
  assert.match(await panel.innerText(),/No recorded history for Xfinity yet/);
  for(const name of ['Category Mix','Burn Rate','Calendar']){await select(name);assert.equal((await page.locator('.bb-chart-carousel-band').boundingBox()).height,height);const bounds=await page.locator('.bb-chart-carousel-slide[aria-hidden="false"] .bb-chart-page').evaluate(el=>({height:el.clientHeight,overflow:el.scrollHeight-el.clientHeight}));assert.ok(bounds.overflow<=1,JSON.stringify({name,width,bounds}))}
  await select('Bills & Utilities');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.deepEqual(traffic,[])
  if(width===390&&dark)await panel.screenshot({path:`/private/tmp/bookiebot-bill-ribbon-${engine.name()}.png`})
  cases++;await page.close()
 }}finally{await browser.close()}}
 console.log(`${cases} Chromium/WebKit cases passed: compact pills, highlight-only behavior, visibility Save/Cancel/reload, native nested scrolling and all four shorter shared stages`)
})().catch(error=>{console.error(error);process.exitCode=1})
