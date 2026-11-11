const assert=require('node:assert/strict');
const {comparisonChart,comparisonAxisLabel}=require('./load_frontend_module.cjs')('comparison-chart.ts');
const near=(a,b)=>assert(Math.abs(a-b)<1e-9,`${a} should match ${b}`);
const photo=comparisonChart([3043.37,3149.82]);
assert.equal(photo.minimum,0);assert.equal(photo.maximum,3500);assert.equal(photo.zero,0);
near(photo.bars[0].width/photo.bars[1].width,3043.37/3149.82);
assert(photo.bars.every(bar=>bar.width>85&&bar.width<95),'Nearly equal spending produces two nearly equal filled bars with headroom');
assert.equal(comparisonAxisLabel(photo.minimum),'$0');assert.equal(comparisonAxisLabel(photo.maximum),'$3,500');
for(const values of [[40,100],[100,40],[100,100],[0,100],[100,0],[0,0],[.01,.02],[1e12,2e12],[-40,100],[-100,-40]]){
 const chart=comparisonChart(values),swapped=comparisonChart([...values].reverse());
 assert.equal(chart.minimum,swapped.minimum);assert.equal(chart.maximum,swapped.maximum,'The common domain does not depend on month order');
 for(let i=0;i<values.length;i++){
  const bar=chart.bars[i];assert(Number.isFinite(bar.start)&&Number.isFinite(bar.width));
  assert(bar.start>=0&&bar.width>=0&&bar.start+bar.width<=100+1e-9);
  near(bar.width,Math.abs(values[i])/(chart.maximum-chart.minimum)*100);
  if(values[i]!==0)assert(bar.width>0&&bar.width<100,'A nonzero month cannot appear empty or define a 100% progress goal');
 }
}
assert.deepEqual(comparisonChart([NaN,Infinity,-Infinity]).bars.map(x=>x.width),[0,0,0]);
assert.equal(comparisonAxisLabel(.05),'$0.05');
assert.equal(comparisonAxisLabel(1.25),'$1.25','Axis labels retain fractional dollar limits');
assert.equal(comparisonChart([.01,.02]).maximum,.03,'Cent-sized amounts have an accurately labeled cent-sized axis');
console.log('Shared dollar scale: screenshot ratios, zero/equal/reversed/negative/large values, visible headroom and axis labels pass');
