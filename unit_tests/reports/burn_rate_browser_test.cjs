// Run after npm run build. All traffic is served from synthetic report fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
const engines=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const fixture=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`
import json
from unit_tests.reports.test_income_projection import build,income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture income','5000'))))))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(assets,'expense-report-app.js'),'utf8')
const csp=fs.readFileSync(path.join(root,'src/bookiebot/reports/phone_app.py'),'utf8').match(/"Content-Security-Policy": "([^"]+)"/)[1]
const shell=Boolean(process.env.BOOKIEBOT_BURN_SHELL)
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n),round=n=>Math.round(n*100)/100
function reportFor(scenario='regular'){
 const report=structuredClone(fixture),daily=[40,45,70,250,200,20,250,0,0,0,65,20,400,0,0,0,0,50,40,230,0,0,50,60,100,139.32]
 if(scenario==='surge')daily[0]+=350
 if(scenario==='over')daily[25]+=1200
 const budget=scenario==='zero'?0:2994.92,elapsedDays=scenario==='future'?0:scenario==='first-day'?1:26
 let actual=0
 const series=Array.from({length:31},(_,i)=>{const day=i+1,expectedSpend=round(budget*day/31),variance=scenario.startsWith('crest-')?-50+400*Math.exp(-Math.pow((day-Number(scenario.split('-')[1]))/4,2)):scenario==='plateau'?200:scenario==='gentle-ramp'?200+day*2:scenario==='arch'?200+30*Math.sin(day/5):scenario==='dip'?(day<=2?-80*day:260+100*Math.sin(day/5)):null,dailySpend=day<=elapsedDays?(variance!==null?round(expectedSpend+variance-actual):scenario==='zero'?0:daily[i]):null;actual=round(actual+(dailySpend??0));return {day,label:String(day),dailySpend,actualSpend:day<=elapsedDays?actual:null,expectedSpend,variance:day<=elapsedDays?round(actual-expectedSpend):null}})
 const expectedSpend=round(budget*elapsedDays/31),diff=round(actual-expectedSpend)
 const burnRate={budget,spent:actual,remaining:round(budget-actual),daysInMonth:31,elapsedDays,expectedSpend,allowedDailyAverage:round(budget/31),actualDailyAverage:elapsedDays?round(actual/elapsedDays):0,dailyDifference:elapsedDays?round(diff/elapsedDays):0,totalDifference:diff,status:!elapsedDays?'not_started':diff>0?'over':'under',series}
 Object.assign(report,{year:2026,month:10,monthLabel:'October 2026',elapsedDays,burnRate})
 for(const view of Object.values(report.modeViews)){
  view.burnRate=structuredClone(burnRate)
  view.categoryBalances={raw:{needs:0,wants:burnRate.remaining,savings:0},remaining:{needs:0,wants:burnRate.remaining,savings:0},deficits:{needs:0,wants:Math.max(0,-burnRate.remaining),savings:0},transfers:[],totalOverspend:Math.max(0,-burnRate.remaining)}
 }
 return report
}
const html=(report,dark,before=false)=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${before?fs.readFileSync(process.env.BOOKIEBOT_BURN_REFERENCE_CSS,'utf8'):css}</style></head><body><div id="bookiebot-expense-report-root"></div>${shell?`<script id="bookiebot-expense-app-config" type="application/json">${JSON.stringify({ownerName:"Brian",reportUrl:"/fixture-report",logoutUrl:"/app/logout"})}</script>`:""}<script id="bookiebot-expense-report-data" type="application/json">${JSON.stringify(report)}</script><script type="module" src="/${before?'before':'app'}.js"></script></body></html>`
async function nativePoint(page,day,touch){
 const chart=page.locator('#bb-chart-burn-rate .recharts-wrapper')
 const position=await chart.evaluate((chart,day)=>{const line=chart.querySelector('.recharts-line-curve'),first=line.getPointAtLength(0),last=line.getPointAtLength(line.getTotalLength()),x=first.x+(last.x-first.x)*(day-1)/25;let lo=0,hi=line.getTotalLength();for(let n=0;n<30;n++){const mid=(lo+hi)/2;if(line.getPointAtLength(mid).x<x)lo=mid;else hi=mid}const p=line.getPointAtLength((lo+hi)/2);return{x:p.x,y:p.y}},day)
 if(touch)await chart.tap({position});else await chart.hover({position})
 await page.waitForFunction(day=>document.querySelector('.bb-burn-node-tooltip')?.dataset.inspectedDay===String(day),day)
 await page.waitForTimeout(70)
}
async function graph(page){return page.locator('#bb-chart-burn-rate').evaluate(el=>{
 const line=el.querySelector('.recharts-line-curve'),rect=el.querySelector('clipPath rect'),samples=[]
 for(let d=0;d<=25;d++){const x=line.getPointAtLength(0).x+(line.getPointAtLength(line.getTotalLength()).x-line.getPointAtLength(0).x)*d/25;let lo=0,hi=line.getTotalLength();for(let n=0;n<30;n++){const mid=(lo+hi)/2;if(line.getPointAtLength(mid).x<x)lo=mid;else hi=mid}const p=line.getPointAtLength((lo+hi)/2);samples.push([(p.x-rect.x.baseVal.value)/rect.width.baseVal.value,(p.y-rect.y.baseVal.value)/rect.height.baseVal.value])}
 return {samples,stops:[...el.querySelectorAll('linearGradient stop')].map(n=>[n.getAttribute('offset'),n.getAttribute('stop-color')])}
})}
async function inspect(page){return page.locator('#bb-chart-burn-rate').evaluate(el=>{
 const clip=el.querySelector('clipPath rect'),svg=el.querySelector('.recharts-surface'),a=new DOMPoint(clip.x.baseVal.value,clip.y.baseVal.value).matrixTransform(svg.getScreenCTM()),b=new DOMPoint(clip.x.baseVal.value+clip.width.baseVal.value,clip.y.baseVal.value+clip.height.baseVal.value).matrixTransform(svg.getScreenCTM()),plotRect={left:a.x,top:a.y,right:b.x,bottom:b.y},t=el.querySelector('.bb-burn-node-tooltip'),portal=el.querySelector('.bb-burn-tooltip-portal'),rail=t.querySelector('.bb-burn-balance-rail'),fill=rail.querySelector('.bb-burn-overfill'),card=t.getBoundingClientRect(),wrapper=portal.querySelector('.recharts-tooltip-wrapper'),dot=el.querySelector('.bb-burn-rate-active-dot')?.getBoundingClientRect()
 const line=el.querySelector('.recharts-line-curve'),matrix=line.getScreenCTM();let curveHits=0
 for(let at=0;at<=line.getTotalLength();at+=2){const p=line.getPointAtLength(at).matrixTransform(matrix);if(p.x>card.left-6&&p.x<card.right+6&&p.y>card.top-6&&p.y<card.bottom+6)curveHits++}
 const obstacles=[],range=document.createRange()
 for(const section of el.querySelectorAll('.bb-chart-page-header,.bb-chart-page-footer')){const walker=document.createTreeWalker(section,NodeFilter.SHOW_TEXT);let text;while(text=walker.nextNode()){if(!text.textContent.trim())continue;range.selectNodeContents(text);for(const r of range.getClientRects())obstacles.push({r,label:text.textContent})}for(const n of section.querySelectorAll('button,.bb-burn-balance-rail,.bb-burn-legend,.bb-category-pressure-track'))obstacles.push({r:n.getBoundingClientRect(),label:n.className})}
 for(const n of el.querySelectorAll('.recharts-cartesian-axis-tick-value'))obstacles.push({r:n.getBoundingClientRect(),label:n.textContent})
 const metricHits=obstacles.filter(({r})=>r.width&&r.height&&card.left<r.right+5&&card.right>r.left-5&&card.top<r.bottom+5&&card.bottom>r.top-5).map(n=>n.label)
 const fixedHits=[...document.querySelectorAll('.bb-bottom-navigation:not([hidden]) .bb-navigation-pane,.bb-shell-header-actions button')].filter(n=>{const r=n.getBoundingClientRect();return r.width&&r.height&&card.left<r.right+5&&card.right>r.left-5&&card.top<r.bottom+5&&card.bottom>r.top-5}).map(n=>n.className)
 const anchor=dot?{x:dot.x+dot.width/2,y:dot.y+dot.height/2}:null,anchorDistance=anchor?Math.hypot(anchor.x-Math.max(card.left,Math.min(card.right,anchor.x)),anchor.y-Math.max(card.top,Math.min(card.bottom,anchor.y))):null
 return {fixedHits,opacity:getComputedStyle(portal).opacity,anchor,anchorDistance,curveHits,metricHits,day:t.dataset.inspectedDay,text:t.innerText,header:t.querySelector('.bb-burn-mini-header').innerText,labels:t.querySelector('.bb-burn-pair-labels').innerText,values:t.querySelector('.bb-burn-pair-values').innerText,over:rail.dataset.over,fill:fill?{percent:parseFloat(fill.style.width),x:fill.getBoundingClientRect().x,color:getComputedStyle(fill).backgroundColor}:null,rail:rail.getBoundingClientRect().toJSON(),background:getComputedStyle(rail).backgroundColor,card:card.toJSON(),labelBottom:t.querySelector('.bb-burn-pair-labels').getBoundingClientRect().bottom,valueTop:t.querySelector('.bb-burn-pair-values').getBoundingClientRect().top,transform:getComputedStyle(wrapper).transform,transition:getComputedStyle(portal).transitionDuration,positioned:portal.dataset.positionedDay,plotRect,outsidePlot:card.bottom<=plotRect.top||card.top>=plotRect.bottom||card.right<=plotRect.left||card.left>=plotRect.right,hidesDot:dot?card.x<dot.right+6&&card.right>dot.x-6&&card.y<dot.bottom+6&&card.bottom>dot.y-6:false,shade:getComputedStyle(el.querySelector('.recharts-area-area')).fillOpacity,stage:document.querySelector('.bb-chart-carousel-band').getBoundingClientRect().height,plot:el.querySelector('.recharts-wrapper').getBoundingClientRect().height,details:!!el.querySelector('.bb-details-toggle'),overflow:document.documentElement.scrollWidth>innerWidth}
 })}
;(async()=>{
 let checks=0,frames=0
 for(const engineName of (process.env.BOOKIEBOT_BURN_ENGINE?[process.env.BOOKIEBOT_BURN_ENGINE]:['chromium','webkit'])){
 const browser=await engines[engineName].launch({headless:true})
 try{
 for(const width of (process.env.BOOKIEBOT_BURN_QUICK?[390]:[320,390,1280]))for(const dark of (process.env.BOOKIEBOT_BURN_QUICK&&!shell?[true]:[false,true])){
  const touch=width<700,page=await browser.newPage({viewport:{width,height:900},hasTouch:touch,colorScheme:dark?'dark':'light',reducedMotion:dark?'reduce':'no-preference'}),errors=[],unexpected=[]
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/*',async route=>{const url=new URL(route.request().url()),name=url.pathname.split('/').pop();if(url.pathname==='/report')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':csp},body:html(reportFor(url.searchParams.get('scenario')||'regular'),dark,url.searchParams.has('before'))});if(name==='app.js')return route.fulfill({contentType:'application/javascript',body:js});if(name==='before.js'&&process.env.BOOKIEBOT_BURN_REFERENCE_SCRIPT)return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(process.env.BOOKIEBOT_BURN_REFERENCE_SCRIPT,'utf8')});if(/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,name),'utf8')});if(shell){
   if(route.request().method()!=='GET'){unexpected.push(route.request().method()+' '+url.pathname);return route.abort()}
   if(url.pathname==='/fixture-report')return route.fulfill({json:reportFor(new URL(page.url()).searchParams.get('scenario')||'regular')})
   const responses={'/app/reconciliation':{enabled:true,items:[],checkedAt:'2026-10-30T00:00:00Z'},'/app/reimbursements':{enabled:true,ownerKey:'brian',currency:'USD',allocations:[],events:[],resets:[],resetState:'fixture'},'/app/goals':{goals:[]},'/app/notifications':{enabled:false,publicKey:'B'+'A'.repeat(86),preferences:{}},'/app/widgets/settings':{connections:[]},'/app/version':{version:'fixture-version'},'/app/expenses/months':{currentMonth:'2026-10',months:[{value:'2026-10',label:'October 2026'}],coverage:{status:'complete',unavailableYears:[]}}}
   if(responses[url.pathname])return route.fulfill({json:responses[url.pathname]})
   if(url.pathname.includes('avatar'))return route.fulfill({contentType:'image/png',body:fs.readFileSync(path.join(root,'assets/avatars/avatar7.png'))})
  }unexpected.push(url.pathname);await route.abort()})
  const open=async(scenario='regular',before=false)=>{await page.goto(`https://bookie.test/report?scenario=${scenario}${before?'&before=1':''}`);await page.getByRole('button',{name:'Show Burn Rate',exact:true}).click();await page.locator('#bb-chart-burn-rate').scrollIntoViewIfNeeded();await page.waitForTimeout(450)}
  if(shell){
   for(const crest of [6,14,22]){
    await open(`crest-${crest}`)
    for(const chartTop of [260,560])for(const compact of [false,true]){
     const base=await page.locator('#bb-chart-burn-rate .recharts-wrapper').evaluate(el=>scrollY+el.getBoundingClientRect().top)
     const y=base-chartTop
     await page.evaluate(({y,compact})=>scrollTo(0,y+(compact?-60:60)),{y,compact});await page.waitForTimeout(80)
     await page.evaluate(y=>scrollTo(0,y),y);await page.waitForTimeout(400)
     assert.equal(await page.locator('.bb-bottom-navigation').getAttribute('data-compact'),String(compact))
     const point=await page.locator('#bb-chart-burn-rate .recharts-wrapper').evaluate((el,day)=>{const line=el.querySelector('.recharts-line-curve'),matrix=line.getScreenCTM(),x=line.getPointAtLength(0).x+(line.getPointAtLength(line.getTotalLength()).x-line.getPointAtLength(0).x)*(day-1)/25;let lo=0,hi=line.getTotalLength();for(let n=0;n<30;n++){const mid=(lo+hi)/2;if(line.getPointAtLength(mid).x<x)lo=mid;else hi=mid}const p=line.getPointAtLength((lo+hi)/2).matrixTransform(matrix);return{x:p.x,y:p.y}},crest)
     await page.touchscreen.tap(point.x,point.y)
     await page.waitForFunction(day=>document.querySelector('.bb-burn-node-tooltip')?.dataset.inspectedDay===String(day),crest)
     await page.waitForTimeout(100)
     const actual=await inspect(page);assert.equal(actual.opacity,'1',JSON.stringify(actual));assert.deepEqual(actual.fixedHits,[],JSON.stringify(actual));assert.equal(actual.hidesDot,false,JSON.stringify(actual));assert.equal(actual.curveHits,0,JSON.stringify(actual))
     assert.ok(actual.anchorDistance<=actual.card.height,JSON.stringify(actual));checks++
     // The still-open card must follow the changing nav geometry without a tap.
     await page.evaluate(compact=>scrollBy(0,compact?-35:65),compact);await page.waitForTimeout(450)
     const moved=await inspect(page);assert.equal(moved.opacity,'1');assert.deepEqual(moved.fixedHits,[],JSON.stringify(moved));checks++
    }
   }
   await page.screenshot({path:`/private/tmp/burn-rate-nav-${engineName}-${dark?'dark':'light'}.png`})
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log(engineName,'shell',dark?'dark':'light','PASS');await page.close();continue
  }
  let reference
  if(process.env.BOOKIEBOT_BURN_REFERENCE_SCRIPT){await open('regular',true);reference=await graph(page)}
  await open()
  const stage=(await page.locator('.bb-chart-carousel-band').boundingBox()).height
  if(reference){const actual=await graph(page);assert.deepEqual(actual.stops,reference.stops);for(let i=0;i<26;i++)for(let axis=0;axis<2;axis++)assert.ok(Math.abs(actual.samples[i][axis]-reference.samples[i][axis])<.00001,'The original monotone line and zero-relative data geometry remain unchanged')}
  await page.evaluate(()=>{window.__burnFrames=[];const tick=()=>{const t=document.querySelector('.bb-burn-node-tooltip'),p=document.querySelector('.bb-burn-tooltip-portal');if(t&&p.dataset.positionedDay&&window.__burnFrames.length<5000)window.__burnFrames.push({day:t.dataset.inspectedDay,positioned:p.dataset.positionedDay,transform:getComputedStyle(p.querySelector('.recharts-tooltip-wrapper')).transform,transition:getComputedStyle(p).transitionDuration});requestAnimationFrame(tick)};requestAnimationFrame(tick)})
  for(const day of [5,13,20,1,26,13]){
   await nativePoint(page,day,touch)
   const actual=await inspect(page),point=reportFor().burnRate.series[day-1]
   assert.ok(actual.header.startsWith(`Oct ${day}`)&&actual.header.endsWith(`${money(point.dailySpend)} spent`),JSON.stringify(actual))
   assert.ok(actual.values.includes(money(point.actualSpend))&&actual.values.includes(money(point.expectedSpend)))
   assert.ok(!/Through|to date|Day spent|Total Spent/.test(actual.text));assert.ok(actual.labels.includes('Spent')&&actual.labels.includes('Limit'))
   assert.ok(actual.labelBottom<=actual.rail.top&&actual.valueTop>=actual.rail.bottom)
   assert.equal(actual.over,String(point.variance>0));if(point.variance>0){assert.ok(Math.abs(actual.fill.percent-Math.min(1,point.variance/point.expectedSpend)*100)<.001);assert.ok(Math.abs(actual.fill.x-actual.rail.x)<.1);assert.notEqual(actual.fill.color,actual.background)}else assert.equal(actual.fill,null)
   assert.equal(actual.transform,'none');assert.equal(actual.transition,'0s');assert.equal(actual.positioned,String(day));assert.equal(actual.hidesDot,false,JSON.stringify(actual));assert.equal(actual.curveHits,0,JSON.stringify(actual));assert.equal(actual.shade,'0.1');assert.equal(actual.stage,stage);assert.equal(actual.details,false);assert.ok(actual.plot>170);assert.equal(actual.overflow,false);assert.ok(actual.card.x>=0&&actual.card.right<=width+.1,JSON.stringify(actual));checks++
  }
  await page.locator('#bb-chart-burn-rate').screenshot({path:`/private/tmp/burn-rate-shipped-${engineName}-${width}-${dark?'dark':'light'}.png`})
  const sampled=await page.evaluate(()=>window.__burnFrames);for(const frame of sampled){assert.equal(frame.day,frame.positioned,'No frame paints new content at the previous anchor');assert.equal(frame.transform,'none');assert.equal(frame.transition,'0s')}frames+=sampled.length
  // Native tooltip still holds and fades, and can be opened again afterward.
  if(width===390){
   await nativePoint(page,20,touch)
   assert.equal(await page.locator('.bb-burn-tooltip-portal .bb-chart-tooltip-frame').count(),1,'One lifecycle frame owns the fade')
   const fade=page.locator('.bb-burn-tooltip-portal .bb-chart-tooltip-frame-dismissing')
   await page.waitForFunction(()=>document.querySelector('.bb-burn-tooltip-portal .bb-chart-tooltip-frame-dismissing'),null,{polling:'raf'})
   await page.waitForTimeout(90)
   const first=await fade.evaluate(n=>({opacity:+getComputedStyle(n).opacity,duration:getComputedStyle(n).transitionDuration,transform:getComputedStyle(n).transform}))
   assert.ok(first.opacity>0&&first.opacity<1,JSON.stringify(first));assert.ok(first.duration.includes('0.36s'))
   if(dark)assert.equal(first.transform,'none','Reduced motion keeps the opacity fade without scaling')
   await page.waitForTimeout(110);const later=await fade.evaluate(n=>+getComputedStyle(n).opacity)
   assert.ok(later>0&&later<first.opacity,'The popup fades progressively instead of snapping or unmounting early')
   await page.waitForTimeout(210);assert.equal(await page.locator('.bb-burn-node-tooltip').count(),0)
   await nativePoint(page,20,touch);await page.mouse.wheel(0,160);await page.waitForTimeout(100)
   assert.equal(await page.locator('.bb-burn-node-tooltip').count(),1,'Scrolling keeps the popup attached to its chart during the existing hold')
   const scrolled=await inspect(page);assert.ok(scrolled.card.top>=0&&scrolled.card.bottom<=900,'Placement respects the visible viewport after scrolling')
   await page.getByRole('button',{name:'Show Calendar',exact:true}).click();await page.waitForTimeout(450);assert.equal(await page.locator('.bb-burn-node-tooltip').count(),0)
   await page.getByRole('button',{name:'Show Burn Rate',exact:true}).click();await nativePoint(page,13,touch)
   await page.getByRole('button',{name:'Projected',exact:true}).click();await page.waitForTimeout(450);assert.equal(await page.locator('.bb-burn-node-tooltip').count(),0);checks+=7
  }
  // Several unrelated curve shapes must be able to use clear interior space
  // without masking the line, summary numbers, axis labels or monthly totals.
  for(const scenario of ['plateau','gentle-ramp','arch','dip']){
   await open(scenario)
   for(const day of (scenario==='dip'?[2,13,26]:[13])){
    await nativePoint(page,day,touch);const actual=await inspect(page)
    assert.equal(actual.hidesDot,false,JSON.stringify(actual));assert.equal(actual.curveHits,0,JSON.stringify(actual));assert.deepEqual(actual.metricHits,[],JSON.stringify(actual))
    assert.equal(actual.outsidePlot,false,JSON.stringify({scenario,width,engineName,day,...actual}))
    assert.equal(actual.overflow,false);checks++
   }
   if(width===390&&dark&&scenario==='dip')await page.locator('#bb-chart-burn-rate').screenshot({path:`/private/tmp/burn-rate-pocket-${engineName}.png`})
  }
  for(const crest of [6,14,22]){
   await open(`crest-${crest}`)
   for(const day of [1,crest,26]){
    await nativePoint(page,day,touch);const actual=await inspect(page)
    assert.equal(actual.hidesDot,false,JSON.stringify(actual));assert.equal(actual.curveHits,0,JSON.stringify(actual))
    if(day===crest)assert.ok(actual.anchorDistance<=actual.card.height*.9,JSON.stringify({crest,...actual}))
    checks++
   }
   if(width===390&&dark)await page.locator('#bb-chart-burn-rate').screenshot({path:`/private/tmp/burn-rate-crest-${crest}-${engineName}.png`})
  }
  for(const scenario of ['surge','over','zero','first-day','future']){
   await open(scenario)
   const panel=page.locator('#bb-chart-burn-rate')
   assert.equal((await page.locator('.bb-chart-carousel-band').boundingBox()).height,stage)
   if(scenario==='surge'){await nativePoint(page,1,touch);const actual=await inspect(page);assert.equal(actual.fill.percent,100);assert.ok(actual.text.includes(money(reportFor('surge').burnRate.series[0].actualSpend)))}
   else if(scenario==='over'){await nativePoint(page,26,touch);assert.ok((await panel.locator('.bb-burn-month-values').innerText()).includes(money(reportFor('over').burnRate.remaining)));assert.equal(await panel.locator('.bb-burn-month-panel [data-over="true"]').count(),1);assert.equal(await panel.locator('.bb-category-pressure').count(),1);assert.ok((await inspect(page)).plot>170,'Category coverage information and the balance stay within the existing stage')}
   else if(scenario==='zero'){await nativePoint(page,13,touch);assert.equal(await panel.locator('.bb-burn-day-bar [data-empty="true"]').count(),1);assert.equal(await panel.locator('.bb-burn-month-panel [data-empty="true"]').count(),1)}
   else if(scenario==='first-day'){await nativePoint(page,1,touch);assert.ok((await panel.locator('.bb-burn-node-tooltip').innerText()).includes(money(reportFor('first-day').burnRate.series[0].actualSpend)))}
   else {assert.ok((await panel.innerText()).includes('Month not started'));assert.equal(await panel.locator('.bb-burn-node-tooltip').count(),0)}
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks++
  }
  if(process.env.BOOKIEBOT_BURN_QUICK){await open();await nativePoint(page,13,touch);await page.setViewportSize({width:320,height:900});await page.waitForTimeout(350);const resized=await inspect(page);assert.ok(resized.card.x>=0&&resized.card.right<=320.1);assert.equal(resized.positioned,resized.day);await open();const chart=page.locator('#bb-chart-burn-rate .recharts-wrapper');await chart.locator('svg[tabindex="0"]').focus();await page.keyboard.press('ArrowRight');await page.waitForTimeout(100);assert.equal(await page.locator('.bb-burn-node-tooltip').count(),1,'Native chart keyboard activation remains available');checks+=2}
  if(width===390&&dark){
   for(const height of [500,360]){
    // Resize the loaded page instead of navigating while its geometry worker
    // request is starting (WebKit reports that aborted fixture load as CORS).
    await open();await page.setViewportSize({width,height})
    await page.locator('#bb-chart-burn-rate').scrollIntoViewIfNeeded();await page.waitForTimeout(350)
    for(const day of [5,13,26]){
     await nativePoint(page,day,touch);const actual=await inspect(page)
     assert.ok(actual.card.top>=0&&actual.card.bottom<=height+.1&&actual.card.left>=0&&actual.card.right<=width+.1,JSON.stringify(actual))
     assert.equal(actual.hidesDot,false,JSON.stringify(actual));assert.equal(actual.overflow,false);checks++
    }
   }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log(engineName,width,dark?'dark':'light','PASS');await page.close()
 }
 }finally{await browser.close()}
 }
 console.log(JSON.stringify({checks,frames,result:'PASS: native mouse/touch, exact day/month amounts, split labels, left overfill, interior/exterior pockets, clear curve/metrics/axes, synchronous anchors, progressive normal/reduced-motion exit, hold/dismiss/scroll anchoring/tab/mode lifecycle, zero/future and responsive layouts'}))
})().catch(error=>{console.error(error);process.exit(1)})
