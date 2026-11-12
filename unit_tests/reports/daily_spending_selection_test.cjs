const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const req=createRequire(path.resolve('web/expense-report/package.json')),React=req('react'),{act,create}=req('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT=true;
let scroll=0,now=100,tree,selection;const selected=[];
const exportsValue={},source=req('typescript').transpileModule(fs.readFileSync('web/expense-report/src/daily-spending-selection.ts','utf8'),{compilerOptions:{module:1,target:7}}).outputText;
vm.runInNewContext(source,{exports:exportsValue,require:name=>name==='react'?React:{readPageScroll:()=>({y:scroll})},performance:{now:()=>now}});
const surface={querySelector:()=>({getBoundingClientRect:()=>({left:20,right:320,width:300})}),getBoundingClientRect:()=>({top:0,bottom:200})};
function Fixture({labels=['a','b','c']}){selection=exportsValue.useDailySpendingSelection(labels,value=>selected.push(value));return React.createElement('div',{ref:selection.ref})}
const event=(x,y=50,id=1)=>({clientX:x,clientY:y,pointerId:id,button:0,isPrimary:true});
const fire=(name,e)=>act(()=>selection[name](e));
act(()=>{tree=create(React.createElement(Fixture),{createNodeMock:()=>surface})});
fire('onPointerDown',event(30));fire('onPointerMove',event(50));fire('onPointerUp',event(280));
assert.deepEqual(selected,['c'],'Release chooses the final coordinate, even if the last hover was elsewhere');
act(()=>selection.click('c'));assert.equal(selected.length,1,'The generated click must not toggle the selected date off');
fire('onPointerDown',event(150));fire('onPointerUp',event(150));act(()=>selection.click('b'));
assert.deepEqual(selected,['c','b'],'A fresh pure tap retains its original click behavior');
fire('onPointerDown',event(30));fire('onPointerMove',event(150));scroll=50;fire('onPointerUp',event(280));assert.equal(selected.length,2,'Native page scrolling must not select a date');scroll=0;
for(const cancel of ['onPointerCancel','onLostPointerCapture']){fire('onPointerDown',event(30));fire('onPointerMove',event(150));fire(cancel,event(150));fire('onPointerUp',event(280));act(()=>selection.click('c'));assert.equal(selected.length,2)}
fire('onPointerDown',event(30));fire('onPointerMove',event(150));fire('onPointerUp',event(350));act(()=>selection.click('c'));assert.equal(selected.length,2,'An out-of-plot drag cannot fall through to a stale hover click');
fire('onPointerDown',event(30));fire('onPointerMove',event(150));fire('onPointerDown',{...event(150,50,2),isPrimary:false});fire('onPointerUp',event(280));assert.equal(selected.length,2,'A second contact cancels selection');
fire('onPointerDown',event(30));fire('onPointerMove',event(150));act(()=>tree.update(React.createElement(Fixture,{labels:['d','e','f']})));fire('onPointerUp',event(280));act(()=>selection.click('f'));assert.equal(selected.length,2,'Replacing the range cancels an in-progress scrub and its follow-up click');
fire('onPointerDown',event(30));fire('onPointerMove',event(150));fire('onPointerUp',event(150));assert.equal(selected.at(-1),'e');act(()=>selection.click('d',true));assert.equal(selected.at(-1),'d','Keyboard activation remains available after a scrub');
now+=1000;act(()=>selection.click('f'));assert.equal(selected.at(-1),'f');
act(()=>tree.unmount());console.log('Daily graph release coordinates, click deduplication, native scroll, cancellation, range replacement and keyboard selection passed');
