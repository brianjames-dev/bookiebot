// Production bundle and isolated canonical ledger fixtures; never contacts a real account.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fixture,tap,engines}=require('./duo_layout_browser_test.cjs');
const data=JSON.parse(fs.readFileSync(process.env.BOOKIEBOT_TRANSACTION_WORKSPACE_FIXTURES||'/private/tmp/bookiebot-transactions-workspace.json','utf8'));
// Enable the existing custom-share capability for this isolated validation scenario.
for(const row of [...data.sources,...Object.values(data.results).flatMap(result=>result.items)])if(row.splitOptions)row.splitOptions={...row.splitOptions,custom:true};
const shots=process.env.BOOKIEBOT_DUO_SHOTS;
const poses=process.env.BOOKIEBOT_DUO_POSE?[process.env.BOOKIEBOT_DUO_POSE.split('x').map(Number)]:[[867,669],[951,648],[867,480],[800,480]];
async function bounds(page){return page.evaluate(()=>{
 const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}},page=document.querySelector('.bb-page'),list=document.querySelector('.bb-recorded-results');
 return {list:box('.bb-recorded-results'),title:box('.bb-transactions-heading'),graph:box('.bb-recorded-graph-reveal'),graphContent:box('.bb-daily-legend'),nav:box('.bb-navigation-pane'),pane:document.querySelector('.bb-duo-action-pane')?box('.bb-duo-action-pane'):null,paneContent:document.querySelector('.bb-duo-pane-content')?box('.bb-duo-pane-content'):null,scroll:[scrollY,page.scrollTop,page.scrollHeight,page.clientHeight],listScroll:[list.scrollHeight,list.clientHeight],viewport:[innerWidth,innerHeight]};
});}
const stable=page=>page.waitForFunction(()=>document.querySelector('.bb-transactions')?.getAttribute('aria-busy')==='false'&&document.querySelector('.bb-recorded-row-access'));
;(async()=>{let cases=0;
 for(const engine of engines.filter(e=>!process.env.ONLY_ENGINE||e.name()===process.env.ONLY_ENGINE)){
  const browser=await engine.launch({headless:true});try{
   for(const dark of [false,true])for(const [width,height] of poses){
    const reviews=[],commands=[];let saved=false,checked=false;
    const sample=data.sources[0];
    const summary={operation:'update',title:sample.title,date:sample.date,category:sample.categoryLabel,location:sample.location,person:sample.person,amountCents:sample.amountCents,before:sample.fields,after:{...sample.fields,amount:'23.45'}};
    const {page,errors,unexpected}=await fixture(browser,width,height,dark,false,false,0,{transactions:async route=>{
     const request=route.request(),url=new URL(request.url()),body=request.postDataJSON(),reply=value=>route.fulfill({json:value});
     if(url.pathname==='/app/transactions/review'){
      reviews.push(body);const item=data.sources.find(row=>row.id===body.id)||sample;
      return reply({review:{item,operation:body.operation,reviewVersion:'isolated-review',destination:body.destination,after:{...item.fields,...body.updates,...(body.updates?.amount?{amount:(body.updates.amount/100).toFixed(2)}:{})},share:body.operation==='split'?{method:body.method,payerCents:body.payerShareCents||400,partnerCents:item.amountCents-(body.payerShareCents||400),payerName:'Brian',partnerName:'Hannah'}:undefined}});
     }
     if(url.pathname==='/app/transactions'&&request.method()==='POST'){
      commands.push(body);
      if(body.operation==='undo'){saved=false;return reply({state:'done',success:true,summary:{...summary,operation:'undo'}})}
      saved=true;return reply({state:'uncertain',detail:'Isolated interrupted response; check saved status.'});
     }
     if(url.pathname.startsWith('/app/transactions/commands/')){checked=true;return reply({state:'done',success:true,summary,undo:{month:data.month,id:sample.id}})}
     if(url.pathname==='/app/transactions'&&request.method()==='GET'){
      const key=url.searchParams.get('offset')==='40'?'page2':url.searchParams.get('search')?'empty':'all';
      const listing=structuredClone(data.results[key]);
      if(saved&&checked)listing.items=listing.items.map(row=>row.id===sample.id?{...row,amountCents:2345,fields:{...row.fields,amount:'23.45'}}:row);
      return reply(listing);
     }
     throw Error('Unexpected isolated transaction request '+request.method()+' '+url.pathname);
    }});
    await tap(page,page.getByRole('button',{name:'Transactions',exact:true}));await stable(page);
    await page.locator('.bb-daily-day-header[aria-expanded="false"]').first().click();
    await page.locator('.bb-daily-day-header[aria-expanded="false"]').last().click();
    await page.waitForTimeout(550);
    const initial=await bounds(page);
    assert.equal(initial.scroll[0],0);assert.equal(initial.scroll[1],0);assert.equal(initial.scroll[2],height);
    assert.equal(initial.title.y,initial.graph.y,'Pane headings align');
    assert(Math.abs(initial.graph.right-(width===951?867:width)+16)<1,'Native right strip stays reserved');
    assert(initial.listScroll[0]>initial.listScroll[1]+300,'Only the left results area needs scrolling');
    assert(initial.graphContent.bottom<=initial.nav.y-15,'Graph clears the existing right dock');
    await page.locator('.bb-recorded-results').evaluate(el=>el.scrollTo(0,99999));
    await page.getByRole('button',{name:'Load more transactions',exact:true}).click();await stable(page);
    assert.equal(await page.locator('.bi-selected-row').count(),50,'Pagination stays reachable inside the left scroll area');
    await page.locator('.bb-recorded-results').evaluate(el=>el.scrollTo(0,0));
    await page.waitForTimeout(150);
    const access=page.getByRole('button',{name:'Show actions for Starbucks Coffee Company',exact:true});
    await access.click();const pane=page.getByRole('region',{name:'Transaction options and editor',exact:true});
    await pane.getByRole('button',{name:/^Edit /}).waitFor();
    assert.equal(await page.locator('.bb-recorded-graph-reveal').getAttribute('aria-hidden'),'true');
    assert.equal(await page.locator('.bb-recorded-swipe[data-revealed="true"]').count(),0,'No inline tray in landscape');
    let b=await bounds(page);assert(b.pane.x>initial.list.right,'Editor lives entirely in the right pane');assert(b.paneContent.bottom<=b.nav.y-15);
    assert.equal(await page.locator('.bb-recorded-row-access[aria-expanded="true"]').count(),1);
    if(shots){fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,`transactions-${engine.name()}-${width}x${height}-${dark?'dark':'light'}.png`)});}
    await pane.getByRole('button',{name:/^Edit /}).click();await pane.getByRole('textbox',{name:'Amount',exact:true}).fill('23.45');
    assert.equal(await page.locator('.bb-recorded-results .bi-editor').count(),0);
    await pane.getByRole('button',{name:'Show Daily Spending',exact:true}).click();
    assert.equal(await page.locator('.bb-recorded-graph-reveal').getAttribute('aria-hidden'),'false');
    await pane.getByRole('button',{name:'Return to transaction editor',exact:true}).click();
    assert.equal(await pane.getByRole('textbox',{name:'Amount',exact:true}).inputValue(),'23.45');
    await page.setViewportSize({width:382,height:657});
    await page.locator('.bb-page.bb-app-shell:not([data-duo-landscape="true"])').waitFor();
    await page.getByRole('textbox',{name:'Amount',exact:true}).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'Amount',exact:true}).inputValue(),'23.45');
    assert.equal(await page.locator('.bb-duo-action-pane').count(),0);
    assert.equal(await page.getByRole('button',{name:'Show spending graph',exact:true}).getAttribute('aria-expanded'),'false');
    await page.getByRole('button',{name:'Review change',exact:true}).click();await page.getByRole('button',{name:'Confirm update',exact:true}).waitFor();
    assert.equal(commands.length,0,'Review cannot commit a financial change');
    await page.setViewportSize({width,height});await pane.getByRole('button',{name:'Confirm update',exact:true}).waitFor();
    assert.equal(await page.locator('.bb-recorded-results .bi-editor').count(),0);
    await pane.getByRole('button',{name:'Back',exact:true}).click();await pane.getByRole('button',{name:'Back to transaction actions',exact:true}).click();
    for(const [label,review]of [['Split','Review split'],['Delete','Review deletion']]){
     await pane.getByRole('button',{name:new RegExp('^'+label+' ')}).click();
     if(label==='Split'){
      await pane.getByRole('textbox',{name:"Brian's share amount",exact:true}).fill('1.001');
      await page.setViewportSize({width:382,height:657});await page.locator('.bb-page.bb-app-shell:not([data-duo-landscape="true"])').waitFor();
      assert.equal(await page.getByRole('textbox',{name:"Brian's share amount",exact:true}).inputValue(),'1.001');
      assert.equal(await page.getByRole('button',{name:'Review split',exact:true}).isDisabled(),true);
      await page.setViewportSize({width,height});await pane.getByRole('textbox',{name:"Brian's share amount",exact:true}).waitFor();
      assert.equal(await pane.getByRole('textbox',{name:"Brian's share amount",exact:true}).inputValue(),'1.001');
      await pane.getByRole('textbox',{name:"Brian's share amount",exact:true}).fill('4.00');
     }
     await pane.getByRole('button',{name:review,exact:true}).click();
     await pane.getByRole('button',{name:label==='Split'?'Confirm split':'Confirm delete',exact:true}).waitFor();
     await pane.getByRole('button',{name:'Back',exact:true}).click();
     await pane.getByRole('button',{name:'Back to transaction actions',exact:true}).click();
    }
    await pane.getByRole('button',{name:/^Edit /}).click();await pane.getByRole('textbox',{name:'Amount',exact:true}).fill('23.45');
    await pane.getByRole('button',{name:'Review change',exact:true}).click();await pane.getByRole('button',{name:'Confirm update',exact:true}).click();
    await pane.getByRole('button',{name:'Check saved status',exact:true}).waitFor();
    assert.equal(await pane.getByRole('button',{name:'Close transaction options',exact:true}).isDisabled(),true);
    await pane.getByRole('button',{name:'Check saved status',exact:true}).click();
    const undo=page.getByRole('button',{name:'Undo',exact:true});await undo.waitFor();
    const ub=await page.locator('.bi-undo-overlay').boundingBox();assert(ub.x>initial.list.right,'Save feedback and Undo stay right-side');
    await undo.click();await stable(page);await page.waitForFunction(()=>!document.querySelector('.bb-duo-action-pane'));
    assert.equal(commands.length,2);assert.equal(commands[0].operation,'update');assert.equal(commands[1].operation,'undo');
    await page.setViewportSize({width:382,height:657});await page.locator('.bb-page.bb-app-shell:not([data-duo-landscape="true"])').waitFor();
    // A disclosed native closed tray moves to the chooser when unfolding.
    await access.scrollIntoViewIfNeeded();await access.press('ArrowLeft');
    await page.setViewportSize({width,height});await pane.getByRole('button',{name:/^Edit /}).waitFor();
    assert.equal(await page.locator('.bb-recorded-swipe[data-revealed="true"]').count(),0);
    await pane.getByRole('button',{name:'Close transaction options',exact:true}).click();
    const final=await bounds(page);assert.equal(final.scroll[2],height);assert.equal(final.scroll[1],0);assert.deepEqual(final.nav,initial.nav,'Dock geometry never depends on editor or scroll state');
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
    await page.close();cases++;console.log('PASS Duo Transactions',engine.name(),width,height,dark?'dark':'light');
   }
  }finally{await browser.close()}
 }
 console.log(cases+' production-bundle Duo Transactions cases passed');
})().catch(error=>{console.error(error);process.exitCode=1});
