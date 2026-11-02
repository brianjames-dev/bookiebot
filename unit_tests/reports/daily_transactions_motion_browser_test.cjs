// Real Daily Spending day/disclosure components, isolated synthetic expenses.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const css=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.css'),'utf8'),measureOnly=process.argv.includes('--measure-only')
const bundle=req('esbuild').buildSync({stdin:{resolveDir:frontend,loader:'tsx',contents:`
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';
 import{DailyTransactionDays}from'./src/daily-transactions';import{CollapsibleContent}from'./src/components/ui/motion';
 const colors={Food:'hsl(var(--category-food))',Shopping:'hsl(var(--category-shopping))'};
 const entries=Array.from({length:120},(_,i)=>({date:'11/5/2026',category:i%2?'Shopping':'Food',amount:i+1,person:'Fixture',location:i%3?'Corner café':'Target',item:'Purchase '+i,status:'recorded'}));
 function Fixture(){const[open,setOpen]=useState(false);return <div className="bb-daily-spending-content"><button id="outer-toggle" onClick={()=>setOpen(v=>!v)}>Transactions</button><CollapsibleContent open={open} lazy id="outer"><div className="bb-daily-transactions"><DailyTransactionDays groups={[{day:'5',entries,today:false},{day:'4',entries:entries.slice(0,6),today:false}]} year={2026} month={11} categoryColors={colors}/></div></CollapsibleContent><div id="following">Following content</div></div>};createRoot(document.getElementById('root')).render(<Fixture/>);
`},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text
async function record(page,selector,action,delay=0){return page.evaluate(async({selector,action,delay})=>{
 const frames=[],start=performance.now(),target=document.querySelector(selector);let done=false
 const tick=t=>{frames.push({t:t-start,h:target.getBoundingClientRect().height,y:scrollY});if(t-start<850)requestAnimationFrame(tick);else done=true};requestAnimationFrame(tick)
 if(delay)await new Promise(r=>setTimeout(r,delay));document.querySelector(action).click();while(!done)await new Promise(r=>setTimeout(r,10));return frames
},{selector,action,delay})}
;(async()=>{for(const engine of[chromium,webkit]){const browser=await engine.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'no-preference'}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',route=>route.abort());await page.setContent(`<html data-theme="dark"><head><style>${css}</style><style>body{margin:0}#root{padding:16px}#following{height:900px}</style></head><body><div id="root"></div></body></html>`);await page.addScriptTag({content:bundle});await page.locator('#outer-toggle').waitFor()
 const first=await record(page,'#outer','#outer-toggle',30);const daySelector='.bb-daily-day-group:first-child > .bb-details-content',button='.bb-daily-day-header'
 // Separate recordings must start from rest, even if a loaded browser takes
 // longer to mount a large day than the fixed frame-sampling window.
 const settled=()=>page.waitForFunction(()=>document.querySelector('.bb-daily-day-group:first-child').dataset.moving==='false')
 const opening=await record(page,daySelector,button,30);await settled()
 const closing=await record(page,daySelector,button,30);await settled()
 const reopening=await record(page,daySelector,button,30);await settled()
 const rapid=await page.evaluate(async()=>{
  const button=document.querySelector('.bb-daily-day-header'),target=document.querySelector('.bb-daily-day-group:first-child > .bb-details-content'),rows=[...target.querySelectorAll('.bb-daily-transaction')],samples=[]
  for(let i=0;i<4;i++){await new Promise(r=>setTimeout(r,60));const before=target.getBoundingClientRect().height;button.click();await new Promise(requestAnimationFrame);samples.push({before,after:target.getBoundingClientRect().height})}
  await new Promise(r=>setTimeout(r,850));return{samples,retained:rows.every((row,index)=>row===target.querySelectorAll('.bb-daily-transaction')[index]),inert:target.inert,rows:target.querySelectorAll('.bb-daily-transaction').length}
 })
 const summary=frames=>{const end=frames.at(-1).h,start=frames[0].h,span=Math.abs(end-start),steps=frames.slice(1).map((v,i)=>Math.abs(v.h-frames[i].h));return{start,end,intermediate:frames.filter(f=>f.h>Math.min(start,end)+1&&f.h<Math.max(start,end)-1).length,maxStepFraction:Math.max(...steps)/span,gapsOver40:frames.slice(1).filter((v,i)=>v.t-frames[i].t>40).length,scroll:[frames[0].y,frames.at(-1).y]}}
 console.log(engine.name(),JSON.stringify({first:summary(first),opening:summary(opening),closing:summary(closing),reopening:summary(reopening)}))
 fs.writeFileSync(`/private/tmp/daily-motion-${engine.name()}.json`,JSON.stringify({first,opening,closing,reopening}))
 if(!measureOnly){
  for(const frames of[first,opening,closing,reopening]){assert.ok(summary(frames).intermediate>=3,'Disclosure must interpolate instead of popping');assert.ok(summary(frames).maxStepFraction<.5,'No single-frame jump through half the panel');for(let i=1;i<frames.length;i++){const delta=frames[i].h-frames[i-1].h;assert.ok(frames.at(-1).h>frames[0].h?delta>=-1:delta<=1,'Opening and closing must move monotonically')}}
  assert.equal(rapid.retained,true,'Rapid reversals preserve the same row/image DOM');assert.equal(rapid.rows,120);assert.equal(rapid.inert,false);for(const sample of rapid.samples)assert.ok(Math.abs(sample.after-sample.before)<opening.at(-1).h*.4,'A reversal continues from its current height');assert.deepEqual(errors,[])
 }
 await page.close()
 }finally{await browser.close()}}})().catch(error=>{console.error(error);process.exit(1)})
