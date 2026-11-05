const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), {createRequire} = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json')), ts = req('typescript'), modules = new Map()
function load(name) {
  const filename = path.resolve('web/expense-report/src', name + '.ts')
  if (modules.has(filename)) return modules.get(filename)
  const exports = {}; modules.set(filename, exports)
  const source=fs.readFileSync(filename,'utf8')+(name==='category-mix-layout'?'\nexport {curveStems};':'')
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText
  new Function('exports','require','structuredClone',code)(exports, target => load(target.replace('./', '')), structuredClone)
  return exports
}
const {prepareContourScene, refineContourScene, contourLabel, CONTOUR_STYLE} = load('category-mix-layout')
const {createContourPathProbe} = load('category-mix-path')
const raw = [['rent','Rent',2500],['bills','Bills & Utilities',380],['needs-subscriptions','Subscriptions (Needs)',180],['need','Need transactions',650],['grocery','Grocery',680],['gas','Gas',250],['food','Food',1329.32],['shopping','Shopping',540],['wants-subscriptions','Subscriptions (Wants)',160],['savings','Cash saved',1596.62],['espp','SpaceX ESPP',400],['left','Income left',1317.14]]
const measure = (text, size) => text.length * size * .56
function input(rows, width) { const size=11; return rows.map(([id,label,amount])=>{const name=contourLabel(id,label),amountLabel=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(amount)+' / '+new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(amount/rows.reduce((sum,row)=>sum+Math.max(0,row[2]),0)*100)+'%';return {id,name,amount,amountLabel,width:Math.ceil(Math.max(measure(name,size),measure(amountLabel,size))+12)}}) }
assert.equal(CONTOUR_STYLE.diameter,219);assert.equal(CONTOUR_STYLE.thickness,26);assert.equal(CONTOUR_STYLE.labelSize,11);assert.equal(CONTOUR_STYLE.labelGap,6);assert.equal(CONTOUR_STYLE.inset,8);assert.equal(CONTOUR_STYLE.drift,36)
assert.equal(contourLabel('needs-subscriptions','Subscriptions (Needs)'),'Subs (Needs)')
assert.equal(contourLabel('needs_subscriptions','Recurring costs'),'Subs (Needs)')
assert.equal(contourLabel('wants-subscriptions','Subscriptions (Wants)'),'Wants subs')
assert.equal(contourLabel('static_bills_subscriptions_needs','Static Bills & Subscriptions'),'Subs (Needs)')
assert.equal(contourLabel('need','Need transactions'),'Other needs')
assert.equal(contourLabel('bills','Bills & Utilities'),'Bills & utils')
function validate(scene) {
  assert.ok(scene.routes, 'A complete collision-free route plan must exist')
  assert.equal(scene.curvedRoutes.length,scene.items.length,'Every visible allocation has its own stem')
  assert.equal(scene.radius-scene.inner,26,'The selected band thickness is retained')
  for(let i=0;i<scene.items.length;i++) {
    const a=scene.items[i]
    assert.ok(a.x>=scene.style.inset-.1&&a.x+a.width<=scene.width-scene.style.inset+.1&&a.y-a.height/2>=scene.style.inset-.1&&a.y+a.height/2<=scene.height-scene.style.inset+.1,'Labels fit the actual host')
    assert.ok(/^\$[\d,]+ \/ [\d.]+%$/.test(a.amountLabel),'Only callout amounts use whole-dollar formatting')
    for(const b of scene.items.slice(i+1))assert.ok(a.x+a.width+scene.style.labelGap-.2<=b.x||b.x+b.width+scene.style.labelGap-.2<=a.x||a.y+a.height/2+scene.style.labelGap-.2<=b.y-b.height/2||b.y+b.height/2+scene.style.labelGap-.2<=a.y-a.height/2,'Callout containers never overlap')
  }
  const probe=createContourPathProbe(),sampled=[]
  for(const route of scene.curvedRoutes) {
    assert.notEqual(route.smoothing,'unresolved');assert.match(route.d,/[CQ]/,'Obstacle detours must retain rounded bends')
    probe.setAttribute('d',route.d)
    for(let at=0;at<probe.getTotalLength();at+=1.2) {
      const p=probe.getPointAtLength(at)
      assert.ok(Math.hypot(p.x-scene.cx,p.y-scene.cy)>scene.radius+.3,'Stems remain outside the ring')
      for(const b of scene.items) {
        if(b.id===route.id)continue
        const r=Math.min(18,b.height/2,b.width/2),qx=Math.abs(p.x-b.x-b.width/2)-b.width/2+r,qy=Math.abs(p.y-b.y)-b.height/2+r
        assert.ok(Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)-r>.8,'Stems avoid other rounded cards')
      }
      sampled.push({id:route.id,...p})
    }
  }
  const cells=new Map()
  for(const p of sampled) {
    const x=Math.floor(p.x/4),y=Math.floor(p.y/4)
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const q of cells.get(`${x+dx},${y+dy}`)||[])if(q.id!==p.id)assert.ok(Math.hypot(q.x-p.x,q.y-p.y)>1.5,'Stems never cross or share a stroke')
    const key=`${x},${y}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(p)
  }
}
let count=0
for(const [width,height] of [[288,350],[358,374],[388,396],[700,400]]) {
  const rows=input(raw,width),before=JSON.stringify(rows),scene=refineContourScene(prepareContourScene(rows,width,height));validate(scene);count++;console.log('geometry',width,height)
  assert.equal(JSON.stringify(rows),before,'Layout must not mutate financial inputs')
  if(scene.assignment)assert.ok(scene.assignment.after<=scene.assignment.before,'Optional seed swaps improve the cheap placement estimate')
}
for(const rows of [raw.slice(0,6),raw.slice(6,9),raw.slice(9),[['rent','Rent',100]],[],[['food','Food',0],['gas','Gas',-10]], [['need','Need transactions',110],['coverage-savings-needs','Needs overspend coverage',40],['left','Income left',350]]]) {
  const scene=refineContourScene(prepareContourScene(input(rows,358),358,374));validate(scene);count++
}
console.log(`${count} Refined flow geometry cases: measured whole-dollar cards, 26px band, rounded independent stems, bounded placement, no collisions, zero/refund/coverage cases`)

// Deliberately crowded measured names force all bounded spacing retries.
// A retry must not silently restore the default diameter, band, inset or drift.
const crowded=refineContourScene(prepareContourScene(input(raw,240).map(row=>({...row,width:210})),240,200,{diameter:193,thickness:24,labelSize:11,labelGap:8,inset:14,drift:17}))
assert.equal(crowded.style.labelGap,14,'Crowded geometry exercises all three spacing retries')
for(const [key,value] of Object.entries({diameter:193,thickness:24,labelSize:11,inset:14,drift:17}))assert.equal(crowded.style[key],value,'Spacing fallback preserves every selected style field')

// A large remaining balance or bill clusters small categories at the ring.
// One failed route used to hide every stem and card after the ring shrank.
for(const [width,height,amounts] of [
  [358,350,[1625,0,80,91,36,300,273,54,15,600,0,6000]],
  [390,280,[2100,240,176,465,25,10,13,13,34,0,0,0]],
]) {
  const rows=input(raw.map((row,i)=>[row[0],row[1],amounts[i]]),width)
  const before=JSON.stringify(rows),prepared=prepareContourScene(rows,width,height),scene=refineContourScene(prepared)
  validate(scene)
  assert.equal(scene.items.length,amounts.filter(amount=>amount>0).length)
  assert.equal(JSON.stringify(rows),before,'Dense routing never mutates category inputs')
  for(const item of scene.items) {
    const original=prepared.items.find(row=>row.id===item.id)
    for(const key of ['amount','amountLabel','start','end','mid'])assert.equal(item[key],original[key],'Dense routing preserves exact values and slice angles')
  }
}
console.log('Dense early-month/zero-income callouts retain every card, separate curved stems and exact financial inputs')

// A broad slice can attach away from its midpoint. Its nearest free corner
// should beat the long trip down a seeded column, regardless of category ID.
for(const rename of [false,true]) {
  const amounts=[2100,240,176,465,25,10,13,13,34,0,0,3798]
  const prepared=prepareContourScene(input(raw.map((row,i)=>[row[0],row[1],amounts[i]]),390),390,354)
  if(rename)prepared.items.forEach((item,index)=>{item.id=`allocation-${index}`})
  const scene=refineContourScene(prepared);validate(scene)
  const largest=scene.items.reduce((a,b)=>a.amount>b.amount?a:b)
  assert.ok(largest.x+largest.width/2<scene.cx&&largest.y<scene.cy-scene.radius,'The broad left slice uses available space above/left of the ring')
  const probe=createContourPathProbe()
  for(const item of scene.items) {
    const route=scene.curvedRoutes.find(route=>route.id===item.id)
    probe.setAttribute('d',route.d)
    assert.ok(probe.getTotalLength()>=18,'Short stems remain visible and readable')
    const angle=item.anchorAngle??item.mid
    assert.ok(angle>=item.start&&angle<=item.end,'Attachments remain inside their actual slice')
    if(item.amount>=2000)assert.ok(probe.getTotalLength()<65,'Broad slices use nearby free space instead of long routed detours')
  }
  assert.ok(Math.abs(largest.anchorAngle-largest.mid)>.3,'A large slice is not pinned to its midpoint')
  assert.ok(scene.placement.after<=scene.placement.before,'Routed refinement only accepts verified cost improvements')
  assert.ok(scene.placement.trials<=24,'Free placement has a bounded routing budget')
}
console.log('Category-independent grid candidates shorten broad-slice stems without losing visibility or slice identity')

// Report order differs from grouping order: a tiny Wants subscription can sit
// between larger Needs and several adjacent small slices. Keep this synthetic
// near-boundary case complete and quick, including fractional host heights.
const projectedRows=[['rent','Rent',2101.37],['bills_utilities','Bills & Utilities',241.73],['static_bills_subscriptions_needs','Subscriptions (Needs)',237.29],['need_expenses','Need transactions',466.39],['subscriptions_wants','Subscriptions (Wants)',34.17],['grocery','Grocery',25.49],['gas','Gas',10.13],['food','Food',13.47],['shopping','Shopping',24.11],['left','Income left',3719.85]]
const measuredWidths=[95,79,84,79,83,71,71,71,71,95]
const projected=prepareContourScene(input(projectedRows,390).map((row,index)=>({...row,width:measuredWidths[index]})),390,354.1)
const started=performance.now(),quick=refineContourScene(projected),elapsed=performance.now()-started
validate(quick)
assert.ok(elapsed<1500,`A cold projected layout must not run a multi-second search (${Math.round(elapsed)}ms)`)
console.log('Cold mixed-order Projected layout resolves in',Math.round(elapsed),'ms')

// The shell's category order and measured card widths can make all of the
// first placement's shuffled route orders fail. Bound that cold work too.
const shellRows=[['rent','Rent',2100],['bills_utilities','Bills & Utilities',240],['static_bills_subscriptions_needs','Subscriptions (Needs)',176],['need_expenses','Need transactions',465],['grocery','Grocery',25],['gas','Gas',10],['food','Food',13],['shopping','Shopping',13],['subscriptions_wants','Subscriptions (Wants)',34],['left','Income left',3798]]
const shellWidths=[95,79,84,79,71,71,71,71,73,95]
const shellStarted=performance.now(),shellLayout=refineContourScene(prepareContourScene(input(shellRows,390).map((row,index)=>({...row,width:shellWidths[index]})),390,354.1))
validate(shellLayout)
assert.ok(performance.now()-shellStarted<1500,'Cold shell category order must not exhaust route permutations before revealing')
console.log('Cold full-shell Projected layout resolves in',Math.round(performance.now()-shellStarted),'ms')

const needsKeys=new Set(['rent','bills_utilities','static_bills_subscriptions_needs','need_expenses','grocery','gas','left'])
const needsRows=projectedRows.filter(row=>needsKeys.has(row[0])).map(row=>row[0]==='left'?[row[0],row[1],354.6]:row)
const needsWidths=[95,70,84,86,71,71,86]
const needsStarted=performance.now(),needsLayout=refineContourScene(prepareContourScene(input(needsRows,390).map((row,index)=>({...row,width:needsWidths[index]})),390,354.1))
validate(needsLayout)
assert.ok(performance.now()-needsStarted<1500,'Scoped Projected Needs must also finish with a complete, timely plan')

const investingRows=[...projectedRows.filter(row=>row[0]!=='left'),['espp','SpaceX ESPP',600.12],projectedRows.at(-1)]
const investingPrepared=prepareContourScene(input(investingRows,390),390,354.1),investingBefore=JSON.stringify(investingPrepared)
const investingStarted=performance.now(),investingLayout=refineContourScene(investingPrepared)
validate(investingLayout)
assert.ok(performance.now()-investingStarted<1500,'Projected ESPP must not turn a dense first reveal into an incomplete or multi-second search')
assert.equal(JSON.stringify(investingPrepared),investingBefore,'The ordered fallback does not mutate the prepared input')
for(const item of investingLayout.items)for(const key of ['amount','amountLabel','start','end','mid'])assert.equal(item[key],investingPrepared.items.find(i=>i.id===item.id)[key],'The ordered fallback preserves exact financial inputs and slice angles')
const renamedInvesting=structuredClone(investingPrepared)
renamedInvesting.items.forEach((item,index)=>{item.id=`renamed-${index}`})
validate(refineContourScene(renamedInvesting))

// Reusing identical route endpoints is only safe when the card obstacles also
// match. A wider neighboring label can block a previously clear connection.
const {curveStems}=load('category-mix-layout')
const obstacles=prepareContourScene(input([['a','A',10],['b','B',20]],390),390,354)
Object.assign(obstacles,{cx:195,cy:177,radius:80})
Object.assign(obstacles.items[0],{x:155,y:24,width:80,height:32,mid:0})
Object.assign(obstacles.items[1],{x:300,y:70,width:20,height:20,mid:Math.PI/2})
obstacles.routes=[{id:'a',edge:'bottom',points:[[195,95],[195,85],[195,50],[195,40]]},{id:'b',edge:'right',points:[[277,177],[289,177],[340,177],[340,70],[320,70]]}]
assert.ok(curveStems(obstacles,true).every(r=>r.smoothing!=='unresolved'))
obstacles.items[1].x=185;obstacles.items[1].width=135
assert.equal(curveStems(obstacles,true).find(r=>r.id==='a').smoothing,'unresolved','Cached curve validation must include the current card bounds')
