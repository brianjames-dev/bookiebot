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
const reference=process.env.BOOKIEBOT_SWIPE_REFERENCE_SCRIPT?{js:fs.readFileSync(process.env.BOOKIEBOT_SWIPE_REFERENCE_SCRIPT,'utf8'),css:fs.readFileSync(process.env.BOOKIEBOT_SWIPE_REFERENCE_CSS,'utf8')}:null
const withoutBurn=structuredClone(report);withoutBurn.burnRate=null;for(const view of Object.values(withoutBurn.modeViews))view.burnRate=null
const html=(dark,before=false,noBurn=false)=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${before?reference.css:css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-report-data" type="application/json">${JSON.stringify(noBurn?withoutBurn:report)}</script><script type="module" src="/${before?"before":"app"}.js"></script></body></html>`
const touch=async(page,selector,type,x,y=200)=>page.locator(selector).first().evaluate((node,{type,x,y})=>{
 const event=new Event(type,{bubbles:true,cancelable:true}),point={identifier:7,clientX:x,clientY:y}
 Object.defineProperties(event,{touches:{value:/end|cancel/.test(type)?[]:[point]},changedTouches:{value:[point]}})
 node.dispatchEvent(event);return event.defaultPrevented
},{type,x,y})
const settle=async page=>{
 await page.waitForFunction(()=>document.querySelector('.bb-chart-carousel')?.dataset.settling==='false')
 await page.waitForTimeout(30)
}
const title=page=>page.locator('.bb-chart-carousel-slide[aria-hidden="false"] .bb-chart-carousel-title').innerText()
const select=async(page,name)=>{await page.getByRole('button',{name:`Show ${name}`,exact:true}).click();await page.waitForFunction(name=>document.querySelector('.bb-chart-carousel-slide[aria-hidden="false"] .bb-chart-carousel-title')?.innerText.trim()===name,name);await settle(page)}
const panels=['Category Mix','Burn Rate','Calendar','Bills & Utilities']
const headingLayout=page=>page.evaluate(()=>{
 const slide=document.querySelector('.bb-chart-carousel-slide[aria-hidden="false"]'),title=slide.querySelector('.bb-chart-carousel-title'),value=title.querySelector('.bb-fitted-amount-text')
 const box=n=>{const r=n.getBoundingClientRect();return [r.x,r.y+scrollY,r.width,r.height]}
 return {title:box(title),value:box(value),font:getComputedStyle(value).fontSize,dots:box(document.querySelector('.bb-chart-carousel-indicators')),content:box(slide.querySelector('.bb-card-content')),plot:box(slide.querySelector('.bb-chart-page-body')),next:box(document.querySelector('.bb-daily-section'))}
})
const snapped=async(page,index)=>{
 try{await page.waitForFunction(index=>{const el=document.querySelector('.bb-chart-carousel');return el.dataset.settling==='false'&&el.clientWidth===document.documentElement.clientWidth&&Math.abs(el.scrollLeft-index*(el.clientWidth+16))<1&&document.querySelectorAll('.bb-chart-carousel-slide')[index].getAttribute('aria-hidden')==='false'},index,{timeout:8000})}catch(error){console.error('Native snap failure',index,await page.locator('.bb-chart-carousel').evaluate(el=>({left:el.scrollLeft,width:el.clientWidth,state:{...el.dataset},hasScrollEnd:'onscrollend' in el,innerWidth,rootWidth:document.documentElement.clientWidth,scrollbar:document.documentElement.style.getPropertyValue('--bb-viewport-scrollbar-width'),slides:[...el.querySelectorAll('.bb-chart-carousel-slide')].map(s=>({name:s.ariaLabel,hidden:s.getAttribute('aria-hidden'),x:s.getBoundingClientRect().x})),snap:getComputedStyle(el).scrollSnapType})));throw error}
}
async function nativeDrag(page,cdp,target,dx,{hold=false,startX}={}){
 const el=page.locator(target).first();await el.scrollIntoViewIfNeeded();const box=await el.boundingBox(),width=page.viewportSize().width
 const x=startX??Math.max(32,Math.min(width-32,box.x+box.width/2)),y=Math.max(50,Math.min(760,box.y+box.height/2))
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]})
 for(let i=1;i<=12;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/12,y}]});await page.waitForTimeout(12)}
 if(hold)return{x:x+dx,y}
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
}
async function checkTitleMask(page,width,dark){
 const viewport=page.locator('.bb-chart-carousel')
 const geometry=await viewport.evaluate((el,{dark,width})=>{
  const box=el.getBoundingClientRect(),dots=document.querySelector('.bb-chart-carousel-indicators').getBoundingClientRect(),heading=el.querySelector('.bb-chart-carousel-heading'),gutter=parseFloat(getComputedStyle(heading).paddingRight),edge=width<=362?box.width-gutter:dots.left-box.left+8
  const background=getComputedStyle(el.closest('.bb-chart-carousel-band')).backgroundColor.match(/[\d.]+/g).slice(0,3).map(Number)
  const probe=document.createElement('div');probe.dataset.headingMaskProbe='';probe.style.cssText=`position:absolute;inset:0;z-index:20;pointer-events:none;background:${dark?'white':'black'}`
  const previous={position:el.style.position,visibility:document.querySelector('.bb-chart-carousel-nav').style.visibility};el.style.position='relative';document.querySelector('.bb-chart-carousel-nav').style.visibility='hidden';el.append(probe)
  return {edge,background,ink:dark?255:0,headingHeight:heading.getBoundingClientRect().height,previous}
 },{dark,width})
 let pixels
 try{
  const png=await viewport.screenshot()
  pixels=await page.evaluate(async({png,bodyY})=>{
   const bitmap=new Image();bitmap.src=`data:image/png;base64,${png}`;await bitmap.decode()
   const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');context.drawImage(bitmap,0,0)
   const row=y=>{const rgba=context.getImageData(0,y,bitmap.width,1).data;return Array.from({length:bitmap.width},(_,x)=>Array.from(rgba.slice(x*4,x*4+3)))}
   return {header:row(24),body:row(bodyY)}
  },{png:png.toString('base64'),bodyY:Math.round(geometry.headingHeight)+20})
 }finally{await viewport.evaluate((el,previous)=>{el.querySelector('[data-heading-mask-probe]').remove();el.style.position=previous.position;document.querySelector('.bb-chart-carousel-nav').style.visibility=previous.visibility},geometry.previous)}
 const background=geometry.background.reduce((sum,n)=>sum+n,0)/3,alpha=(row,x)=>{const pixel=row[Math.max(0,Math.min(row.length-1,Math.round(x)))],mean=pixel.reduce((sum,n)=>sum+n,0)/3;return(mean-background)/(geometry.ink-background)}
 const fade=[geometry.edge-18,geometry.edge-12,geometry.edge-8,geometry.edge-4,geometry.edge+2].map(x=>alpha(pixels.header,x))
 assert.ok(fade[0]>.98&&fade[1]>.55&&fade[1]<.9&&fade[2]>.3&&fade[2]<.7&&fade[3]>.08&&fade[3]<.4&&Math.abs(fade[4])<.025,JSON.stringify({message:'Heading opacity fades smoothly to zero before the markers',geometry,fade}))
 assert.ok(pixels.header.slice(Math.ceil(geometry.edge)+1).every((_,x)=>Math.abs(alpha(pixels.header,Math.ceil(geometry.edge)+1+x))<.025),'The entire right gutter hides incoming titles')
 assert.ok(pixels.body.every((_,x)=>alpha(pixels.body,x)>.98),'The graph below the heading remains completely unmasked')
}
const sameLayout=(actual,expected)=>{for(const key of Object.keys(expected))if(Array.isArray(expected[key]))actual[key].forEach((n,i)=>assert.ok(Math.abs(n-expected[key][i])<1,JSON.stringify({key,actual,expected})));else assert.equal(actual[key],expected[key])}
;(async()=>{
 let cases=0,native=0
 for(const engineName of (process.env.BOOKIEBOT_SWIPE_ENGINE?[process.env.BOOKIEBOT_SWIPE_ENGINE]:['chromium','webkit'])){
 const browser=await engines[engineName].launch({headless:true})
 try{
 for(const width of (process.env.BOOKIEBOT_SWIPE_WIDTHS?process.env.BOOKIEBOT_SWIPE_WIDTHS.split(',').map(Number):process.env.BOOKIEBOT_SWIPE_QUICK?[390]:[320,390,736,1280]))for(const dark of (process.env.BOOKIEBOT_SWIPE_QUICK?[true]:[false,true])){
  const page=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:1,isMobile:engineName==='chromium'&&width<700,hasTouch:true,colorScheme:dark?'dark':'light',reducedMotion:dark?'reduce':'no-preference'}),errors=[],traffic=[]
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(String(error)))
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname==='/report')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':csp},body:html(dark,url.searchParams.has('reference'),url.searchParams.has('noBurn'))});if(url.pathname==='/app.js'||url.pathname==='/before.js')return route.fulfill({contentType:'application/javascript',body:url.pathname==='/before.js'?reference.js:js});const name=path.basename(url.pathname);if(/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,name),'utf8')});traffic.push(url.pathname);await route.abort()})
  const previous={}
  if(reference){await page.goto('https://bookie.test/report?reference=1');for(const name of panels){await select(page,name);previous[name]=await headingLayout(page)}}
  await page.goto('https://bookie.test/report')
  await page.waitForFunction(dark=>document.documentElement.dataset.theme===(dark?'dark':'light'),dark)
  for(const name of panels){
   await select(page,name);const layout=await headingLayout(page)
   assert.equal(await page.getByRole('heading',{name,exact:true}).count(),1)
   assert.equal(await page.locator('.bb-chart-carousel-nav h2').count(),0)
   assert.equal(await page.locator('.bb-chart-carousel-nav [role="status"]').innerText(),name)
   if(reference)sameLayout(layout,previous[name]);cases++
  }
  await select(page,'Category Mix');const viewport=page.locator('.bb-chart-carousel'),stage=(await page.locator('.bb-chart-carousel-band').boundingBox()).height
  const ownership=await viewport.evaluate(el=>({overflow:getComputedStyle(el).overflowX,snap:getComputedStyle(el).scrollSnapType,touch:getComputedStyle(el).touchAction,transform:getComputedStyle(el.firstElementChild).transform,animations:el.firstElementChild.getAnimations().length,scrollWidth:el.scrollWidth,width:el.clientWidth}))
  assert.equal(ownership.overflow,'auto');assert.equal(ownership.snap,'x mandatory');assert.equal(ownership.touch,'auto');assert.equal(ownership.transform,'none');assert.equal(ownership.animations,0);assert.equal(ownership.scrollWidth,4*ownership.width+48);cases++
  await checkTitleMask(page,width,dark);cases++
  // Untrusted events cannot invoke native panning. Verify passive arbitration
  // separately, then move the actual scroll offset to inspect intermediate layout.
  for(const target of ['#bb-chart-category .bb-chart-carousel-heading','.bb-category-pie-center','#bb-chart-category .recharts-sector','.bb-contour-label rect','.bb-category-pie-host']){
   await select(page,'Category Mix')
   if(target.includes('contour')){if(await page.getByRole('button',{name:'Show category callouts',exact:true}).count())await page.getByRole('button',{name:'Show category callouts',exact:true}).tap();await page.locator('.bb-contour-callouts[data-ready="true"][data-visible="true"]').waitFor();await page.waitForTimeout(700)}
   const shown=await page.locator('.bb-category-pie-center').getAttribute('aria-pressed'),origin=await headingLayout(page)
   assert.equal(await touch(page,target,'touchstart',300),false);assert.equal(await touch(page,target,'touchmove',30),false)
   assert.equal(await viewport.evaluate(el=>el.scrollLeft),0,'JS touch handlers never move the track')
   await viewport.evaluate(el=>{el.style.scrollSnapType='none';el.scrollTo({left:270,behavior:'instant'})})
   const dragged=await headingLayout(page)
   assert.ok(Math.abs(dragged.title[0]-origin.title[0]+270)<1);assert.ok(Math.abs(dragged.content[0]-origin.content[0]+270)<1)
   assert.deepEqual(dragged.dots,origin.dots);assert.equal(dragged.font,origin.font)
   await touch(page,target,'touchend',30)
   await page.locator(target).first().dispatchEvent('click',{bubbles:true,cancelable:true,detail:1})
   assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.locator('.bb-category-pie-center').getAttribute('aria-pressed'),shown)
   await viewport.evaluate(el=>{el.style.scrollSnapType='';el.scrollTo({left:el.clientWidth+16,behavior:'smooth'})});await snapped(page,1)
   assert.equal(await title(page),'Burn Rate');assert.equal((await page.locator('.bb-chart-carousel-band').boundingBox()).height,stage);cases++
  }
  await select(page,'Category Mix')
  const host='.bb-category-pie-host'
  await touch(page,host,'touchstart',250);await touch(page,host,'touchmove',230,330);await touch(page,host,'touchmove',30,350);await touch(page,host,'touchend',30,350);await settle(page);assert.equal(await title(page),'Category Mix');cases++
  await touch(page,host,'touchstart',250);await touch(page,host,'touchmove',90);await touch(page,host,'touchcancel',90);await settle(page);assert.equal(await title(page),'Category Mix');cases++
  const filter='.bb-category-mix-filter select';await touch(page,filter,'touchstart',250);await touch(page,filter,'touchmove',20);await touch(page,filter,'touchend',20);assert.equal(await title(page),'Category Mix');cases++
  const center=page.locator('.bb-category-pie-center'),was=await center.getAttribute('aria-pressed');await center.tap();assert.notEqual(await center.getAttribute('aria-pressed'),was);cases++
  await page.getByRole('button',{name:'Show Burn Rate',exact:true}).focus();await page.keyboard.press('Enter');await page.keyboard.press('ArrowRight');await settle(page);assert.equal(await title(page),'Calendar');cases++
  // Focus must not introduce the old second offset on the Calendar slide.
  const calendarLeft=await viewport.evaluate(el=>el.scrollLeft),marker=page.locator('#bb-chart-calendar .bb-subscription-marker').first()
  assert.ok(await marker.count());await marker.focus();await page.waitForTimeout(200);assert.ok(Math.abs(await viewport.evaluate(el=>el.scrollLeft)-calendarLeft)<1);assert.equal(await viewport.evaluate(el=>el.scrollTop),0);cases++
  await select(page,'Burn Rate');await page.setViewportSize({width:width===320?390:320,height:900});await page.waitForTimeout(200);await snapped(page,1)
  await page.setViewportSize({width,height:900});await page.waitForTimeout(200);await snapped(page,1);cases++
  if(width===390){await page.setViewportSize({width:736,height:390});await page.waitForTimeout(200);await snapped(page,1);await page.setViewportSize({width,height:900});await page.waitForTimeout(200);await snapped(page,1);cases++}
  // Real horizontal trackpad input invokes each engine's native scrolling/snap.
  await select(page,'Category Mix');await viewport.scrollIntoViewIfNeeded();const box=await viewport.boundingBox();await page.mouse.move(width/2,Math.max(100,Math.min(700,box.y+200)))
  await page.mouse.wheel(width*.8,0);await snapped(page,1);assert.equal(await title(page),'Burn Rate');native++
  await page.mouse.wheel(-width*.8,0);await snapped(page,0);native++
  // Smooth navigation can be retargeted, with no stale scrollend selecting an old page.
  await page.emulateMedia({reducedMotion:'no-preference'});await select(page,'Category Mix')
  for(const name of ['Bills & Utilities','Burn Rate','Calendar']){await page.getByRole('button',{name:`Show ${name}`,exact:true}).click();await page.waitForTimeout(25)}
  await snapped(page,2);cases++
  if(engineName==='chromium'&&width===390){
   const cdp=await page.context().newCDPSession(page)
   await select(page,'Category Mix');await nativeDrag(page,cdp,host,-310,{startX:width-40});await snapped(page,1);native++
   for(const target of ['#bb-chart-category .bb-chart-carousel-title','.bb-category-pie-center','#bb-chart-category .recharts-sector','.bb-contour-label rect','.bb-category-pie-host']){
    await select(page,'Category Mix')
    if(target.includes('contour')){if(await page.getByRole('button',{name:'Show category callouts',exact:true}).count())await page.getByRole('button',{name:'Show category callouts',exact:true}).tap();await page.waitForTimeout(800)}
    const shown=await center.getAttribute('aria-pressed')
    const point=await nativeDrag(page,cdp,target,-Math.min(150,width*.4),{hold:true})
    await page.waitForTimeout(80)
    const held=await viewport.evaluate(el=>el.scrollLeft);assert.ok(held>40&&held<width,'Native touch pans while the finger is still held')
    assert.equal(await page.locator('.bb-chart-carousel-track').evaluate(el=>el.getAnimations().length),0)
    // Reverse while still holding, then complete the swipe. Browser keeps one owner.
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x+25,y:point.y}]})
    await page.waitForFunction(held=>document.querySelector('.bb-chart-carousel').scrollLeft<held-1,held,{timeout:2000})
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x-55,y:point.y}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle(page)
    const nativeIndex=await viewport.evaluate(el=>Math.round(el.scrollLeft/(el.clientWidth+16)));assert.ok(nativeIndex===0||nativeIndex===1);await snapped(page,nativeIndex)
    assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await center.getAttribute('aria-pressed'),shown);native++
   }
   await select(page,'Category Mix');await page.locator(host).scrollIntoViewIfNeeded();const b=await page.locator(host).boundingBox(),y=Math.min(650,b.y+b.height/2),beforeY=await page.evaluate(()=>scrollY)
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width/2,y}]});for(let i=1;i<=6;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:width/2,y:y-150*i/6}]});await page.waitForTimeout(20)}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(250);assert.ok(await page.evaluate(()=>scrollY)>beforeY+50);await snapped(page,0);native++
   // Native fling, re-grab and reverse without any scripted position capture.
   await nativeDrag(page,cdp,host,-180);await nativeDrag(page,cdp,'.bb-chart-carousel',180);await settle(page);assert.ok(await viewport.evaluate(el=>Math.abs(el.scrollLeft/(el.clientWidth+16)-Math.round(el.scrollLeft/(el.clientWidth+16)))<.01));native++
   await cdp.detach()
  }
  await page.emulateMedia({reducedMotion:dark?'reduce':'no-preference'})
  if(width===390){await select(page,'Burn Rate');await page.locator('.bb-chart-carousel-band').screenshot({path:`/private/tmp/native-chart-scroll-${engineName}-${dark?'dark':'light'}.png`})}
  await page.goto('https://bookie.test/report?noBurn=1');await select(page,'Category Mix');assert.equal(await page.locator('.bb-chart-carousel-dot').count(),3)
  await select(page,'Bills & Utilities');const short=await headingLayout(page);assert.ok(short.value[0]+short.value[2]<=short.title[0]+short.title[2]+1)
  if(width>362)assert.ok(short.title[0]+short.title[2]+8<=short.dots[0]+1)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.deepEqual(traffic,[]);cases++
  console.log(engineName,width,dark?'dark/reduced':'light','PASS');await page.close()
 }
 }finally{await browser.close()}
 }
 console.log(JSON.stringify({cases,native,result:'PASS: native overflow/snap ownership, unchanged settled geometry, moving/fading titles and fixed markers, passive chart/tap arbitration, Calendar focus, native wheel/touch/reverse/vertical, navigation retargeting, resize, reduced motion and three-panel reports'}))
})().catch(error=>{console.error(error);process.exit(1)})
