// Actual server snapshots and production Calendar/Transactions, with no writers.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright'))
const fixture=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_QUEUED_BILL_FIXTURE||'/private/tmp/bookiebot-queued-bill-fixture.json','utf8'))
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8')
const bundlePromise=req('esbuild').build({stdin:{resolveDir:frontend,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{TransactionsScreen}from'./src/transactions-screen';import{CashflowCalendar}from'./src/cashflow-calendar';import{ChartTooltipDismissProvider}from'./src/components/ui/chart';
 const fixture=${JSON.stringify(fixture)};
 function Fixture(){const[paid,setPaid]=React.useState(false),report=paid?fixture.paidReport:fixture.queuedReport;window.advanceWithdrawal=()=>setPaid(true);return <ChartTooltipDismissProvider revision={Number(paid)}><p data-current>{report.modeViews.current.metrics.totalExpenses}</p><p data-projected>{report.modeViews.projected.metrics.totalExpenses}</p><TransactionsScreen key={String(paid)} active ownerName="Brian" initialMonth="2026-11"/><div style={{height:530}}><CashflowCalendar year={2026} month={11} events={report.calendarEvents.filter(e=>e.kind==='bill')} projected={false} onInspect={()=>{}}/></div></ChartTooltipDismissProvider>}
 createRoot(document.getElementById('root')).render(<Fixture/>);
 `},outfile:'/private/tmp/queued-bill-browser-fixture.js',bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'unused-worker',setup(build){build.onResolve({filter:/\?worker&url$/},()=>({path:'unused',namespace:'worker'}));build.onLoad({filter:/.*/,namespace:'worker'},()=>({contents:'export default "data:application/javascript,"',loader:'js'}))}}]}).then(result=>result.outputFiles.find(file=>file.path.endsWith('.js')).text)
;(async()=>{const bundle=await bundlePromise;let cases=0;for(const engine of[chromium,webkit]){const browser=await engine.launch();try{for(const dark of[false,true]){
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),errors=[],writes=[];let paid=false
 page.on('pageerror',e=>errors.push(e.message))
 await page.addInitScript(()=>{const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[window.paidClock?'2026-11-15T20:00:00Z':'2026-11-14T20:00:00Z']))}}})
 await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url())
  if(url.origin!=='https://queued.test')return route.abort()
  if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:`<html data-theme="${dark?'dark':'light'}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;padding:18px}#root{max-width:720px;margin:auto}</style><div id="root"></div><script>${bundle}</script></html>`})
  if(request.method()!=='GET'){writes.push(request.url());return route.abort()}
  if(url.pathname==='/app/transactions')return route.fulfill({contentType:'application/json',body:JSON.stringify(fixture[paid?'paid':'queued'])})
  if(url.pathname.startsWith('/app/assets/')){const file=path.join(assets,path.basename(url.pathname));if(fs.existsSync(file))return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.png')?'image/png':'image/svg+xml'})}
  return route.abort()
 })
 await page.goto('https://queued.test/fixture');await page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false')
 assert.equal(await page.locator('[data-current]').textContent(),'0');assert.equal(await page.locator('[data-projected]').textContent(),'152.08')
 assert.equal(await page.locator('.bb-recorded-swipe').count(),0)
 assert.equal(await page.getByRole('button',{name:/PG&E · Bill · \$152.08 · Scheduled/}).count(),1)
 paid=true;await page.evaluate(()=>{window.paidClock=true;window.advanceWithdrawal()});await page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.bb-recorded-swipe').length===1)
 assert.equal(await page.locator('[data-current]').textContent(),'152.08');assert.equal(await page.locator('[data-projected]').textContent(),'152.08')
 assert.equal(await page.locator('.bb-daily-transaction-name').textContent(),'PG&E')
 assert.equal(await page.locator('.bb-daily-single-day .bb-daily-day').textContent(),'15')
 assert.equal(await page.getByRole('button',{name:/PG&E · Bill · \$152.08 · Recorded/}).count(),1)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.deepEqual(writes,[])
 await page.screenshot({path:`/private/tmp/queued-bill-${engine.name()}-${dark?'dark':'light'}.png`,fullPage:true});await page.close();cases++
 }}finally{await browser.close()}}console.log(JSON.stringify({cases,status:'passed',viewport:'390x844',financialWrites:0}))})().catch(e=>{console.error(e);process.exitCode=1})
