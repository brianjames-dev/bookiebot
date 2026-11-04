const assert=require('node:assert/strict'),deepEqual=(a,b)=>assert.equal(JSON.stringify(a),JSON.stringify(b))
const model={exports:require('./load_frontend_module.cjs')('transaction-split-model.ts')}
const{allocate,identifySplit,splitNotches,magneticShare,parseShare,quarterShare,sliderShare,stepShare,circleFillHeight}=model.exports
assert.equal(allocate(6842,6500),4447);assert.equal(allocate(845,5000),423);assert.equal(allocate(1,5000),1)
deepEqual(splitNotches(6842,5000),[0,3421,6842]);assert.equal(splitNotches(6842,5100).length,4);assert.equal(identifySplit(3421,6842,5000,'income'),'income');assert.equal(identifySplit(0,6842,6500),'fronted')
const points=splitNotches(10000,6500)
deepEqual(magneticShare(5100,10000,points,240,8,null),{value:5000,held:5000});deepEqual(magneticShare(5400,10000,points,240,8,5000),{value:5000,held:5000});assert.equal(magneticShare(5800,10000,points,240,8,5000).value,5800)
assert.equal(magneticShare(6500,10000,points,240,8,5000).value,6500);assert.equal(magneticShare(5200,10000,splitNotches(10000,5200),240,8,5000).value,5200)
const near=pixels=>Math.round(5000+pixels/240*10000)
assert.equal(magneticShare(near(6),10000,points,240,7,null).value,5000)
assert.notEqual(magneticShare(near(7.5),10000,points,240,7,null).value,5000)
assert.equal(magneticShare(near(7.5),10000,points,240,8,null).value,5000)
assert.equal(magneticShare(near(11),10000,points,240,7,5000).value,5000)
assert.notEqual(magneticShare(near(13),10000,points,240,7,5000).value,5000)
assert.equal(magneticShare(near(13),10000,points,240,8,5000).value,5000)
for(const text of['','-1','Infinity','1e2','1.234','100.01','1,00'])assert.equal(parseShare(text,10000),null)
assert.equal(parseShare('0',10000),0);assert.equal(parseShare('100.00',10000),10000);assert.equal(parseShare('12.34',10000),1234)
for(const total of[1,2,3,845,1865,6842,10000001])for(const basis of[0,1,4999,5000,5001,6500,9999,10000]){const own=allocate(total,basis);assert(own>=0&&own<=total);assert.equal(own+(total-own),total)}
assert.equal(quarterShare(1234,6842),1225);assert.equal(quarterShare(1264,6842),1275);assert.equal(quarterShare(6842,6842),6842)
const exact=splitNotches(6842,6500)
assert.equal(sliderShare(3421,6842,exact,240,7,null).value,3421)
assert.equal(sliderShare(4447,6842,exact,240,7,null).value,4447)
assert.equal(stepShare(4447,6842,exact,1),4450);assert.equal(stepShare(4450,6842,exact,-1),4447)
assert.equal(stepShare(3400,6842,exact,1),3421);assert.equal(stepShare(3421,6842,exact,-1),3400)
assert.equal(stepShare(6842,6842,exact,1),6842);assert.equal(stepShare(0,6842,exact,-1),0)
let pointerChecks=0
for(const total of[1,2,3,10,24,25,26,99,100,101,845,1865,6842])for(const basis of[0,1,4999,5000,5001,6500,9999,10000]){
 const notches=splitNotches(total,basis);let held=null,previous=-1
 for(let raw=0;raw<=total;raw++){
  const resolved=sliderShare(raw,total,notches,240,7,held);held=resolved.held
  assert(resolved.value>=previous,JSON.stringify({total,basis,raw,previous,value:resolved.value}));assert(resolved.value>=0&&resolved.value<=total);assert(notches.includes(resolved.value)||resolved.value%25===0);assert.equal(resolved.value+(total-resolved.value),total);previous=resolved.value;pointerChecks++
 }
 held=null;previous=total+1
 for(let raw=total;raw>=0;raw--){const resolved=sliderShare(raw,total,notches,240,7,held);held=resolved.held;assert(resolved.value<=previous,JSON.stringify({total,basis,raw,previous,value:resolved.value}));assert(notches.includes(resolved.value)||resolved.value%25===0);previous=resolved.value;pointerChecks++}
 let current=0,count=0
 while(current<total){const next=stepShare(current,total,notches,1);assert(next>current);assert(notches.includes(next)||next%25===0);current=next;assert(++count<total+5)}
 while(current>0){const next=stepShare(current,total,notches,-1);assert(next<current);assert(notches.includes(next)||next%25===0);current=next;assert(++count<2*total+10)}
}
for(let step=0;step<=100;step++){
 const p=step/100,height=circleFillHeight(p),y=1-2*height/76,area=(Math.acos(Math.min(1,Math.max(-1,y)))-y*Math.sqrt(Math.max(0,1-y*y)))/Math.PI
 assert(Math.abs(area-p)<.000001);assert(Math.abs(height+circleFillHeight(1-p)-76)<.0001)
}
deepEqual(splitNotches(46472,6473,30081),[0,23236,30081,46472]);assert.equal(identifySplit(30081,46472,6473,'custom',30081),'income')
console.log('Split notches, exact server income target, quarter steps, gentle magnetism, circular fill and '+pointerChecks+' bidirectional pointer samples passed')
