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
const trackX=page=>page.locator('.bb-chart-carousel-track').evaluate(el=>new DOMMatrixReadOnly(getComputedStyle(el).transform).m41)
const settle=page=>page.locator('.bb-chart-carousel[data-settling="false"]').waitFor()
const title=page=>page.locator('.bb-chart-carousel-slide[aria-hidden="false"] .bb-chart-carousel-title').innerText()
const select=async(page,name)=>{await page.getByRole('button',{name:`Show ${name}`,exact:true}).click();await page.waitForFunction(name=>(document.querySelector('.bb-chart-carousel-slide[aria-hidden="false"] .bb-chart-carousel-title')??document.querySelector('.bb-chart-carousel-nav .bb-chart-carousel-title'))?.innerText.trim()===name,name);await settle(page)}
const panels=['Category Mix','Burn Rate','Calendar','Bills & Utilities']
const headingLayout=page=>page.evaluate(()=>{
 const slide=document.querySelector('.bb-chart-carousel-slide[aria-hidden="false"]'),title=slide.querySelector('.bb-chart-carousel-title')??document.querySelector('.bb-chart-carousel-nav .bb-chart-carousel-title'),value=title.querySelector('.bb-fitted-amount-text')
 const box=n=>{const r=n.getBoundingClientRect();return [r.x,r.y+scrollY,r.width,r.height]}
 return {title:box(title),value:box(value),font:getComputedStyle(value).fontSize,dots:box(document.querySelector('.bb-chart-carousel-indicators')),content:box(slide.querySelector('.bb-card-content')),plot:box(slide.querySelector('.bb-chart-page-body')),next:box(document.querySelector('.bb-daily-section'))}
})
const finishDragSample=page=>page.locator('.bb-chart-carousel-track').evaluate(async track=>{
 await new Promise(requestAnimationFrame)
 await Promise.all(track.getAnimations().map(animation=>animation.finished.catch(()=>{})))
})
async function checkHeldDragInterpolation(page,dark){
 await page.emulateMedia({reducedMotion:'no-preference'})
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 const probe=await page.locator('.bb-chart-carousel').evaluate(async viewport=>{
  const track=viewport.querySelector('.bb-chart-carousel-track'),read=()=>new DOMMatrixReadOnly(getComputedStyle(track).transform).m41
  const frame=()=>new Promise(requestAnimationFrame),send=(type,x)=>{const event=new Event(type,{bubbles:true,cancelable:true}),point={identifier:19,clientX:x,clientY:200};Object.defineProperties(event,{touches:{value:/end|cancel/.test(type)?[]:[point]},changedTouches:{value:[point]}});viewport.dispatchEvent(event)}
  const origin=read();send('touchstart',300);send('touchmove',240);await frame()
  const first=track.getAnimations()[0];if(!first)throw new Error('Held drag must use an accelerated transform animation between input samples')
  const timing=first.effect.getTiming(),firstFrames=first.effect.getKeyframes();first.pause();first.currentTime=timing.duration/2
  const middle=read();send('touchmove',200);await frame()
  const second=track.getAnimations()[0];if(!second)throw new Error('The next touch sample must retarget the compositor bridge')
  const nextFrames=second.effect.getKeyframes(),from=new DOMMatrixReadOnly(nextFrames[0].transform).m41,to=new DOMMatrixReadOnly(nextFrames.at(-1).transform).m41
  second.pause();second.currentTime=second.effect.getTiming().duration/2;const nextMiddle=read()
  send('touchcancel',200)
  return {origin,duration:timing.duration,fill:timing.fill,firstFrom:new DOMMatrixReadOnly(firstFrames[0].transform).m41,firstTo:new DOMMatrixReadOnly(firstFrames.at(-1).transform).m41,middle,from,to,nextMiddle,canceled:first.playState==='idle'&&second.playState==='idle'}
 })
 assert.ok(probe.duration>0&&probe.duration<=16);assert.equal(probe.fill,'both')
 assert.ok(Math.abs(probe.firstFrom-probe.origin)<.1&&Math.abs(probe.firstTo-probe.origin+60)<.1)
 assert.ok(Math.abs(probe.middle-probe.origin+30)<.2,'The browser presents an intermediate position while the finger stays down')
 assert.ok(Math.abs(probe.from-probe.middle)<.2&&Math.abs(probe.to-probe.origin+100)<.2,'Retarget from the actual visible position toward the exact latest touch sample')
 assert.ok(Math.abs(probe.nextMiddle-(probe.from+probe.to)/2)<.2);assert.ok(probe.canceled,'Cancellation releases both pending compositor bridges')
 await settle(page);await page.emulateMedia({reducedMotion:dark?'reduce':'no-preference'})
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
 for(const width of (process.env.BOOKIEBOT_SWIPE_QUICK?[390]:[320,390,736,1280]))for(const dark of (process.env.BOOKIEBOT_SWIPE_QUICK?[true]:[false,true])){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,isMobile:width<700,colorScheme:dark?'dark':'light',reducedMotion:dark?'reduce':'no-preference'}),errors=[],traffic=[]
  page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message))
  await page.route('**/*',async route=>{const url=new URL(route.request().url()),name=url.pathname.split('/').pop();if(name==='report')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':csp},body:html(dark,url.searchParams.has('reference'),url.searchParams.has('noBurn'))});if(name==='before.js'&&reference)return route.fulfill({contentType:'application/javascript',body:reference.js});if(name==='app.js')return route.fulfill({contentType:'application/javascript',body:js});if(/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,name),'utf8')});traffic.push(url.pathname);await route.abort()})
  const previous={}
  if(reference){await page.goto('https://bookie.test/report?reference=1');for(const name of panels){await select(page,name);previous[name]=await headingLayout(page)}}
  await page.goto('https://bookie.test/report')
  for(const name of panels){
   await select(page,name);const layout=await headingLayout(page)
   assert.equal(await page.getByRole('heading',{name,exact:true}).count(),1,'Only the selected page exposes its heading')
   assert.equal(await page.locator('.bb-chart-carousel-nav h2').count(),0,'Indicators stay outside the title track')
   assert.equal(await page.locator('.bb-chart-carousel-nav [role="status"]').innerText(),name)
   if(reference)sameLayout(layout,previous[name]);cases++
  }
  if(width===390)await page.locator('.bb-chart-carousel-band').screenshot({path:`/private/tmp/chart-title-${engineName}-${dark?'dark':'light'}.png`})
  await select(page,'Category Mix')
  await checkTitleMask(page,width,dark);cases++
  await checkHeldDragInterpolation(page,dark);cases++
  const stage=(await page.locator('.bb-chart-carousel-band').boundingBox()).height
  for(const target of ['#bb-chart-category .bb-chart-carousel-heading','.bb-category-pie-center','#bb-chart-category .recharts-sector','.bb-contour-label rect','.bb-category-pie-host']){
   await select(page,'Category Mix')
   if(target.includes('contour')){if(await page.getByRole('button',{name:'Show category callouts',exact:true}).count())await page.getByRole('button',{name:'Show category callouts',exact:true}).tap();await page.locator('.bb-contour-callouts[data-ready="true"][data-visible="true"]').waitFor()}
   const shown=await page.locator('.bb-category-pie-center').getAttribute('aria-pressed'),origin=await headingLayout(page)
   if(target.includes('heading'))await page.evaluate(()=>{
    const slide=document.querySelector('#bb-chart-category'),heading=slide.querySelector('h2'),content=slide.querySelector('.bb-card-content'),dots=document.querySelector('.bb-chart-carousel-indicators')
    window.__headingMotion={running:true,frames:[]};const sample=()=>{const state=window.__headingMotion;if(!state.running)return;state.frames.push({offset:heading.getBoundingClientRect().x-content.getBoundingClientRect().x,dots:dots.getBoundingClientRect().x});requestAnimationFrame(sample)};sample()
   })
   assert.equal(await touch(page,target,'touchstart',300),false)
   for(const delta of [90,180,270]){assert.equal(await touch(page,target,'touchmove',300-delta),false);await finishDragSample(page);assert.ok(Math.abs(await trackX(page)+delta)<1,JSON.stringify({message:'Drag follows the finger beyond the former 220px limit',target,delta,x:await trackX(page),viewport:await page.locator('.bb-chart-carousel').boundingBox(),dragging:await page.locator('.bb-chart-carousel').getAttribute('data-dragging'),motion:await page.locator('.bb-chart-carousel-track').evaluate(el=>({reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,style:el.style.transform,animations:el.getAnimations().map(a=>({time:a.currentTime,duration:a.effect.getTiming().duration}))})),title:await title(page)}))}
   const dragged=await headingLayout(page)
   assert.ok(Math.abs(dragged.title[0]-origin.title[0]+270)<1,'The title travels the exact same distance as the graph')
   assert.ok(Math.abs(dragged.content[0]-origin.content[0]+270)<1)
   assert.deepEqual(dragged.dots,origin.dots,'The fixed indicators never follow the track')
   assert.equal(dragged.font,origin.font,'Dragging cannot refit or restyle the title')
   if(target.includes('heading')&&width===390)await page.locator('.bb-chart-carousel-band').screenshot({path:`/private/tmp/chart-title-drag-${engineName}-${dark?'dark':'light'}.png`})
   await touch(page,target,'touchend',30);assert.equal(await title(page),'Burn Rate',`Swiping from ${target} navigates`)
   await page.locator(target).first().dispatchEvent('click',{bubbles:true,cancelable:true,detail:1})
   assert.equal(await page.getByRole('dialog').count(),0,'A swipe cannot also inspect a category')
   assert.equal(await page.locator('.bb-category-pie-center').getAttribute('aria-pressed'),shown,'A swipe cannot toggle callouts')
   await settle(page)
   if(target.includes('heading')){
    const samples=await page.evaluate(()=>{window.__headingMotion.running=false;return window.__headingMotion.frames})
    assert.ok(samples.length>=3);for(const frame of samples){assert.ok(Math.abs(frame.offset-samples[0].offset)<1,'Title and content stay coupled throughout drag and spring settlement');assert.ok(Math.abs(frame.dots-samples[0].dots)<1,'Indicators remain fixed on every sampled frame')}
   }
   assert.equal((await page.locator('.bb-chart-carousel-band').boundingBox()).height,stage);cases++
  }
  await select(page,'Category Mix')
  const host='.bb-category-pie-host'
  await touch(page,host,'touchstart',100);await touch(page,host,'touchmove',200);await finishDragSample(page);const edge1=await trackX(page)
  await touch(page,host,'touchmove',300);await finishDragSample(page);assert.ok(await trackX(page)>edge1,'The edge resists progressively without hitting a stop');await touch(page,host,'touchend',300);await settle(page);assert.equal(await trackX(page),0)
  await touch(page,host,'touchstart',250);await touch(page,host,'touchmove',230,330);await touch(page,host,'touchmove',30,350);await touch(page,host,'touchend',30,350);await settle(page);assert.equal(await title(page),'Category Mix','Vertical intent cannot turn into a graph swipe')
  await touch(page,host,'touchstart',250);await touch(page,host,'touchmove',90);await finishDragSample(page);await touch(page,host,'touchcancel',90);await settle(page);assert.equal(await title(page),'Category Mix');assert.equal(await trackX(page),0)
  await touch(page,host,'touchstart',250);await touch(page,host,'touchmove',90);await finishDragSample(page)
  const multi=await page.locator(host).evaluate(el=>{const event=new Event('touchstart',{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:[{identifier:7,clientX:90,clientY:200},{identifier:8,clientX:140,clientY:200}]});el.dispatchEvent(event);return event.defaultPrevented})
  assert.equal(multi,false);await settle(page);assert.equal(await trackX(page),0,'A second finger cannot leave the track stranded between pages')
  const filter='.bb-category-mix-filter select'
  await touch(page,filter,'touchstart',250);await touch(page,filter,'touchmove',20);await touch(page,filter,'touchend',20);assert.equal(await title(page),'Category Mix','The native chooser keeps its own interaction')
  // Interrupt an in-flight page animation and drag from its visible position.
  await page.emulateMedia({reducedMotion:'no-preference'})
  await touch(page,host,'touchstart',280);await touch(page,host,'touchmove',100);await finishDragSample(page);await touch(page,host,'touchend',100)
  await page.waitForTimeout(50)
  const frozen=await page.locator('.bb-chart-carousel').evaluate(el=>{const track=el.querySelector('.bb-chart-carousel-track'),stamp=performance.now(),before=new DOMMatrixReadOnly(getComputedStyle(track).transform).m41,e=new Event('touchstart',{bubbles:true,cancelable:true});Object.defineProperties(e,{touches:{value:[{identifier:7,clientX:100,clientY:200}]}});el.dispatchEvent(e);return{before,after:new DOMMatrixReadOnly(getComputedStyle(track).transform).m41,style:track.style.transform,animations:track.getAnimations().length,elapsed:performance.now()-stamp}})
  assert.ok(Math.abs(frozen.before-frozen.after)<1+frozen.elapsed*Math.max(3,(width+16)*.01),JSON.stringify({message:'Regrab only advances by the elapsed animation time',frozen}));await finishDragSample(page);const paused=await trackX(page);assert.ok(Math.abs(paused-Number(frozen.style.match(/translate3d\(([-\d.]+)/)[1]))<1,'The next painted frame stays at the captured position')
  await touch(page,'.bb-chart-carousel','touchmove',125);await finishDragSample(page);assert.ok(Math.abs(await trackX(page)-paused-25)<1,'Regrab follows the finger without restarting at the old page')
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
   await select(page,'Burn Rate');const heading=page.locator('#bb-chart-burn-rate .bb-chart-carousel-title');await heading.scrollIntoViewIfNeeded();const head=await heading.boundingBox(),headerTouch=await page.context().newCDPSession(page),headX=head.x+head.width/2,headY=head.y+head.height/2
   await headerTouch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:headX,y:headY}]});for(let i=1;i<=6;i++){await headerTouch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:headX+(width-20-headX)*i/6,y:headY}]});await page.waitForTimeout(20)}await headerTouch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle(page);assert.equal(await title(page),'Category Mix','Real touch swipes from the title use the page spring');await headerTouch.detach();native++
   await select(page,'Category Mix');await page.locator(host).scrollIntoViewIfNeeded();const cdp=await page.context().newCDPSession(page),box=await center.boundingBox(),startX=box.x+box.width/2,startY=Math.min(700,box.y+box.height/2)
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:startX,y:startY}]});for(let i=1;i<=6;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:startX+(20-startX)*i/6,y:startY}]});await page.waitForTimeout(20)}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle(page);assert.equal(await title(page),'Burn Rate','Real touch swipes from the center button navigate');assert.equal(await page.getByRole('dialog').count(),0)
   await select(page,'Category Mix');await page.locator(host).scrollIntoViewIfNeeded();const b=await page.locator(host).boundingBox(),y=Math.min(650,b.y+b.height/2),beforeY=await page.evaluate(()=>scrollY)
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width/2,y}]});for(let i=1;i<=6;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:width/2,y:y-150*i/6}]});await page.waitForTimeout(20)}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(250);assert.ok(await page.evaluate(()=>scrollY)>beforeY+50,'Real vertical scrolling remains native');assert.equal(await title(page),'Category Mix');await cdp.detach();native+=2
  }
  await page.goto('https://bookie.test/report?noBurn=1');await select(page,'Category Mix')
  assert.equal(await page.locator('.bb-chart-carousel-dot').count(),3);assert.equal(await page.getByRole('button',{name:'Show Burn Rate',exact:true}).count(),0)
  await select(page,'Bills & Utilities');const short=await headingLayout(page)
  assert.ok(short.value[0]+short.value[2]<=short.title[0]+short.title[2]+1,'Three-indicator reports retain fitted headings')
  if(width>362)assert.ok(short.title[0]+short.title[2]+8<=short.dots[0]+1)
  cases++
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.deepEqual(traffic,[]);cases+=10
  console.log(engineName,width,dark?'dark/reduced':'light','PASS');await page.close()
 }
 }finally{await browser.close()}
 }
 console.log(JSON.stringify({cases,native,result:'PASS: unchanged heading/content layout, moving titles with fixed markers, full-width swipe from title/background/center/slice/callout, rubber band, interruption/reverse/cancel, vertical intent, click isolation, controls, resize, reduced motion and keyboard'}))
})().catch(error=>{console.error(error);process.exit(1)})
