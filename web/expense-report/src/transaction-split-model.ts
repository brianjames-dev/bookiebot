export type SplitMethod='income'|'equal'|'fronted'|'custom'
export const splitMoney=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100)
import {ratioShareCents} from './split-ratio'
export const allocate=(total:number,basis:number)=>ratioShareCents(total,[basis,10000])
export function splitMethodLabel(method:SplitMethod,incomeBasis:number,partnerName='your partner'){return method==='income'?`By income · ${incomeBasis/100}/${100-incomeBasis/100}`:method==='equal'?'50/50':method==='fronted'?`Fronted for ${partnerName}`:'Custom split'}
export function splitNotches(total:number,incomeBasis:number,incomeCents=allocate(total,incomeBasis)){return [...new Set([0,allocate(total,5000),incomeCents,total])].sort((a,b)=>a-b)}
export function identifySplit(cents:number,total:number,incomeBasis:number,preferred:SplitMethod='custom',incomeCents=allocate(total,incomeBasis)):SplitMethod{
 if(cents===0)return 'fronted'
 if(preferred==='income'&&cents===incomeCents)return 'income'
 if(cents===allocate(total,5000))return 'equal'
 if(cents===incomeCents)return 'income'
 return 'custom'
}
// Distances are measured on the slider's usable track, not as a percentage
// of the bill. Closely spaced notches get independent, nonoverlapping wells.
export function magneticShare(raw:number,total:number,notches:number[],travel:number,capture:number,held:number|null){
 const value=Math.max(0,Math.min(total,Math.round(raw)))
 const distance=(a:number,b:number)=>Math.abs(a-b)/total*Math.max(1,travel)
 const well=(point:number,factor:number)=>Math.min(capture*factor,...notches.filter(other=>other!==point).map(other=>distance(point,other)*.42))
 if(held!==null&&distance(value,held)<=well(held,1.75))return {value:held,held}
 const nearest=notches.reduce((best,point)=>distance(value,point)<distance(value,best)?point:best,notches[0])
 return distance(value,nearest)<=well(nearest,1)?{value:nearest,held:nearest}:{value,held:null}
}
// Quantize only after testing the raw pointer against percentage targets.
// The purchase endpoint is also exact when its cents aren't a multiple of 25.
export function quarterShare(raw:number,total:number){return Math.max(0,Math.min(total,Math.round(raw/25)*25))}
export function sliderShare(raw:number,total:number,notches:number[],travel:number,capture:number,held:number|null){
 const snapped=magneticShare(raw,total,notches,travel,capture,held)
 if(snapped.held!==null)return snapped
 // A quarter step must never leap over a nearby exact notch, then jump
 // backwards when that notch captures the finger (important for small bills).
 const lower=notches.filter(point=>point<=snapped.value).reduce((a,b)=>Math.max(a,b),0)
 const upper=notches.filter(point=>point>=snapped.value).reduce((a,b)=>Math.min(a,b),total)
 return {...snapped,value:Math.max(lower,Math.min(upper,quarterShare(snapped.value,total)))}
}
// Keyboard navigation visits the same quarter-dollar ladder plus every exact
// notch, without allocating an array proportional to the purchase amount.
export function stepShare(current:number,total:number,notches:number[],direction:1|-1){
 const quarter=direction>0?(Math.floor(current/25)+1)*25:(Math.ceil(current/25)-1)*25
 const next=Math.max(0,Math.min(total,quarter))
 return notches.filter(point=>direction>0?point>current&&point<next:point<current&&point>next).reduce((best,point)=>direction>0?Math.min(best,point):Math.max(best,point),next)
}
// Height for a circular fill whose area matches the share, rather than using
// linear height (which exaggerates values near the top and bottom of a circle).
export function circleFillHeight(proportion:number,diameter=76){
 const target=Math.max(0,Math.min(1,proportion))
 if(target===0||target===1)return diameter*target
 let low=0,high=1
 for(let index=0;index<22;index++){const height=(low+high)/2,y=1-2*height,area=(Math.acos(y)-y*Math.sqrt(Math.max(0,1-y*y)))/Math.PI;if(area<target)low=height;else high=height}
 return diameter*(low+high)/2
}
export function shareText(cents:number,total:number){return `${new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(cents/total*100)}%`}
export const parseShare=(text:string,total:number)=>{
 if(!/^\d+(?:\.\d{0,2})?$/.test(text))return null
 const cents=Math.round(Number(text)*100)
 return Number.isSafeInteger(cents)&&cents>=0&&cents<=total?cents:null
}
