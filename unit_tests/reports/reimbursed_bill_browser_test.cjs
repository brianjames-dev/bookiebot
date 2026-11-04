// Actual Transactions components and server-generated cash/gross snapshots.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright'))
const fixture=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_NET_BILL_FIXTURE||'/private/tmp/bookiebot-net-bill-fixture.json','utf8'))
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8')
const bundlePromise=req('esbuild').build({stdin:{resolveDir:frontend,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{TransactionsScreen}from'./src/transactions-screen';import{ChartTooltipDismissProvider}from'./src/components/ui/chart';import{recordedDays,recordedChart}from'./src/recorded-transaction-view';import{confirmedRows}from'./src/transaction-feedback';
 const sample=${JSON.stringify(fixture.settled)},row=sample.items[0];
 window.probe={fallbackDay:recordedDays(sample.items,[],'2026-11')[0].total,chart:recordedChart(sample.days,'2026-11')[0].amount,feedback:confirmedRows(sample.items,row.id,{operation:'update',after:{amount:'162.08'}})[0]};
 createRoot(document.getElementById('root')).render(<ChartTooltipDismissProvider revision={0}><TransactionsScreen active ownerName="Brian" initialMonth="2026-11"/></ChartTooltipDismissProvider>);
 `},outfile:'/private/tmp/net-bill-browser-fixture.js',bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'unused-worker',setup(build){build.onResolve({filter:/\?worker&url$/},()=>({path:'unused',namespace:'worker'}));build.onLoad({filter:/.*/,namespace:'worker'},()=>({contents:'export default "data:application/javascript,"',loader:'js'}))}}]}).then(result=>result.outputFiles.find(file=>file.path.endsWith('.js')).text)
;(async()=>{const bundle=await bundlePromise;let cases=0;for(const engine of[chromium,webkit]){const browser=await engine.launch();try{for(const dark of[false,true]){
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),errors=[],writes=[];let state='initial'
 page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url())
  if(url.origin!=='https://cash.test')return route.abort()
  if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:`<html data-theme="${dark?'dark':'light'}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;padding:18px}</style><div id="root"></div><script>${bundle}</script></html>`})
  if(request.method()!=='GET'){writes.push(request.url());return route.abort()}
  if(url.pathname==='/app/transactions')return route.fulfill({contentType:'application/json',body:JSON.stringify(fixture[state])})
  if(url.pathname.startsWith('/app/assets/')){const file=path.join(assets,path.basename(url.pathname));if(fs.existsSync(file))return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.png')?'image/png':'image/svg+xml'})}
  return route.abort()
 })
 await page.goto('https://cash.test/fixture')
 for(const [next,amount]of[['initial','152.08'],['partial','132.08'],['settled','80.00']]){
  state=next;if(next!=='initial')await page.evaluate(()=>window.dispatchEvent(new Event('bookiebot:reimbursements-changed')))
  await page.waitForFunction(expected=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false'&&document.querySelector('.bb-daily-transaction')?.textContent.includes('$'+expected),amount)
  assert((await page.locator('.bb-daily-summary').innerText()).replace(/\s+/g,'').includes('$'+amount),'Total Spent matches bill cash')
  assert.equal(await page.locator('.bb-recorded-swipe').count(),1)
 }
 const probe=await page.evaluate(()=>window.probe);assert.equal(probe.fallbackDay,80);assert.equal(probe.chart,80);assert.equal(probe.feedback.amountCents,16208);assert.equal(probe.feedback.displayAmountCents,9000)
 await page.getByRole('button',{name:'Show spending graph',exact:true}).click();await page.waitForTimeout(470)
 assert.equal(await page.locator('.bb-recorded-graph-reveal').getAttribute('aria-hidden'),'false')
 const row=page.locator('.bb-recorded-row-access');await row.press('ArrowLeft');await page.waitForTimeout(470)
 await page.getByRole('button',{name:/Update PG&E/}).click()
 assert.equal(await page.getByLabel('Amount', {exact:true}).inputValue(),'152.08','Editor retains original gross charge')
 assert.equal(await page.getByRole('button',{name:'Review change',exact:true}).isDisabled(),true,'Net display alone is not an edit')
 await page.getByRole('button',{name:'Cancel',exact:true}).click()
 await page.waitForTimeout(470);await row.press('ArrowRight');await page.waitForTimeout(470)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);assert.deepEqual(writes,[])
 await page.screenshot({path:`/private/tmp/net-bill-${engine.name()}-${dark?'dark':'light'}.png`,fullPage:true})
 state='zero';await page.evaluate(()=>window.dispatchEvent(new Event('bookiebot:reimbursements-changed')))
 await page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false'&&document.querySelector('.bb-daily-transaction')?.textContent.includes('$0.00'))
 assert((await page.locator('.bb-daily-summary').innerText()).replace(/\s+/g,'').includes('$0.00'));assert.equal(await page.locator('.bb-recorded-swipe').count(),1)
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);await page.close();cases++
 }}finally{await browser.close()}}console.log(JSON.stringify({cases,status:'passed',viewport:'390x844',financialWrites:0}))})().catch(e=>{console.error(e);process.exitCode=1})
