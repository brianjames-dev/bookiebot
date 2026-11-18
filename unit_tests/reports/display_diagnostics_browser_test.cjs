// Exercise capture/export, not a claimed reproduction of the native iOS fault.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const out='/private/tmp/bookiebot-display-report';fs.mkdirSync(out,{recursive:true});
(async()=>{let cases=0;for(const engine of engines){const browser=await engine.launch({headless:true});try{for(const [width,height]of [[951,669],[382,657]]){
 const {page,errors,unexpected}=await fixture(browser,width,height,true,false,false,0,{config:{version:'fixture-version'}});
 try{
  await page.evaluate(()=>{
   window.__copiedReports=[];window.__denyClipboard=false;
   Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(text){if(window.__denyClipboard)throw Error('Clipboard blocked');window.__copiedReports.push(text)}}});
   window.__diagnosticCanvas=document.querySelector('.bb-page');
   Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));
   // A controlled DOM gap proves the report can distinguish a page offset from
   // a native host inset. This is not an imitation of iOS's compositor bug.
   document.querySelector('.bb-page').style.top='82px';
   Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));
  });await page.waitForTimeout(1700);
  assert(await page.evaluate(()=>window.__diagnosticCanvas===document.querySelector('.bb-page')),'No document replacement');
  await page.locator('.bb-page').evaluate(el=>el.style.removeProperty('top'));
  await tap(page,page.getByRole('button',{name:'Settings',exact:true}));
  const copy=page.getByRole('button',{name:'Copy display report',exact:true});await copy.scrollIntoViewIfNeeded();await copy.tap();
  await page.getByRole('status').filter({hasText:'Display report copied.'}).waitFor();
  const raw=await page.evaluate(()=>window.__copiedReports.at(-1)),data=JSON.parse(raw);fs.writeFileSync(out+'/'+engine.name()+'-'+width+'-report.json',JSON.stringify(data,null,2));
  assert.equal(data.build,'fixture-version');assert.equal(data.beforeBackground.screen,'overview');assert.equal(data.beforeBackground.boxes.page[1],0);assert.equal(data.resumeChanges[0].screen,undefined,'Unchanged screen uses the compact delta format');let state=data.beforeBackground;const frames=data.resumeChanges.map(delta=>state={...state,...delta});assert(frames.some(frame=>frame.boxes.page[1]===82&&frame.screen==='overview'),'Keep a late foreground gap after navigating away to copy');assert.equal(data.current.screen,'settings');assert.equal(data.current.boxes.page[1],0);assert.equal(data.current.open,width===951);assert(data.resumeChanges.length<=10);assert(!raw.includes('Fixture income')&&!raw.includes('Rent')&&!raw.includes('Brian')&&!raw.includes('bookie.test'),'No financial/identity/URL content');assert(raw.length<20000);
  await page.evaluate(()=>window.__denyClipboard=true);await copy.tap();const field=page.getByRole('textbox',{name:'Display report',exact:true});await field.waitFor();assert(await field.getAttribute('readonly')!==null);assert.equal(JSON.parse(await field.inputValue()).build,'fixture-version');
  const style=await copy.evaluate(el=>{const s=getComputedStyle(el);return {background:s.backgroundColor,height:el.getBoundingClientRect().height}});assert.equal(style.background,'rgba(0, 0, 0, 0)');assert(style.height>=44);
  await page.screenshot({path:out+'/'+engine.name()+'-'+width+'.png'});assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);cases++;console.log('PASS native private display export, retained bad-frame trace and clipboard fallback',engine.name(),width,height);
 }catch(error){await page.screenshot({path:out+'/failure-'+engine.name()+'-'+width+'.png',fullPage:true});throw error}finally{await page.close()}
 }}finally{await browser.close()}}console.log(cases+' native display-report cases passed')})().catch(error=>{console.error(error);process.exitCode=1});
