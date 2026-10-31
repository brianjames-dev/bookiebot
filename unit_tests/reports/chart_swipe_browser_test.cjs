// Production assets + synthetic reports only. Chromium also exercises real touch input.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
const engines=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const report=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`
import json
from unit_tests.reports.test_income_projection import build,income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture income','5000'))))))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
for(const view of Object.values(report.modeViews)){
 view.breakdown=[['rent','Rent',1200],['grocery','Grocery',300],['gas','Gas',100],['food','Food',280],['shopping','Shopping',180],['subscriptions_wants','Wants subscriptions',70]].map(([key,label,amount])=>({key,label,amount,color:'green',percentage:0}))
 view.categoryBudgets={needs:2500,wants:1500,savings:1000}
 view.categoryBalances={raw:{needs:900,wants:970,savings:0},remaining:{needs:900,wants:970,savings:0},deficits:{needs:0,wants:0,savings:0},transfers:[],totalOverspend:0}
}
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(assets,'expense-report-app.js'),'utf8')
const csp=fs.readFileSync(path.join(root,'src/bookiebot/reports/phone_app.py'),'utf8').match(/"Content-Security-Policy": "([^"]+)"/)[1]
const html=dark=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-report-data" type="application/json">${JSON.stringify(report)}</script><script type="module" src="/app.js"></script></body></html>`
const touch=async(page,selector,type,x,y=200)=>page.locator(selector).first().evaluate((node,{type,x,y})=>{
 const event=new Event(type,{bubbles:true,cancelable:true}),point={identifier:7,clientX:x,clientY:y}
 Object.defineProperties(event,{touches:{value:/end|cancel/.test(type)?[]:[point]},changedTouches:{value:[point]}})
 node.dispatchEvent(event);return event.defaultPrevented
},{type,x,y})
const trackX=page=>page.locator('.bb-chart-carousel-track').evaluate(el=>new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)
const settle=page=>page.locator('.bb-chart-carousel[data-settling="false"]').waitFor()
const title=page=>page.locator('.bb-chart-carousel-title').innerText()
const select=async(page,name)=>{await page.getByRole('button',{name:`Show ${name}`,exact:true}).click();await page.waitForFunction(name=>document.querySelector('.bb-chart-carousel-title')?.innerText.trim()===name,name);await settle(page)}
;(async()=>{
 let cases=0,native=0
 for(const engineName of (process.env.BOOKIEBOT_SWIPE_ENGINE?[process.env.BOOKIEBOT_SWIPE_ENGINE]:['chromium','webkit'])){
 const browser=await engines[engineName].launch({headless:true})
 try{
 for(const width of (process.env.BOOKIEBOT_SWIPE_QUICK?[390]:[320,390,736]))for(const dark of (process.env.BOOKIEBOT_SWIPE_QUICK?[true]:[false,true])){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,isMobile:width<700,colorScheme:dark?'dark':'light',reducedMotion:dark?'reduce':'no-preference'}),errors=[],traffic=[]
  page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/*',async route=>{const url=new URL(route.request().url()),name=url.pathname.split('/').pop();if(name==='report')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':csp},body:html(dark)});if(name==='app.js')return route.fulfill({contentType:'application/javascript',body:js});if(/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,name),'utf8')});traffic.push(url.pathname);await route.abort()})
  await page.goto('https://bookie.test/report');await select(page,'Category Mix')
  const stage=(await page.locator('.bb-chart-carousel-band').boundingBox()).height
  for(const target of ['.bb-category-pie-center','#bb-chart-category .recharts-sector','.bb-contour-label rect','.bb-category-pie-host']){
   await select(page,'Category Mix')
   if(target.includes('contour')){if(await page.getByRole('button',{name:'Show category callouts',exact:true}).count())await page.getByRole('button',{name:'Show category callouts',exact:true}).tap();await page.locator('.bb-contour-callouts[data-ready="true"][data-visible="true"]').waitFor()}
   const shown=await page.locator('.bb-category-pie-center').getAttribute('aria-pressed')
   assert.equal(await touch(page,target,'touchstart',300),false)
   for(const delta of [90,180,270]){assert.equal(await touch(page,target,'touchmove',300-delta),false);await page.waitForTimeout(25);assert.ok(Math.abs(await trackX(page)+delta)<1,JSON.stringify({message:'Drag follows the finger beyond the former 220px limit',target,delta,x:await trackX(page),viewport:await page.locator('.bb-chart-carousel').boundingBox(),dragging:await page.locator('.bb-chart-carousel').getAttribute('data-dragging'),motion:await page.locator('.bb-chart-carousel-track').evaluate(el=>({reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,style:el.style.transform,animations:el.getAnimations().map(a=>({time:a.currentTime,duration:a.effect.getTiming().duration}))})),title:await title(page)}))}
   await touch(page,target,'touchend',30);assert.equal(await title(page),'Burn Rate',`Swiping from ${target} navigates`)
   await page.locator(target).first().dispatchEvent('click',{bubbles:true,cancelable:true,detail:1})
   assert.equal(await page.getByRole('dialog').count(),0,'A swipe cannot also inspect a category')
   assert.equal(await page.locator('.bb-category-pie-center').getAttribute('aria-pressed'),shown,'A swipe cannot toggle callouts')
   await settle(page);assert.equal((await page.locator('.bb-chart-carousel-band').boundingBox()).height,stage);cases++
  }
  await select(page,'Category Mix')
  const host='.bb-category-pie-host'
  await touch(page,host,'touchstart',100);await touch(page,host,'touchmove',200);await page.waitForTimeout(25);const edge1=await trackX(page)
  await touch(page,host,'touchmove',300);await page.waitForTimeout(25);assert.ok(await trackX(page)>edge1,'The edge resists progressively without hitting a stop');await touch(page,host,'touchend',300);await settle(page);assert.equal(await trackX(page),0)
  await touch(page,host,'touchstart',250);await touch(page,host,'touchmove',230,330);await touch(page,host,'touchmove',30,350);await touch(page,host,'touchend',30,350);await settle(page);assert.equal(await title(page),'Category Mix','Vertical intent cannot turn into a graph swipe')
  await touch(page,host,'touchstart',250);await touch(page,host,'touchmove',90);await page.waitForTimeout(25);await touch(page,host,'touchcancel',90);await settle(page);assert.equal(await title(page),'Category Mix');assert.equal(await trackX(page),0)
  await touch(page,host,'touchstart',250);await touch(page,host,'touchmove',90);await page.waitForTimeout(25)
  const multi=await page.locator(host).evaluate(el=>{const event=new Event('touchstart',{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:[{identifier:7,clientX:90,clientY:200},{identifier:8,clientX:140,clientY:200}]});el.dispatchEvent(event);return event.defaultPrevented})
  assert.equal(multi,false);await settle(page);assert.equal(await trackX(page),0,'A second finger cannot leave the track stranded between pages')
  const filter='.bb-category-mix-filter select'
  await touch(page,filter,'touchstart',250);await touch(page,filter,'touchmove',20);await touch(page,filter,'touchend',20);assert.equal(await title(page),'Category Mix','The native chooser keeps its own interaction')
  // Interrupt an in-flight page animation and drag from its visible position.
  await page.emulateMedia({reducedMotion:'no-preference'})
  await touch(page,host,'touchstart',280);await touch(page,host,'touchmove',100);await page.waitForTimeout(25);await touch(page,host,'touchend',100)
  await page.waitForTimeout(50)
  const frozen=await page.locator('.bb-chart-carousel').evaluate(el=>{const track=el.querySelector('.bb-chart-carousel-track'),stamp=performance.now(),before=new DOMMatrixReadOnly(getComputedStyle(track).transform).m41,e=new Event('touchstart',{bubbles:true,cancelable:true});Object.defineProperties(e,{touches:{value:[{identifier:7,clientX:100,clientY:200}]}});el.dispatchEvent(e);return{before,after:new DOMMatrixReadOnly(getComputedStyle(track).transform).m41,style:track.style.transform,animations:track.getAnimations().length,elapsed:performance.now()-stamp}})
  assert.ok(Math.abs(frozen.before-frozen.after)<1+frozen.elapsed*Math.max(3,(width+16)*.01),JSON.stringify({message:'Regrab only advances by the elapsed animation time',frozen}));await page.waitForTimeout(25);const paused=await trackX(page);assert.ok(Math.abs(paused-Number(frozen.style.match(/translate3d\(([-\d.]+)/)[1]))<1,'The next painted frame stays at the captured position')
  await touch(page,'.bb-chart-carousel','touchmove',125);await page.waitForTimeout(25);assert.ok(Math.abs(await trackX(page)-paused-25)<1,'Regrab follows the finger without restarting at the old page')
  await touch(page,'.bb-chart-carousel','touchcancel',125);await settle(page);assert.equal(await title(page),'Burn Rate')
  await select(page,'Category Mix')
  await touch(page,host,'touchstart',280);await touch(page,host,'touchmove',60);await page.waitForTimeout(20);await touch(page,host,'touchend',60);await page.waitForTimeout(40)
  await touch(page,'.bb-chart-carousel','touchstart',40);await page.waitForTimeout(20);await touch(page,'.bb-chart-carousel','touchmove',280);await page.waitForTimeout(20);await touch(page,'.bb-chart-carousel','touchend',280);await settle(page);assert.equal(await title(page),'Category Mix','A deliberate fast reversal returns to the previous page')
  await select(page,'Burn Rate')
  await page.setViewportSize({width:width===320?390:320,height:900});await page.waitForTimeout(150);assert.ok(Math.abs(await trackX(page)+(width===320?390:320)+16)<1,'Resize retains the selected page')
  await page.setViewportSize({width,height:900});await page.waitForTimeout(150)
  await select(page,'Category Mix')
  const center=page.locator('.bb-category-pie-center'),was=await center.getAttribute('aria-pressed');await center.tap();assert.notEqual(await center.getAttribute('aria-pressed'),was,'The next deliberate tap works immediately')
  await page.getByRole('button',{name:'Show Burn Rate',exact:true}).focus();await page.keyboard.press('Enter');await page.keyboard.press('ArrowRight');await settle(page);assert.equal(await title(page),'Calendar','Keyboard graph selection remains intact')
  if(engineName==='chromium'&&width===390){
   await select(page,'Category Mix');await page.locator(host).scrollIntoViewIfNeeded();const cdp=await page.context().newCDPSession(page),box=await center.boundingBox(),startX=box.x+box.width/2,startY=Math.min(700,box.y+box.height/2)
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:startX,y:startY}]});for(let i=1;i<=6;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:startX+(20-startX)*i/6,y:startY}]});await page.waitForTimeout(20)}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle(page);assert.equal(await title(page),'Burn Rate','Real touch swipes from the center button navigate');assert.equal(await page.getByRole('dialog').count(),0)
   await select(page,'Category Mix');await page.locator(host).scrollIntoViewIfNeeded();const b=await page.locator(host).boundingBox(),y=Math.min(650,b.y+b.height/2),beforeY=await page.evaluate(()=>scrollY)
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width/2,y}]});for(let i=1;i<=6;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:width/2,y:y-150*i/6}]});await page.waitForTimeout(20)}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(250);assert.ok(await page.evaluate(()=>scrollY)>beforeY+50,'Real vertical scrolling remains native');assert.equal(await title(page),'Category Mix');await cdp.detach();native+=2
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.deepEqual(traffic,[]);cases+=10
  console.log(engineName,width,dark?'dark/reduced':'light','PASS');await page.close()
 }
 }finally{await browser.close()}
 }
 console.log(JSON.stringify({cases,native,result:'PASS: full-width swipe from background/center/slice/callout, rubber band, interruption/reverse/cancel, vertical intent, click isolation, controls, resize, reduced motion and keyboard'}))
})().catch(error=>{console.error(error);process.exit(1)})
