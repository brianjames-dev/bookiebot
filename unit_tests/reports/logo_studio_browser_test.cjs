// Offline gallery interaction contracts; optional final argument verifies a real generated fragment.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict')
const {chromium,webkit}=require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE||'playwright')
const template=fs.readFileSync(path.resolve(__dirname,'../../skills/bookiebot-logo-studio/assets/review-board.html'),'utf8')
const payload={version:1,snapshotId:'fixture',atlas:{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',size:84,columns:1,width:84,height:168},items:[
 {key:'merchant:one',kind:'merchant',name:'One <script> never code',currentIndex:0,candidateIndex:1,candidateSha256:'exact-candidate'},
 {key:'company:two',kind:'company',name:'Two',currentIndex:0}
]}
const fragment=template.replace('__STUDIO_DATA__',JSON.stringify(payload).replace(/</g,'\\u003c'))
;(async()=>{
 let cases=0
 for(const engine of [chromium,webkit]){
  const browser=await engine.launch()
  try{
   for(const width of [320,390,736])for(const colorScheme of ['light','dark']){
    const page=await browser.newPage({viewport:{width,height:800},colorScheme})
    const errors=[];page.on('pageerror',error=>errors.push(error.message))
    await page.route('**/*',route=>route.abort())
    const batchFragment=width===320?fragment:fragment.replace('"snapshotId":"fixture"','"snapshotId":"fixture","batchRef":"docs/logo-review/batches/example/batch.json"')
    await page.setContent(batchFragment)
    await page.evaluate(()=>{window.saved=[];window.sent=[];window.openai={setWidgetState:async state=>window.saved.push(state),sendFollowUpMessage:async value=>window.sent.push(value)}})
    const q=selector=>{const found=page.locator('#bookiebot-logo-studio '+selector);return selector==='[data-send]'?found.first():found}
    assert.equal(await q('[data-editor]').isVisible(),false)
    assert.equal(await q('[data-send]').isDisabled(),true)
    await q('[data-key="merchant:one"]').click()
    assert.equal(await q('[data-editor]').isVisible(),true)
    assert.equal(await q('[data-comparison] [role="img"]').count(),4)
    await q('[data-notes]').fill('Center it; keep native colors')
    await q('[data-url]').fill('http://example.com/bad')
    await q('[data-send]').click()
    assert.equal(await page.evaluate(()=>window.sent.length),0)
    assert.match(await q('[data-error]').textContent(),/HTTPS/)
    await q('[data-url]').fill('https://example.com/good.svg')
    await q('[data-send]').click()
    let sent=await page.evaluate(()=>window.sent.at(-1))
    let feedback=JSON.parse(sent.prompt.split('\n\n').at(-1))
    assert.equal(feedback.items[0].ready,false)
    assert.equal(feedback.items[0].notes,'Center it; keep native colors')
    // Candidate handoffs must continue the same batch rather than erasing history.
    if(width!==320){
     assert.equal(feedback.batchRef,'docs/logo-review/batches/example/batch.json')
     assert.match(sent.prompt,/Continue the existing batch/)
     assert.match(sent.prompt,/approval decisions.*do not need a new intake/)
    }else assert.equal(feedback.batchRef,undefined)
    await q('[data-ready]').check()
    await q('[data-new]').fill('New Store\nNew Store\nAnother Store')
    await q('[data-approve]').click()
    await q('[data-send]').click()
    sent=await page.evaluate(()=>window.sent.at(-1));feedback=JSON.parse(sent.prompt.split('\n\n').at(-1))
    assert.deepEqual(feedback.newRequests,['New Store','Another Store'])
    assert.equal(feedback.items[0].ready,true)
    assert.equal(feedback.items[0].candidateSha256,'exact-candidate')
    assert.equal(feedback.items[0].decision,'approve')
    await q('[data-notes]').fill('Another refinement')
    await q('[data-send]').click()
    feedback=JSON.parse((await page.evaluate(()=>window.sent.at(-1).prompt)).split('\n\n').at(-1))
    assert.equal(feedback.items[0].decision,undefined)
    const snapshot=await page.evaluate(()=>window.saved.at(-1))
    const count=await page.evaluate(()=>window.saved.length)
    await q('[data-clear]').click()
    assert.equal(await q('[data-editor]').isVisible(),false)
    await page.evaluate(state=>window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:state}}})),snapshot)
    assert.equal(await q('[data-editor]').isVisible(),true)
    assert.equal(await q('[data-comparison] [role="img"]').count(),4)
    assert.equal(await q('[data-notes]').inputValue(),'Another refinement')
    assert.equal(await page.evaluate(()=>window.saved.length),count+1,'restoring state must not save again')
    const stale={...snapshot,modelContent:{...snapshot.modelContent,items:[{key:'merchant:one',notes:'Keep these notes',referenceUrls:[],ready:false,decision:'approve',candidateSha256:'old-candidate'}]}}
    await page.evaluate(state=>window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:state}}})),stale)
    await q('[data-send]').click()
    feedback=JSON.parse((await page.evaluate(()=>window.sent.at(-1).prompt)).split('\n\n').at(-1))
    assert.equal(feedback.items[0].decision,undefined,'new artwork must invalidate restored approval')
    assert.equal(feedback.items[0].notes,'Keep these notes')
    const unrelated={...stale,modelContent:{...stale.modelContent,batchRef:'another/batch.json',items:[{key:'merchant:one',notes:'Unrelated review',referenceUrls:[],ready:true}]}}
    await page.evaluate(state=>window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{widgetState:state}}})),unrelated)
    assert.equal(await q('[data-notes]').inputValue(),'Keep these notes','another batch must not restore into this review')
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
    assert.deepEqual(errors,[])
    await page.close();cases++
   }
   if(process.argv[2]){
    const page=await browser.newPage({viewport:{width:390,height:844}})
    const fragment=fs.readFileSync(process.argv[2],'utf8')
    await page.setContent(fragment)
    const atlas=await page.evaluate(async()=>{const d=JSON.parse(document.getElementById('bookiebot-logo-studio-data').textContent);const image=new Image();image.src=d.atlas.url;await image.decode();return{width:image.width,height:image.height,expectedHeight:d.atlas.height,count:d.items.length}})
    assert.equal(await page.locator('[data-key]').count(),atlas.count)
    assert.equal(atlas.width,1008);assert.equal(atlas.height,atlas.expectedHeight)
    await page.locator('[data-key]').last().click()
    assert.equal(await page.locator('[data-editor]').isVisible(),true)
    await page.close();cases++
   }
  }finally{await browser.close()}
 }
 console.log(JSON.stringify({cases,status:'passed'}))
})().catch(error=>{console.error(error);process.exitCode=1})
