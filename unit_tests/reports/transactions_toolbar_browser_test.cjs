// Shipped app, isolated read-only rows: toolbar fit and native graph/fold state.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const ready=page=>page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false');
async function toolbar(page){
 await page.waitForFunction(()=>{const n=document.querySelector('.bb-recorded-search input'),s=document.querySelector('.bb-recorded-search-hint');return n&&s&&n.placeholder===(s.getBoundingClientRect().width<=n.clientWidth?'Search transactions':'')});
 const g=await page.locator('.bb-transactions').evaluate(root=>{
  const rect=n=>n.getBoundingClientRect().toJSON(),search=root.querySelector('.bb-recorded-search'),input=search.querySelector('input'),filter=root.querySelector('.bb-category-mix-filter'),button=root.querySelector('.bb-recorded-toolbar .bb-recorded-graph-toggle');
  return {search:rect(search),input:rect(input),filter:rect(filter),button:rect(button),buttonVisible:getComputedStyle(button).display!=='none',total:root.querySelectorAll('.bb-chart-kicker,.bb-chart-total').length,overflow:document.documentElement.scrollWidth>innerWidth};
 });
 assert.equal(g.total,0,'Transactions has neither a total label nor a headline amount');
 assert(Math.abs(g.search.y+g.search.height/2-g.filter.y-g.filter.height/2)<1,'Search and filter share one row');
 assert(g.search.right+7<=g.filter.left&&g.search.width>=54&&g.input.width>0,'Search keeps a usable nonoverlapping input: '+JSON.stringify(g));
 if(g.buttonVisible){assert(Math.abs(g.search.y+g.search.height/2-g.button.y-g.button.height/2)<1);assert(g.filter.right+7<=g.button.left);assert.equal(g.button.height,44)}
 assert(!g.overflow,'No horizontal page overflow');return g;
}
(async()=>{let count=0;for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{for(const dark of [false,true])for(const c of [{width:320,height:657},{width:382,height:740},{width:466,height:678},{width:867,height:480},{width:951,height:648,rail:84},{width:1280,height:900}].filter(c=>!process.env.ONLY_WIDTH||c.width===Number(process.env.ONLY_WIDTH))){
  const {page,errors,unexpected}=await fixture(browser,c.width,c.height,dark,false,false,c.rail||0);
  try{
   await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));await ready(page);await toolbar(page);
   const input=page.getByRole('searchbox',{name:'Search transactions',exact:true}),filter=page.getByRole('combobox',{name:'Filter transactions',exact:true});
   if(c.width===1280)assert.equal(await input.getAttribute('placeholder'),'Search transactions');
   if(c.width===320)assert.equal(await input.getAttribute('placeholder'),'');
   await filter.selectOption('category:need_expenses');await ready(page);await toolbar(page);
   await input.fill('fixture');await page.waitForTimeout(260);await ready(page);await toolbar(page);await page.getByRole('button',{name:'Clear search',exact:true}).click();await ready(page);await toolbar(page);
   for(const value of ['income','savings','all']){await filter.selectOption(value);await ready(page);await toolbar(page)}
   const wide=c.width>=800&&c.width<=1024,plot=await page.locator('.bb-daily-plot').elementHandle();
   if(!wide){await page.getByRole('button',{name:'Show spending graph',exact:true}).click();assert.equal(await page.locator('.bb-recorded-graph-reveal').getAttribute('aria-hidden'),'false');await toolbar(page);assert(await plot.evaluate(n=>n===document.querySelector('.bb-transactions .bb-daily-plot')),'The native graph stays mounted')}
   else{const bounds=await page.evaluate(()=>({scroll:document.documentElement.scrollHeight,height:innerHeight,list:document.querySelector('.bb-recorded-results').getBoundingClientRect().height}));assert(bounds.scroll<=bounds.height+1&&bounds.list>200,'Only left rows scroll and reclaim the removed total space: '+JSON.stringify(bounds));}
   if(c.width===382){await input.fill('fold draft');await page.waitForTimeout(260);await ready(page);await page.setViewportSize({width:951,height:648});await toolbar(page);assert.equal(await input.inputValue(),'fold draft');await page.setViewportSize({width:c.width,height:c.height});await toolbar(page);assert.equal(await input.inputValue(),'fold draft');await page.getByRole('button',{name:'Clear search',exact:true}).click();await ready(page)}
   if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.BOOKIEBOT_SCREENSHOT_DIR,`toolbar-${engine.name()}-${c.width}-${dark?'dark':'light'}.png`)})}
   assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);console.log('PASS Transactions toolbar',engine.name(),c.width,dark?'dark':'light');count++;
  }finally{await page.close()}
 }}finally{await browser.close()}
}console.log(count+' Transactions toolbar cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
