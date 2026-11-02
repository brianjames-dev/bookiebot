// Shipped bundle, synthetic report only; no authenticated APIs or financial writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),req=createRequire(path.join(root,'web/expense-report/package.json'))
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const report=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`
import json
from unit_tests.reports.test_income_projection import build,income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture income','5000'))))))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
report.ownerName='Brian'
report.dailyEntries=[['Groceries',120,'9/5/2026','Weekly groceries','Whole Foods'],['Food',30,'9/5/2026','Lunch','Chipotle'],['Shopping',15,'','Purchase','Target'],['Food',8,'9/5/2026','Coffee','Corner café'],['Groceries',20,'9/5/2026','Produce','Neighborhood market'],['Gas',54,'9/5/2026','Gas','Chevron'],['Shopping',137,'9/5/2026','Household items','Target']].map(([category,amount,date,item,location])=>({category,amount,date,item,person:'Brian',location}))
for(const view of Object.values(report.modeViews)){
 view.calendarEvents=[{kind:'bill',label:'City utilities',amount:107,day:8,group:'bills_utilities',projectedOnly:true},{kind:'subscription',label:'Netflix',amount:15.49,day:8,group:'subscriptions_wants',projectedOnly:true}]
 view.breakdown=[['grocery','Groceries',140],['food','Food',38],['gas','Gas',54],['shopping','Shopping',152],['bills_utilities','Bills & Utilities',107],['subscriptions_wants','Subs (Wants)',15.49]].map(([key,label,amount])=>({key,label,amount,color:'#999',percentage:10}))
}
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8'),js=fs.readFileSync(path.join(assets,'expense-report-app.js'),'utf8')
const html=dark=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script>localStorage.setItem('bookiebot-expense-report-theme','${dark?'dark':'light'}')</script><script id="bookiebot-expense-report-data" type="application/json">${JSON.stringify(report)}</script><script type="module" src="/app.js"></script></body></html>`
async function settle(section){await section.evaluate(async el=>{await Promise.allSettled(el.getAnimations({subtree:true}).map(animation=>animation.finished))})}
async function closedLayout(section){return section.evaluate(section=>{
 const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,center:r.top+r.height/2}}
 const dropdown=section.querySelector('select[aria-label="Daily spending filter"]'),title=section.querySelector('h2'),button=section.querySelector('.bb-daily-transactions-toggle'),row=section.querySelector('.bb-daily-amount-row'),amount=row.querySelector('.bb-fitted-amount-text'),integer=amount.querySelector('.bb-amount-integer')||amount,reference=document.querySelector('select[aria-label="Category mix filter"]')
 return {dropdown:rect(dropdown),title:rect(title),button:rect(button),row:rect(row),amount:rect(amount),integer:rect(integer),overflow:document.documentElement.scrollWidth>innerWidth,styles:[dropdown,reference].map(el=>{const s=getComputedStyle(el);return[s.borderRadius,s.padding,s.fontSize,s.backgroundColor]}),radius:getComputedStyle(button).borderRadius}
})}
;(async()=>{let cases=0
 for(const engine of [chromium,webkit]){const browser=await engine.launch({headless:true})
 try{for(const width of [320,390,861,1280])for(const dark of [false,true]){
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:true,isMobile:width<768,colorScheme:dark?'dark':'light',reducedMotion:dark?'reduce':'no-preference'})
  const errors=[],traffic=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000)
  await page.route('**/*',async route=>{const url=new URL(route.request().url()),name=path.basename(url.pathname)
   if(route.request().method()!=='GET'||url.origin!=='https://bookie.test'){traffic.push(route.request().method()+' '+url);return route.abort()}
   if(url.pathname==='/report')return route.fulfill({contentType:'text/html',body:html(dark)})
   if(name==='app.js')return route.fulfill({contentType:'application/javascript',body:js})
   if(/^category-mix-layout-[\w-]+\.js$/.test(name))return route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(assets,name))})
   if(/^company-logo-[\w-]+\.(svg|png)$/.test(name)&&fs.existsSync(path.join(assets,name)))return route.fulfill({contentType:name.endsWith('.svg')?'image/svg+xml':'image/png',body:fs.readFileSync(path.join(assets,name))})
   traffic.push(url.pathname);return route.abort()
  })
  await page.goto('https://bookie.test/report')
  const section=page.locator('.bb-daily-section'),filter=section.getByRole('combobox',{name:'Daily spending filter',exact:true}),button=section.getByRole('button',{name:'Transactions',exact:true}),amount=section.locator('.bb-daily-amount-row .bb-fitted-amount-text')
  await section.waitFor();await page.getByRole('button',{name:'Projected',exact:true}).click();await section.scrollIntoViewIfNeeded()
  assert.deepEqual(await filter.locator('option').allTextContents(),['All','Needs','Wants']);assert.equal(await section.getByRole('tablist').count(),0)
  const stage=await page.locator('.bb-chart-carousel-band').evaluate(el=>el.getBoundingClientRect().height)
  for(const [scope,total,days]of[['needs','$301.00',2],['wants','$205.49',3],['all','$506.49',3]]){
   await filter.selectOption(scope);await page.waitForFunction(total=>document.querySelector('.bb-daily-amount-row .bb-fitted-amount-text').textContent===total,total)
   await settle(section)
   const m=await closedLayout(section)
   assert.equal(m.overflow,false,JSON.stringify(m));assert.deepEqual(m.styles[0],m.styles[1]);assert.equal(m.radius,'24px');assert.ok(m.dropdown.height>=44&&m.button.height>=44)
   assert.ok(m.title.right+7<=m.dropdown.left,JSON.stringify(m));assert.ok(Math.abs(m.title.center-m.dropdown.center)<1,JSON.stringify(m))
   assert.ok(m.amount.right+10<=m.button.left,JSON.stringify(m));assert.ok(Math.abs(m.integer.center-m.button.center)<2,JSON.stringify(m));assert.ok(Math.abs(m.row.right-m.button.right)<1,JSON.stringify(m));assert.ok(m.amount.width>20)
   const legend=section.getByRole('list',{name:'Daily spending legend'})
   assert.deepEqual(await legend.locator('li').allTextContents(),scope==='all'?['Needs','Wants']:[scope==='needs'?'Needs':'Wants'])
   await section.locator('.recharts-rectangle').first().waitFor({state:'visible'})
   const colors=await section.evaluate(el=>{
    const legend=el.querySelector('.bb-daily-legend'),plot=el.querySelector('.bb-chart-box');return {below:legend.getBoundingClientRect().top>=plot.getBoundingClientRect().bottom,colors:[...legend.querySelectorAll('li')].map(li=>({name:li.textContent,color:getComputedStyle(li.firstElementChild).backgroundColor,bar:getComputedStyle(el.querySelector(`.recharts-rectangle[fill="${li.textContent==='Needs'?'hsl(var(--chart-1))':'hsl(var(--chart-2))'}"]`)||el.querySelector('.recharts-rectangle')).fill}))}
   })
   assert.ok(colors.below);for(const item of colors.colors)assert.equal(item.color,item.bar)
   await button.click();await section.locator('.bb-daily-transactions').waitFor({state:'visible'})
   const type=section.getByRole('combobox',{name:'Transaction type',exact:true}),close=section.getByRole('button',{name:'Close transactions',exact:true})
   assert.equal(await button.count(),0);assert.equal(await section.locator('.bb-daily-day-group').count(),days);assert.equal(await filter.inputValue(),scope);assert.equal(await type.inputValue(),'');assert.equal(await section.locator('.bb-daily-bead').first().evaluate(n=>getComputedStyle(n).visibility),'visible')
   assert.equal(await amount.textContent(),total,'Disclosure does not alter the total')
   assert.equal(await type.evaluate(el=>el===document.activeElement),true,'Focus follows the morphing control')
   const id=await close.getAttribute('aria-controls');assert.equal(await page.locator(`[id="${id}"]`).getAttribute('inert'),null)
   await close.focus();await page.keyboard.press('Space');assert.equal(await button.getAttribute('aria-expanded'),'false');assert.equal(await button.evaluate(el=>el===document.activeElement),true)
  }
  assert.equal(await page.locator('.bb-chart-carousel-band').evaluate(el=>el.getBoundingClientRect().height),stage)
  const morph=await section.evaluate(async section=>{
   const carrier=section.querySelector('.bb-daily-morph-control'),row=section.querySelector('.bb-daily-amount-row'),trigger=section.querySelector('.bb-daily-transactions-toggle'),close=section.querySelector('.bb-daily-transactions-close'),select=section.querySelector('[aria-label="Transaction type"]'),frames=[];let done=false;const start=performance.now()
   const tick=t=>{const c=carrier.getBoundingClientRect(),r=row.getBoundingClientRect();frames.push({t:t-start,width:c.width,y:c.top-r.top,right:c.right-r.right});if(t-start<600)requestAnimationFrame(tick);else done=true};requestAnimationFrame(tick)
   trigger.click();await new Promise(r=>setTimeout(r,80));close.click();await new Promise(r=>setTimeout(r,60));trigger.click();await new Promise(r=>setTimeout(r,60));close.click();while(!done)await new Promise(r=>setTimeout(r,10));return{frames,same:carrier===section.querySelector('.bb-daily-morph-control')&&trigger===section.querySelector('.bb-daily-transactions-toggle')&&select===section.querySelector('[aria-label="Transaction type"]')}
  })
  assert.equal(morph.same,true,'Micro taps retain the same controls')
  for(const frame of morph.frames)assert.ok(Math.abs(frame.right)<1,'Capsule stays anchored during rapid reversals')
  if(!dark){assert.ok(new Set(morph.frames.map(frame=>Math.round(frame.width))).size>4,'Capsule width interpolates');if(width<=390)assert.ok(new Set(morph.frames.map(frame=>Math.round(frame.y))).size>4,'Wrapping follows a continuous slide')}
  await button.click()
  const headers=section.locator('.bb-daily-day-header'),type=section.getByRole('combobox',{name:'Transaction type',exact:true}),close=section.getByRole('button',{name:'Close transactions',exact:true})
  assert.deepEqual(await headers.locator('.bb-daily-day').allTextContents(),['8','5','No date'])
  assert.ok(!(await headers.allTextContents()).some(text=>text.includes('Sep')))
  for(let i=0;i<3;i++)await headers.nth(i).click()
  await section.locator('.bb-daily-transaction').first().waitFor({state:'visible'})
  assert.equal(await section.locator('.bb-daily-transaction').count(),9)
  assert.equal(await section.getByText('Recorded',{exact:true}).count(),0)
  assert.equal(await section.getByText('Scheduled',{exact:true}).count(),1,'Only the subscription is scheduled; a recorded bill remains recorded')
  const groups=section.locator('.bb-daily-day-group'),busy=groups.nth(1)
  assert.deepEqual(await busy.locator('.bb-daily-transaction').evaluateAll(rows=>rows.map(el=>el.dataset.category)),['Food','Food','Gas','Groceries','Groceries','Shopping'])
  assert.deepEqual(await busy.locator('.bb-daily-transaction-name').allTextContents(),['Chipotle','Corner café','Chevron','Whole Foods','Neighborhood market','Target'])
  assert.deepEqual(await headers.locator('.bb-daily-preview-item').evaluateAll(items=>items.map(item=>item.parentElement.children.length)),[2,2,6,6,6,6,6,6,1])
  assert.equal(await busy.locator('.bb-daily-preview-more').count(),0)
  assert.equal(await busy.locator('.bb-daily-preview').getAttribute('role'),'img')
  await settle(section)
  const geometry=await section.evaluate(el=>{
   const rect=n=>n.getBoundingClientRect(),rows=[...el.querySelectorAll('.bb-daily-transaction')],rail=el.querySelector('.bb-daily-day-entries')
   return {overflow:document.documentElement.scrollWidth>innerWidth,rail:parseFloat(getComputedStyle(rail).borderLeftWidth),icons:rows.map(row=>{const r=rect(row.querySelector('.bb-daily-row-icon-anchor'));return[r.width,r.height]}),scheduled:rows.filter(row=>row.dataset.scheduled==='true').map(row=>({meta:rect(row.querySelector('.bb-daily-transaction-meta')).top,status:rect(row.querySelector('.bb-daily-transaction-status')).top,name:rect(row.querySelector('.bb-daily-transaction-name')).top,amount:rect(row.querySelector('.bb-daily-transaction-money')).top})),widths:[rect(el.querySelector('.bb-daily-active-filter')).width,rect(el.querySelector('.bb-daily-amount-row')).width]}
  })
  const categoryColors=await section.locator('.bb-daily-transaction-category').evaluateAll(labels=>labels.map(label=>{const tokens={'Groceries':'grocery','Food':'food','Gas':'gas','Shopping':'shopping','Bills & utilities':'bills','Subs (Wants)':'subs-wants'},probe=document.createElement('span');label.append(probe);probe.style.color='hsl(var(--category-'+tokens[label.firstChild.textContent]+'))';const expected=getComputedStyle(probe).color;probe.remove();return{actual:getComputedStyle(label).color,expected}}))
  for(const color of categoryColors)assert.equal(color.actual,color.expected)
  assert.equal(await type.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px','One capsule border around Type and Close')
  assert.equal(geometry.overflow,false);assert.equal(geometry.rail,1);for(const size of geometry.icons)assert.deepEqual(size,[28,28]);for(const row of geometry.scheduled){assert.ok(Math.abs(row.meta-row.status)<1,JSON.stringify(row));assert.ok(Math.abs(row.name-row.amount)<1)}
  if(width<=390)assert.ok(Math.abs(geometry.widths[0]-geometry.widths[1])<1)
  await busy.locator('.bb-daily-day-entries').scrollIntoViewIfNeeded()
  await page.waitForFunction(()=>[...document.querySelectorAll('.bb-daily-icon-layer img')].every(img=>img.complete&&img.naturalWidth>0))
  if(width===390){
   const header=headers.first(),file=`/private/tmp/bookiebot-preview-gap-${engine.name()}-${dark}.png`
   await header.click();await settle(section)
   const point=await groups.first().evaluate(el=>{const header=el.querySelector('.bb-daily-day-header'),h=header.getBoundingClientRect(),b=el.querySelector('.bb-daily-bead').getBoundingClientRect();header.style.background='#234c63';return[Math.round(b.left-h.left+28),Math.round(b.top-h.top+14)]})
   await header.screenshot({path:file});await header.evaluate(el=>el.style.removeProperty('background'))
   execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',"from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert('RGB'); point=(int(sys.argv[2]),int(sys.argv[3])); assert im.getpixel(point) == (35,76,99), im.getpixel(point)",file,...point.map(String)])
  }
  if(width===390&&dark){await page.waitForTimeout(350);await section.screenshot({path:`/private/tmp/bookiebot-daily-quiet-${engine.name()}.png`})}
  await type.selectOption('Shopping');assert.equal(await amount.textContent(),'$506.49');assert.equal(await section.locator('.bb-daily-day-group').count(),2);assert.equal(await section.locator('.bb-daily-transaction').count(),2)
  await close.click();await button.click();assert.equal(await type.inputValue(),'Shopping','Collapse retains list filter')
  await filter.selectOption('needs');assert.equal(await type.inputValue(),'','Scope changes reset Type');await close.click()
  await page.evaluate(()=>localStorage.setItem('bookiebot-amount-appearance:v1:brian',JSON.stringify({version:1,raisedCents:false})));await page.reload();await section.waitFor();assert.equal(await section.locator('.bb-daily-amount-row .bb-amount-fraction').count(),0)
  const plain=await closedLayout(section);assert.ok(Math.abs(plain.integer.center-plain.button.center)<2);assert.equal(plain.overflow,false)
  assert.deepEqual(errors,[]);assert.deepEqual(traffic,[]);cases++;console.log(engine.name(),width,dark?'dark/reduced':'light','PASS');await page.close()
 }}finally{await browser.close()}}
 console.log(`${cases} Chromium/WebKit Quiet indent, morph, legend, day/category order, logo sizing and Scheduled alignment cases passed.`)
})().catch(error=>{console.error(error);process.exit(1)})
