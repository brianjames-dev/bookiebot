const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json')),React=req('react'),{act,create}=req('react-test-renderer'),ts=req('typescript');global.IS_REACT_ACT_ENVIRONMENT=true;
function fixture(reduced=false){const timers=new Map(),events=new Map(),root={attributes:new Set(['inert','aria-hidden']),removeAttribute(name){this.attributes.delete(name)}},splash={dataset:{},removed:false,setAttribute(){},removeEventListener(name){events.delete(name)},addEventListener(name,fn){events.set(name,fn)},remove(){this.removed=true}},exports={};let serial=0;
 const window={matchMedia:()=>({matches:reduced}),setTimeout(fn,ms){timers.set(++serial,{fn,ms});return serial},clearTimeout(id){timers.delete(id)}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('web/expense-report/src/startup-splash.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,require:req,window,document:{getElementById:id=>id==='bookiebot-startup-splash'?splash:id==='bookiebot-expense-report-root'?root:null}});
 return {root,splash,events,timers,...exports}}
(async()=>{
 const f=fixture();let tree;const Harness=({ready})=>{f.useStartupSplash(ready);return null};
 await act(async()=>{tree=create(React.createElement(Harness,{ready:false}))});assert.equal(f.splash.dataset.leaving,undefined);assert(f.root.attributes.has('inert'));
 await act(async()=>tree.update(React.createElement(Harness,{ready:true})));assert.equal(f.splash.dataset.leaving,'true');assert.equal(f.root.attributes.size,0);assert.equal(f.timers.size,1);f.finishStartupSplash();assert.equal(f.timers.size,1,'Strict mode and duplicate readiness cannot restart the transition');
 f.events.get('transitionend')({target:f.splash,propertyName:'transform'});assert(!f.splash.removed);f.events.get('transitionend')({target:f.splash,propertyName:'opacity'});assert(f.splash.removed);assert.equal(f.timers.size,0);await act(async()=>tree.unmount());
 for(const reduced of [false,true]){const g=fixture(reduced);g.finishStartupSplash();assert.equal([...g.timers.values()][0].ms,reduced?0:360);[...g.timers.values()][0].fn();assert(g.splash.removed);assert.equal(g.events.size,0,'A missed transition end cannot strand the splash')}
 console.log('Startup ring readiness, idempotent exit, accessibility handoff, reduced motion and fallback removal passed')
})().catch(e=>{console.error(e);process.exitCode=1});
