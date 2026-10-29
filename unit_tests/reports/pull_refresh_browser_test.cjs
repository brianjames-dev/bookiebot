// Run after npm run build; all API traffic is fulfilled from isolated fixtures.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), {execFileSync} = require('node:child_process')
const {createRequire} = require('node:module')
const root = path.resolve(__dirname,'../..'), frontend = path.join(root,'web/expense-report')
const req = createRequire(path.join(frontend,'package.json'))
const {chromium,webkit} = process.env.BOOKIEBOT_PLAYWRIGHT_MODULE ? require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE) : req('playwright')
const report = JSON.parse(execFileSync(process.env.BOOKIEBOT_TEST_PYTHON || 'python', ['-c', `
import json
from unit_tests.reports.test_income_projection import build, income_rows
from bookiebot.reports.expense_breakdown import expense_breakdown_client_payload
print(json.dumps(expense_breakdown_client_payload(build(income_rows(('9/1/2026','Fixture income','5000'))))))
`],{cwd:root,env:{...process.env,PYTHONPATH:path.join(root,'src')}}).toString())
const css=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.css'),'utf8')
const js=fs.readFileSync(path.join(root,'src/bookiebot/reports/assets/expense-report-app.js'),'utf8')
const html=dark=>`<!doctype html><html data-theme="${dark?'dark':'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="bookiebot-expense-report-root"></div><script id="bookiebot-expense-app-config" type="application/json">${JSON.stringify({ownerName:'Brian',reportUrl:'/app/expenses/data',logoutUrl:'/app/logout'})}</script><script>localStorage.setItem('bookiebot-expense-report-theme','${dark?'dark':'light'}')</script><script type="module">${js}</script></body></html>`
const screens={Overview:'/app/expenses/data',Transactions:'/app/transactions',Shared:'/app/reimbursements',Savings:'/app/goals',Reconcile:'/app/reconciliation',Settings:'/app/widgets/settings'}
async function gesture(page,end=280,{start=80,x=16,cancel=false,finish=true,selector='.bb-shell-masthead',drift=false,begin=true}={}) {
  await page.evaluate(({start,end,x,cancel,finish,selector,drift,begin})=>{
    const target=document.querySelector(selector)
    const touch=y=>({identifier:71,target,clientX:x,clientY:y,pageX:x,pageY:y})
    const fire=(type,y)=>{
      const event=new Event(type,{bubbles:true,cancelable:true})
      Object.defineProperties(event,{touches:{value:type==='touchend'||type==='touchcancel'?[]:[touch(y)]},changedTouches:{value:[touch(y)]}})
      return target.dispatchEvent(event)
    }
    if(begin)fire('touchstart',start)
    if(drift) {x+=18;fire('touchmove',start+8)}
    fire('touchmove',end);if(finish)fire(cancel?'touchcancel':'touchend',end)
  },{start,end,x,cancel,finish,selector,drift,begin})
}
async function waitReady(page,label) {
  await page.waitForFunction(label=>document.querySelector(`button[aria-label="Refresh ${label}"]`)?.disabled===false,label)
}
;(async()=>{
  let cases=0
  for(const engine of [chromium,webkit]) {
    const browser=await engine.launch({headless:true})
    try {
      for(const width of [320,390]) for(const dark of [false,true]) {
        const page=await browser.newPage({viewport:{width,height:780},hasTouch:true,isMobile:true,reducedMotion:dark?'reduce':'no-preference'})
        // Push permission/service-worker setup has its own tests. This fixture
        // verifies settings reads and unsaved preferences without enabling push.
        await page.addInitScript(()=>{
          delete window.PushManager
          window.__preventedMoves=0
          window.addEventListener('touchmove',event=>{if(event.defaultPrevented)window.__preventedMoves++},{passive:true})
        })
        const requests=[],errors=[];let failedCheck=false,reportNumber=0,holdCheck=false,releaseCheck,holdReport=false,releaseReport
        page.on('pageerror',error=>errors.push(error.message))
        await page.route('**/*',async route=>{
          const request=route.request(),url=new URL(request.url()),name=url.pathname,body=request.postDataJSON()
          if(url.origin!=='https://bookie.test'){await route.abort();return}
          if(name==='/app/expenses'){await route.fulfill({contentType:'text/html',body:html(dark)});return}
          requests.push({name,method:request.method(),query:url.search,body})
          await new Promise(resolve=>setTimeout(resolve,90))
          let value
          if(name==='/app/expenses/data') {
            if(holdReport)await new Promise(resolve=>{releaseReport=resolve})
            value={...report,generatedAt:new Date(Date.now()+ ++reportNumber*1000).toISOString()}
          }
          else if(name==='/app/reconciliation') {
            if(body?.operation==='check'&&holdCheck)await new Promise(resolve=>{releaseCheck=resolve})
            if(body?.operation==='check'&&failedCheck){failedCheck=false;await route.fulfill({status:500,json:{error:'Fixture offline'}});return}
            value={enabled:true,checkedAt:'2026-10-29T07:00:00Z',items:[]}
          } else if(name==='/app/reimbursements') value={enabled:true,ownerKey:'brian',currency:'USD',allocations:[],events:[],resets:[],resetState:'fixture'}
          else if(name==='/app/goals') value={goals:[]}
          else if(name==='/app/transactions')value={items:[],total:0,nextOffset:null,categories:[],persons:[],month:'2026-09'}
          else if(name==='/app/widgets/settings')value={connections:[],scriptUrl:'/app/widgets/script',setupInstructionsUrl:'/app/widgets/help'}
          else if(name==='/app/notifications')value={enabled:false,publicKey:'B'+'A'.repeat(86),preferences:{weekly:true,upcoming:false,showAmounts:false,hour:10}}
          else if(name==='/app/expenses/months')value={currentMonth:'2026-09',months:[{value:'2026-09',label:'September 2026'}],coverage:{status:'complete',unavailableYears:[]}}
          else if(name==='/app/version')value={version:'fixture-version'}
          else if(name.includes('avatar')){await route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG8kAAAAASUVORK5CYII=','base64')});return}
          else {await route.fulfill({status:404,json:{error:'Unknown fixture endpoint'}});return}
          await route.fulfill({json:value})
        })
        await page.goto('https://bookie.test/app/expenses')
        await page.locator('.bb-app-shell').waitFor();await waitReady(page,'Overview')
        if(width===320&&!dark) {
          for(const layoutWidth of [320,360,390,768,1024]) {
            await page.setViewportSize({width:layoutWidth,height:780})
            await page.waitForTimeout(100)
            const layout=await page.evaluate(()=>{
              const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,height:r.height}}
              return {header:rect('.bb-report-header'),month:rect('.bb-report-header .bb-month-trigger'),toggle:rect('.bb-report-header .bb-projection-control'),targets:[...document.querySelectorAll('.bb-report-header .bb-metric-toggle')].map(n=>n.getBoundingClientRect().height),overflow:document.documentElement.scrollWidth>innerWidth}
            })
            assert.ok(layout.month.right+6<=layout.toggle.left,'Month and view toggle must not overlap')
            assert.ok(Math.abs(layout.toggle.right-layout.header.right)<1,'View toggle anchors to the right edge')
            assert.ok(Math.abs(layout.month.top+layout.month.height/2-layout.toggle.top-layout.toggle.height/2)<1,'Month and view toggle share the same row')
            assert.ok(layout.targets.every(h=>h>=44));assert.equal(layout.overflow,false)
          }
          await page.setViewportSize({width,height:780})
          await page.getByRole('button',{name:'Projected',exact:true}).click()
          assert.equal(await page.getByRole('button',{name:'Projected',exact:true}).getAttribute('aria-pressed'),'true')
          await page.getByRole('button',{name:'Current',exact:true}).click()
          assert.equal(await page.getByRole('button',{name:'Current',exact:true}).getAttribute('aria-pressed'),'true')
          await page.waitForTimeout(350)
          await page.screenshot({path:`/tmp/bookiebot-header-${engine.name()}.png`})
        }
        for(const [label,path] of Object.entries(screens)) {
          await (label==='Settings' ? page.getByRole('button',{name:label,exact:true}) : page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:label,exact:true})).click()
          await page.evaluate(()=>window.scrollTo(0,0));await waitReady(page,label)
          if(label==='Transactions') {await page.getByRole('searchbox',{name:'Search transactions'}).fill('coffee');await page.waitForTimeout(400);await waitReady(page,label)}
          if(label==='Savings') {await page.getByRole('button',{name:'＋ Goal',exact:true}).click();await page.getByLabel('Goal name',{exact:true}).fill('Keep this draft');await page.getByLabel('Goal name',{exact:true}).blur();await page.evaluate(()=>window.scrollTo(0,0))}
          if(label==='Settings') {await page.getByLabel('Notification delivery time').selectOption('15');await page.evaluate(()=>window.scrollTo(0,0))}
          const before=requests.filter(r=>r.name===path).length
          const reportBefore=requests.filter(r=>r.name==='/app/expenses/data').length
          const notificationsBefore=requests.filter(r=>r.name==='/app/notifications').length
          await gesture(page,150);await page.waitForTimeout(120)
          assert.equal(requests.filter(r=>r.name===path).length,before,'Short pull must not request data')
          await gesture(page,224);await page.waitForTimeout(120)
          assert.equal(requests.filter(r=>r.name===path).length,before,'The former 144px trigger must no longer refresh')
          if(label==='Overview')holdReport=true
          await gesture(page)
          if(label==='Overview') {
            await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='refreshing')
            const busy=page.locator('.bb-report-header .bb-app-status span').filter({hasText:'Refreshing…'})
            assert.equal(await busy.getAttribute('class'),'sr-only','The duplicate loading text is accessible without a visible label under the month')
            while(!releaseReport)await page.waitForTimeout(10)
            holdReport=false;releaseReport()
          }
          await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='done')
          if(dark) {
            assert.equal(await page.locator('.bb-pull-disc').evaluate(n=>getComputedStyle(n).animationName),'none','Reduced motion skips the pop')
            assert.equal(await page.locator('.bb-pull-burst').evaluate(n=>getComputedStyle(n).animationName),'none','Reduced motion skips the burst')
          }
          assert.equal(requests.filter(r=>r.name===path).length,before+1,`${label} refreshes the active data once`)
          if(label==='Transactions') {
            const last=requests.filter(r=>r.name===path).at(-1)
            assert.match(last.query,/fresh=1/);assert.match(last.query,/search=coffee/)
            assert.equal(await page.getByRole('searchbox',{name:'Search transactions'}).inputValue(),'coffee')
          }
          if(label==='Savings') {
            assert.equal(requests.filter(r=>r.name==='/app/expenses/data').length,reportBefore+1,'Savings also reloads investment report data exactly once')
            assert.equal(await page.getByLabel('Goal name',{exact:true}).inputValue(),'Keep this draft')
          }
          if(label==='Settings') {
            assert.equal(requests.filter(r=>r.name==='/app/notifications').length,notificationsBefore+1,'Settings waits for notifications and widgets')
            assert.equal(await page.getByLabel('Notification delivery time').inputValue(),'15','Refresh retains unsaved notification preferences')
          }
          if(label==='Reconcile')assert.equal(requests.filter(r=>r.name===path).at(-1).body?.operation,'check')
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
          cases++
        }
        await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Reconcile',exact:true}).click();await page.evaluate(()=>window.scrollTo(0,0));await waitReady(page,'Reconcile')
        failedCheck=true;await gesture(page)
        await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='error')
        await waitReady(page,'Reconcile');await gesture(page)
        await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='done')
        assert.equal(requests.filter(r=>r.name==='/app/reconciliation').at(-1).method,'GET','Uncertain checks refresh status without repeating the bank command')
        // Native scrolling stays in the browser; the app only observes it.
        if(width===390&&!dark) {
          await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='idle'&&document.querySelector('.bb-pull-refresh-space').getBoundingClientRect().height<.1)
          const geometry=()=>page.evaluate(()=>Object.fromEntries(['.bb-wordmark','.bb-app-avatar','.bb-shell-header-actions','#bb-reconcile-title'].map(selector=>[selector,document.querySelector(selector).getBoundingClientRect().top])))
          const original=await geometry()
          const originalHeight=await page.evaluate(()=>document.documentElement.scrollHeight)
          await page.evaluate(()=>{
            window.__toolbarMotion=[];window.__sampleToolbar=true
            const sample=()=>{
              if(!window.__sampleToolbar)return
              window.__toolbarMotion.push({top:document.querySelector('.bb-shell-header-actions').getBoundingClientRect().top,phase:document.querySelector('.bb-pull-refresh').dataset.phase})
              requestAnimationFrame(sample)
            }
            sample()
          })
          holdCheck=true
          const cdp=engine===chromium ? await page.context().newCDPSession(page) : null,before=requests.filter(r=>r.name==='/app/reconciliation').length
          if(cdp) {
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:16,y:78}]})
            for(const y of [100,135])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:16,y}]})
          } else await gesture(page,135,{start:78,finish:false})
          await page.waitForTimeout(100)
          const growingFrom=await page.locator('.bb-pull-disc').evaluate(n=>n.getBoundingClientRect().width)
          if(cdp)for(const y of [175,220,260])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:16,y}]})
          else await gesture(page,260,{start:78,finish:false,begin:false})
          await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='armed')
          await page.waitForTimeout(100)
          assert.ok(await page.locator('.bb-pull-disc').evaluate(n=>n.getBoundingClientRect().width)>growingFrom+8,'The icon progressively grows with the pull')
          const pulled=await geometry()
          for(const selector in original)assert.ok(Math.abs(pulled[selector]-original[selector])<.5,`${selector} must not get a second, scripted drag offset`)
          assert.equal(await page.locator('.bb-pull-refresh-space').evaluate(node=>node.getBoundingClientRect().height),0,'Dragging never changes page layout')
          assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),originalHeight,'Dragging never changes the scroll extent')
          assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).overscrollBehaviorY),'contain','Local native bounce remains enabled')
          assert.equal(await page.evaluate(()=>window.__preventedMoves),0,'No native touch movement is canceled')
          assert.equal(await page.locator('.bb-pull-refresh-label').count(),0,'There is no visible label')
          assert.ok(await page.evaluate(()=>document.querySelector('#bb-reconcile-title').getBoundingClientRect().top>document.querySelector('.bb-pull-refresh').getBoundingClientRect().bottom),'The pull indicator must not cover the heading')
          await page.screenshot({path:'/tmp/bookiebot-pull-refresh-armed.png'})
          if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
          else await page.evaluate(()=>{
            const event=new Event('touchend',{bubbles:true,cancelable:true})
            Object.defineProperties(event,{touches:{value:[]},changedTouches:{value:[{identifier:71,clientY:260,clientX:16}]}})
            document.querySelector('.bb-shell-masthead').dispatchEvent(event)
          })
          await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='refreshing')
          await page.waitForTimeout(350)
          const held=await geometry()
          for(const selector in original)assert.ok(Math.abs(held[selector]-original[selector]-(selector==='.bb-shell-header-actions'?0:64))<.5,`${selector} must retain its correct loading position`)
          const spinner=page.locator('.bb-pull-spinner')
          const first=await spinner.evaluate(node=>({transform:getComputedStyle(node).transform,animation:getComputedStyle(node).animationName}))
          await page.waitForTimeout(100)
          const second=await spinner.evaluate(node=>getComputedStyle(node).transform)
          assert.equal(first.animation,'bb-pull-spin');assert.notEqual(first.transform,second,'Loading must animate while the response is pending')
          assert.equal(await page.locator('.bb-pull-glyph').evaluate(node=>node.getBoundingClientRect().width),52,'Larger refresh icon')
          await page.screenshot({path:'/tmp/bookiebot-pull-refresh-loading.png'})
          const anchorBefore=await page.locator('.bb-pull-refresh').boundingBox()
          await page.evaluate(()=>{const space=document.createElement('div');space.id='refresh-scroll-fixture';space.style.height='1400px';document.body.append(space);window.scrollTo(0,160)})
          await page.waitForFunction(()=>scrollY===160)
          const scrolling=await page.evaluate(()=>({spinner:document.querySelector('.bb-pull-refresh').getBoundingClientRect().bottom,brand:document.querySelector('.bb-wordmark').getBoundingClientRect().top,position:getComputedStyle(document.querySelector('.bb-pull-refresh')).position}))
          assert.equal(scrolling.position,'absolute');assert.ok(scrolling.spinner<scrolling.brand,'Loading stays above the brand while scrolling')
          assert.ok(Math.abs((await page.locator('.bb-pull-refresh').boundingBox()).y-anchorBefore.y+160)<1,'Loading scrolls out with the document instead of overlaying content')
          await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('#refresh-scroll-fixture').remove()})
          await page.waitForFunction(()=>scrollY===0)
          while(!releaseCheck)await page.waitForTimeout(10)
          holdCheck=false;releaseCheck()
          await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='done')
          await page.waitForTimeout(80)
          const revealing=await page.locator('.bb-pull-check').evaluate(node=>Number(getComputedStyle(node).opacity))
          assert.ok(revealing>0&&revealing<1,'The checkmark must ease into view')
          const celebration=await page.locator('.bb-pull-burst').evaluate(n=>({animation:getComputedStyle(n).animationName,opacity:Number(getComputedStyle(n).opacity)}))
          assert.equal(celebration.animation,'bb-pull-burst');assert.ok(celebration.opacity>0,'Success emits radial lines')
          assert.equal(await page.locator('.bb-pull-disc').evaluate(n=>getComputedStyle(n).animationName),'bb-pull-pop')
          await page.waitForTimeout(280)
          assert.equal(await page.locator('.bb-pull-check').evaluate(node=>Number(getComputedStyle(node).opacity)),1)
          assert.equal(await page.locator('.bb-pull-progress').evaluate(node=>Number(getComputedStyle(node).opacity)),0)
          await page.screenshot({path:'/tmp/bookiebot-pull-refresh-success.png'})
          await page.waitForTimeout(250)
          assert.equal(await page.locator('.bb-pull-burst').evaluate(n=>Number(getComputedStyle(n).opacity)),0,'The success burst finishes once')
          await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='settling')
          assert.equal(await page.locator('.bb-pull-check').evaluate(node=>Number(getComputedStyle(node).opacity)),1,'The checkmark stays during the final retraction')
          await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='idle')
          const motion=await page.evaluate(()=>{window.__sampleToolbar=false;return window.__toolbarMotion})
          assert.ok(motion.every(frame=>Math.abs(frame.top-original['.bb-shell-header-actions'])<.5),'Top-right controls stay anchored through every refresh animation frame')
          for(const phase of ['refreshing','done','settling'])assert.ok(motion.some(frame=>frame.phase===phase),`Toolbar position sampled during ${phase}`)
          assert.equal(requests.filter(r=>r.name==='/app/reconciliation').length,before+1)
          assert.equal(await page.evaluate(()=>scrollY),0,'The gesture must not reload/navigate or scroll the document')
          // A pull from an ordinary filter button, even with a sideways start,
          // must reveal the indicator. A short release still cancels.
          const controlCount=requests.filter(r=>r.name==='/app/reconciliation').length
          await gesture(page,150,{selector:'.bb-reconcile-filters button',finish:false,drift:true})
          await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.visible==='true')
          assert.equal(await page.locator('.bb-pull-refresh').getAttribute('data-phase'),'pulling')
          await page.evaluate(()=>document.dispatchEvent(new Event('touchcancel',{bubbles:true})))
          assert.equal(requests.filter(r=>r.name==='/app/reconciliation').length,controlCount)
          await page.locator('.bb-reconcile-filters button').nth(1).tap()
          assert.equal(await page.locator('.bb-reconcile-filters button').nth(1).getAttribute('aria-pressed'),'true','Normal native taps still select filters')
          // One continuous real pan must scroll normally from below the top and
          // then arm refresh, without requiring another touchstart at the edge.
          if(cdp) {
            await page.evaluate(()=>{
              const space=document.createElement('div');space.id='native-scroll-fixture';space.style.height='1400px';document.body.append(space)
            })
            for(const initialScroll of [120,0]) {
              await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='idle'&&document.querySelector('.bb-pull-refresh-space').getBoundingClientRect().height<.1)
              await page.evaluate(top=>window.scrollTo(0,top),initialScroll)
              await page.waitForFunction(top=>scrollY===top,initialScroll)
              const count=requests.filter(r=>r.name==='/app/reconciliation').length
              const bounds=await page.locator('.bb-reconcile-filters button').first().boundingBox(),x=bounds.x+20,start=bounds.y+bounds.height/2
              await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:start}]})
              for(const delta of [30,80,140,200,280,360,440]) {
                await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:start+delta}]})
                await page.waitForTimeout(35)
              }
              assert.equal(await page.evaluate(()=>scrollY),0,'The browser pans freely to the top')
              await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='armed')
              assert.equal(await page.locator('.bb-pull-refresh-space').evaluate(node=>node.getBoundingClientRect().height),0)
              assert.equal(await page.evaluate(()=>window.__preventedMoves),0)
              await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
              await page.waitForFunction(()=>document.querySelector('.bb-pull-refresh')?.dataset.phase==='done')
              assert.equal(requests.filter(r=>r.name==='/app/reconciliation').length,count+1,'One native pan performs exactly one refresh')
              assert.equal(await page.locator('.bb-reconcile-filters button').nth(1).getAttribute('aria-pressed'),'true','A native pan from a button does not activate its click')
            }
            await page.evaluate(()=>document.querySelector('#native-scroll-fixture').remove())
          }
        }
        assert.deepEqual(errors,[])
        assert.ok(requests.filter(r=>r.method==='POST').every(r=>r.name==='/app/reconciliation'&&r.body?.operation==='check'),'No financial mutation or notification POSTs')
        await page.close()
      }
    } finally {await browser.close()}
  }
  console.log(`${cases} full-app Chromium/WebKit page refresh cases passed, plus status recovery/native touch/draft preservation; all APIs isolated`)
})().catch(error=>{console.error(error);process.exitCode=1})
