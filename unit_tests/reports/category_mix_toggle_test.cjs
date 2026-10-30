const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const req=createRequire(path.resolve('web/expense-report/package.json')),ts=req('typescript'),React=req('react'),Renderer=req('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT=true
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText
const source=fs.readFileSync('web/expense-report/src/report-app.tsx','utf8'),ast=ts.createSourceFile('app.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const host=ast.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='CategoryMixPieMotionHost')
const runtime={exports:{},require:req,useRef:React.useRef}
vm.runInNewContext(compile(host.getText(ast)+'\nexports.Host=CategoryMixPieMotionHost'),runtime)
let tree,toggles=0
const event=(x=0,y=0,interactive=false)=>({clientX:x,clientY:y,isPrimary:true,target:{closest:()=>interactive?{}:null}})
try{
 Renderer.act(()=>{tree=Renderer.create(React.createElement(runtime.exports.Host,{layout:{containerPadding:10},showCallouts:false,onToggle:()=>toggles++}))})
 const node=tree.root.findByType('div')
 node.props.onPointerDownCapture(event());node.props.onClick(event());assert.equal(toggles,1,'A deliberate background tap toggles callouts')
 node.props.onPointerDownCapture(event());node.props.onClick(event(0,0,true));assert.equal(toggles,1,'Slice, callout, and center button actions never also toggle the background')
 for(const [x,y] of [[30,0],[0,30]]){node.props.onPointerDownCapture(event());node.props.onPointerMoveCapture(event(x,y));node.props.onClick(event(x,y));assert.equal(toggles,1,'Carousel swipes and native scrolling do not toggle callouts')}
 node.props.onPointerDownCapture(event());node.props.onPointerCancel();node.props.onClick(event());assert.equal(toggles,1,'Cancelled touch gestures cannot toggle')
 node.props.onPointerDownCapture(event());node.props.onClick(event());assert.equal(toggles,2,'A second deliberate tap toggles back')
}finally{if(tree)Renderer.act(()=>tree.unmount())}

const animations={exports:{},require:req};vm.runInNewContext(compile(fs.readFileSync('web/expense-report/src/chart-animation.tsx','utf8')),animations)
const animate=animations.exports.categoryRingAnimation
const large={cx:195,cy:190,outerRadius:187,innerRadius:161,startAngle:90,endAngle:-170,paddingAngle:.7,payload:{key:'food'}}
const compact={...large,cx:193,cy:200,outerRadius:110,innerRadius:84}
const snapshot=animate([{status:'matched',prev:large,next:compact}],.4,'centric')[0]
for(const [field,value] of Object.entries({cx:194.2,cy:194,outerRadius:156.2,innerRadius:130.2}))assert.equal(snapshot.animationGeometry[field],value)
assert.equal(snapshot.animationGeometry.outerRadius-snapshot.animationGeometry.innerRadius,26,'Band thickness remains constant throughout the morph')
const reversed=animate([{status:'matched',prev:snapshot,next:large}],0,'centric')[0]
assert.deepEqual(reversed.animationGeometry,snapshot.animationGeometry,'A rapid reverse starts from the current visible geometry without snapping')
const final=animate([{status:'matched',prev:snapshot,next:large}],1,'centric')[0]
assert.equal(final.animationGeometry.outerRadius,187)
assert.equal(final.outerRadius,187,'SVG target coordinates stay stable throughout animation')
console.log('Explicit background toggles preserve slice/callout actions and native gestures; ring size and center morph smoothly through interruption')
