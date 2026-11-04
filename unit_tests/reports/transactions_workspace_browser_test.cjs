// Actual workspace, native graph/day motion and canonical action identities.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright'))
const fixture=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_TRANSACTION_WORKSPACE_FIXTURES||'/private/tmp/bookiebot-transactions-workspace.json','utf8'))
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8')
const bundlePromise=req('esbuild').build({stdin:{resolveDir:frontend,loader:'tsx',contents:`import React from 'react';import{createRoot}from'react-dom/client';import{TransactionsScreen}from'./src/transactions-screen';import{ChartTooltipDismissProvider}from'./src/components/ui/chart';createRoot(document.getElementById('root')).render(<ChartTooltipDismissProvider revision={0}><TransactionsScreen active ownerName="Brian" initialMonth="${fixture.month}"/></ChartTooltipDismissProvider>);`},outfile:'/private/tmp/bookiebot-transactions-fixture.js',bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'unused-overview-worker',setup(build){build.onResolve({filter:/\?worker&url$/},()=>({path:'unused-worker',namespace:'fixture-worker'}));build.onLoad({filter:/.*/,namespace:'fixture-worker'},()=>({contents:'export default "data:application/javascript,"',loader:'js'}))}}]})
const money=c=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c/100)
async function chartSpacing(page,screen){
 const measure=()=>screen.evaluate(root=>{
  const rect=selector=>root.querySelector(selector).getBoundingClientRect(),layout=rect('.bb-chart-layout'),plot=rect('.bb-recorded-graph-reveal'),summary=rect('.bb-daily-summary'),search=rect('.bb-recorded-search'),summaryStyle=getComputedStyle(root.querySelector('.bb-daily-summary')),open=root.querySelector('.bb-recorded-graph-toggle').getAttribute('aria-expanded')==='true'
  return{height:layout.height,plotHeight:plot.height,summaryHeight:summary.height,summaryPad:summaryStyle.paddingTop,summaryBorder:summaryStyle.borderTopWidth,summaryAbove:summary.bottom<=plot.top+1,searchGap:search.top-layout.bottom,open}
 })
 const check=g=>{
  assert(Math.abs(g.height-g.plotHeight-g.summaryHeight)<1,`Natural content height must not stretch with the list: ${JSON.stringify(g)}`)
  assert.equal(g.summaryPad,'0px','Shared mobile summary padding must not override the approved draft');assert.equal(g.summaryBorder,'0px','The draft has no divider above its metric')
  assert(g.summaryAbove,`Total/filter stay above the optional plot: ${JSON.stringify(g)}`)
  assert(g.open?g.plotHeight>250:g.plotHeight<1,`Disclosure owns graph height: ${JSON.stringify(g)}`)
  assert(g.searchGap>=19&&g.searchGap<=21,`Search retains its normal gap: ${JSON.stringify(g)}`)
 }
 check(await measure())
 await screen.locator('.bb-recorded-search').scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(requestAnimationFrame));check(await measure())
 await page.evaluate(()=>scrollTo(0,0));await page.evaluate(()=>new Promise(requestAnimationFrame));check(await measure())
}
async function approvedRowGeometry(screen){
 const geometry=await screen.evaluate(root=>{
  const single=root.querySelector('.bb-daily-single-day'),group=root.querySelector('.bb-daily-day-group:not(.bb-daily-single-day)'),entries=group.querySelector('.bb-daily-day-entries'),style=entries&&getComputedStyle(entries)
  return{single:single.offsetHeight,header:group.querySelector('.bb-daily-day-header').offsetHeight,divider:parseFloat(getComputedStyle(group).borderBottomWidth),nested:entries?{padding:style.paddingBottom,margin:style.marginBottom,border:style.borderLeftColor,guideEnd:getComputedStyle(entries,'::before').bottom,lastRow:entries.offsetHeight-entries.lastElementChild.offsetTop-entries.lastElementChild.offsetHeight}:null}
 })
 assert.equal(geometry.single,geometry.header+geometry.divider,'Flat singles and grouped day sections share one height')
 assert.equal(geometry.single,73)
 if(geometry.nested){assert.equal(geometry.nested.padding,'0px');assert.equal(geometry.nested.margin,'0px');assert.equal(geometry.nested.border,'rgba(0, 0, 0, 0)');assert.equal(geometry.nested.guideEnd,'6px');assert.equal(geometry.nested.lastRow,0)}
}
async function approvedActionRail(shell){
 const geometry=await shell.evaluate(root=>{
  const row=root.querySelector('.bb-daily-transaction'),rail=root.querySelector('.bb-recorded-swipe-actions'),remove=root.querySelector('.bb-recorded-action-delete'),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=getComputedStyle(remove).backgroundColor;ctx.fillRect(0,0,1,1)
  return{seam:rail.getBoundingClientRect().left-row.getBoundingClientRect().right,red:[...ctx.getImageData(0,0,1,1).data],heights:[...rail.children].map(button=>button.offsetHeight)}
 })
 assert(Math.abs(geometry.seam)<.6,'The swipe rail must touch the row without a gap: '+geometry.seam)
 assert(geometry.red[0]>140&&geometry.red[0]>geometry.red[1]*1.5&&geometry.red[0]>geometry.red[2]*1.5,'Delete remains red in both themes')
 assert(geometry.heights.every(height=>height>=44))
}
async function noFocusChrome(screen){
 const failures=await screen.evaluate(root=>{const failures=[];for(const el of root.querySelectorAll('button,input,select,summary,[tabindex]')){
  if(el.disabled||el.closest('[inert]')||!el.getClientRects().length)continue
  const border=getComputedStyle(el).borderColor;el.focus({preventScroll:true});if(document.activeElement!==el)continue
  for(const target of[el,el.closest('.bb-category-mix-filter')].filter(Boolean)){const s=getComputedStyle(target);if(s.outlineStyle!=='none'&&s.outlineWidth!=='0px'||s.boxShadow!=='none')failures.push(el.getAttribute('aria-label')||el.textContent)}
  if(getComputedStyle(el).borderColor!==border)failures.push('focus changed border: '+el.tagName);el.blur()
 }return failures});assert.deepEqual(failures,[],'Keyboard focus must not add visible borders, outlines or shadows')
}
async function swipeMotion(page,first){
 const access=first.getByRole('button',{name:'Show actions for Starbucks Coffee Company',exact:true}),shell=access.locator('..')
 const sample=()=>shell.evaluate(async el=>{const group=el.closest('.bb-daily-day-group'),bead=group.querySelector('.bb-daily-bead[data-entry="0"]'),row=el.querySelector('.bb-daily-transaction'),rail=el.querySelector('.bb-recorded-swipe-actions'),viewport=bead.closest('.bb-recorded-swipe-icon-viewport'),frames=[];for(let i=0;i<19;i++){await new Promise(requestAnimationFrame);const r=getComputedStyle(row),b=getComputedStyle(bead),rowTransform=r.transform,beadTranslate=b.translate;frames.push({row:new DOMMatrix(rowTransform).m41,bead:parseFloat(beadTranslate)||0,opacity:b.opacity,duration:r.transitionDuration,easing:r.transitionTimingFunction,clip:viewport.style.clipPath,rail:getComputedStyle(rail).visibility})}return frames})
 await access.press('ArrowRight');const close=await sample();assert(close.some(f=>f.row< -1)&&close.at(-1).row>close[0].row)
 assert(close.every(f=>f.rail==='visible'&&f.opacity==='1'&&Math.abs(f.row-f.bead)<1.1&&f.clip.startsWith('polygon(')),JSON.stringify(close))
 await page.waitForTimeout(460)
 const bounds=await access.boundingBox();await page.mouse.move(bounds.x+bounds.width*.7,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.7-130,bounds.y+bounds.height/2,{steps:10});await page.mouse.up();const open=await sample()
 assert(open.some(f=>f.row< -130));assert(open.every(f=>f.opacity==='1'&&Math.abs(f.row-f.bead)<1.1&&f.clip.startsWith('polygon(')),JSON.stringify(open))
 assert(open.every(f=>f.duration===close[0].duration&&f.easing===close[0].easing),'Entry and exit share the same CSS curve and duration');assert.equal(open[0].duration,'0.42s, 0.42s')
 await page.waitForTimeout(460)
}
;(async()=>{const bundle=(await bundlePromise).outputFiles.find(f=>f.path.endsWith('.js')).text;let cases=0
for(const engine of[chromium,webkit].filter(engine=>!process.env.ONLY_ENGINE||engine.name()===process.env.ONLY_ENGINE)){const browser=await engine.launch();try{
 for(const width of(process.env.ONLY_WIDTH?[Number(process.env.ONLY_WIDTH)]:[320,390,1280]))for(const dark of(process.env.ONLY_THEME?[process.env.ONLY_THEME==='dark']:[false,true])){
  const page=await browser.newPage({viewport:{width,height:width===390?844:1000},hasTouch:true,isMobile:width<700,colorScheme:dark?'dark':'light'}),errors=[],commands=[],reviews=[]
  page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)})
  await page.route('**/*',route=>{
   const request=route.request(),url=new URL(request.url()),reply=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)})
   if(url.origin!=='https://transactions.test')return route.abort()
   if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:`<html data-theme="${dark?'dark':'light'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;padding:18px}#root{max-width:900px;margin:auto}</style><div id="root"></div><script>${bundle}</script></html>`})
   if(url.pathname.startsWith('/app/assets/')){const file=path.join(assets,path.basename(url.pathname));if(fs.existsSync(file))return route.fulfill({contentType:file.endsWith('.png')?'image/png':'image/svg+xml',body:fs.readFileSync(file)})}
   if(url.pathname==='/app/transactions/review'){
    const body=request.postDataJSON();reviews.push(body);const item=fixture.sources.find(r=>r.id===body.id);assert(item)
    return reply({review:{item,operation:body.operation,destination:body.destination,after:{...item.fields,...body.updates,...(body.updates?.amount?{amount:(body.updates.amount/100).toFixed(2)}:{})},reviewVersion:'isolated-browser-review'}})
   }
   if(url.pathname==='/app/transactions'&&request.method()==='GET'){
    const q=url.searchParams,key=q.get('offset')==='40'?'page2':q.get('search')?(q.get('search').toLowerCase().includes('star')?'search':'empty'):q.get('kind')||q.get('bucket')||(q.get('split')==='shared'?'shared':q.get('category')==='food'?'food':'all')
    return reply(fixture.results[key]||fixture.results.empty)
   }
   commands.push({url:url.href,method:request.method()});return route.abort()
  })
  await page.goto('https://transactions.test/fixture');const screen=page.getByRole('region',{name:'Recorded transactions',exact:true}),ready=()=>page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false')
  await screen.locator('.bb-chart-total').waitFor().catch(async error=>{console.error(await page.locator('body').innerText());await page.screenshot({path:'/private/tmp/inline-workspace-failure.png'});throw error});await ready()
  const filter=screen.getByRole('combobox',{name:'Filter transactions',exact:true}),total=screen.locator('.bb-chart-total')
  assert.equal(await screen.getByRole('button',{name:'Show spending graph',exact:true}).getAttribute('aria-expanded'),'false')
  assert.equal(await screen.locator('.bb-recorded-graph-reveal').getAttribute('aria-hidden'),'true')
  assert.equal(await screen.locator('.bb-recorded-graph-reveal').evaluate(el=>el.inert),true)
  const plot=await screen.locator('.bb-daily-plot').elementHandle()
  await chartSpacing(page,screen);await approvedRowGeometry(screen)
  await screen.getByRole('button',{name:'Show spending graph',exact:true}).click();await page.waitForTimeout(470);await chartSpacing(page,screen)
  for(let reversal=0;reversal<3;reversal++){await screen.locator('.bb-recorded-graph-toggle').click();await page.waitForTimeout(40)}
  await page.waitForTimeout(470);assert.equal(await screen.locator('.bb-recorded-graph-toggle').getAttribute('aria-expanded'),'false');await chartSpacing(page,screen)
  assert(await plot.evaluate(el=>el===document.querySelector('.bb-daily-plot')),'Disclosure keeps the native chart mounted')
  assert.equal(await total.innerText(),money(fixture.results.all.totalAmountCents));assert.equal(await screen.getByRole('combobox').count(),1);assert.equal(await screen.locator('.bb-daily-single-day').count(),1)
  const geometry=await screen.evaluate(el=>{const single=el.querySelector('.bb-daily-single-day .bb-daily-day-total'),regular=el.querySelector('.bb-daily-day-header .bb-daily-day-total'),a=el.querySelector('.bb-chart-total').getBoundingClientRect(),f=el.querySelector('.bb-category-mix-filter').getBoundingClientRect(),search=el.querySelector('.bb-recorded-search').getBoundingClientRect();return{singleRight:single.getBoundingClientRect().right,regularRight:regular.getBoundingClientRect().right,singleSize:getComputedStyle(single).fontSize,regularSize:getComputedStyle(regular).fontSize,beside:a.right<f.left,above:f.bottom<search.top,overflow:document.documentElement.scrollWidth>innerWidth}})
  assert(Math.abs(geometry.singleRight-geometry.regularRight)<1&&geometry.singleSize===geometry.regularSize&&geometry.beside&&geometry.above&&!geometry.overflow,JSON.stringify(geometry))
  assert((await screen.locator('.bb-daily-day-group').last().locator('.bb-daily-day-header').getAttribute('aria-label')).includes('45 entries'))
  const single=screen.locator('.bb-daily-single-day .bb-recorded-swipe')
  assert.equal(await single.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px','A flat single-entry day must not have a second divider above its text')
  const singleAccess=single.getByRole('button',{name:/Show actions/})
  await singleAccess.click();await page.waitForTimeout(460)
  assert.equal(await single.getAttribute('data-side'),'closed','Pointer taps cannot reveal row actions')
  await singleAccess.tap();await page.waitForTimeout(460)
  assert.equal(await single.getAttribute('data-side'),'closed','Touch taps cannot reveal row actions')
  await singleAccess.press('Enter');await page.waitForTimeout(460)
  assert.equal(await single.getAttribute('data-side'),'left','Keyboard and assistive activation remain available')
  await approvedActionRail(single)
  await singleAccess.press('Escape');await page.waitForTimeout(460)
  const box=await singleAccess.boundingBox()
  for(const[dx,dy]of[[-5,0],[-12,40]]){
   await page.mouse.move(box.x+box.width*.8,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width*.8+dx,box.y+box.height/2+dy,{steps:5});await page.mouse.up();await page.waitForTimeout(460)
   assert.equal(await single.getAttribute('data-side'),'closed','Micro-movement and vertical scroll gestures cannot reveal actions')
  }
  await noFocusChrome(screen)
  await screen.getByRole('button',{name:'Load more transactions',exact:true}).click();await ready();assert.equal(await total.innerText(),money(fixture.results.all.totalAmountCents));assert.equal(await screen.getByRole('button',{name:'Load more transactions',exact:true}).count(),0);await chartSpacing(page,screen)
  const first=screen.locator('.bb-daily-day-group').first();await first.locator('.bb-daily-day-header').click();await page.waitForFunction(()=>document.querySelector('.bb-daily-day-group').dataset.moving==='false')
  await approvedRowGeometry(screen)
  const rowBorders=await first.locator('.bb-daily-row-shell').evaluateAll(rows=>rows.map(el=>({shell:getComputedStyle(el).borderTopWidth,swipe:getComputedStyle(el.querySelector('.bb-recorded-swipe')).borderTopWidth})))
  assert(rowBorders.every((row,i)=>row.swipe==='0px'&&row.shell===(i?'1px':'0px')),'Only the native separators between expanded rows remain')
  await first.getByRole('button',{name:'Show actions for Starbucks Coffee Company',exact:true}).tap();await page.waitForTimeout(460)
  assert.equal(await first.locator('.bb-recorded-swipe').first().getAttribute('data-side'),'closed','Expanded rows also require an actual swipe')
  await first.getByRole('button',{name:'Show actions for Starbucks Coffee Company',exact:true}).press('ArrowLeft');await page.waitForTimeout(460)
  await approvedActionRail(first.locator('.bb-recorded-swipe').first())
  const buttons=first.getByRole('group',{name:'Actions for Starbucks Coffee Company',exact:true}).getByRole('button');assert.equal(await buttons.count(),3)
  const sizes=await buttons.evaluateAll(es=>es.map(e=>({w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})));assert(sizes.every(e=>Math.abs(e.w-sizes[0].w)<.1&&Math.abs(e.h-sizes[0].h)<.1))
  if(width===390&&dark)await swipeMotion(page,first)
  await noFocusChrome(screen)
  await first.getByRole('button',{name:'Update Starbucks Coffee Company',exact:true}).click();await screen.getByRole('combobox',{name:'Update category',exact:true}).selectOption('gas');await screen.getByRole('region',{name:'Edit transaction',exact:true}).getByLabel('Amount',{exact:true}).fill('9.45')
  await noFocusChrome(screen)
  await screen.getByRole('button',{name:'Review change',exact:true}).click();await screen.getByRole('button',{name:'Confirm update',exact:true}).waitFor();assert.equal(reviews.at(-1).operation,'move');assert.equal(reviews.at(-1).updates.amount,945);assert.equal(reviews.at(-1).destination,'gas');assert((await screen.locator('.bi-review-changes').innerText()).includes('$9.45'));assert((await screen.locator('.bi-review-change[data-field="category"]').innerText()).includes('Gas'));await noFocusChrome(screen);await screen.getByRole('button',{name:'Back',exact:true}).click();await screen.getByRole('button',{name:'Cancel',exact:true}).click()
  await screen.getByRole('button',{name:'Show spending graph',exact:true}).click();await page.waitForTimeout(470)
  for(const[value,key]of[['needs','needs'],['wants','wants'],['shared','shared'],['category:food','food'],['income','income'],['savings','savings'],['all','all']]){await filter.selectOption(value);await ready();assert.equal(await total.innerText(),money(fixture.results[key].totalAmountCents));if(value==='shared')assert.equal(await screen.locator('.bb-daily-single-day').count(),2);await chartSpacing(page,screen)}
  await screen.getByRole('searchbox',{name:'Search transactions',exact:true}).fill('star');await page.waitForTimeout(300);await ready();assert.equal(await total.innerText(),'$8.45');assert.equal(await screen.locator('.bb-recorded-search button').count(),1);assert.equal(await screen.locator('.bb-daily-single-day').count(),1);await screen.getByRole('button',{name:'Clear search',exact:true}).click();await ready()
  if(width===390&&dark){await screen.getByRole('button',{name:'Hide spending graph',exact:true}).click();await page.waitForTimeout(1700);await screen.getByRole('heading',{name:'Transactions',exact:true}).click();await screen.screenshot({path:`/private/tmp/transactions-workspace-${engine.name()}.png`})}
  assert.deepEqual(errors,[]);assert.deepEqual(commands,[],'No financial command is sent by the browser acceptance');cases++;console.log(JSON.stringify({engine:engine.name(),width,dark,passed:true}));await page.close()
 }
}finally{await browser.close()}}
console.log(JSON.stringify({cases,passed:true,checks:['actual native graph/day components','full-result pagination totals','partial-day counts','flat single totals and category badges','joined actions','combined category/amount review and cancel','unified scopes/search','phone/desktop, both themes']}))
})().catch(error=>{console.error(error);process.exitCode=1})
