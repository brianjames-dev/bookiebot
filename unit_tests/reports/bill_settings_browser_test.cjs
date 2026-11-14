// Shipped CSS/components in closed and open DUO; isolated API fixtures only.
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,tap:nativeTap,engines}=require('./duo_layout_browser_test.cjs');
async function tap(page,button){await button.waitFor({state:'visible'});await button.evaluate(el=>el.scrollIntoView({block:'center'}));try{await nativeTap(page,button)}catch(error){console.error(await button.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {button:el.outerHTML,box:{x:r.x,y:r.y,width:r.width,height:r.height},hit:hit?.outerHTML,inert:el.closest('[inert]')?.outerHTML.slice(0,300),scrollY,innerHeight}}));await page.screenshot({path:'/private/tmp/bookiebot-bills-tap-failure.png',fullPage:true});throw error}}
const source={id:'pge-fixture',type:'variable',name:'PG&E',amountCents:null,cadence:'monthly',pullDay:22,pullMonths:[],category:'bills_utilities',account:'Checking',active:true,effectiveFrom:'0001-01',effectiveUntil:'9999-12',splitMethod:'income',payerBasisPoints:6473,version:'pge-v1',nextDate:'2026-11-22',needsSetup:false,earliestEffectiveMonth:'2026-11',charge:{available:true,month:'2026-11',amountCents:0,recorded:false,virtual:false,date:'2026-11-22',version:'charge-v1'}};
;(async()=>{let count=0;
for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
 const browser=await engine.launch({headless:true});try{
 for(const dark of [false,true])for(const width of [320,382,867].filter(w=>!process.env.ONLY_WIDTH||w===Number(process.env.ONLY_WIDTH))){
  const commands=[],reviews=[],saved=new Map();let bills=[structuredClone(source)],revision=0,lose=true;
  const {page,errors,unexpected}=await fixture(browser,width,width<800?657:669,dark,false,false,0,{transactions:route=>{
   const url=new URL(route.request().url());assert.equal(route.request().method(),'GET');
   const row={id:'2026-11:pge-source',month:'2026-11',version:'pge-source-v1',actionId:'pge-source',date:'2026-11-13',title:'PG&E',location:'',person:'Brian',kind:'payment',category:'bills_utilities',categoryLabel:'Bills & utilities',amountCents:9843,fields:{amount:'98.43'},split:'',splitOptions:{custom:true,payerName:'Brian',partnerName:'Hannah',incomePayerCents:6371,payerBasisPoints:6473},editableFields:['amount'],capabilities:{update:true,split:true},reasons:{}};
   const items=url.searchParams.get('month')==='2026-11'?[row,{...row,id:'2026-11:other-source',title:'Water'}]:[];
   return route.fulfill({json:{items,total:items.length,nextOffset:null,categories:['bills_utilities'],persons:['Brian'],month:url.searchParams.get('month'),snapshotVersion:'native-split',days:items.length?[{date:row.date,month:row.month,count:2,totalCents:19686,needsCents:19686,wantsCents:0}]:[],totalAmountCents:19686}})
  },bills:async route=>{
   const req=route.request(),url=new URL(req.url()),reply=value=>route.fulfill({json:value}),body=req.postDataJSON();
   if(req.method()==='GET'){
    if(url.pathname.includes('/commands/'))return reply(saved.get(url.pathname.split('/').pop()));
    if(url.pathname.endsWith('/charge'))return reply({transaction:{id:'2026-11:pge-source',month:'2026-11',date:'2026-11-13'}});
    return reply({month:'2026-11',today:'2026-11-13',settingsVersion:'settings-'+revision,ownerName:'Brian',partnerName:'Hannah',incomeBasisPoints:6473,splitsEnabled:true,bills});
   }
   assert.equal(req.headers()['x-bookiebot-app'],'1');assert(!('owner' in body));
   const after=body.bill?{...source,...body.bill,id:body.id||'new-fixture',version:'new-v1',amountCents:Math.round(Number(body.bill.amount)*100),earliestEffectiveMonth:'2026-11',charge:source.charge}:undefined;
   const review=body.operation==='amount'?{operation:'amount',name:'PG&E',amountCents:9843,month:'2026-11',date:'2026-11-13',share:{method:'income',payerCents:6371,partnerCents:3472},reviewVersion:'review-'+revision}:{operation:body.operation,after:body.operation==='delete'?{...bills.find(b=>b.id===body.id),active:false}:after,effectiveFrom:body.effectiveFrom||body.bill.effectiveFrom,reviewVersion:'review-'+revision};
   if(url.pathname.endsWith('/review')){reviews.push(body);return reply({review})}
   assert(body.requestId&&body.reviewVersion);commands.push(body);
   if(body.operation==='amount')bills=bills.map(b=>({...b,charge:{...b.charge,recorded:true,amountCents:9843}}));
   else if(body.operation==='create')bills.push(after);
   else if(body.operation==='delete')bills=bills.map(b=>b.id===body.id?{...b,active:false}:b);
   revision++;const result={state:'done',success:true,detail:'Saved bill.'};saved.set(body.requestId,result);
   if(lose){lose=false;return route.abort('failed')}return reply(result);
  }});
  await tap(page,page.getByRole('button',{name:'Settings',exact:true}));
  await tap(page,page.getByRole('button',{name:'Manage bills & subscriptions',exact:true}));
  const panel=page.locator('main[aria-label="Bills"]');await panel.locator('.bb-bills-row').waitFor();
  await tap(page,panel.locator('.bb-bills-row').first());
  await tap(page,panel.getByRole('button',{name:'Enter monthly amount',exact:true}));
  await panel.getByLabel('Bill amount',{exact:true}).fill('98.43');
  await tap(page,panel.getByRole('button',{name:'Review',exact:true}));
  await panel.getByRole('heading',{name:'Confirm amount',exact:true}).waitFor();
  assert.equal(commands.length,0,'Review never records an amount');
  await tap(page,panel.getByRole('button',{name:'Confirm amount',exact:true}));
  await panel.getByRole('button',{name:'Check saved status',exact:true}).waitFor();
  await tap(page,panel.getByRole('button',{name:'Check saved status',exact:true}));
  await panel.locator('.bb-bills-editor[data-open="false"]').waitFor({state:'attached'});assert.equal(commands.length,1);
  await tap(page,panel.getByRole('button',{name:'Add bill',exact:true}));
  await panel.getByLabel('Name',{exact:true}).fill('Insurance');await panel.getByLabel('Type',{exact:true}).selectOption('fixed');
  await panel.getByRole('textbox',{name:'Recurring amount',exact:true}).fill('42.30');await panel.getByLabel('Payment day',{exact:true}).fill('15');
  assert.equal(await panel.getByLabel('Applies from',{exact:true}).count(),1);await tap(page,panel.getByRole('button',{name:/^Recurring split/}));
  await panel.getByLabel("Brian's share percentage",{exact:true}).fill('42.25');await panel.getByRole('button',{name:'Split by income',exact:true}).click();
  assert.equal(await panel.getByLabel("Brian's share percentage",{exact:true}).inputValue(),'64.73');
  assert(!(await panel.getByRole('slider').getAttribute('aria-valuetext')).includes('$'),'Recurring defaults are percentages');
  await page.setViewportSize({width:width<800?867:382,height:669});
  assert.equal(await panel.getByLabel('Name',{exact:true}).inputValue(),'Insurance','Folding retains the form');
  await page.setViewportSize({width,height:width<800?657:669});
  await tap(page,panel.getByRole('button',{name:'Use split',exact:true}));
  const geometry=await panel.evaluate(p=>{const list=p.querySelector('.bb-bills-toolbar').getBoundingClientRect(),editor=p.querySelector('.bb-bills-editor').getBoundingClientRect();return {list:{x:list.x,width:list.width},editor:{x:editor.x,width:editor.width},overflow:document.documentElement.scrollWidth-innerWidth}});
  assert(geometry.overflow<=1,'Bills does not overflow');
  if(width>=800){assert(geometry.list.width>0&&geometry.editor.width>0,'Both usable panes have content width');assert(geometry.editor.x>geometry.list.x+geometry.list.width)}
  else assert.equal(geometry.list.x,geometry.editor.x,'Closed editor uses the normal content width');
  if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.BOOKIEBOT_SCREENSHOT_DIR+`/bills-editor-${engine.name()}-${width}-${dark?'dark':'light'}.png`,fullPage:true})}
  await tap(page,panel.getByRole('button',{name:'Review',exact:true}));await panel.getByRole('heading',{name:'Review bill',exact:true}).waitFor();
  assert.equal(reviews.at(-1).bill.splitMethod,'income');assert.equal(reviews.at(-1).bill.effectiveFrom,'2026-11','An eligible new bill starts with the current month');
  await tap(page,panel.getByRole('button',{name:'Confirm',exact:true}));await panel.locator('.bb-bills-editor[data-open="false"]').waitFor({state:'attached'});
  assert.equal(commands.length,2);assert.equal(new Set(commands.map(c=>c.requestId)).size,2);
  await tap(page,panel.locator('.bb-bills-row').filter({hasText:'Insurance'}));
  await tap(page,panel.getByRole('button',{name:'Stop bill',exact:true}));await panel.getByLabel('Stop from',{exact:true}).fill('2026-12');
  await tap(page,panel.getByRole('button',{name:'Review',exact:true}));await panel.getByRole('heading',{name:'Stop bill',exact:true}).waitFor();
  await tap(page,panel.getByRole('button',{name:'Stop bill',exact:true}));await panel.locator('.bb-bills-editor[data-open="false"]').waitFor({state:'attached'});assert.equal(commands.at(-1).operation,'delete');
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  if(process.env.BOOKIEBOT_SCREENSHOT_DIR){fs.mkdirSync(process.env.BOOKIEBOT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.BOOKIEBOT_SCREENSHOT_DIR+`/bills-${engine.name()}-${width}-${dark?'dark':'light'}.png`,fullPage:true})}
  await tap(page,panel.locator('.bb-bills-row').filter({hasText:'PG&E'}));
  assert.equal(await panel.getByRole('button',{name:'Edit this charge / split',exact:true}).count(),0,'Recurring setup does not navigate to Transactions');
  await page.close();count++;
 }
 }finally{await browser.close()}
}
console.log(`${count} actual-bundle Bills cases passed`)
})().catch(error=>{console.error(error);process.exitCode=1});
