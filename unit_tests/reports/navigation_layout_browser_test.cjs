// Run after npm run build. Set BOOKIEBOT_PLAYWRIGHT_MODULE when Playwright is
// supplied by an external browser-test runtime rather than frontend dependencies.
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '../..')
const frontend = path.join(root, 'web/expense-report')
const req = createRequire(path.join(frontend, 'package.json'))
const { chromium, webkit } = process.env.BOOKIEBOT_PLAYWRIGHT_MODULE
  ? require(process.env.BOOKIEBOT_PLAYWRIGHT_MODULE) : req('playwright')
const css = fs.readFileSync(path.join(root, 'src/bookiebot/reports/assets/expense-report-app.css'), 'utf8')
const bundle = req('esbuild').buildSync({ stdin: { resolveDir: frontend, loader: 'tsx', contents: `
  import React, {useState,useRef,useEffect} from 'react'; import {createRoot} from 'react-dom/client';
  import {KonstaProvider} from 'konsta/react'; import {AppNavigationBar} from './src/app-navigation-bar';
  import {nextScrollNavigation} from './src/app-navigation';
  import {AppHeaderTools} from './src/app-header-tools';
  function Fixture() {
    const [config,setConfig]=useState({active:'overview',compact:false,count:5});
    const scrollState=useRef({lastY:0,travel:0,compact:false});
    useEffect(()=>{const scroll=()=>{if(!window.scrollNav)return;const next=nextScrollNavigation(scrollState.current,scrollY,document.documentElement.scrollHeight-innerHeight);scrollState.current=next;setConfig(current=>({...current,compact:next.compact}));};window.addEventListener('scroll',scroll,{passive:true});return()=>window.removeEventListener('scroll',scroll);},[]);
    window.configure=changes=>setConfig(current=>({...current,...changes}));
    window.currentScreen=config.active;
    return <KonstaProvider theme="ios" dark={window.dark}><div className="bb-app-shell">
      <AppHeaderTools askOpen={!!config.askOpen} settingsOpen={!!config.settings} askDisabled={!!config.disabled} settingsDisabled={!!config.disabled}
        onAsk={()=>setConfig(current=>({...current,askOpen:!current.askOpen}))} onSettings={()=>setConfig(current=>({...current,settings:!current.settings}))}/>
      <AppNavigationBar disabled={!!config.disabled} active={config.active} current={config.settings ? null : config.active} compact={config.compact} reconciliationVisible={config.count===5}
        onSelect={active=>{window.selections.push(active); if(!window.blockNavigation) setConfig(current=>({...current,active}));}}/>
    </div></KonstaProvider>;
  }
  window.selections=[]; createRoot(document.getElementById('root')).render(<Fixture/>);
` }, bundle: true, format: 'iife', write: false, define: { 'process.env.NODE_ENV': '"production"' } }).outputFiles[0].text

async function geometry(page, label, compact) {
  // Let the ResizeObserver run after a tab/count/viewport change.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const result = await page.locator('.bb-navigation-pane').evaluate(host => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const selected = host.querySelector('button[data-state="active"]')
    return {
      selected: selected.getAttribute('aria-label'), committed:window.currentScreen, button: rect(selected),
      bubble: rect(host.querySelector('.bb-navigation-selection')),
      icon: rect(selected.querySelector('.bb-glass-icon')),
      variants: [...host.querySelectorAll('button')].map(n=>({screen:n.dataset.navScreen,selected:n.querySelector('.bb-glass-icon').dataset.selected==='true',fill:getComputedStyle(n.querySelector('.bb-glass-icon-solid svg')).fill,stroke:getComputedStyle(n.querySelector('.bb-glass-icon-outline svg')).stroke,solid:+getComputedStyle(n.querySelector('.bb-glass-icon-solid')).opacity,outline:+getComputedStyle(n.querySelector('.bb-glass-icon-outline')).opacity,text:n.innerText})),
      ink: getComputedStyle(host).color, iconColors: [...host.querySelectorAll('button svg')].map(n=>getComputedStyle(n).color),
      pane: rect(host), stacks: [...host.querySelectorAll('button > span')].map(rect),
      anchor:host.style.getPropertyValue('--bb-nav-position'),lensLeft:getComputedStyle(host.querySelector('.bb-navigation-selection')).left,
      targets: [...host.querySelectorAll('button')].map(rect),
      overflow: document.documentElement.scrollWidth > innerWidth,
    }
  })
  assert.equal(result.selected, label)
  const { button, bubble, icon } = result
  const close = (a, b, message) => assert.ok(Math.abs(a - b) <= 0.25, `${message}: ${a} vs ${b}; ${JSON.stringify(result)}`)
  close(bubble.x + bubble.width / 2, button.x + button.width / 2, 'Bubble must center on the actual selected button')
  close(bubble.y + bubble.height / 2, button.y + button.height / 2, 'Vertical centering')
  close(bubble.x + bubble.width / 2, icon.x + icon.width / 2, 'Icon must center in the bubble')
  assert.ok(result.iconColors.every(color=>color===result.ink),'Selected and outline glyphs use the same neutral ink as the reference')
  const contents = [icon]
  for(const item of result.variants){const committed=item.screen===result.committed;assert.equal(item.text,'','No visible nav labels in either size');assert.equal(item.selected,committed,'Only the committed tab is filled, including during preview');assert.equal(item.solid,committed?1:0,'The filled layer reaches the correct resting opacity');assert.equal(item.outline,committed?0:1,'The outline layer reaches the correct resting opacity');assert.notEqual(item.fill,'none');assert.notEqual(item.stroke,'none')}
  close(icon.width,compact?23:27,'Expanded icons are larger; compact icons keep their current size')
  const centers=result.targets.map(r=>r.x+r.width/2),spacing=centers[1]-centers[0]
  result.targets.forEach(r=>close(r.width,result.targets[0].width,'Equal-width navigation targets'))
  for(let i=2;i<centers.length;i++)close(centers[i]-centers[i-1],spacing,'Icons must be equally spaced')
  const rim=compact?4:5
  close(bubble.height,result.pane.height-rim*2,'Selection has concentric vertical glass inset')
  close(bubble.width,button.width+rim*2,'Broad capsule spans the tab track rather than only its icon')
  assert.ok(bubble.x >= result.pane.x + 1 && bubble.right <= result.pane.right - 1, 'Edge capsules stay inside the glass')
  for (const content of contents) {
    assert.ok(content.x >= bubble.x + 1 && content.right <= bubble.right - 1, `Bubble must enclose ${label} horizontally`)
    assert.ok(content.y >= bubble.y + 1 && content.bottom <= bubble.bottom - 1, `Bubble must enclose ${label} vertically`)
  }
  result.targets.forEach(target => assert.ok(target.width >= 44 && target.height >= 44, 'At least 44px touch targets'))
  assert.equal(result.overflow, false, 'Navigation must not widen the document')
  return { width: bubble.width, height: bubble.height }
}

async function fixture(browser, width, dark, reducedMotion = 'reduce') {
  const page = await browser.newPage({ viewport: { width, height: 700 }, hasTouch: true, reducedMotion })
  await page.route('**/*', route => route.abort())
  await page.setContent(`<!doctype html><html data-theme="${dark ? 'dark' : 'light'}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>window.dark=${dark}</script></body></html>`)
  await page.addScriptTag({ content: bundle })
  await page.locator('.bb-navigation-pane').waitFor()
  return page
}

;(async () => {
  let cases = 0
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true })
    try {
      for (const width of [320, 390, 768]) for (const dark of [false, true]) {
        const page = await fixture(browser, width, dark)
        for (const count of [4, 5]) for (const compact of [false, true]) {
          await page.evaluate(config => window.configure(config), { count, compact })
          let sharedSize
          for (const label of ['Overview', 'Transactions', 'Shared', 'Savings', ...(count === 5 ? ['Reconcile'] : [])]) {
            await page.getByRole('button', { name: label, exact: true }).click()
            const size = await geometry(page, label, compact)
            if (sharedSize) {
              assert.ok(Math.abs(size.width - sharedSize.width) <= 0.25, 'Every tab must use the same capsule width')
              assert.ok(Math.abs(size.height - sharedSize.height) <= 0.25, 'Every tab must use the same capsule height')
            }
            sharedSize = size
          }
          cases++
        }
        // Native touch must select once, including near equal-width target edges.
        await page.evaluate(() => window.configure({ count: 5, compact: false }))
        await geometry(page, 'Reconcile', false)
        const transaction = await page.getByRole('button', { name: 'Transactions', exact: true }).boundingBox()
        const before = await page.evaluate(() => window.selections.length)
        await page.touchscreen.tap(transaction.x + transaction.width - 2, transaction.y + transaction.height / 2)
        await geometry(page, 'Transactions', false)
        assert.equal(await page.evaluate(() => window.selections.length), before + 1, 'Touch must not double-select')
        // Keyboard activation and navigation rejected by the work guard stay aligned.
        await page.getByRole('button', { name: 'Savings', exact: true }).focus()
        await page.keyboard.press('Space')
        await geometry(page, 'Savings', false)
        await page.evaluate(() => { window.blockNavigation = true })
        await page.getByRole('button', { name: 'Shared', exact: true }).click()
        await geometry(page, 'Savings', false)
        await page.touchscreen.tap(transaction.x + 3, transaction.y + transaction.height / 2)
        await geometry(page, 'Savings', false)
        await page.evaluate(() => window.configure({ settings: true }))
        await geometry(page, 'Savings', false)
        assert.equal(await page.locator('.bb-bottom-navigation button[aria-current="page"]').count(), 0, 'Settings retains the bubble without claiming a main tab is the current page')
        if (engine === chromium && width === 320 && dark) {
          await page.evaluate(() => { window.blockNavigation = false; window.configure({ settings: false }) })
          const cdp = await page.context().newCDPSession(page)
          const bounds = await page.locator('.bb-navigation-link').evaluateAll(buttons => buttons.map(button => { const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } }))
          const previous = await page.evaluate(() => window.selections.length)
          const touch = async (type, point) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] })
          await touch('touchStart', bounds[0])
          await touch('touchMove', bounds[1])
          await geometry(page, 'Transactions', false)
          await touch('touchMove', bounds[4])
          await geometry(page, 'Reconcile', false)
          await touch('touchEnd')
          await geometry(page, 'Reconcile', false)
          assert.equal(await page.evaluate(() => window.selections.length), previous + 1, 'Dragging selects once on release')
          await touch('touchStart', bounds[0])
          await touch('touchMove', bounds[1])
          await touch('touchCancel')
          await geometry(page, 'Reconcile', false)
          assert.equal(await page.evaluate(() => window.selections.length), previous + 1, 'A cancelled gesture cannot navigate')
          await cdp.detach()
        }
        await page.close()
      }
      const moving = await fixture(browser, 390, true, 'no-preference')
      await moving.evaluate(()=>window.configure({active:'transactions'}));await moving.waitForTimeout(700)
      await moving.evaluate(() => {
        window.scrollNav=true;document.body.style.minHeight='2000px'
        window.__compactFrames=[];window.__sampleCompact=true;window.__resizeWrites=0;window.__navMutation=new MutationObserver(records=>window.__resizeWrites+=records.filter(r=>r.attributeName==='style').length);window.__navMutation.observe(document.querySelector('.bb-navigation-pane'),{attributes:true,subtree:true})
        const sample=()=>{if(!window.__sampleCompact)return;const pane=document.querySelector('.bb-navigation-pane'),lens=pane.querySelector('.bb-navigation-selection').getBoundingClientRect(),button=pane.querySelector('button[data-state="active"]').getBoundingClientRect(),r=pane.getBoundingClientRect();window.__compactFrames.push({width:r.width,height:r.height,error:Math.abs(lens.x+lens.width/2-button.x-button.width/2)});requestAnimationFrame(sample)};sample()
      })
      for (const compact of [true, false]) {
        await moving.evaluate(compact => window.scrollTo(0,compact?160:20),compact)
        await moving.locator(`.bb-bottom-navigation[data-compact="${compact}"]`).waitFor()
        await moving.waitForTimeout(600)
        await geometry(moving, 'Transactions', compact)
      }
      // Reversing before the shrink finishes must continue from its painted
      // size, and every icon/selection must remain aligned throughout.
      await moving.evaluate(()=>window.scrollTo(0,200));await moving.waitForTimeout(100)
      await moving.evaluate(()=>window.scrollTo(0,100));await moving.waitForTimeout(600)
      await geometry(moving,'Transactions',false)
      const compactFrames=await moving.evaluate(()=>{window.__sampleCompact=false;window.__navMutation.disconnect();return window.__compactFrames})
      assert.equal(await moving.evaluate(()=>window.__resizeWrites),0,'Shrinking/expanding performs no observer-driven inline style writes')
      assert.ok(Math.max(...compactFrames.map(f=>f.error))<1.2,'The selected capsule stays with its icon while shrinking, expanding and reversing')
      assert.ok(new Set(compactFrames.map(f=>Math.round(f.height*10))).size>=6,'Bar shrink and expansion paint intermediate sizes')
      await moving.setViewportSize({ width: 320, height: 700 })
      await moving.waitForTimeout(600)
      await geometry(moving, 'Transactions', false)
      // Real animation frames must travel continuously and retarget from the
      // visible lens, with a small elastic settle instead of a jump/crossfade.
      await moving.evaluate(()=>window.configure({active:'overview'}));await moving.waitForTimeout(700)
      await moving.evaluate(()=>{
        window.__navFrames=[];window.__sampleNav=true;window.__navSvgNodes=[...document.querySelectorAll('.bb-navigation-pane svg')]
        const sample=()=>{if(!window.__sampleNav)return;const pane=document.querySelector('.bb-navigation-pane'),lens=pane.querySelector('.bb-navigation-selection'),surface=pane.querySelector('.bb-navigation-lens-surface'),r=lens.getBoundingClientRect();window.__navFrames.push({x:r.x,width:r.width,paintWidth:surface.getBoundingClientRect().width,solid:+getComputedStyle(pane.querySelector('[data-nav-screen="reconcile"] .bb-glass-icon-solid')).opacity,outline:+getComputedStyle(pane.querySelector('[data-nav-screen="reconcile"] .bb-glass-icon-outline')).opacity});requestAnimationFrame(sample)};sample()
      })
      const resting=await moving.locator('.bb-navigation-selection').boundingBox()
      await moving.getByRole('button',{name:'Reconcile',exact:true}).click();await moving.waitForTimeout(110)
      const beforeRetarget=await moving.locator('.bb-navigation-selection').boundingBox()
      assert.ok(beforeRetarget.x>resting.x+5,'The lens actually slides across intervening tabs')
      await moving.getByRole('button',{name:'Transactions',exact:true}).click();await moving.waitForTimeout(700)
      await geometry(moving,'Transactions',false)
      const frames=await moving.evaluate(()=>{window.__sampleNav=false;return window.__navFrames})
      assert.ok(new Set(frames.map(f=>Math.round(f.x*10))).size>=6,'The browser paints intermediate positions')
      assert.ok(frames.some(f=>f.paintWidth>f.width*1.015),'The lens gently deforms in transit')
      assert.ok(frames.some(f=>f.solid>0&&f.solid<1&&f.outline>0&&f.outline<1),'Icon silhouettes ease through overlapping opacity in both directions')
      assert.equal(await moving.evaluate(()=>window.__navSvgNodes.every((node,i)=>node===document.querySelectorAll('.bb-navigation-pane svg')[i])),true,'SVG layers persist across release and interrupted selection')
      const surface=await moving.locator('.bb-navigation-lens-surface').boundingBox(),settled=await moving.locator('.bb-navigation-selection').boundingBox()
      assert.ok(Math.abs(surface.width-settled.width)<.25,'The settled material relaxes completely');cases++
      // Held previews retain the committed icon, gently lift the bar and
      // normalize live finger tracking through that scale in both nav sizes.
      for(const compact of [false,true]) {
        await moving.evaluate(compact=>window.configure({active:'transactions',compact}),compact)
        await moving.waitForTimeout(700);await geometry(moving,'Transactions',compact)
        const pane=moving.locator('.bb-navigation-pane'),rest=await pane.boundingBox(),restColor=await pane.evaluate(el=>getComputedStyle(el).backgroundColor)
        const button=await moving.getByRole('button',{name:'Transactions',exact:true}).boundingBox(),x=button.x+button.width/2,y=button.y+button.height/2
        const restIcon=await moving.getByRole('button',{name:'Transactions',exact:true}).locator('.bb-glass-icon').boundingBox()
        const event=async(type,x,y)=>pane.evaluate((el,{type,x,y})=>el.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:81,pointerType:'touch',clientX:x,clientY:y})),{type,x,y})
        await pane.evaluate(el=>{window.__capturePointer=el.setPointerCapture;el.setPointerCapture=()=>{};window.__holdFrames=[];window.__sampleHold=true;const sample=()=>{if(!window.__sampleHold)return;window.__holdFrames.push(el.getBoundingClientRect().width);requestAnimationFrame(sample)};sample()})
        const selections=await moving.evaluate(()=>window.selections.length)
        await event('pointerdown',x,y);await moving.waitForTimeout(100)
        await event('pointermove',x+12,y);await moving.waitForTimeout(300)
        const following=await moving.locator('.bb-navigation-selection').boundingBox(),held=await pane.boundingBox()
        const heldIcon=await moving.getByRole('button',{name:'Transactions',exact:true}).locator('.bb-glass-icon').boundingBox()
        assert.ok(Math.abs(following.x+following.width/2-x-12)<1,'The lens stays under the finger while the bar lifts')
        assert.notEqual(await pane.evaluate(el=>getComputedStyle(el).backgroundColor),restColor,'Holding changes the whole glass hue')
        assert.ok(Math.abs(held.width/rest.width-1.035)<.001,'A held bar grows subtly by three and a half percent')
        assert.ok(heldIcon.width-restIcon.width>.75&&heldIcon.width-restIcon.width<1.05,'Held icons grow slightly more in either size')
        const holdFrames=await moving.evaluate(()=>{window.__sampleHold=false;return window.__holdFrames})
        assert.ok(holdFrames.some(w=>w>rest.width*1.002&&w<rest.width*1.033),'The hold lift eases through intermediate sizes')
        const target=await moving.getByRole('button',{name:'Reconcile',exact:true}).boundingBox(),tx=target.x+target.width/2
        await event('pointermove',tx,y);await moving.waitForTimeout(100)
        assert.equal(await moving.getByRole('button',{name:'Reconcile',exact:true}).locator('.bb-glass-icon').getAttribute('data-selected'),'false','Previewed destinations stay outlined until release')
        assert.equal(await moving.getByRole('button',{name:'Transactions',exact:true}).locator('.bb-glass-icon').getAttribute('data-selected'),'true','The committed tab retains its fill during a swipe')
        assert.equal(await moving.evaluate(()=>window.selections.length),selections,'Holding and previewing cannot navigate')
        if(process.env.BOOKIEBOT_NAV_SCREENSHOT)await moving.screenshot({path:process.env.BOOKIEBOT_NAV_SCREENSHOT.replace('.png',`-${compact?'compact':'expanded'}-held.png`),clip:{x:0,y:610,width:320,height:90}})
        await event('pointerup',tx,y);await moving.waitForTimeout(700);await geometry(moving,'Reconcile',compact)
        assert.equal(await moving.evaluate(()=>window.selections.length),selections+1,'Release commits exactly once and then fills the destination')
        const cancelTarget=await moving.getByRole('button',{name:'Transactions',exact:true}).boundingBox(),cx=cancelTarget.x+cancelTarget.width/2
        await event('pointerdown',cx,y);await moving.waitForTimeout(300)
        assert.equal(await moving.getByRole('button',{name:'Transactions',exact:true}).locator('.bb-glass-icon').getAttribute('data-selected'),'false','Touch-down alone never fills a new icon')
        await event('pointercancel',cx,y);await pane.evaluate(el=>el.setPointerCapture=window.__capturePointer)
        await moving.waitForTimeout(700);await geometry(moving,'Reconcile',compact)
        assert.equal(await moving.evaluate(()=>window.selections.length),selections+1,'Cancellation cannot change the committed icon or tab')
        const released=await pane.boundingBox()
        assert.equal(await pane.evaluate(el=>getComputedStyle(el).backgroundColor),restColor,'Release restores the resting glass hue')
        assert.ok(Math.abs(released.width-rest.width)<.25,'The lifted bar fully relaxes on release or cancellation');cases++
      }
      await moving.evaluate(()=>window.configure({compact:false}));await moving.waitForTimeout(700)
      if (process.env.BOOKIEBOT_NAV_SCREENSHOT) await moving.screenshot({ path: process.env.BOOKIEBOT_NAV_SCREENSHOT, clip: { x: 0, y: 610, width: 320, height: 90 } })
      await moving.close()
      // Exercise the exact header component used by the app, with native mouse
      // down/up so :active follows the browser's actual button lifecycle.
      for(const dark of [false,true])for(const preference of ['reduce','no-preference']) {
        const tools=await fixture(browser,390,dark,preference)
        await tools.evaluate(()=>document.body.style.minHeight='2000px')
        const navColor=await tools.locator('.bb-navigation-pane').evaluate(el=>getComputedStyle(el).backgroundColor)
        for(const label of ['Ask BookieBot','Settings']) {
          const button=tools.getByRole('button',{name:label,exact:true}),glass=button.locator('..')
          const before=await glass.boundingBox(),restColor=await glass.evaluate(el=>getComputedStyle(el).backgroundColor)
          assert.equal(restColor,navColor,'Fixed tools and navigation share the resting glass material')
          assert.ok(before.width>=44&&before.height>=44,'Independent header targets remain at least 44px')
          const point=await button.boundingBox(),x=point.x+point.width/2,y=point.y+point.height/2
          await tools.evaluate(()=>{window.__toolSvgNodes=[...document.querySelectorAll('.bb-shell-header-actions svg')]})
          await tools.mouse.move(x,y);await tools.mouse.down();await tools.waitForTimeout(300)
          const held=await glass.boundingBox()
          assert.ok(Math.abs(held.width/before.width-(preference==='reduce'?1:1.035))<.001,'Header buttons share the stronger lift and Reduce Motion behavior')
          assert.notEqual(await glass.evaluate(el=>getComputedStyle(el).backgroundColor),restColor,'The held tool receives the same whole-surface tint')
          assert.equal(await button.locator('.bb-glass-icon').getAttribute('data-selected'),'false','Held tools stay outlined until activation')
          await button.evaluate(el=>{window.__toolFrames=[];window.__sampleTool=true;const sample=()=>{if(!window.__sampleTool)return;window.__toolFrames.push(+getComputedStyle(el.querySelector('.bb-glass-icon-solid')).opacity);requestAnimationFrame(sample)};sample()})
          await tools.mouse.up();await tools.waitForTimeout(260)
          assert.equal(await button.locator('.bb-glass-icon').getAttribute('data-selected'),'true','Activated tools fill only after release')
          await button.focus();await tools.keyboard.press('Space');await tools.waitForTimeout(260)
          const opacity=await tools.evaluate(()=>{window.__sampleTool=false;return window.__toolFrames})
          if(preference==='no-preference')assert.ok(opacity.some(v=>v>0&&v<1),'Header solid/outline transitions crossfade on activation and return')
          else assert.ok(opacity.every(v=>v===0||v===1),'Reduce Motion switches silhouette without animation')
          assert.equal(await button.locator('.bb-glass-icon').getAttribute('data-selected'),'false')
          assert.equal(await tools.evaluate(()=>window.__toolSvgNodes.every((node,i)=>node===document.querySelectorAll('.bb-shell-header-actions svg')[i])),true,'Header SVGs are retained across toggles')
          assert.equal(await glass.evaluate(el=>getComputedStyle(el).backgroundColor),restColor,'Header tint relaxes after release')
          await tools.evaluate(()=>window.scrollTo(0,160));await tools.waitForTimeout(60)
          const scrolled=await glass.boundingBox();assert.ok(Math.abs(scrolled.x-before.x)<.25&&Math.abs(scrolled.y-before.y)<.25,'Header tools retain their fixed screen anchors while scrolling')
          await tools.evaluate(()=>window.scrollTo(0,0));cases++
        }
        await tools.evaluate(()=>window.configure({disabled:true}))
        const disabled=tools.getByRole('button',{name:'Settings',exact:true}),box=await disabled.boundingBox()
        await tools.mouse.move(box.x+box.width/2,box.y+box.height/2);await tools.mouse.down();await tools.waitForTimeout(280)
        assert.equal(await disabled.locator('.bb-glass-icon').getAttribute('data-selected'),'false')
        const unlifted=await disabled.locator('..').boundingBox();assert.ok(Math.abs(unlifted.width-44)<.25,'Disabled tools never acquire a held lift')
        await tools.mouse.up()
        if(process.env.BOOKIEBOT_NAV_SCREENSHOT&&dark&&preference==='no-preference')await tools.screenshot({path:process.env.BOOKIEBOT_NAV_SCREENSHOT.replace('.png','-tools.png'),clip:{x:0,y:0,width:390,height:100}})
        await tools.close()
      }
    } finally { await browser.close() }
  }
  console.log(`${cases} Chromium/WebKit layout combinations passed: all tab bounds, touch, keyboard, guarded selection, resize and compact transitions`)
})().catch(error => { console.error(error); process.exit(1) })
