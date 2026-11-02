// Approved date-column motion against real React components and local artwork.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright'))
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8')
const bundle=req('esbuild').buildSync({stdin:{resolveDir:frontend,loader:'tsx',contents:`
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{DailyTransactionDays}from'./src/daily-transactions';
 const colors={Food:'hsl(var(--category-food))',Shopping:'hsl(var(--category-shopping))',Rent:'hsl(var(--category-rent))'};
 const entries=Array.from({length:7},(_,i)=>({date:'11/5/2026',category:i%2?'Shopping':'Food',amount:i+1,person:'Fixture',location:i%2?'Target':'Chipotle',item:'Purchase '+i,status:i===6?'scheduled':'recorded'}));
 const groups=[{day:'5',entries,today:false},{day:'1',entries:entries.slice(0,1),today:true},{day:'No date',entries:entries.slice(0,2),today:false}];
 function Fixture(){const[month,setMonth]=useState(11);return <div className="bb-daily-spending-content"><DailyTransactionDays groups={groups} year={2026} month={month} categoryColors={colors}/><button id="month" onClick={()=>setMonth(v=>v===11?12:11)}>Other month</button></div>};createRoot(document.getElementById('root')).render(<Fixture/>);
`},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text
async function settled(group){await group.page().waitForFunction(selector=>document.querySelector(selector)?.dataset.moving==='false',await group.getAttribute('data-test-selector'))}
;(async()=>{let cases=0
for(const engine of [chromium,webkit].filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch();try{for(const width of [320,390,1280].filter(w=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH)))for(const dark of [false,true]){
 const page=await browser.newPage({viewport:{width,height:900},colorScheme:dark?'dark':'light'}),errors=[],traffic=[];page.on('pageerror',e=>errors.push(e.message))
 await page.route('**/*',route=>{const url=new URL(route.request().url()),name=path.basename(url.pathname)
 if(url.origin!=='https://bookie.test'){traffic.push(url.href);return route.abort()}
 if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:`<html data-theme="${dark?'dark':'light'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#root{padding:18px;max-width:460px;margin:auto}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`})
 if(/^company-logo-[\w-]+\.(svg|png)$/.test(name)&&fs.existsSync(path.join(assets,name)))return route.fulfill({contentType:name.endsWith('.svg')?'image/svg+xml':'image/png',body:fs.readFileSync(path.join(assets,name))})
 traffic.push(url.href);return route.abort()})
 await page.goto('https://bookie.test/fixture');await page.locator('[data-motion-ready="true"]').first().waitFor();await page.evaluate(()=>document.fonts.ready)
 const today=page.locator('.bb-daily-day-header[aria-current="date"]');await today.focus();await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('[aria-current="date"]').getAttribute('aria-expanded')==='true');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('[aria-current="date"]').closest('section').dataset.moving==='false');
 const group=page.locator('.bb-daily-day-group').first(),button=group.locator('.bb-daily-day-header')
 await group.evaluate(el=>el.setAttribute('data-test-selector','.bb-daily-day-group:first-child'))
 assert.equal(await group.locator('.bb-daily-preview-item').count(),7);assert.equal(await group.locator('.bb-daily-bead').count(),6);assert.equal(await group.locator('.bb-daily-preview-more').textContent(),'+1')
 assert.equal(await page.locator('.bb-daily-day-header[aria-current="date"]').count(),1);assert.equal(await page.locator('.bb-daily-date-weekday').nth(1).textContent(),'Today')
 assert.equal(await group.locator('.bb-daily-day-count').evaluate(n=>getComputedStyle(n).opacity),'0');assert.equal(await group.locator('.bb-daily-transaction').count(),0)
 await page.waitForFunction(()=>[...document.querySelectorAll('.bb-daily-icon-layer img')].every(img=>img.complete&&img.naturalWidth))
 await group.evaluate(el=>{globalThis.__beads=[...el.querySelectorAll('.bb-daily-bead')];globalThis.__images=[...el.querySelectorAll('.bb-daily-bead img')]})
 const continuity=await group.evaluate(async el=>{
  el.querySelector('button').click();await Promise.resolve()
  const animations=el.getAnimations({subtree:true});for(const a of animations)a.pause();await Promise.all(animations.map(a=>a.ready.catch(()=>{})))
  const count=el.querySelector('.bb-daily-day-count'),timing=animations.find(a=>a.effect.target===count).effect.getTiming(),at=timing.delay+Number(timing.duration)/2
  for(const a of animations)a.currentTime=Math.min(at,a.effect.getComputedTiming().endTime)
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
  const read=()=>[...el.querySelectorAll('.bb-daily-bead')].map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,opacity:getComputedStyle(n).opacity}}),before=read(),countBefore=Number(getComputedStyle(count).opacity)
  el.querySelector('button').click();await Promise.resolve();const after=read();return{distances:before.map((p,i)=>Math.hypot(p.x-after[i].x,p.y-after[i].y)),countBefore,countAfter:Number(getComputedStyle(count).opacity)}
 })
 assert(continuity.distances.every(d=>d<1),JSON.stringify(continuity));assert(continuity.countBefore>0&&continuity.countBefore<1,JSON.stringify(continuity));assert(Math.abs(continuity.countBefore-continuity.countAfter)<.01)
 await settled(group);assert.equal(await group.locator('.bb-daily-day-count').evaluate(n=>getComputedStyle(n).opacity),'0')
 await button.click();await settled(group)
 const geometry=await group.evaluate(el=>{
 const rows=[...el.querySelectorAll('.bb-daily-transaction')],beads=[...el.querySelectorAll('.bb-daily-bead')],count=el.querySelector('.bb-daily-day-count'),total=el.querySelector('.bb-daily-day-total')
 return{hiddenBadges:beads.every(n=>{const dot=n.querySelector('.bb-daily-preview-dot');return !dot||getComputedStyle(dot).display==='none'||new DOMMatrix(getComputedStyle(dot).transform).a===0}),count:Number(getComputedStyle(count).opacity),fits:count.getBoundingClientRect().right<total.getBoundingClientRect().left,overflow:document.documentElement.scrollWidth>innerWidth,beads:beads.map((n,i)=>{const b=n.getBoundingClientRect(),a=rows[i].querySelector('.bb-daily-row-icon-anchor').getBoundingClientRect();return Math.hypot(b.x-a.x,b.y-a.y)}),oneImage:beads.every(n=>n.querySelectorAll('img').length===1),retained:__beads.every((n,i)=>n===beads[i])&&__images.every((n,i)=>n===el.querySelectorAll('.bb-daily-bead img')[i]),rows:rows.length,inert:el.querySelector('.bb-daily-day-panel').inert}
 })
 assert.equal(geometry.count,1);assert(geometry.fits&&!geometry.overflow&&geometry.retained&&geometry.oneImage&&geometry.hiddenBadges&&!geometry.inert,JSON.stringify(geometry));assert.equal(geometry.rows,7);assert(geometry.beads.every(d=>d<1),JSON.stringify(geometry))
 await button.click();await settled(group)
 const closed=await group.evaluate(el=>[...el.querySelectorAll('.bb-daily-bead')].map((n,i)=>({opacity:Number(getComputedStyle(n).opacity),z:Number(getComputedStyle(n).zIndex),y:n.getBoundingClientRect().y,anchor:el.querySelectorAll('.bb-daily-preview-item')[Math.min(i,6)].getBoundingClientRect().y})))
 assert(closed.slice(0,6).every((n,i)=>n.opacity===1&&Math.abs(n.y-n.anchor)<1&&(i===0||n.z<closed[i-1].z)));assert.equal(closed[6].opacity,0)
 for(const delay of [40,80,50,100]){await button.click();await page.waitForTimeout(delay)}await settled(group)
 await button.click();await page.waitForTimeout(80);await page.setViewportSize({width:width===320?390:320,height:900});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await settled(group)
 await page.emulateMedia({reducedMotion:'reduce'});await button.click();assert.equal(await button.getAttribute('aria-expanded'),'false');assert.equal(await group.getAttribute('data-moving'),'false');await button.click();assert.equal(await group.locator('.bb-daily-day-count').evaluate(n=>getComputedStyle(n).opacity),'1',JSON.stringify(await group.evaluate(el=>({moving:el.dataset.moving,open:el.querySelector('button').getAttribute('aria-expanded'),opacity:el.querySelector('.bb-daily-day-count').style.opacity,animations:el.getAnimations({subtree:true}).length,reduce:matchMedia('(prefers-reduced-motion: reduce)').matches}))))
 await page.locator('#month').click();await page.waitForFunction(()=>document.querySelectorAll('.bb-daily-transaction').length===0);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 const cleanup=await page.evaluate(()=>({connected:__beads.map(n=>n.isConnected),animations:document.getAnimations().map(a=>({target:a.effect.target.className,type:a.constructor.name})),previews:[...document.querySelectorAll('.bb-daily-day-group')].map(el=>({ready:el.dataset.motionReady,opacity:getComputedStyle(el.querySelector('.bb-daily-bead')).opacity,visibility:getComputedStyle(el.querySelector('.bb-daily-bead')).visibility}))}))
 assert(cleanup.connected.every(value=>!value)&&cleanup.animations.length===0&&cleanup.previews.every(p=>p.ready==='true'&&p.opacity==='1'&&p.visibility==='visible'),JSON.stringify(cleanup));assert.deepEqual(errors,[]);assert.deepEqual(traffic,[])
 if(width===390&&dark)await page.screenshot({path:`/private/tmp/daily-date-column-${engine.name()}.png`})
 console.log(JSON.stringify({engine:engine.name(),width,dark,passed:true,maximumReversalJump:Math.max(...continuity.distances)}));cases++;await page.close()
 }}finally{await browser.close()}}
 console.log(`${cases} date-column cases passed`)
})().catch(error=>{console.error(error);process.exit(1)})
