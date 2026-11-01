// Actual calendar + shared day dialog, deterministic dates and real local logos.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const css=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.css'),'utf8')
const catalog=JSON.parse(fs.readFileSync(path.join(frontend,'src/company-logos.json'),'utf8'))
const bundlePromise=req('esbuild').build({stdin:{resolveDir:frontend,loader:'tsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {CalendarAnalyticsPanel} from './src/report-app';import {CompanyMedallion} from './src/cashflow-calendar';import catalog from './src/company-logos.json';
 const e=(label,kind,amount,day,extra={})=>({label,kind,amount,day,group:kind==='bill'?'bills_utilities':kind==='income'?'income':'subscriptions_wants',projectedOnly:false,...extra});
 function Fixture(){const [month,setMonth]=React.useState(10),[year,setYear]=React.useState(2026),[revision,setRevision]=React.useState(0),[projected,setProjected]=React.useState(true),[showCatalog,setShowCatalog]=React.useState(false);window.calendarFixture={setMonth,setYear,setRevision,setProjected,setShowCatalog};
 const events=[e('YouTube Premium','subscription',18.75,31),e('Income','income',3800,31),e('Unknown vendor','subscription',9.99,31),e('PG&E','bill',80.99,31),e('Slate Digital All Access','subscription',14.99,31),e('MacroFactor','subscription',12.99,31),e('Water','bill',0,31,{amountUnknown:true}),e('Raycast','subscription',10,1),e('ChatGPT Pro','subscription',200,1)];
 const context=[{year:2026,month:11,available:true,events:[e('Rent','bill',1500,1,{projectedOnly:true,amountEstimated:true}),e('Recology','bill',68.14,6,{projectedOnly:true}),e('Aidvantage','bill',90,6,{projectedOnly:true}),e('Water','bill',0,5,{projectedOnly:true,amountUnknown:true})]}];
 return showCatalog ? <section className="fixture-catalog" style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(82px,1fr))',gap:16,padding:16}}>{catalog.map(item=><div key={item.id} data-company={item.id} style={{display:'grid',justifyItems:'center',gap:6,fontSize:11,textAlign:'center'}}><CompanyMedallion event={e(item.aliases[0],'subscription',10,1)}/>{item.name}</div>)}</section> : <div className="fixture-frame"><div className="fixture-title">Calendar<span>••━•</span></div><div className="fixture-stage"><CalendarAnalyticsPanel key={year+'-'+month} year={year} month={month} aliases={{water:'santa-rosa-water','student loan':'aidvantage'}} events={events} context={context} projected={projected} collapseKey={revision}/></div></div>}
 createRoot(document.getElementById('root')).render(<Fixture/>);
`},plugins:[{name:'calendar-test-exports',setup(build){build.onResolve({filter:/\?worker&url$/},args=>({path:args.path,namespace:'unused-worker'}));build.onLoad({filter:/.*/,namespace:'unused-worker'},()=>({contents:'export default "/unused-worker.js"',loader:'js'}));build.onLoad({filter:/\/report-app\.tsx$/},args=>({contents:fs.readFileSync(args.path,'utf8')+'\nexport {CalendarAnalyticsPanel};',loader:'tsx',resolveDir:path.dirname(args.path)}))}}],bundle:true,format:'iife',outfile:'calendar-fixture.js',write:false,define:{'process.env.NODE_ENV':'"production"'}}).then(result=>result.outputFiles.find(file=>file.path.endsWith('.js')).text)
;(async()=>{
 const bundle=await bundlePromise;let cases=0
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch({headless:true})
  try{for(const width of [320,390,1024])for(const dark of [false,true]){
   const page=await browser.newPage({viewport:{width,height:900}}),errors=[]
   page.on('pageerror',e=>errors.push(e.message))
   await page.route('**/*',route=>{
    const name=new URL(route.request().url()).pathname.split('/').pop(),item=catalog.find(x=>x.asset===name)
    return item?route.fulfill({body:fs.readFileSync(path.join(root,'src/bookiebot/reports/assets',name)),contentType:name.endsWith('.svg')?'image/svg+xml':name.endsWith('.png')?'image/png':name.endsWith('.jpg')?'image/jpeg':'image/x-icon'}):route.abort()
   })
   await page.setContent('<html data-theme="'+(dark?'dark':'light')+'"><head><base href="http://calendar.test/"><style>'+css+'</style><style>body{margin:0;background:hsl(var(--background));color:hsl(var(--foreground))}.fixture-frame{margin:0 auto;max-width:1080px;background:hsl(var(--card))}.fixture-title{display:flex;justify-content:space-between;font-size:28px;padding:16px 16px 0}.fixture-title span{color:hsl(var(--primary));font-size:20px}.fixture-stage{height:'+(width>600?660:540)+'px}</style></head><body><div id="root"></div></body></html>')
   await page.addScriptTag({content:`{const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-10-31T20:00:00Z']))}}}`})
   await page.addScriptTag({content:bundle})
   await page.waitForSelector('.bb-cf-grid')
   const geometry=()=>page.locator('.bb-cashflow-calendar').evaluate(panel=>{const grid=panel.querySelector('.bb-cf-grid'),legend=panel.querySelector('.bb-cf-legend');return {panel:panel.getBoundingClientRect().toJSON(),grid:grid.getBoundingClientRect().toJSON(),legend:legend.getBoundingClientRect().toJSON(),days:[...grid.children].map(x=>({rect:x.getBoundingClientRect().toJSON(),scroll:x.scrollHeight,height:x.clientHeight})),width:document.documentElement.scrollWidth,viewport:window.innerWidth}})
   const weeks=await geometry()
   assert.equal(await page.locator('.bb-cf-day').count(),14)
   assert.equal(await page.locator('.bb-cf-range').textContent(),'Oct 25 – Nov 7')
   assert.ok(weeks.width<=width,JSON.stringify(weeks))
   assert.ok(Math.abs(weeks.panel.bottom-weeks.legend.bottom-104)<2,'104px bottom room')
   assert.ok(weeks.days.every(d=>d.scroll<=d.height+1),'Logo stacks and totals fit day cells '+JSON.stringify(weeks))
   assert.ok(weeks.grid.bottom<weeks.legend.top)
   await page.locator('[data-date="2026-10-31"] .bb-cf-overflow').click()
   await page.locator('dialog[open]').waitFor();await page.waitForFunction(()=>document.querySelector('dialog')?.dataset.state==='open')
   assert.equal(await page.locator('.bb-cf-details li').count(),7)
   assert.ok((await page.locator('.bb-cf-details').textContent()).includes('$18.75'))
   assert.ok((await page.locator('.bb-cf-details').textContent()).includes('Not entered'))
   assert.equal(await page.locator('.bb-cf-details .lucide-dollar-sign').count(),1,'Income fallback uses a dollar sign in the shared day dialog')
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog')?.open)
   await page.getByRole('button',{name:'Show full month',exact:true}).click();await page.waitForTimeout(430)
   const full=await geometry()
   assert.equal(await page.locator('.bb-cf-range').textContent(),'Oct 1 – 31')
   assert.equal(await page.locator('.bb-cf-day').count(),35)
   assert.ok(Math.abs(full.grid.height-weeks.grid.height)<1,'Month and weeks occupy the same height')
   assert.equal(await page.locator('.bb-cf-icons').count(),0)
   assert.ok(await page.locator('.bb-cf-combined').count()>0)
   await page.locator('[data-date="2026-10-31"] .bb-cf-combined-hit').click();await page.locator('dialog[open]').waitFor()
   assert.equal(await page.locator('.bb-cf-details li').count(),7)
   await page.evaluate(()=>window.calendarFixture.setRevision(1));await page.waitForFunction(()=>!document.querySelector('dialog')?.open)
   await page.getByRole('button',{name:'Show this week and next week',exact:true}).click();await page.waitForTimeout(430)
   assert.equal(await page.locator('.bb-cf-day').count(),14)
   for(let i=0;i<4;i++){await page.locator('.bb-cf-view-toggle').click();await page.waitForTimeout(40)}
   await page.waitForTimeout(430)
   assert.equal(await page.locator('.bb-cashflow-calendar').getAttribute('data-mode'),'weeks')
   assert.ok(Math.abs((await geometry()).grid.height-weeks.grid.height)<1,'Rapid reversals retain stage geometry')
   // Failed logo downloads retain visible generic type icons.
   const failed=page.locator('.bb-cf-medallion:has(.bb-cf-logo)').first()
   await failed.locator('img').evaluate(img=>img.dispatchEvent(new Event('error')))
   await page.waitForFunction(()=>document.querySelector('.bb-cf-medallion[data-prepared-circle="true"][data-logo-ready="false"]:not(:has(img))'))
   assert.equal(await page.locator('.bb-cf-medallion[data-prepared-circle="true"][data-logo-ready="false"]:not(:has(img)) > .bb-cf-medallion-layer > .bb-cf-medallion-face > svg').evaluate(el=>getComputedStyle(el).visibility),'visible','Failed images keep the type fallback')
   assert.deepEqual(errors,[])
   await page.emulateMedia({reducedMotion:'reduce'})
   for(const [year,month,count] of [[2026,2,28],[2026,5,42],[2028,2,35]]){
    await page.evaluate(([y,m])=>{window.calendarFixture.setYear(y);window.calendarFixture.setMonth(m)},[year,month])
    await page.getByRole('button',{name:'Show full month',exact:true}).click()
    await page.waitForFunction(n=>document.querySelectorAll('.bb-cf-day').length===n,count)
    const g=await geometry();assert.ok(g.width<=width);assert.ok(g.days.every(d=>d.scroll<=d.height+1),'4/5/6 week month cells fit')
   }
   if(width===390){await page.evaluate(()=>{window.calendarFixture.setYear(2026);window.calendarFixture.setMonth(10)});await page.waitForTimeout(50);await page.locator('.fixture-frame').screenshot({path:'/private/tmp/bookiebot-calendar-'+engine.name()+'-'+(dark?'dark':'light')+'.png'})}
   // Exercise the actual medallion renderer with every approved file, not just
   // standalone review thumbnails. No universal inset/backplate may return.
   await page.evaluate(()=>window.calendarFixture.setShowCatalog(true))
   await page.locator('.fixture-catalog').waitFor()
   await page.locator('.fixture-catalog img').evaluateAll(images=>images.forEach(img=>img.loading='eager'))
   await page.waitForFunction(()=>document.querySelectorAll('.fixture-catalog [data-logo-ready="true"]').length===89)
   await page.waitForTimeout(200)
   const faces=await page.locator('.fixture-catalog .bb-cf-medallion').evaluateAll(items=>items.map(item=>{const face=item.querySelector('.bb-cf-medallion-face'),image=item.querySelector('img'),f=face.getBoundingClientRect(),i=image.getBoundingClientRect();return {prepared:item.dataset.preparedCircle,background:getComputedStyle(face).backgroundColor,mask:getComputedStyle(face).maskImage,width:i.width,height:i.height,faceWidth:f.width,offsetX:i.x-f.x,offsetY:i.y-f.y,naturalWidth:image.naturalWidth}}))
   const invalid=faces.filter(f=>f.prepared!=='true'||f.background!=='rgba(0, 0, 0, 0)'||f.naturalWidth!==256||Math.abs(f.width-f.faceWidth)>=.1||f.width!==f.height||Math.abs(f.offsetX)>=.1||Math.abs(f.offsetY)>=.1||f.mask==='none')
   assert.deepEqual(invalid,[],'Prepared circles fill the face and retain the transparent type-dot gap')
   assert.ok((await page.locator('.fixture-catalog').textContent()).includes('YouTube Premium'))
   if(width===390)await page.locator('.fixture-catalog').screenshot({path:'/private/tmp/bookiebot-approved-logos-'+engine.name()+'-'+(dark?'dark':'light')+'.png'})
   assert.deepEqual(errors,[])
   cases++;await page.close()
  }}finally{await browser.close()}
 }
 console.log(cases+' Chromium/WebKit mobile/desktop/theme cases passed: date boundaries, stable height, logo fallback, busy-day modal, escape, collapse and 4/5/6-week months')
})().catch(error=>{console.error(error);process.exitCode=1})
