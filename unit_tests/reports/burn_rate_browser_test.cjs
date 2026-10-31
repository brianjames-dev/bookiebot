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
 const turns=[-.4,-.7,-1,.72,.94,1,.83,.86,.73,.71,.42,.24,.18,.05,-.18,-.3,-.56,-.48,.2,.06,.28,.31,.33,.55,.52,.16,.03,-.21,-.36,-.52]
 const report=structuredClone(fixture),daily=[40,45,70,250,200,20,250,0,0,0,65,20,400,0,0,0,0,50,40,230,0,0,50,60,100,139.32]
 if(scenario==='surge')daily[0]+=350
 if(scenario==='over')daily[25]+=1200
 const budget=scenario==='zero'?0:2994.92,elapsedDays=scenario==='multi-turn'?30:scenario==='future'?0:scenario==='first-day'?1:26
 let actual=0
 const series=Array.from({length:31},(_,i)=>{const day=i+1,expectedSpend=round(budget*day/31),variance=scenario==='multi-turn'?40+260*turns[i]:scenario.startsWith('crest-')?-50+400*Math.exp(-Math.pow((day-Number(scenario.split('-')[1]))/4,2)):scenario==='plateau'?200:scenario==='gentle-ramp'?200+day*2:scenario==='arch'?200+30*Math.sin(day/5):scenario==='dip'?(day<=2?-80*day:260+100*Math.sin(day/5)):null,dailySpend=day<=elapsedDays?(variance!==null?round(expectedSpend+variance-actual):scenario==='zero'?0:daily[i]):null;actual=round(actual+(dailySpend??0));return {day,label:String(day),dailySpend,actualSpend:day<=elapsedDays?actual:null,expectedSpend,variance:day<=elapsedDays?round(actual-expectedSpend):null}})
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
 const position=await chart.evaluate((chart,day)=>{const line=chart.querySelector('.recharts-line-curve'),first=line.getPointAtLength(0),last=line.getPointAtLength(line.getTotalLength()),x=first.x+(last.x-first.x)*(day-1)/Math.max(1,Number(document.querySelector('.bb-burn-rate-note').textContent.match(/^\d+/)?.[0])-1);let lo=0,hi=line.getTotalLength();for(let n=0;n<30;n++){const mid=(lo+hi)/2;if(line.getPointAtLength(mid).x<x)lo=mid;else hi=mid}const p=line.getPointAtLength((lo+hi)/2);return{x:p.x,y:p.y}},day)
 if(touch)await chart.tap({position});else await chart.hover({position})
 await page.waitForFunction(day=>document.querySelector('.bb-burn-node-tooltip')?.dataset.inspectedDay===String(day),day)
 await page.waitForTimeout(70)
}
async function checkTurningNodes(page,touch,width,engineName,checks){
 let last
 for(const day of [3,11,6,17]){
  await nativePoint(page,day,touch);const actual=await inspect(page)
  assert.equal(actual.opacity,'1',JSON.stringify(actual));assert.deepEqual(actual.fixedHits,[],JSON.stringify(actual));assert.equal(actual.hidesDot,false,JSON.stringify(actual));assert.equal(actual.curveHits,0,JSON.stringify(actual))
  // A 320px plot can be narrower than the card plus either clear curve side.
  // Enforce tight attachment where it fits; retain curve clearance when cramped.
  assert.ok(actual.anchorDistance<=(width<390?actual.card.height:Math.max(32,actual.card.height/3)),JSON.stringify({day,...actual}))
  if(day===3||day===17)assert.ok(actual.card.top>=actual.anchor.y-actual.card.height*.55&&actual.card.bottom>actual.anchor.y+actual.card.height*.4,JSON.stringify({day,...actual}))
  if(day===17)assert.ok(actual.card.top>=actual.anchor.y+8,JSON.stringify({day,...actual}))
  if(day===6&&width<700)assert.ok(Math.hypot(actual.card.left-actual.anchor.x,actual.card.bottom-actual.anchor.y)<=32,JSON.stringify({day,...actual}))
  // The shorter 320px plot can put both clear pockets near the same corner.
  // Check the peak's own attachment there, rather than an arbitrary large move.
  if(last&&day===6&&width>=390)assert.ok(Math.hypot(actual.card.x-last.card.x,actual.card.y-last.card.y)>20,JSON.stringify({message:'The peak must not inherit the shoulder anchor',width,engineName,last,actual}))
  if(width===390)await page.locator('#bb-chart-burn-rate').screenshot({path:`/private/tmp/burn-rate-turn-${shell?'shell':'report'}-${engineName}-${day}.png`})
  last=actual;checks++
 }
 return checks
}
async function checkCompactPresentation(page,width,engineName,checks){
 const panel=page.locator('#bb-chart-burn-rate'),info=panel.getByRole('button',{name:'Explain Available today',exact:true}),dialog=page.getByRole('dialog',{name:'Available today',exact:true})
 const before=await panel.evaluate(el=>{const a=el.querySelector('.bb-chart-kicker').getBoundingClientRect(),b=el.querySelector('.bb-burn-rate-value').getBoundingClientRect(),c=el.querySelector('.bb-burn-rate-pace>span').getBoundingClientRect(),d=el.querySelector('.bb-burn-rate-pace>strong').getBoundingClientRect(),footer=el.querySelector('.bb-burn-month-panel').getBoundingClientRect(),stage=el.closest('.bb-chart-carousel-band').getBoundingClientRect(),glyph=el.querySelector('.bb-burn-rate-info>span'),bar=el.querySelector('.bb-burn-used');return{labelsFirst:a.bottom<=b.top&&c.bottom<=d.top,footerTop:footer.top,gap:stage.bottom-footer.bottom,line:el.querySelector('.recharts-line-curve').getAttribute('d'),icon:[glyph.textContent,getComputedStyle(glyph).fontSize,getComputedStyle(glyph).opacity],labelColor:getComputedStyle(el.querySelector('.bb-burn-spent-label')).color,barColor:bar&&getComputedStyle(bar).backgroundColor,stage:stage.height}})
 assert.ok(before.labelsFirst,JSON.stringify(before));assert.deepEqual(before.icon,['ⓘ','12px','0.7']);assert.equal(before.labelColor,before.barColor);assert.ok(before.gap>=103,JSON.stringify(before));assert.equal(await panel.locator('.bb-chart-page-footer button,.bb-burn-limit-row,.bb-burn-legend').count(),0);checks++
 if(width===390)await panel.screenshot({path:`/private/tmp/burn-rate-fraction-app-${engineName}-${shell?'shell':'report'}.png`})
 await info.click();await dialog.waitFor();await page.waitForTimeout(180)
 const data=reportFor().burnRate,text=await dialog.innerText();for(const part of ['Room to spend while staying on pace.',`Allowance through Oct ${data.elapsedDays}`,money(data.expectedSpend),money(data.spent),money(Math.abs(data.totalDifference)),'Food · Shopping · Wants subscriptions','Allowance reflects category coverage.'])assert.ok(text.includes(part),part)
 const placed=await dialog.evaluate(el=>{const box=el.getBoundingClientRect();return{width:box.width,left:box.left,right:box.right,top:box.top,bottom:box.bottom,height:innerHeight,rows:[...el.querySelectorAll('dl>div')].every(row=>row.querySelector('dt').getBoundingClientRect().right+8<=row.querySelector('dd').getBoundingClientRect().left),fixedHits:[...document.querySelectorAll('.bb-bottom-navigation:not([hidden]) .bb-navigation-pane,.bb-shell-header-actions button')].some(n=>{const r=n.getBoundingClientRect();return box.left<r.right&&box.right>r.left&&box.top<r.bottom&&box.bottom>r.top})}})
 assert.ok(placed.left>=0&&placed.right<=width+.1&&placed.top>=0&&placed.bottom<=placed.height+.1,JSON.stringify(placed));assert.ok(placed.rows,JSON.stringify(placed));assert.equal(placed.fixedHits,false,JSON.stringify(placed));assert.equal(await panel.locator('.recharts-line-curve').getAttribute('d'),before.line);assert.equal((await panel.locator('.bb-burn-month-panel').boundingBox()).y,before.footerTop);checks++
 if(width===390)await page.screenshot({path:`/private/tmp/burn-rate-fraction-app-info-${engineName}-${shell?'shell':'report'}.png`})
 await dialog.getByRole('button',{name:'Close spending pace explanation',exact:true}).click();await dialog.waitFor({state:'hidden'});await info.focus();await page.keyboard.press('Enter');await dialog.waitFor();await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Explain Available today');checks++
 await info.click();await dialog.waitFor();await page.locator('.bb-chart-carousel-slide[aria-hidden="false"] .bb-chart-carousel-title').click();await dialog.waitFor({state:'hidden'});checks++
 await info.click();await dialog.waitFor();await page.getByRole('button',{name:'Show Calendar',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:'Show Burn Rate',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.bb-chart-carousel').dataset.settling!=='true');checks++
 await info.click();await dialog.waitFor();await page.getByRole('button',{name:'Projected',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:'Current',exact:true}).click();checks++
 await info.click();await dialog.waitFor();await page.evaluate(()=>scrollBy(0,40));await dialog.waitFor({state:'hidden'});checks++
 assert.equal((await page.locator('.bb-chart-carousel-band').boundingBox()).height,before.stage);return checks
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
 const curve=el.querySelector('.recharts-line-curve'),centerX=card.left+card.width/2;let lo=0,hi=curve.getTotalLength();for(let i=0;i<25;i++){const at=(lo+hi)/2,p=curve.getPointAtLength(at).matrixTransform(curve.getScreenCTM());if(p.x<centerX)lo=at;else hi=at}const curveY=curve.getPointAtLength((lo+hi)/2).matrixTransform(curve.getScreenCTM()).y,side=card.top+card.height/2<curveY?'above':'below'
 const anchor=dot?{x:dot.x+dot.width/2,y:dot.y+dot.height/2}:null,anchorDistance=anchor?Math.hypot(anchor.x-Math.max(card.left,Math.min(card.right,anchor.x)),anchor.y-Math.max(card.top,Math.min(card.bottom,anchor.y))):null
 return {side,cardSize:{width:t.offsetWidth,height:t.offsetHeight},panelBounds:el.querySelector('.bb-burn-rate-page').getBoundingClientRect().toJSON(),fixedHits,opacity:getComputedStyle(portal).opacity,anchor,anchorDistance,curveHits,metricHits,day:t.dataset.inspectedDay,text:t.innerText,header:t.querySelector('.bb-burn-mini-header').innerText,labels:t.querySelector('.bb-burn-pair-labels').innerText,values:t.querySelector('.bb-burn-pair-values').innerText,over:rail.dataset.over,fill:fill?{percent:parseFloat(fill.style.width),x:fill.getBoundingClientRect().x,color:getComputedStyle(fill).backgroundColor}:null,rail:rail.getBoundingClientRect().toJSON(),background:getComputedStyle(rail).backgroundColor,card:card.toJSON(),labelBottom:t.querySelector('.bb-burn-pair-labels').getBoundingClientRect().bottom,valueTop:t.querySelector('.bb-burn-pair-values').getBoundingClientRect().top,transform:getComputedStyle(wrapper).transform,transition:getComputedStyle(portal).transitionDuration,local:portal.style.transform,positioned:portal.dataset.positionedDay,plotRect,outsidePlot:card.bottom<=plotRect.top||card.top>=plotRect.bottom||card.right<=plotRect.left||card.left>=plotRect.right,hidesDot:dot?card.x<dot.right+6&&card.right>dot.x-6&&card.y<dot.bottom+6&&card.bottom>dot.y-6:false,shade:getComputedStyle(el.querySelector('.recharts-area-area')).fillOpacity,stage:document.querySelector('.bb-chart-carousel-band').getBoundingClientRect().height,plot:el.querySelector('.recharts-wrapper').getBoundingClientRect().height,details:!!el.querySelector('.bb-details-toggle'),overflow:document.documentElement.scrollWidth>innerWidth}
 })}
;(async()=>{
 let checks=0,frames=0
 for(const engineName of (process.env.BOOKIEBOT_BURN_ENGINE?[process.env.BOOKIEBOT_BURN_ENGINE]:['chromium','webkit'])){
 const browser=await engines[engineName].launch({headless:true})
 try{
 for(const width of (process.env.BOOKIEBOT_BURN_WIDTHS?process.env.BOOKIEBOT_BURN_WIDTHS.split(',').map(Number):process.env.BOOKIEBOT_BURN_QUICK?[390]:[320,390,1280]))for(const dark of (process.env.BOOKIEBOT_BURN_QUICK&&!shell?[true]:[false,true])){
  const touch=width<700,page=await browser.newPage({viewport:{width,height:900},hasTouch:touch,colorScheme:dark?'dark':'light',reducedMotion:dark?'reduce':'no-preference'}),errors=[],unexpected=[]
  page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/*',async route=>{const url=new URL(route.request().url()),name=url.pathname.split('/').pop();if(url.pathname==='/report')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':csp},body:html(reportFor(url.searchParams.get('scenario')||'regular'),dark,url.searchParams.has('before'))});if(name==='app.js')return route.fulfill({contentType:'application/javascript',body:js});if(name==='before.js'&&process.env.BOOKIEBOT_BURN_REFERENCE_SCRIPT)return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(process.env.BOOKIEBOT_BURN_REFERENCE_SCRIPT,'utf8')});if(/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,name),'utf8')});if(shell){
   if(route.request().method()!=='GET'){unexpected.push(route.request().method()+' '+url.pathname);return route.abort()}
   if(url.pathname==='/fixture-report')return route.fulfill({json:reportFor(new URL(page.url()).searchParams.get('scenario')||'regular')})
   const responses={'/app/reconciliation':{enabled:true,items:[],checkedAt:'2026-10-30T00:00:00Z'},'/app/reimbursements':{enabled:true,ownerKey:'brian',currency:'USD',allocations:[],events:[],resets:[],resetState:'fixture'},'/app/goals':{goals:[]},'/app/notifications':{enabled:false,publicKey:'B'+'A'.repeat(86),preferences:{}},'/app/widgets/settings':{connections:[]},'/app/version':{version:'fixture-version'},'/app/expenses/months':{currentMonth:'2026-10',months:[{value:'2026-10',label:'October 2026'}],coverage:{status:'complete',unavailableYears:[]}}}
   if(responses[url.pathname])return route.fulfill({json:responses[url.pathname]})
   if(url.pathname.includes('avatar'))return route.fulfill({contentType:'image/png',body:fs.readFileSync(path.join(root,'assets/avatars/avatar7.png'))})
  }unexpected.push(url.pathname);await route.abort()})
  const open=async(scenario='regular',before=false)=>{await page.goto(`https://bookie.test/report?scenario=${scenario}${before?'&before=1':''}`);await page.getByRole('button',{name:'Show Burn Rate',exact:true}).click();await page.locator('#bb-chart-burn-rate').scrollIntoViewIfNeeded();await page.waitForFunction(()=>{const el=document.querySelector('.bb-chart-carousel');return el.dataset.settling==='false'&&Math.abs(el.scrollLeft-el.clientWidth-16)<1});await page.waitForTimeout(100)}
  if(process.env.BOOKIEBOT_BURN_EXPIRY_ONLY){
   await open('plateau');await nativePoint(page,13,touch)
   await page.locator('.bb-burn-node-tooltip').waitFor({state:'detached',timeout:6500})
   const chart=page.locator('#bb-chart-burn-rate .bb-chart-container'),revision=await chart.getAttribute('data-bb-chart-interaction-revision')
   await page.evaluate(()=>{
    window.__expiredReappearances=0
    const portal=document.querySelector('.bb-burn-tooltip-portal')
    window.__expiryObserver=new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)if(n.nodeType===1&&(n.matches('.bb-burn-node-tooltip')||n.querySelector('.bb-burn-node-tooltip')))window.__expiredReappearances++})
    window.__expiryObserver.observe(portal,{subtree:true,childList:true})
   })
   for(const delta of [45,-45,85,-85]){await page.evaluate(delta=>scrollBy(0,delta),delta);await page.waitForTimeout(55)}
   assert.equal(await page.locator('.bb-burn-node-tooltip').count(),0,'Scrolling after the deadline cannot resurrect cached content');checks++
   if(touch){
    const box=await chart.boundingBox(),x=box.x+box.width*.55,y=Math.max(210,Math.min(650,box.y+box.height*.5))
    if(engineName==='chromium'){
     const cdp=await page.context().newCDPSession(page)
     await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]})
     await page.waitForTimeout(70)
     assert.equal(await page.locator('.bb-burn-node-tooltip').count(),0,'Touching down to scroll is not selection intent')
     for(const delta of [25,60,100]){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-delta}]});await page.waitForTimeout(35)}
     await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach()
    }else{
     await chart.evaluate((el,{x,y})=>{
      for(const [type,dy] of [['pointerdown',0],['pointermove',-35],['pointercancel',-80]])el.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:'touch',pointerId:7,isPrimary:true,clientX:x,clientY:y+dy,button:0}))
     },{x,y})
     await page.mouse.wheel(0,100)
    }
   }else await page.mouse.wheel(0,100)
   await page.waitForTimeout(350)
   assert.equal(await chart.getAttribute('data-bb-chart-interaction-revision'),revision,'Vertical scroll never publishes a fresh inspection')
   assert.equal(await page.locator('.bb-burn-node-tooltip').count(),0);checks++
   await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await page.locator('#bb-chart-burn-rate').scrollIntoViewIfNeeded();await page.waitForTimeout(200)
   assert.equal(await page.locator('.bb-burn-node-tooltip').count(),0)
   assert.equal(await page.evaluate(()=>{window.__expiryObserver.disconnect();return window.__expiredReappearances}),0,'No transient repaint is permitted after expiry');checks++
   await nativePoint(page,touch?13:20,touch)
   assert.equal(await page.locator('.bb-burn-node-tooltip').count(),1,'A deliberate tap on the same node or genuine desktop hover starts a new inspection');checks++
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log(engineName,width,'expiry/scroll/renew',dark?'dark':'light','PASS');await page.close();continue
  }
  if(shell){
   await open();checks=await checkCompactPresentation(page,width,engineName,checks)
   // Require a real scroll-driven flip, not merely 'zero or one'. Both sides
   // of a flat native trend are available as the card approaches a screen edge.
   await open('plateau')
   // Give the short fixture enough document above the plot to actually move
   // its locked upper pocket behind the bottom nav without hitting scrollY=0.
   await page.evaluate(()=>{const spacer=document.createElement('div');spacer.style.height='420px';document.querySelector('.bb-chart-carousel-band').before(spacer)})
   await page.locator('#bb-chart-burn-rate .recharts-wrapper').evaluate(el=>scrollTo(0,scrollY+el.getBoundingClientRect().top-340))
   await page.waitForTimeout(400);await nativePoint(page,13,touch)
   const initial=await inspect(page),direction=initial.side==='above'?1:-1
   let flipped
   for(let i=0;i<18;i++) {
    await page.evaluate(delta=>scrollBy(0,delta),direction*24);await page.waitForTimeout(30)
    const now=await inspect(page)
    if(now.local!==initial.local){flipped=now;break}
   }
   assert.ok(flipped,JSON.stringify({message:'Scrolling must actually use the allowed opposite-side move',engineName,dark,initial,current:await inspect(page)}))
   assert.notEqual(flipped.side,initial.side);assert.equal(flipped.hidesDot,false);assert.equal(flipped.curveHits,0);assert.deepEqual(flipped.fixedHits,[])
   assert.ok(flipped.anchorDistance<=Math.max(32,flipped.card.height/2)+1,JSON.stringify(flipped));checks++
   // A spent anchor may pass underneath the nav without any early fade.
   const nav=await page.locator('.bb-navigation-pane').boundingBox()
   await page.evaluate(delta=>scrollBy(0,delta),flipped.card.bottom-nav.y-32)
   await page.waitForTimeout(450)
   const underNav=await inspect(page)
   assert.ok(underNav.fixedHits.some(name=>name.includes('bb-navigation-pane')),JSON.stringify({underNav,flipped,nav,navAfter:await page.locator('.bb-navigation-pane').boundingBox(),scroll:await page.evaluate(()=>scrollY)}))
   assert.equal(await page.locator('.bb-burn-tooltip-portal').getAttribute('data-scroll-hidden'),'false')
   assert.equal(await page.locator('.bb-burn-tooltip-portal .bb-chart-tooltip-frame').evaluate(n=>Number(getComputedStyle(n).opacity)),1,'Passing under nav remains opaque')
   assert.equal(underNav.local,flipped.local);checks++
   // 24px still stays painted; only the final 8px begins the viewport exit.
   await page.evaluate(delta=>scrollBy(0,delta),underNav.card.top-24);await page.waitForTimeout(60)
   assert.equal(await page.locator('.bb-burn-tooltip-portal').getAttribute('data-scroll-hidden'),'false')
   const near=await inspect(page)
   await page.evaluate(delta=>scrollBy(0,delta),near.card.top-7)
   await page.waitForFunction(()=>document.querySelector('.bb-burn-tooltip-portal').dataset.scrollHidden==='true')
   const exit=await page.locator('.bb-burn-tooltip-portal').evaluate(async portal=>{
    const frames=[],start=performance.now()
    while(performance.now()-start<420){await new Promise(requestAnimationFrame);frames.push({opacity:Number(getComputedStyle(portal.querySelector('.bb-chart-tooltip-frame')).opacity),local:portal.style.transform,frameTransform:getComputedStyle(portal.querySelector('.bb-chart-tooltip-frame')).transform})}
    return frames
   })
   assert.ok(exit.some(f=>f.opacity>0&&f.opacity<1),JSON.stringify(exit));assert.equal(exit.at(-1).opacity,0)
   if(dark)assert.ok(exit.every(f=>f.frameTransform==='none'),'Reduced motion scroll exit fades without scaling')
   assert.ok(exit.every(f=>f.local===flipped.local),'Exit animation must never move the chart-local anchor');checks++
   await page.evaluate(()=>scrollBy(0,-200));await page.waitForTimeout(400)
   assert.equal(await page.locator('.bb-burn-tooltip-portal').getAttribute('data-scroll-hidden'),'false')
   assert.equal((await inspect(page)).local,flipped.local,'Scrolling back can reveal the retained card without another relocation');checks++
   if(process.env.BOOKIEBOT_BURN_SCROLL_ONLY){
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log(engineName,width,'scroll flip/fade',dark?'dark':'light','PASS');await page.close();continue
   }
   for(const crest of [6,14,22]){
    await open(`crest-${crest}`)
    for(const chartTop of [260,560])for(const compact of [false,true]){
     const base=await page.locator('#bb-chart-burn-rate .recharts-wrapper').evaluate(el=>scrollY+el.getBoundingClientRect().top)
     const y=base-chartTop
     await page.evaluate(({y,compact})=>scrollTo(0,y+(compact?-60:60)),{y,compact});await page.waitForTimeout(80)
     await page.evaluate(y=>scrollTo(0,y),y);await page.waitForTimeout(400)
     assert.equal(await page.locator('.bb-bottom-navigation').getAttribute('data-compact'),String(compact))
     const point=await page.locator('#bb-chart-burn-rate .recharts-wrapper').evaluate((el,day)=>{const line=el.querySelector('.recharts-line-curve'),matrix=line.getScreenCTM(),x=line.getPointAtLength(0).x+(line.getPointAtLength(line.getTotalLength()).x-line.getPointAtLength(0).x)*(day-1)/Math.max(1,Number(document.querySelector('.bb-burn-rate-note').textContent.match(/^\d+/)?.[0])-1);let lo=0,hi=line.getTotalLength();for(let n=0;n<30;n++){const mid=(lo+hi)/2;if(line.getPointAtLength(mid).x<x)lo=mid;else hi=mid}const p=line.getPointAtLength((lo+hi)/2).matrixTransform(matrix);return{x:p.x,y:p.y}},crest)
     await page.touchscreen.tap(point.x,point.y)
     await page.waitForFunction(day=>document.querySelector('.bb-burn-node-tooltip')?.dataset.inspectedDay===String(day),crest)
     await page.waitForTimeout(100)
     const actual=await inspect(page);assert.equal(actual.opacity,'1',JSON.stringify(actual));assert.deepEqual(actual.fixedHits,[],JSON.stringify(actual));assert.equal(actual.hidesDot,false,JSON.stringify(actual));assert.equal(actual.curveHits,0,JSON.stringify(actual))
     assert.ok(actual.anchorDistance<=actual.card.height,JSON.stringify(actual));checks++
     // A scroll may flip once across the curve, but must not keep seeking the
     // viewport/nav edge. Opacity may hide a locked card beneath fixed controls.
     await page.locator('.bb-burn-tooltip-portal').evaluate(portal=>{
      window.__burnRedundantStyles=0
      const observer=new MutationObserver(records=>{for(const record of records)if(record.oldValue===portal.getAttribute('style'))window.__burnRedundantStyles++})
      observer.observe(portal,{attributes:true,attributeFilter:['style'],attributeOldValue:true});window.__burnStyleObserver=observer
     })
     let previous=actual.local,previousSide=actual.side,moves=0
     for(const delta of [65,65,65,-65,-65,-65,65,-65]){
      await page.evaluate(delta=>scrollBy(0,delta),delta);await page.waitForTimeout(45)
      const moved=await inspect(page)
      if(moved.local!==previous){moves++;assert.notEqual(moved.side,previousSide,'Scroll relocation must cross the actual trend line');assert.equal(moved.opacity,'1');assert.deepEqual(moved.fixedHits,[],JSON.stringify(moved));assert.equal(moved.hidesDot,false);assert.equal(moved.curveHits,0);assert.ok(moved.anchorDistance<=Math.max(32,moved.card.height/2)+1,JSON.stringify(moved))}
      previous=moved.local;previousSide=moved.side
     }
     assert.ok(moves<=1,JSON.stringify({crest,chartTop,compact,moves}));assert.equal(await page.evaluate(()=>{window.__burnStyleObserver.disconnect();return window.__burnRedundantStyles}),0,'Scrolling cannot redundantly rewrite the same serialized anchor');checks++
    }
   }
   await open('multi-turn')
   for(const top of [170,290]){
    await page.locator('#bb-chart-burn-rate .recharts-wrapper').evaluate((el,top)=>scrollTo(0,scrollY+el.getBoundingClientRect().top-top),top)
    await page.waitForTimeout(450)
    checks=await checkTurningNodes(page,touch,width,engineName,checks)
   }
   await page.screenshot({path:`/private/tmp/burn-rate-nav-${engineName}-${dark?'dark':'light'}.png`})
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log(engineName,'shell',dark?'dark':'light','PASS');await page.close();continue
  }
  let reference
  if(process.env.BOOKIEBOT_BURN_REFERENCE_SCRIPT){await open('regular',true);reference=await graph(page)}
  await open()
  checks=await checkCompactPresentation(page,width,engineName,checks)
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
   const scrolled=await inspect(page);assert.equal(scrolled.positioned,scrolled.day,'Scrolling keeps the same inspection; it may leave the viewport naturally')
   await page.getByRole('button',{name:'Show Calendar',exact:true}).click();await page.waitForTimeout(450);assert.equal(await page.locator('.bb-burn-node-tooltip').count(),0)
   await page.getByRole('button',{name:'Show Burn Rate',exact:true}).click();await nativePoint(page,13,touch)
   await page.getByRole('button',{name:'Projected',exact:true}).click();await page.waitForTimeout(450);assert.equal(await page.locator('.bb-burn-node-tooltip').count(),0);checks+=7
  }
  // Unrelated curve shapes must keep the line clear in nearby interior/exterior
  // pockets, with labels treated as readability preferences rather than walls.
  for(const scenario of ['plateau','gentle-ramp','arch','dip']){
   await open(scenario)
   for(const day of (scenario==='dip'?[2,13,26]:[13])){
    await nativePoint(page,day,touch);const actual=await inspect(page)
    assert.equal(actual.hidesDot,false,JSON.stringify(actual));assert.equal(actual.curveHits,0,JSON.stringify(actual))
    assert.ok(actual.anchorDistance<=actual.card.height,JSON.stringify({scenario,width,engineName,day,...actual}))
    assert.equal(actual.overflow,false);checks++
   }
   if(width===390&&dark&&scenario==='dip')await page.locator('#bb-chart-burn-rate').screenshot({path:`/private/tmp/burn-rate-pocket-${engineName}.png`})
  }
  for(const crest of [6,14,22]){
   await open(`crest-${crest}`)
   for(const day of [1,crest,26]){
    await nativePoint(page,day,touch);const actual=await inspect(page)
    assert.equal(actual.hidesDot,false,JSON.stringify(actual));assert.equal(actual.curveHits,0,JSON.stringify(actual))
    if(day===crest&&actual.anchorDistance>actual.card.height*.9){
     // A short header plus a card nearly as wide as the plot may leave no
     // room above or beside the peak. Then clear space below the curve wins.
     const {anchor,card,cardSize,panelBounds:p}=actual,belowOnly=anchor.y-cardSize.height-12<p.top+8&&anchor.x-cardSize.width-12<p.left+8&&anchor.x+cardSize.width+12>p.right-8
     assert.ok(belowOnly,JSON.stringify({crest,...actual}));assert.ok(card.top>=anchor.y+12,JSON.stringify(actual));assert.ok(actual.anchorDistance<=actual.plotRect.bottom-anchor.y+16,JSON.stringify(actual))
    }
    checks++
   }
   if(width===390&&dark)await page.locator('#bb-chart-burn-rate').screenshot({path:`/private/tmp/burn-rate-crest-${crest}-${engineName}.png`})
  }
  await open('multi-turn');checks=await checkTurningNodes(page,touch,width,engineName,checks)
  for(const scenario of ['surge','over','zero','first-day','future']){
   await open(scenario)
   const panel=page.locator('#bb-chart-burn-rate')
   assert.equal((await page.locator('.bb-chart-carousel-band').boundingBox()).height,stage)
   if(scenario==='surge'){await nativePoint(page,1,touch);const actual=await inspect(page);assert.equal(actual.fill.percent,100);assert.ok(actual.text.includes(money(reportFor('surge').burnRate.series[0].actualSpend)))}
   else if(scenario==='over'){await nativePoint(page,26,touch);assert.ok((await panel.locator('.bb-burn-month-values').innerText()).includes(money(reportFor('over').burnRate.remaining)));assert.equal(await panel.locator('.bb-burn-month-panel [data-over="true"]').count(),1);assert.equal(await panel.locator('.bb-category-pressure').count(),1);assert.ok((await inspect(page)).plot>170,'Category coverage information and the balance stay within the existing stage')}
   else if(scenario==='zero'){await nativePoint(page,13,touch);assert.equal(await panel.locator('.bb-burn-day-bar [data-empty="true"]').count(),1);assert.equal(await panel.locator('.bb-burn-month-panel [data-empty="true"]').count(),1)}
   else if(scenario==='first-day'){await nativePoint(page,1,touch);assert.ok((await panel.locator('.bb-burn-node-tooltip').innerText()).includes(money(reportFor('first-day').burnRate.series[0].actualSpend)))}
   else {assert.match(await panel.innerText(),/not started/i);assert.equal(await panel.locator('.bb-burn-node-tooltip').count(),0)}
   if(scenario==='over'||scenario==='future'){
    const label=scenario==='future'?'Not started':'Over pace',dialog=page.getByRole('dialog',{name:label,exact:true}),data=reportFor(scenario).burnRate
    await panel.getByRole('button',{name:`Explain ${label}`,exact:true}).click();await dialog.waitFor()
    const text=await dialog.innerText();for(const amount of [data.expectedSpend,data.spent])assert.ok(text.includes(money(amount)),text)
    if(scenario==='future'){assert.ok(text.includes('No elapsed days'));assert.ok(!text.includes('Oct 0'))}else assert.ok(text.includes(money(Math.abs(data.totalDifference))))
    await dialog.getByRole('button',{name:'Close spending pace explanation',exact:true}).click();await dialog.waitFor({state:'hidden'});checks++
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks++
  }
  if(process.env.BOOKIEBOT_BURN_QUICK){await open();await nativePoint(page,13,touch);await page.setViewportSize({width:320,height:900});await page.waitForFunction(()=>{const el=document.querySelector('.bb-chart-carousel');return el.clientWidth===320&&el.dataset.settling==='false'&&Math.abs(el.scrollLeft-336)<1});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const resized=await inspect(page);assert.ok(resized.card.x>=0&&resized.card.right<=320.1,JSON.stringify({engineName,resized}));assert.equal(resized.positioned,resized.day);await open();const chart=page.locator('#bb-chart-burn-rate .recharts-wrapper');await chart.locator('svg[tabindex="0"]').focus();const beforeKey=await page.locator('.bb-chart-carousel').evaluate(el=>({left:el.scrollLeft,state:{...el.dataset},active:document.activeElement?.outerHTML.slice(0,160)}));await page.keyboard.press('ArrowRight');await page.waitForTimeout(150);assert.equal(await page.locator('.bb-burn-node-tooltip').count(),1,JSON.stringify({message:'Native chart keyboard activation remains available',engineName,beforeKey,afterKey:await page.locator('.bb-chart-carousel').evaluate(el=>({left:el.scrollLeft,state:{...el.dataset},active:document.activeElement?.outerHTML.slice(0,160)}))}));checks+=2}
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
 console.log(JSON.stringify({checks,frames,result:'PASS: native mouse/touch, exact day/month amounts, split labels, left overfill, interior/exterior pockets, clear curve/fixed controls, bounded readability, fresh node anchors, progressive normal/reduced-motion exit, hold/dismiss/scroll anchoring/tab/mode lifecycle, zero/future and responsive layouts'}))
})().catch(error=>{console.error(error);process.exit(1)})
