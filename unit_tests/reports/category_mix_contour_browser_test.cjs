// Run after npm run build. Execute the shared report UI with isolated payloads.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const [plain,enrolled]=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`
import json
from unit_tests.reports.test_income_projection import build,income_rows
from unit_tests.reports.test_espp_tracking import plan_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload as payload
print(json.dumps([payload(build(income_rows(('9/1/2026','Fixture income','5000')))),payload(build(plan_rows(('9/11/2026','xAI paycheck','3800'))))]))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
const css=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.js'),'utf8')
const html=(report,dark)=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-report-data" type="application/json">${JSON.stringify(report)}</script><script type="module" src="/app/assets/expense-report-app.js"></script></body></html>`
const csp=fs.readFileSync(path.join(root,"src/bookiebot/reports/phone_app.py"),"utf8").match(/"Content-Security-Policy": "([^"]+)"/)[1]
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value)

const report=JSON.parse(JSON.stringify(enrolled))
const values=[['rent','Rent',2500],['bills_utilities','Bills & Utilities',380],['static_bills_subscriptions_needs','Subscriptions (Needs)',180],['need_expenses','Need transactions',650],['grocery','Grocery',680],['gas','Gas',250],['food','Food',1329.32],['shopping','Shopping',540],['subscriptions_wants','Subscriptions (Wants)',160]]
for(const view of Object.values(report.modeViews)) {
 view.breakdown=values.map(([key,label,amount])=>({key,label,amount,percentage:0,color:'green'}))
 Object.assign(view.metrics,{monthlyIncome:9983.08,totalExpenses:6669.32,amountSaved:1996.62,incomeAfterExpenses:1317.14})
 view.categoryBudgets={needs:4991.54,wants:2994.92,savings:1596.62}
 view.categoryBalances={raw:{needs:351.54,wants:965.6,savings:0},remaining:{needs:351.54,wants:965.6,savings:0},deficits:{needs:0,wants:0,savings:0},transfers:[],totalOverspend:0}
 Object.assign(view.savingsInvesting,{cashSaved:1596.62,esppContribution:400,estimatedEsppContribution:0,combinedContributions:1996.62})
}
async function checkCalloutFocus(card){
 const styles=await card.evaluate(el=>[el,el.querySelector('rect')].map(node=>{const style=getComputedStyle(node);return {outline:style.outlineStyle,shadow:style.boxShadow,stroke:style.stroke,width:style.strokeWidth}}))
 for(const style of styles){assert.equal(style.outline,'none');assert.equal(style.shadow,'none');assert.equal(style.stroke,'none');assert.equal(style.width,'0px','Callout focus must never draw an outline or border, including keyboard and dialog restoration')}
}
async function startMotionSamples(category){
 await category.evaluate(el=>{
  window.__categoryMotion={running:true,frames:[],start:null};el.querySelector('.bb-category-pie-center').addEventListener('click',()=>{window.__categoryMotion.start=performance.now()},{once:true})
  const sample=()=>{
   const state=window.__categoryMotion;if(!state.running)return
   const path=el.querySelector('.recharts-sector'),d=path?.getAttribute('d')??'',move=d.match(/^M(-?[\d.]+),(-?[\d.]+)A/),arcs=[...d.matchAll(/A([\d.]+),/g)]
   if(move&&arcs.length>=2){
    const outer=+arcs[0][1],inner=+arcs[1][1],point=new DOMPoint(+move[1],+move[2]+outer).matrixTransform(path.getScreenCTM()),button=el.querySelector('.bb-category-pie-center'),box=button.getBoundingClientRect(),number=el.querySelector('.bb-category-used'),text=number.getBoundingClientRect(),style=getComputedStyle(button)
    state.frames.push({elapsed:state.start===null?null:performance.now()-state.start,paint:+getComputedStyle(el.querySelector('.bb-contour-callouts')).opacity,calloutAlpha:Math.max(0,...[...el.querySelectorAll('.bb-contour-stem,.bb-contour-label')].map(n=>+getComputedStyle(n).opacity)),x:box.x+box.width/2,y:box.y+box.height/2,ringX:point.x,ringY:point.y,outer,inner,height:box.height,numberHeight:text.height,numberCenter:text.y+text.height/2,font:parseFloat(getComputedStyle(number).fontSize),caption:parseFloat(style.fontSize),gap:parseFloat(style.gap),draw:[...el.querySelectorAll('.bb-contour-stem')].some(n=>{const d=parseFloat(getComputedStyle(n).strokeDashoffset);return d>0&&d<1}),pop:[...el.querySelectorAll('.bb-contour-label')].some(n=>{const a=+getComputedStyle(n).opacity;return a>0&&a<1})})
   }
   requestAnimationFrame(sample)
  };sample()
 })
}
async function checkMotionSamples(category,morph=true){
 const frames=await category.evaluate(()=>{window.__categoryMotion.running=false;return window.__categoryMotion.frames})
 assert.ok(frames.length>12);if(morph)assert.ok(new Set(frames.map(f=>Math.round(f.outer))).size>5,'The native ring visibly morphs through intermediate geometry')
 for(const f of frames){
  assert.ok(Math.hypot(f.x-f.ringX,f.y-f.ringY)<.8,JSON.stringify({message:'Center text follows the actual sector frame without jumping ahead or lagging',f}))
  const mix=Math.max(0,Math.min(1,(f.outer-f.inner-26)/22)),number=24+6*mix,caption=11+mix,gap=4*mix
  assert.ok(Math.abs(f.font-number)<.1&&Math.abs(f.caption-caption)<.1&&Math.abs(f.gap-gap)<.1,JSON.stringify(f))
  assert.ok(Math.abs(f.numberHeight-number*1.1)<.2&&Math.abs(f.height-(number*1.1+caption*1.5+gap+16))<.2,JSON.stringify(f))
  assert.ok(Math.abs(f.numberCenter-f.y+(caption*1.5+gap)/2)<.3,JSON.stringify({message:'The center number never pops within its changing box',f}))
 }
 assert.ok(frames.some(f=>f.draw),'Stems visibly draw out rather than appearing fully formed');assert.ok(frames.some(f=>f.pop),'Cards visibly expand from zero opacity');return frames
}
async function checkCascade(category,reduced,fresh=true){
 const launch=await category.locator('.bb-contour-callouts').evaluate(svg=>({window:+svg.dataset.cascadeWindow,cssClockFree:[...svg.querySelectorAll('.bb-contour-stem,.bb-contour-label')].every(n=>getComputedStyle(n).transitionProperty==='none'),stems:[...svg.querySelectorAll('.bb-contour-stem')].map(n=>({id:n.dataset.category,length:n.getAttribute('pathLength')})),motions:svg.getAnimations({subtree:true}).filter(a=>a.effect?.target?.matches('.bb-contour-stem,.bb-contour-label')).map(a=>({id:a.effect.target.dataset.category,stem:a.effect.target.classList.contains('bb-contour-stem'),delay:a.effect.getTiming().delay,duration:a.effect.getTiming().duration,frames:a.effect.getKeyframes()}))}))
 assert.ok(launch.stems.every(s=>s.length==='1'));assert.ok(launch.cssClockFree,'No competing CSS transition clock, including the global reduced-motion duration')
 if(reduced){assert.equal(launch.motions.length,0,JSON.stringify(launch));return launch}
 const stems=launch.motions.filter(m=>m.stem),cards=launch.motions.filter(m=>!m.stem);assert.equal(stems.length,launch.stems.length);assert.equal(cards.length,stems.length)
 const delays=stems.map(m=>m.delay);assert.equal(Math.min(...delays),0);assert.ok(Math.max(...delays)<=launch.window);if(stems.length>1)assert.equal(Math.max(...delays),launch.window)
 for(const stem of stems){const card=cards.find(m=>m.id===stem.id);assert.ok(card.delay>stem.delay&&card.delay<stem.delay+stem.duration);if(fresh)assert.equal(parseFloat(stem.frames[0].strokeDashoffset),1);else assert.ok(parseFloat(stem.frames[0].strokeDashoffset)>=0&&parseFloat(stem.frames[0].strokeDashoffset)<=1);assert.equal(parseFloat(stem.frames.at(-1).strokeDashoffset),0)}
 return launch
}
;(async()=>{
 let count=0
 for(const engine of (process.env.BOOKIEBOT_CONTOUR_ENGINE==='chromium'?[chromium]:process.env.BOOKIEBOT_CONTOUR_ENGINE==='webkit'?[webkit]:[chromium,webkit])) {
  const browser=await engine.launch({headless:true})
  try {
   for(const width of ((process.env.BOOKIEBOT_CONTOUR_PREVIEW||process.env.BOOKIEBOT_CONTOUR_FINAL)?[390]:[320,390,1280]))for(const dark of (process.env.BOOKIEBOT_CONTOUR_PREVIEW?[true]:[false,true])) {
    const reduced=process.env.BOOKIEBOT_CONTOUR_MOTION==='normal'?false:dark
    const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,colorScheme:dark?'dark':'light',reducedMotion:reduced?'reduce':'no-preference'}),errors=[],unexpected=[]
    page.on('pageerror',error=>errors.push(error.message))
    await page.route('**/*',async route=>{
     const url=new URL(route.request().url()),name=url.pathname.split('/').pop()
     if(url.pathname==='/report')return route.fulfill({contentType:'text/html',headers:{'Content-Security-Policy':csp},body:html(report,dark)})
     if(name==='expense-report-app.js')return route.fulfill({contentType:'application/javascript',body:js})
     if(/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(root,'src/bookiebot/reports/assets',name),'utf8')})
     unexpected.push(url.pathname);await route.abort()
    })
    const start=Date.now();await page.goto('https://bookie.test/report')
    const category=page.locator('#bb-chart-category')
    await page.getByRole('button',{name:'Show Category Mix',exact:true}).click()
    await category.getByRole('button',{name:'Show category callouts',exact:true}).waitFor()
    await page.waitForTimeout(700)
    const large=await category.evaluate(el=>{const host=el.querySelector('.bb-category-pie-host').getBoundingClientRect(),center=el.querySelector('.bb-category-pie-center').getBoundingClientRect(),radii=[...el.querySelector('.recharts-sector').getAttribute('d').matchAll(/A([\d.]+),/g)].map(match=>Number(match[1]));return {ring:el.querySelector('.recharts-pie').getBoundingClientRect().width,host:host.width,hostHeight:host.height,outer:radii[0],band:radii[0]-radii[1],offset:center.y+center.height/2-host.y-host.height/2,caption:getComputedStyle(el.querySelector('.bb-category-pie-center')).fontSize,gap:getComputedStyle(el.querySelector('.bb-category-pie-center')).gap,opacity:getComputedStyle(el.querySelector('.bb-contour-callouts')).opacity,font:getComputedStyle(el.querySelector('.bb-category-used')).fontSize}})
    assert.equal(large.opacity,'0','Callouts stay hidden until deliberately requested');assert.equal(large.font,'30px');assert.equal(large.caption,'12px');assert.equal(large.gap,'4px');assert.ok(Math.abs(large.band-48)<.01);assert.ok(Math.abs(large.outer-(Math.min(large.host,large.hostHeight)/2-36))<.2);assert.ok(Math.abs(large.offset+16)<.2,'Hidden ring retains the selected upward offset')
    await category.screenshot({path:`/private/tmp/category-ring-large-${engine.name()}-${width}-${dark?'dark':'light'}.png`})
    await category.locator('.bb-contour-label').first().waitFor({state:'attached',timeout:120000})
    if(!reduced)await startMotionSamples(category)
    await category.getByRole('button',{name:'Show category callouts',exact:true}).click({force:true})
    if(!reduced){
     await page.waitForTimeout(100)
     const during=(await category.locator('.recharts-pie').boundingBox()).width
     assert.ok(during<large.ring&&during>150,'The ring visibly interpolates its radius instead of snapping')
     await category.getByRole('button',{name:'Hide category callouts',exact:true}).click({force:true})
     await page.waitForTimeout(80)
     await category.getByRole('button',{name:'Show category callouts',exact:true}).click({force:true})
    }
    await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor({timeout:120000})
    await checkCascade(category,reduced,false)
    await page.waitForTimeout(740)
    if(!reduced)await checkMotionSamples(category)
    if(!reduced){
     await startMotionSamples(category)
     await category.getByRole('button',{name:'Hide category callouts',exact:true}).click({force:true})
     await page.waitForTimeout(90)
     await category.getByRole('button',{name:'Show category callouts',exact:true}).click({force:true})
     assert.equal(await category.locator('.bb-contour-callouts').getAttribute('data-ready'),'true','Reopening during retraction resumes immediately while the ring remains compact')
     await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor()
     const forward=await checkCascade(category,false,false);await page.waitForTimeout(740);await checkMotionSamples(category,false)
     await startMotionSamples(category)
     const compact=(await category.evaluate(el=>+el.querySelector('.recharts-sector').getAttribute('d').match(/A([\d.]+),/)[1]))
     await category.locator('.bb-contour-label').first().focus()
     await page.keyboard.press('Tab')
     assert.equal(await category.locator('.bb-contour-label:focus-visible').count(),1)
     await checkCalloutFocus(category.locator('.bb-contour-label:focus-visible'))
     await category.getByRole('button',{name:'Hide category callouts',exact:true}).evaluate(n=>n.click())
     const reverse=await category.locator('.bb-contour-callouts').evaluate(svg=>({paint:getComputedStyle(svg).opacity,motions:svg.getAnimations({subtree:true}).filter(a=>a.effect?.target?.matches('.bb-contour-stem,.bb-contour-label')).map(a=>({id:a.effect.target.dataset.category,stem:a.effect.target.classList.contains('bb-contour-stem'),delay:a.effect.getTiming().delay,frames:a.effect.getKeyframes()}))}))
     assert.equal(reverse.paint,'1','The SVG stays painted for the full reverse cascade')
     assert.equal(reverse.motions.length,forward.motions.length)
     for(const old of forward.motions.filter(m=>m.stem)){
      const stem=reverse.motions.find(m=>m.id===old.id&&m.stem),card=reverse.motions.find(m=>m.id===old.id&&!m.stem)
      assert.ok(Math.abs(card.delay-(forward.window-old.delay))<.005);assert.ok(Math.abs(stem.delay-card.delay-60)<.005)
      assert.equal(parseFloat(stem.frames[0].strokeDashoffset),0);assert.equal(parseFloat(stem.frames.at(-1).strokeDashoffset),1)
      assert.ok(card.frames[1].transform.includes('1.035')&&card.frames.at(-1).transform.includes('.01'))
     }
     await page.waitForFunction(()=>getComputedStyle(document.querySelector('#bb-chart-category .bb-contour-callouts')).opacity==='0')
     await page.waitForTimeout(400)
     const closeFrames=await checkMotionSamples(category)
     assert.ok(closeFrames.some(f=>f.outer>large.outer+.15),'Expansion has a subtle spring overshoot too')
     assert.ok(closeFrames.filter(f=>f.outer>compact+1).every(f=>f.calloutAlpha<.001&&f.paint===0),'The ring expands only after every stem/card has retracted')
     assert.ok(Math.abs(closeFrames.at(-1).outer-large.outer)<.1)
     await startMotionSamples(category)
     await category.getByRole('button',{name:'Show category callouts',exact:true}).click({force:true})
     await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor()
     await checkCascade(category,false);await page.waitForTimeout(740)
     const opening=await checkMotionSamples(category),firstStem=opening.find(f=>f.draw)
     assert.ok(firstStem&&firstStem.elapsed<350,JSON.stringify({message:'Warm ring reveal no longer waits 520ms before drawing stems',firstStem}))
     assert.ok(Math.min(...opening.map(f=>f.outer))<compact-.15,'Shrinking retains its gentle spring tail')
    }
    assert.ok((await category.locator('.recharts-pie').boundingBox()).width<large.ring,'The ring shrinks to make room for callouts')
    console.log(engine.name(),width,dark?'dark':'light','first-layout-ms',Date.now()-start)
    const originalHeight=(await page.locator('.bb-chart-carousel-band').boundingBox()).height
    for(const filter of (process.env.BOOKIEBOT_CONTOUR_PREVIEW?['all']:['all','needs','wants','savings'])) {
     await category.getByRole('combobox',{name:'Category mix filter',exact:true}).selectOption(filter)
     if(!reduced&&filter!=='all')assert.equal(await category.locator('.bb-contour-callouts').getAttribute('data-ready'),'false','Final callouts stay hidden while sectors morph')
     await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor({timeout:120000})
     await page.waitForTimeout(reduced?50:700)
     const geometry=await category.evaluate(el=>{
      const svg=el.querySelector('.bb-contour-callouts'),host=el.querySelector('.bb-category-pie-host').getBoundingClientRect(),center=el.querySelector('.bb-category-pie-center').getBoundingClientRect(),labels=[...svg.querySelectorAll('.bb-contour-label')],paths=[...svg.querySelectorAll('.bb-contour-stem')]
      const boxes=labels.map(label=>({id:label.dataset.category,box:label.querySelector('rect').getBBox()}))
      let overlap=false,intrusion=null,minSeparation=Infinity;const samples=[],byId=new Map()
      for(let i=0;i<boxes.length;i++)for(const b of boxes.slice(i+1)){const a=boxes[i].box,c=b.box;if(a.x<c.x+c.width+5&&a.x+a.width>c.x-5&&a.y<c.y+c.height+5&&a.y+a.height>c.y-5)overlap=true}
      for(const p of paths){const pts=[];for(let at=0;at<=p.getTotalLength();at+=.9){const point=p.getPointAtLength(at);pts.push([point.x,point.y]);for(const b of boxes){if(b.id===p.dataset.category)continue;const r=Math.min(18,b.box.height/2),qx=Math.abs(point.x-b.box.x-b.box.width/2)-b.box.width/2+r,qy=Math.abs(point.y-b.box.y-b.box.height/2)-b.box.height/2+r;if(Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r<.5)intrusion={stem:p.dataset.category,box:b.id}}}samples.push({id:p.dataset.category,pts});byId.set(p.dataset.category,p)}
      const cells=new Map();for(const route of samples)for(const p of route.pts){const x=Math.floor(p[0]/4),y=Math.floor(p[1]/4);for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const q of cells.get(`${x+dx},${y+dy}`)||[])if(q.id!==route.id)minSeparation=Math.min(minSeparation,Math.hypot(q.p[0]-p[0],q.p[1]-p[1]));const key=`${x},${y}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push({id:route.id,p})}
      return {hostCenter:(host.left+host.right)/2,ringWidth:el.querySelector(".recharts-pie").getBoundingClientRect().width,paths:paths.length,labels:labels.length,overlap,intrusion,minSeparation,curved:paths.every(p=>/[CQ]/.test(p.getAttribute('d'))),fits:boxes.every(({box:b})=>b.x>=0&&b.y>=0&&b.x+b.width<=host.width+.1&&b.y+b.height<=host.height+.1),textSizes:labels.map(label=>({name:label.querySelector('.bb-contour-name').textContent,card:label.querySelector('rect').getBBox().width,amount:label.querySelector('.bb-contour-amount').getBBox().width})),dimmed:labels.every(label=>getComputedStyle(label.querySelector('.bb-contour-percent')).fill!==getComputedStyle(label.querySelector('.bb-contour-amount')).fill),headerFont:getComputedStyle(el.querySelector('.bb-chart-total')).fontSize,titleFont:getComputedStyle(document.querySelector('.bb-chart-carousel-slide[aria-hidden="false"] .bb-chart-carousel-title')).fontSize,align:(()=>{const a=el.querySelector('.bb-chart-total').getBoundingClientRect(),b=el.querySelector('select').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2)})(),captionFont:getComputedStyle(el.querySelector('.bb-category-pie-center')).fontSize,captionGap:getComputedStyle(el.querySelector('.bb-category-pie-center')).gap,whole:labels.every(label=>/^\$[\d,]+ \/ [\d.]+%$/.test(label.querySelector('.bb-contour-amount').textContent)),centered:labels.every(label=>{const b=label.querySelector('rect').getBBox();return Math.abs(Number(label.querySelector('.bb-contour-name').getAttribute('x'))-b.x-b.width/2)<.1}),matched:labels.every(label=>label.dataset.category==='left'||getComputedStyle(label.querySelector('.bb-contour-name')).fill===getComputedStyle(byId.get(label.dataset.category)).stroke),textFits:labels.every(label=>['.bb-contour-name','.bb-contour-amount'].every(selector=>label.querySelector(selector).getBBox().width<=label.querySelector('rect').getBBox().width-7)),nameFont:labels.map(label=>getComputedStyle(label.querySelector('.bb-contour-name')).fontSize),percentFont:getComputedStyle(el.querySelector('.bb-category-used')).fontSize,captionFits:el.querySelector('.bb-category-pie-center > span').getBoundingClientRect().width<=center.width,hostWidth:host.width,hostHeight:host.height,names:labels.map(label=>label.querySelector('.bb-contour-name').textContent),overflow:document.documentElement.scrollWidth>innerWidth}
     })
     assert.equal(geometry.paths,geometry.labels,JSON.stringify(geometry));assert.ok(geometry.labels>0,JSON.stringify(geometry))
     for(const key of ['curved','fits','dimmed','whole','centered','matched','textFits','captionFits'])assert.equal(geometry[key],true,JSON.stringify({engine:engine.name(),width,filter,key,geometry}))
     assert.equal(geometry.overlap,false,JSON.stringify(geometry));assert.equal(geometry.intrusion,null,JSON.stringify(geometry));assert.ok(geometry.minSeparation>=1.4,JSON.stringify(geometry));assert.equal(geometry.overflow,false)
     assert.ok(Math.abs(geometry.hostCenter-width/2)<1,'The labeled ring stays centered in the page');assert.equal(geometry.percentFont,'24px');assert.equal(geometry.captionFont,'11px');assert.equal(geometry.captionGap,'0px');assert.equal(geometry.headerFont,'28px');assert.equal(geometry.titleFont,'28px');assert.ok(geometry.align<1,'Category selector is centered beside the amount');assert.ok(geometry.nameFont.every(font=>font==='11px'));assert.equal((await page.locator('.bb-chart-carousel-band').boundingBox()).height,originalHeight)
     if(filter==='all'){if(width===390)assert.ok(geometry.ringWidth<=221&&geometry.ringWidth>150,'The compact ring fits the percentage callouts');assert.equal(geometry.paths,12);assert.ok(geometry.names.includes('Other needs'));assert.ok(geometry.names.includes('Bills & utils'));assert.ok(geometry.names.includes('Subs (Needs)'));assert.ok(geometry.names.includes('Wants subs'))}
     count++
    }
    await category.getByRole('combobox',{name:'Category mix filter',exact:true}).selectOption('all')
    await category.locator('.bb-contour-callouts[data-ready="true"]').waitFor()
    assert.equal(await category.getByRole('button',{name:'Categories',exact:true}).count(),0,'The obsolete Categories button is absent')
    assert.equal(await category.locator('.bb-chart-page-footer').count(),0,'No redundant footer/details modal remains')
    const foodCard=category.locator('.bb-contour-label[data-category="food"]')
    assert.match(await foodCard.textContent(),/\$1,329 \/ 13\.3%/,'Amounts include the same percentage as the Categories list')
    await foodCard.tap();await page.getByRole('dialog').waitFor()
    assert.match(await page.getByRole('dialog').innerText(),/Food/)
    await page.keyboard.press('Escape');await page.waitForTimeout(350)
    assert.equal(await foodCard.evaluate(el=>{el.focus();return document.activeElement===el}),true)
    await checkCalloutFocus(foodCard)
    const foodSlice=category.locator('.recharts-sector[aria-label="Inspect Food, $1,329.32"]')
    await foodSlice.hover();await page.waitForTimeout(150)
    assert.equal(await category.locator('.recharts-tooltip-wrapper').count(),0,'Slice hover cannot spawn the old thumbnail tooltip')
    await foodSlice.click();await page.getByRole('dialog').waitFor()
    assert.equal(await category.locator('.recharts-tooltip-wrapper').count(),0,'Slice taps open only transactions')
    assert.match(await page.getByRole('dialog').innerText(),/Food/)
    await page.keyboard.press('Escape');await page.waitForTimeout(350)
    assert.equal(await category.locator('.bb-category-pie-host').getAttribute('data-callouts'),'true','Inspecting a slice or callout never toggles visibility')
    const focus=await foodSlice.evaluate(el=>{el.focus();const css=getComputedStyle(el);return {outline:css.outlineStyle,stroke:css.stroke,width:css.strokeWidth}})
    assert.equal(focus.outline,'none');assert.equal(focus.stroke,'none');assert.equal(focus.width,'0px','Touch/dialog focus cannot add a selection stroke')
    const hostBox=await category.locator('.bb-category-pie-host').boundingBox()
    await page.touchscreen.tap(hostBox.x+3,hostBox.y+3)
    await page.waitForTimeout(950)
    assert.equal(await category.locator('.bb-category-pie-host').getAttribute('data-callouts'),'false','Tapping empty chart background hides the callouts')
    assert.ok(Math.abs((await category.locator('.recharts-pie').boundingBox()).width-large.ring)<1,'Hiding callouts restores the original full-size ring')
    await page.mouse.move(hostBox.x+3,hostBox.y+3);await page.mouse.down();await page.mouse.move(hostBox.x+3,hostBox.y+40,{steps:6});await page.mouse.up()
    assert.equal(await category.locator('.bb-category-pie-host').getAttribute('data-callouts'),'false','A vertical drag never toggles')
    await category.getByRole('button',{name:'Show category callouts',exact:true}).focus();await page.keyboard.press('Enter')
    await page.waitForTimeout(700)
    assert.equal(await category.locator('.bb-category-pie-host').getAttribute('data-callouts'),'true','The center toggle works from the keyboard')
    await foodCard.focus();await page.keyboard.press('Enter');await page.getByRole('dialog').waitFor();await page.keyboard.press('Escape');await page.waitForTimeout(350)
    await category.locator('.bb-chart-kicker').click()
    await category.screenshot({path:`/private/tmp/refined-flow-${engine.name()}-${width}-${dark?'dark':'light'}.png`})
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[],'Only the public local geometry worker is requested')
    await page.close()
   }
  }finally{await browser.close()}
 }
 console.log(`${count} production Chromium/WebKit Refined flow cases passed`)
})().catch(error=>{console.error(error);process.exitCode=1})
