// Pixel regressions for the opening handoff, moving edges and last collapse frame.
// The lagging-cutout case emulates separate shape/transform clocks: freeze old
// SVG geometry and delay large CSS cutouts. This is not physical iOS reproduction.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),{execFileSync}=require('node:child_process')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||req.resolve('playwright'))
const assets=path.join(root,'src/bookiebot/reports/assets'),css=fs.readFileSync(path.join(assets,'expense-report-app.css'),'utf8')
const bundle=req('esbuild').buildSync({stdin:{resolveDir:frontend,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{DailyTransactionDays}from'./src/daily-transactions';
 const entries=Array.from({length:5},(_,i)=>({date:'10/25/2026',category:i===4?'Other needs':'Food',amount:20+i,person:'Fixture',location:i===1?'Netflix':i===4?'Amazon':'Unknown café '+i,item:'Meal',status:'recorded'}));
 createRoot(document.getElementById('root')).render(<div className="bb-daily-spending-content"><DailyTransactionDays groups={[{day:'25',entries,today:false}]} year={2026} month={10} categoryColors={{Food:'hsl(var(--category-food))','Other needs':'hsl(var(--category-need))'}}/></div>);
`},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'}}).outputFiles[0].text
async function seek(page,time){await page.evaluate(async time=>{const animations=document.querySelector('.bb-daily-day-group').getAnimations({subtree:true});for(const a of animations)a.pause();await Promise.all(animations.map(a=>a.ready.catch(()=>{})));for(const a of animations)a.currentTime=Math.min(time,a.effect.getComputedTiming().endTime);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))},time)}
async function resume(page){await page.evaluate(()=>{for(const a of document.querySelector('.bb-daily-day-group').getAnimations({subtree:true}))if(a.currentTime<a.effect.getComputedTiming().endTime)a.play()});await page.waitForFunction(()=>document.querySelector('.bb-daily-day-group').dataset.moving==='false')}
async function startExpansion(page,header){
 const beforeWillChange=await page.locator('.bb-daily-bead').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).willChange))
 await header.click()
 const handoff=await page.locator('.bb-daily-bead').evaluateAll(nodes=>({willChange:nodes.map(n=>getComputedStyle(n).willChange),redundantOpacity:nodes.flatMap(n=>n.getAnimations().filter(a=>{const frames=a.effect.getKeyframes();return frames.some(f=>'opacity' in f)&&frames.every(f=>Number(f.opacity)===1)})).length}))
 assert.equal(handoff.redundantOpacity,0,'Opaque preview icons must not acquire an opacity effect when motion starts')
 assert.deepEqual(handoff.willChange,beforeWillChange,'Starting motion must not change icon layer hints')
}
async function inspectEdges(page,file){
 const gaps=await page.locator('.bb-daily-day-group').evaluate(el=>{
  const beads=[...el.querySelectorAll('.bb-daily-bead')];let checked=0,centerError=0,paintError=0,shapeAnimations=0
  for(const bead of beads){const own=bead.getBoundingClientRect(),body=bead.querySelector('.bb-daily-bead-body').getBoundingClientRect();paintError=Math.max(paintError,Math.hypot(own.x-body.x,own.y-body.y))
   for(const clip of bead.querySelectorAll('[data-cutout$="-circle"]')){const prior=beads[Number(clip.dataset.cutout.split('-')[0])].getBoundingClientRect(),hole=clip.getBoundingClientRect();shapeAnimations+=clip.getAnimations().filter(a=>a.effect.getKeyframes().some(f=>'clipPath' in f)).length
    if(Math.hypot(prior.x-own.x,prior.y-own.y)<30){centerError=Math.max(centerError,Math.hypot(prior.x-hole.x,prior.y-hole.y));checked++}
   }
  }
  return{checked,centerError,paintError,shapeAnimations,clips:el.querySelectorAll('[data-cutout$="-circle"]').length}
 })
 assert(gaps.clips>0);assert.equal(gaps.shapeAnimations,0,'Large gaps must remain fixed-size shapes')
 assert(gaps.centerError<.15,'An overlapping gap must follow the upper circle: '+JSON.stringify(gaps))
 assert(gaps.paintError<.15,'Gap movement must not move the lower icon paint: '+JSON.stringify(gaps))
 const points=await page.locator('.bb-daily-bead').evaluateAll(nodes=>nodes.flatMap((n,index)=>{
  const r=n.getBoundingClientRect(),reference=document.querySelectorAll('[data-reference]')[index].getBoundingClientRect()
  return [[3,14],[14,3],[25,14],[14,25],[7,7],[21,7],[7,21],[21,21],[14,14]].map(([x,y])=>{
   const p={x:r.left+x,y:r.top+y}
   const clear=nodes.slice(0,index).every(prior=>{const b=prior.getBoundingClientRect(),dot=prior.querySelector('.bb-daily-preview-dot');if(Math.hypot(p.x-b.left-b.width/2,p.y-b.top-b.height/2)<=b.width/2+2.8)return false;if(dot&&getComputedStyle(dot).display!=='none'){const d=dot.getBoundingClientRect();if(d.width&&Math.hypot(p.x-d.left-d.width/2,p.y-d.top-d.height/2)<=d.width/2+2.8)return false}return true})
   return{...p,clear,reference:{x:reference.left+x,y:reference.top+y}}
  })
 }))
 await page.screenshot({path:file})
 return JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`from PIL import Image
import json,sys
im=Image.open(sys.argv[1]).convert('RGB');points=json.loads(sys.argv[2]);checked=0
for p in points:
 if not p['clear']: continue
 def color(v): return im.getpixel((round(v['x']*3),round(v['y']*3)))
 actual,expected=color(p),color(p['reference'])
 # Compare flat reference pixels; glyph-edge antialiasing varies with subpixels.
 rx,ry=round(p['reference']['x']*3),round(p['reference']['y']*3)
 if any(max(abs(a-b) for a,b in zip(im.getpixel((rx+dx,ry+dy)),expected))>2 for dx in [-2,0,2] for dy in [-2,0,2]): continue
 assert max(abs(a-b) for a,b in zip(actual,expected))<=8, {'actual':actual,'expected':expected,'point':p}
 checked+=1
assert checked>0
print(json.dumps({'checked':checked}))`,file,JSON.stringify(points)],{encoding:'utf8'}))
}
;(async()=>{let cases=0;for(const engine of[chromium,webkit].filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch();try{for(const dark of[false,true])for(const lagged of[false,true]){
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3,colorScheme:dark?'dark':'light'}),errors=[];page.on('pageerror',e=>errors.push(e.message))
 if(lagged)await page.addInitScript(()=>{const native=Element.prototype.animate;Element.prototype.animate=function(frames,options){if(this instanceof SVGElement&&Array.isArray(frames)&&frames.some(frame=>'cx' in frame||'cy' in frame||'r' in frame))return native.call(this,frames.map(({offset})=>({offset})),options);if(this.matches('.bb-daily-clip')&&Array.isArray(frames)&&frames.some(frame=>typeof frame.clipPath==='string'&&/A16(?:\.0+)? 16/.test(frame.clipPath)))return native.call(this,frames,{...options,delay:(options?.delay||0)+32});return native.call(this,frames,options)}})
 await page.route('**/*',route=>{const url=new URL(route.request().url()),name=path.basename(url.pathname)
  if(url.origin!=='https://bookie.test')return route.abort()
  if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:`<html data-theme="${dark?'dark':'light'}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#root{padding:18px}.glass{position:fixed;right:8px;top:0;width:80px;height:30px;backdrop-filter:blur(16px);background:#ffffff18}</style><div class="glass"></div><div id="root"></div><script>${bundle}</script></html>`})
  if(/^company-logo-[\w-]+\.(svg|png)$/.test(name)&&fs.existsSync(path.join(assets,name)))return route.fulfill({contentType:name.endsWith('.svg')?'image/svg+xml':'image/png',body:fs.readFileSync(path.join(assets,name))})
  return route.abort()
 })
 await page.goto('https://bookie.test/fixture');await page.locator('[data-motion-ready=true]').waitFor();await page.evaluate(()=>document.fonts.ready)
 await page.waitForFunction(()=>[...document.querySelectorAll('.bb-daily-bead img')].every(img=>img.complete&&img.naturalWidth))
 // Unclipped copies are pixel references, not part of the production component.
 await page.locator('.bb-daily-bead').evaluateAll(nodes=>nodes.forEach((n,index)=>{const ref=n.querySelector('.bb-transaction-icon').cloneNode(true);ref.dataset.reference='true';Object.assign(ref.style,{position:'fixed',left:`${18+index*38}px`,top:'760px'});document.body.append(ref)}))
 const header=page.locator('.bb-daily-day-header'),prefix=`/private/tmp/daily-icon-edges-${engine.name()}-${dark}-${lagged}`
 await startExpansion(page,header);let samples=0
 for(const time of[0,8,16,32,48,64,96,128,192,250,400,520]){await seek(page,time);samples+=(await inspectEdges(page,`${prefix}-open-${time}.png`)).checked}
 await resume(page);await header.click()
 for(const time of[80,160]){await seek(page,time);samples+=(await inspectEdges(page,`${prefix}-close-${time}.png`)).checked}
 await seek(page,643.99);await header.screenshot({path:`${prefix}-before.png`});await resume(page);await header.screenshot({path:`${prefix}-after.png`})
 const landing=JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON||'python',['-c',`from PIL import Image,ImageChops,ImageStat
import json,sys
a,b=[Image.open(p).convert('RGB') for p in sys.argv[1:]]
assert a.size==b.size
mean=sum(ImageStat.Stat(ImageChops.difference(a,b)).mean)/3
assert mean<0.25,mean
print(json.dumps({'meanPixelDifference':mean}))`,`${prefix}-before.png`,`${prefix}-after.png`],{encoding:'utf8'}))
 for(let repeat=0;repeat<2;repeat++){await startExpansion(page,header);await seek(page,48);samples+=(await inspectEdges(page,`${prefix}-repeat-${repeat}-48.png`)).checked;await resume(page);await header.click();await resume(page)}
 assert.deepEqual(errors,[]);console.log(JSON.stringify({engine:engine.name(),dark,lagged,samples,...landing}));cases++;await page.close()
 }}finally{await browser.close()}}
 console.log(`${cases} mobile pixel-edge / collapse-landing cases passed`)
})().catch(error=>{console.error(error);process.exit(1)})
