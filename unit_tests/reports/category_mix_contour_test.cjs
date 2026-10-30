const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), {createRequire} = require('node:module')
const req = createRequire(path.resolve('web/expense-report/package.json')), ts = req('typescript'), modules = new Map()
function load(name) {
  const filename = path.resolve('web/expense-report/src', name + '.ts')
  if (modules.has(filename)) return modules.get(filename)
  const exports = {}; modules.set(filename, exports)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}}).outputText
  new Function('exports','require','structuredClone',code)(exports, target => load(target.replace('./', '')), structuredClone)
  return exports
}
const {prepareContourScene, refineContourScene, contourLabel, CONTOUR_STYLE} = load('category-mix-layout')
const {createContourPathProbe} = load('category-mix-path')
const raw = [['rent','Rent',2500],['bills','Bills & Utilities',380],['needs-subscriptions','Subscriptions (Needs)',180],['need','Need transactions',650],['grocery','Grocery',680],['gas','Gas',250],['food','Food',1329.32],['shopping','Shopping',540],['wants-subscriptions','Subscriptions (Wants)',160],['savings','Cash saved',1596.62],['espp','SpaceX ESPP',400],['left','Income left',1317.14]]
const measure = (text, size) => text.length * size * .56
function input(rows, width) { const size=width<330?11.5:12; return rows.map(([id,label,amount])=>{const name=contourLabel(id,label),amountLabel=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(amount)+' / '+new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(amount/rows.reduce((sum,row)=>sum+Math.max(0,row[2]),0)*100)+'%';return {id,name,amount,amountLabel,width:Math.ceil(Math.max(measure(name,size),measure(amountLabel,size))+12)}}) }
assert.equal(CONTOUR_STYLE.diameter,220);assert.equal(CONTOUR_STYLE.thickness,26);assert.equal(CONTOUR_STYLE.drift,23)
assert.equal(contourLabel('needs-subscriptions','Subscriptions (Needs)'),'Needs subs')
assert.equal(contourLabel('wants-subscriptions','Subscriptions (Wants)'),'Wants subs')
assert.equal(contourLabel('static_bills_subscriptions_needs','Static Bills & Subscriptions'),'Needs subs')
assert.equal(contourLabel('need','Need transactions'),'Other needs')
assert.equal(contourLabel('bills','Bills & Utilities'),'Bills & utils')
function validate(scene) {
  assert.ok(scene.routes, 'A complete collision-free route plan must exist')
  assert.equal(scene.curvedRoutes.length,scene.items.length,'Every visible allocation has its own stem')
  assert.equal(scene.radius-scene.inner,26,'The selected band thickness is retained')
  for(let i=0;i<scene.items.length;i++) {
    const a=scene.items[i]
    assert.ok(a.x>=9.9&&a.x+a.width<=scene.width-9.9&&a.y-a.height/2>=9.9&&a.y+a.height/2<=scene.height-9.9,'Labels fit the actual host')
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
  assert.ok(scene.assignment.routedAfter.cost<=scene.assignment.routedBefore.cost,'Swaps are accepted against actual curved paths')
}
for(const rows of [raw.slice(0,6),raw.slice(6,9),raw.slice(9),[['rent','Rent',100]],[],[['food','Food',0],['gas','Gas',-10]], [['need','Need transactions',110],['coverage-savings-needs','Needs overspend coverage',40],['left','Income left',350]]]) {
  const scene=refineContourScene(prepareContourScene(input(rows,358),358,374));validate(scene);count++
}
console.log(`${count} Refined flow geometry cases: measured whole-dollar cards, 26px band, rounded independent stems, efficient swaps, no collisions, zero/refund/coverage cases`)
