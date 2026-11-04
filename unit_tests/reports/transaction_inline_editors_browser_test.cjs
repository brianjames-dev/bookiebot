// Actual workspace, native graph/day motion and canonical action identities.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright'))
const fixture=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_TRANSACTION_WORKSPACE_FIXTURES||'/private/tmp/bookiebot-transactions-workspace.json','utf8'))
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8')
const bundlePromise=req('esbuild').build({stdin:{resolveDir:frontend,loader:'tsx',contents:`import React from 'react';import{createRoot}from'react-dom/client';import{TransactionsScreen}from'./src/transactions-screen';import{ChartTooltipDismissProvider}from'./src/components/ui/chart';createRoot(document.getElementById('root')).render(<ChartTooltipDismissProvider revision={0}><TransactionsScreen active ownerName="Brian" initialMonth="${fixture.month}"/></ChartTooltipDismissProvider>);`},outfile:'/private/tmp/bookiebot-transactions-fixture.js',bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'unused-overview-worker',setup(build){build.onResolve({filter:/\?worker&url$/},()=>({path:'unused-worker',namespace:'fixture-worker'}));build.onLoad({filter:/.*/,namespace:'fixture-worker'},()=>({contents:'export default "data:application/javascript,"',loader:'js'}))}}]})
const money=c=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(c/100)
;(async()=>{
 const bundle=(await bundlePromise).outputFiles.find(file=>file.path.endsWith('.js')).text,cases=[]
 for(const engine of[chromium,webkit]){
  const browser=await engine.launch()
  try{for(const [width,dark,reduced]of[[320,true,false],[390,true,false],[390,false,true],[1024,false,false]]){
   const page=await browser.newPage({viewport:{width,height:1000},hasTouch:true,isMobile:width<700,colorScheme:dark?'dark':'light',reducedMotion:reduced?'reduce':'no-preference'}),errors=[],commands=[],reviews=[]
   let sources=fixture.sources.slice(0,5).map(row=>({...row,split:'',splitOptions:{...row.splitOptions,custom:true,payerCents:undefined}})),undoSnapshot=null
   const listing=()=>{
    const days=[];for(const row of sources){let day=days.find(day=>day.date===row.date);if(!day){day={date:row.date,month:row.month,count:0,totalCents:0,needsCents:0,wantsCents:0};days.push(day)}day.count++;day.totalCents+=row.amountCents;if(['grocery','gas','need_expenses'].includes(row.category))day.needsCents+=row.amountCents;else day.wantsCents+=row.amountCents}
    return {items:sources,total:sources.length,nextOffset:null,days,totalAmountCents:sources.reduce((sum,row)=>sum+row.amountCents,0),categories:['food','grocery','gas','shopping','need_expenses'],persons:['Brian (BofA)','Brian (AL)','Hannah'],month:fixture.month,snapshotVersion:'fixture-'+commands.length}
   }
   const checked=body=>{
    const row=body.operation==='undo'?undoSnapshot?.row:sources.find(row=>row.id===body.id);assert(row)
    const share=body.operation==='split'?{method:body.method,payerCents:body.method==='custom'?body.payerShareCents:body.method==='fronted'?0:body.method==='equal'?Math.round(row.amountCents/2):row.splitOptions.incomePayerCents}:undefined
    if(share)Object.assign(share,{partnerCents:row.amountCents-share.payerCents,payerName:'Brian',partnerName:'Hannah'})
    return {item:row,operation:body.operation,destination:body.destination,reviewVersion:'isolated-review-'+row.version,after:{...row.fields,...body.updates,...(body.updates?.amount?{amount:(body.updates.amount/100).toFixed(2)}:{})},share}
   }
   page.on('pageerror',error=>errors.push(error.message))
   await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),reply=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)})
    if(url.origin!=='https://transactions.test')return route.abort()
    if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:`<html data-theme="${dark?'dark':'light'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0;padding:18px}#root{max-width:900px;margin:auto}</style><div id="root"></div><script>${bundle}</script></html>`})
    if(url.pathname.startsWith('/app/assets/')){const file=path.join(assets,path.basename(url.pathname));if(fs.existsSync(file))return route.fulfill({contentType:file.endsWith('.png')?'image/png':'image/svg+xml',body:fs.readFileSync(file)})}
    if(url.pathname==='/app/transactions/review'){const body=request.postDataJSON();reviews.push(body);return reply({review:checked(body)})}
    if(url.pathname==='/app/transactions'&&request.method()==='GET')return reply(listing())
    if(url.pathname==='/app/transactions'&&request.method()==='POST'){
     const body=request.postDataJSON(),review=checked(body);assert.equal(body.reviewVersion,review.reviewVersion);assert(body.requestId);commands.push(body)
     const row=review.item,summary={...review,title:row.title,date:row.date,category:row.categoryLabel,location:row.location,person:row.person,amountCents:row.amountCents,before:row.fields}
     if(body.operation==='undo')sources=undoSnapshot.sources
     else{
      undoSnapshot={row,sources:structuredClone(sources)}
      if(body.operation==='delete')sources=sources.filter(item=>item.id!==row.id)
      else sources=sources.map(item=>item.id===row.id?{...item,version:item.version+'-saved',fields:review.after,category:body.destination??item.category,categoryLabel:body.destination??item.categoryLabel,amountCents:body.updates?.amount??item.amountCents,split:body.operation==='split'?body.method:item.split,splitOptions:{...item.splitOptions,...(review.share?{payerCents:review.share.payerCents}:{})}}:item)
     }
     return reply({state:'done',success:true,summary,...(body.operation!=='undo'?{undo:{id:'fixture-undo',month:row.month}}:{})})
    }
    throw Error('Unexpected isolated request '+url)
   })
   await page.goto('https://transactions.test/fixture')
   const screen=page.getByRole('region',{name:'Recorded transactions',exact:true}),ready=()=>page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false'),group=screen.locator('.bb-daily-day-group').first()
   await screen.locator('.bb-chart-total').waitFor();await ready();await group.locator('.bb-daily-day-header').click();await page.waitForFunction(()=>document.querySelector('.bb-daily-day-group').dataset.moving==='false')
   const open=async(merchant,action)=>{const access=group.getByRole('button',{name:'Show actions for '+merchant,exact:true});await access.press('ArrowLeft');await group.getByRole('button',{name:action+' '+merchant,exact:true}).click();await group.locator('.bi-expansion[data-open="true"]').waitFor();await page.waitForTimeout(reduced?20:400)}
   await open('Starbucks Coffee Company','Update')
   const editor=group.getByRole('region',{name:'Edit transaction',exact:true})
   assert.equal(await editor.getByRole('button',{name:'Review change',exact:true}).isDisabled(),true)
   const geo=await editor.getByRole('textbox',{name:'Amount',exact:true}).evaluate(el=>({height:el.getBoundingClientRect().height,font:getComputedStyle(el).fontSize}));assert.equal(geo.font,'16px');assert(geo.height<=32.1)
   await editor.getByRole('textbox',{name:'Amount',exact:true}).fill('12.75');await editor.getByRole('combobox',{name:'Update category',exact:true}).selectOption('shopping')
   await editor.getByRole('button',{name:'Review change',exact:true}).click();await editor.getByRole('button',{name:'Confirm update',exact:true}).waitFor()
   assert.equal(commands.length,0);assert.equal(reviews.at(-1).operation,'move');assert.equal(reviews.at(-1).updates.amount,1275)
   assert.equal(await editor.getByRole('heading').count(),0);assert.equal(await editor.locator('del').count(),2)
   const duration=await editor.locator('.bi-step-viewport').evaluate(el=>el.getAnimations().map(animation=>animation.effect.getTiming().duration));if(!reduced)assert(duration.includes(440))
   await editor.getByRole('button',{name:'Confirm update',exact:true}).click()
   const popup=screen.getByRole('dialog');await popup.waitFor({timeout:15000});assert.equal(commands.length,1)
   assert.equal(await group.locator('.bi-expansion[data-open="true"]').count(),0);assert.equal(await screen.locator('.bb-transaction-completion').count(),0)
   assert((await group.locator('.bb-daily-day-total').first().innerText()).includes('$142.00'))
   assert.equal(await popup.getByRole('button',{name:'Undo',exact:true}).count(),1);await popup.getByRole('button',{name:'Undo',exact:true}).click();await ready();await popup.waitFor({state:'detached'})
   await page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false');assert.equal(commands.at(-1).operation,'undo');assert.equal(reviews.at(-1).operation,'undo')
   await open('Whole Foods','Split')
   const splitEditor=group.getByRole('region',{name:'Edit transaction',exact:true}),income=splitEditor.getByRole('button',{name:'Split by income',exact:true}),slider=splitEditor.getByRole('slider')
   assert.equal(await income.locator('svg.lucide-chart-pie').count(),1);assert.equal(await income.isDisabled(),true)
   const incomeValue=Number(await slider.inputValue());await slider.press('ArrowRight');const stepped=Number(await slider.inputValue());assert(stepped>incomeValue);assert.equal(stepped%25,0);assert.equal(await income.isEnabled(),true)
   await income.click();assert.equal(Number(await slider.inputValue()),incomeValue);assert.equal(await income.isDisabled(),true)
   await splitEditor.getByRole('textbox',{name:"Hannah's share amount",exact:true}).fill('3.08');assert.equal(await splitEditor.getByRole('textbox',{name:"Brian's share amount",exact:true}).inputValue(),'65.34')
   await splitEditor.getByRole('button',{name:'Review split',exact:true}).click();await splitEditor.getByRole('button',{name:'Confirm split',exact:true}).waitFor();assert.equal(reviews.at(-1).payerShareCents,6534)
   await splitEditor.getByRole('button',{name:'Back',exact:true}).click();assert.equal(await slider.inputValue(),'6534')
   // Closing a parent clears its draft and review; reopening cannot revive them.
   await group.locator('.bb-daily-day-header').click();await page.waitForTimeout(reduced?20:700);await group.locator('.bb-daily-day-header').click();await page.waitForTimeout(reduced?20:700);assert.equal(await group.locator('.bi-expansion[data-open="true"]').count(),0)
   await open('Starbucks Coffee Company','Delete');await editor.getByRole('button',{name:'Review deletion',exact:true}).click();await editor.getByRole('button',{name:'Confirm delete',exact:true}).waitFor();await editor.getByRole('button',{name:'Back',exact:true}).click();await editor.getByRole('button',{name:'Cancel',exact:true}).click()
   assert.equal(commands.length,2,'Reviewing and cancelling Split/Delete never sends a financial command')
   assert.equal(await screen.evaluate(el=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[])
   if(width===390&&!reduced){
    await open('Whole Foods','Split')
    const active=group.getByRole('region',{name:'Edit transaction',exact:true}),access=group.getByRole('button',{name:'Show actions for Whole Foods',exact:true})
    await access.press('ArrowLeft');await page.waitForTimeout(450);await access.press('ArrowRight');await page.waitForTimeout(450)
    assert.equal(await group.locator('.bb-daily-bead[data-entry="2"]').evaluate(el=>getComputedStyle(el).opacity),'1','Swiping a row with an open editor cannot blink its persistent logo')
    await active.scrollIntoViewIfNeeded();await active.screenshot({path:'/private/tmp/inline-editors-'+engine.name()+'-split.png'})
    await active.getByRole('textbox',{name:"Brian's share amount",exact:true}).fill('50.00');await active.getByRole('button',{name:'Review split',exact:true}).click();await active.getByRole('button',{name:'Confirm split',exact:true}).click();await popup.waitFor({timeout:15000})
    assert.equal(commands.at(-1).method,'custom');assert.equal(commands.at(-1).payerShareCents,5000)
    const remaining=await popup.getAttribute('data-expires-at');assert(Number(remaining)-Date.now()<=8000)
    await popup.waitFor({state:'detached',timeout:10000});assert.equal(await screen.getByRole('button',{name:'Undo',exact:true}).count(),0);assert.equal(await screen.locator('.bb-recorded-undo').count(),0)
   }
   cases.push({engine:engine.name(),width,dark,reduced,passed:true});console.log(JSON.stringify(cases.at(-1)));await page.close()
  }}finally{await browser.close()}
 }
 console.log(JSON.stringify({cases:cases.length,passed:true,checks:['actual inline row context','compact fields and cohesive server review','confirmed value and category placement feedback','no persistent receipt','timed explicit Undo with fresh server review','pie income shortcut and exact cents','quarter steps and manual cents','parent collapse discards nested editor','no financial commands on cancel','reduced motion, both themes, mobile/desktop']}))
})().catch(error=>{console.error(error);process.exitCode=1})
