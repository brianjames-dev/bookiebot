import {useEffect,useState} from 'react'
import {ChevronLeft,ChevronRight} from 'lucide-react'
import {billMoney,billMonth} from './bill-review'
export type BillEndReviewData={direction?:'restore';items:{month:string;date:string;amountCents:number;removable:boolean;reason:string;selected:boolean}[];removeMonths:string[];removedCents:number;historyCommands:(Record<string,unknown>&{operation:string})[]}
/** One review, paged within the native editor so short open panes still fit. */
export function BillEndReview({value,locked,onSelection}:{value:BillEndReviewData;locked:boolean;onSelection:(months:string[])=>void}){
 const [short,setShort]=useState(false),[offset,setOffset]=useState(0)
 useEffect(()=>{if(typeof matchMedia!=='function')return;const query=matchMedia('(min-width:800px) and (max-height:600px)'),update=()=>setShort(query.matches);update();query.addEventListener('change',update);return()=>query.removeEventListener('change',update)},[])
 const key=value.items.map(i=>i.month).join(',')+value.direction
 useEffect(()=>setOffset(0),[key])
 const size=short?2:4,start=Math.floor(offset/size)*size,items=value.items.slice(start,start+size),restoring=value.direction==='restore'
 return <section className="bb-bill-end-review" aria-label="Monthly charge corrections">
  <p className="bb-bill-end-total"><strong>{restoring?'+':'−'}{billMoney(value.removedCents)}</strong><span>{value.removeMonths.length} {value.removeMonths.length===1?'charge':'charges'} · original months</span></p>
  {value.items.length>0?<div className="bb-bill-end-items">{items.map(item=><label className="bb-bill-end-item" key={item.month}>
   <input type="checkbox" aria-label={`${restoring?'Restore':'Remove'} ${billMonth(item.month)} charge`} checked={item.selected} disabled={locked||restoring||!item.removable} onChange={e=>onSelection(e.target.checked?[...value.removeMonths,item.month].sort():value.removeMonths.filter(m=>m!==item.month))}/>
   <span><strong>{billMonth(item.month)}</strong><small>{item.reason||new Date(item.date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'})}</small></span>
   <strong className="bb-bill-end-delta">{item.selected?(restoring?'+':'−')+billMoney(item.amountCents):'Keep '+billMoney(item.amountCents)}</strong>
  </label>)}</div>:<p className="bi-footnote">No recorded charges to remove.</p>}
  {value.items.length>size&&<div className="bb-bill-end-pages"><button type="button" aria-label="Previous charges" disabled={locked||start===0} onClick={()=>setOffset(Math.max(0,start-size))}><ChevronLeft aria-hidden="true"/></button><span>{start+1}–{Math.min(start+size,value.items.length)} of {value.items.length}</span><button type="button" aria-label="Next charges" disabled={locked||start+size>=value.items.length} onClick={()=>setOffset(start+size)}><ChevronRight aria-hidden="true"/></button></div>}
 </section>
}
