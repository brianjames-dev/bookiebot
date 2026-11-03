// Run after npm run build. Render the actual chart components with isolated data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module')
const root=path.resolve(__dirname,'../..'),frontend=path.join(root,'web/expense-report'),req=createRequire(path.join(frontend,'package.json'))
const {chromium,webkit}=process.env.BOOKIEBOT_PLAYWRIGHT_MODULE?require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE):req('playwright')
const css=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.css'),'utf8')
const charts=['BurnRateChart','DailySpendingChart','BillsUtilitiesChart']
// Export private chart components only in this fixture. The unrelated Category
// Mix worker URL is resolved without starting a worker or making a request.
const bundlePromise=req('esbuild').build({stdin:{resolveDir:frontend,loader:'tsx',contents:`
  import React from 'react';import {createRoot} from 'react-dom/client';
  import {${charts.join(',')}} from './src/report-app';
  const series=Array.from({length:5},(_,i)=>({day:i+1,label:String(i+1),dailySpend:30,actualSpend:30*(i+1),expectedSpend:40*(i+1),variance:(i-2)*30}));
  const burn={budget:1200,spent:150,remaining:1050,daysInMonth:30,elapsedDays:5,expectedSpend:200,allowedDailyAverage:40,actualDailyAverage:30,dailyDifference:-10,totalDifference:-50,status:'under',series};
  const daily=series.map((p,i)=>({label:p.label,amount:(i+1)*30,needsAmount:(i+1)*20,wantsAmount:(i+1)*10}));
  createRoot(document.getElementById('root')).render(<>
    <section data-test-chart="burn"><BurnRateChart burnRate={burn} categoryBalances={{raw:{needs:0,wants:1050,savings:0},remaining:{needs:0,wants:1050,savings:0},deficits:{needs:0,wants:0,savings:0},transfers:[],totalOverspend:0}} month={10}/></section>
    <section data-test-chart="daily" className="bb-daily-spending-content"><DailySpendingChart data={daily} total={450} filter="all" detailsOpen={false} detailsId="fixture" onToggleDetails={()=>{}} onInspectDay={()=>{}}/></section>
    <section data-test-chart="bills"><BillsUtilitiesChart items={[{key:'power',label:'Power',history:[{month:8,label:'Aug',amount:70},{month:9,label:'Sep',amount:100}]}]} billEvents={[]} year={2026} month={9}/></section>
  </>);
`},plugins:[{name:'chart-test-exports',setup(build){build.onResolve({filter:/\?worker&url$/},args=>({path:args.path,namespace:'unused-worker'}));build.onLoad({filter:/.*/,namespace:'unused-worker'},()=>({contents:'export default "/unused-category-worker.js"',loader:'js'}));build.onLoad({filter:/\/report-app\.tsx$/},args=>({contents:fs.readFileSync(args.path,'utf8')+'\nexport {'+charts.join(',')+'};',loader:'tsx',resolveDir:path.dirname(args.path)}))}}],bundle:true,format:'iife',outfile:'chart-grid-fixture.js',write:false,define:{'process.env.NODE_ENV':'"production"'}}).then(result=>result.outputFiles.find(file=>file.path.endsWith('.js')).text)

;(async()=>{
 const bundle=await bundlePromise
 let cases=0
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch({headless:true})
  try{for(const width of [390,1024])for(const dark of [false,true]){
   const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'})
   const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>route.abort())
   await page.setContent('<html data-theme="'+(dark?'dark':'light')+'"><head><style>'+css+'</style><style>section[data-test-chart]{height:420px}section[data-test-chart=burn]{height:600px}.bb-chart-box,.bb-bills-chart-box{height:260px!important}</style></head><body><div id="root"></div></body></html>')
   await page.addScriptTag({content:bundle})
   await page.waitForFunction(()=>document.querySelectorAll('[data-test-chart] .recharts-cartesian-grid').length===3,null,{timeout:10000}).catch(error=>{assert.deepEqual(errors,[]);throw error})
   for(const name of ['burn','daily','bills']){
    const colors=await page.locator('[data-test-chart="'+name+'"]').evaluate(section=>{
     const probe=document.createElement('span');section.append(probe);probe.style.transition='none';probe.style.color='hsl(var(--muted-foreground))';const grey=getComputedStyle(probe).color;probe.style.color='hsl(var(--foreground))';const foreground=getComputedStyle(probe).color;probe.remove()
     const grids=[...section.querySelectorAll('.recharts-cartesian-grid line')].filter(n=>getComputedStyle(n).strokeDasharray!=='none').map(n=>getComputedStyle(n).stroke)
     const zero=section.querySelector('.recharts-reference-line-line')
     return {grey,foreground,grids,zero:zero?{stroke:getComputedStyle(zero).stroke,opacity:getComputedStyle(zero).strokeOpacity}:null}
    })
    assert.ok(colors.grids.length>=2,name+' has dotted guides')
    assert.ok(colors.grids.every(stroke=>stroke===colors.grey),JSON.stringify({name,...colors}))
    if(name==='burn'){assert.equal(colors.zero.stroke,colors.grey,JSON.stringify(colors));assert.equal(colors.zero.opacity,'1');assert.notEqual(colors.zero.stroke,colors.foreground)}
    cases++
   }
   assert.deepEqual(errors,[])
   if(width===390)await page.locator('[data-test-chart="burn"]').screenshot({path:'/private/tmp/bookiebot-grid-'+engine.name()+'-'+(dark?'dark':'light')+'.png'})
   await page.close()
  }}finally{await browser.close()}
 }
 console.log(cases+' Chromium/WebKit chart cases passed: grey horizontal/vertical grids and matching Burn Rate zero baseline, both themes/mobile/desktop')
})().catch(error=>{console.error(error);process.exitCode=1})
