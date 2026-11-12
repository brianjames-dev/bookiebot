import React,{useRef,useState} from 'react'
import {ChartPie} from 'lucide-react'
import {allocate,circleFillHeight,identifySplit,quarterShare,sliderShare,stepShare,parseShare,shareText,splitMoney,splitNotches,splitMethodLabel,type SplitMethod} from './transaction-split-model'

export type SplitInputDraft={payer:boolean;text:string}|null
export function NotchedSplitControl({total,payerCents,method,incomeBasis,capture,incomeTarget,payerName,partnerName,allowCustom=true,disabled,onChange,onValidityChange,inputDraft,onInputDraft}:{total:number;payerCents:number;method:SplitMethod;incomeBasis:number;capture:number;incomeTarget?:number;payerName:string;partnerName:string;allowCustom?:boolean;disabled:boolean;onChange:(cents:number,method:SplitMethod)=>void;onValidityChange:(valid:boolean)=>void;inputDraft?:SplitInputDraft;onInputDraft?:(draft:SplitInputDraft)=>void}){
 const [localDraft,setLocalDraft]=useState<SplitInputDraft>(null),[announcement,setAnnouncement]=useState('')
 // Transactions keeps raw input with its draft so changing panes preserves validation too.
 const draft=inputDraft===undefined?localDraft:inputDraft
 const setDraft=(next:SplitInputDraft)=>{setLocalDraft(next);onInputDraft?.(next)}
 const pointer=useRef(false),held=useRef<number|null>(null),travel=useRef(240),slider=useRef<HTMLInputElement>(null)
 const incomeCents=incomeTarget??allocate(total,incomeBasis),notches=splitNotches(total,incomeBasis,incomeCents),mode=splitMethodLabel(method,incomeBasis,partnerName),partner=total-payerCents
 const debt=partner===0?`${partnerName} owes nothing.`:`${partnerName} will owe ${payerName} ${splitMoney(partner)}.`
 const invalidDraft=draft!==null&&parseShare(draft.text,total)===null,canRestoreIncome=!disabled&&(payerCents!==incomeCents||invalidDraft)
 const send=(raw:number)=>{const value=allowCustom?raw:notches.reduce((best,point)=>Math.abs(point-raw)<Math.abs(best-raw)?point:best,notches[0]);setDraft(null);onValidityChange(true);onChange(value,identifySplit(value,total,incomeBasis,method,incomeCents))}
 return <div className="bs-split" data-visual="levels" role="group" aria-label="Split the purchase">
  <div className="bs-context"><button className="bs-income-reset" type="button" aria-label="Split by income" data-tooltip="Split by income" disabled={!canRestoreIncome} onClick={()=>{
   if(!canRestoreIncome)return
   pointer.current=false;held.current=null;setDraft(null);onValidityChange(true);onChange(incomeCents,'income')
   setAnnouncement(`By income. ${payerName} covers ${splitMoney(incomeCents)}; ${partnerName} owes ${payerName} ${splitMoney(total-incomeCents)}.`)
  }}><ChartPie aria-hidden="true"/></button></div>
  <div className="bs-central" aria-hidden="true">
  <div className="bs-allocation">
   {[payerCents,partner].map((cents,index)=><div className="bs-orb" data-person={index===0?'payer':'partner'} key={index}>
    <i className="bs-orb-vessel"><i className="bs-orb-level" style={{height:`${circleFillHeight(cents/total)}px`}}/></i>
    <span className="bs-orb-percent">{shareText(cents,total)}</span>
   </div>)}
  </div>
  </div>
  <div className="bs-shares">
   {[{name:payerName,payer:true,cents:payerCents},{name:partnerName,payer:false,cents:partner}].map(side=><label className={`bs-share ${side.payer?'bs-payer':'bs-partner'}`} key={side.name}>
    <span className="bs-share-name"><span>{side.name}’s share</span></span>
    <span className="bs-amount"><span aria-hidden="true">$</span><input type="text" inputMode="decimal" autoComplete="off" aria-label={`${side.name}'s share amount`} disabled={disabled||!allowCustom} value={draft?.payer===side.payer?draft.text:(side.cents/100).toFixed(2)} onChange={event=>{
     const text=event.target.value,cents=parseShare(text,total);setDraft({payer:side.payer,text});onValidityChange(cents!==null)
     if(cents!==null){const next=side.payer?cents:total-cents;onChange(next,identifySplit(next,total,incomeBasis,method,incomeCents))}
    }} onBlur={()=>{if(draft&&parseShare(draft.text,total)!==null){setDraft(null);setAnnouncement(debt)}}}/></span>
   </label>)}
  </div>
  <div className="bs-slider">
   <div className="bs-rail" aria-hidden="true" style={{background:`linear-gradient(to right,hsl(var(--primary)) 0%,hsl(var(--primary)) ${payerCents/total*100}%,var(--bi-split-ink) ${payerCents/total*100}%,var(--bi-split-ink) 100%)`}}>
    {notches.map(value=><i key={value} className="bs-notch" data-active={payerCents===value} style={{left:`${value/total*100}%`}}/>)}
   </div>
   <input ref={slider} type="range" min={0} max={total} step={1} value={payerCents} disabled={disabled} aria-label={`${payerName}'s share slider`} aria-valuetext={`${mode}. ${payerName} covers ${splitMoney(payerCents)}; ${partnerName} covers ${splitMoney(partner)}. ${debt}`} onPointerDown={event=>{pointer.current=true;travel.current=Math.max(1,event.currentTarget.clientWidth-20);held.current=notches.includes(payerCents)?payerCents:null;setDraft(null);onValidityChange(true)}} onPointerUp={()=>{pointer.current=false;held.current=null;setAnnouncement(`${mode}. ${debt}`)}} onPointerCancel={()=>{pointer.current=false;held.current=null}} onKeyDown={event=>{
    pointer.current=false;held.current=null
    if(!['ArrowRight','ArrowUp','ArrowLeft','ArrowDown','PageUp','PageDown','Home','End'].includes(event.key))return
    event.preventDefault();let value=payerCents
    if(event.key==='Home')value=0
    else if(event.key==='End')value=total
    else {const direction=event.key==='ArrowRight'||event.key==='ArrowUp'||event.key==='PageUp'?1:-1;for(let count=0;count<(event.key.startsWith('Page')?10:1);count++)value=stepShare(value,total,notches,direction)}
    send(value)
   }} onKeyUp={()=>setAnnouncement(`${mode}. ${debt}`)} onChange={event=>{
    let value=Number(event.target.value)
    if(pointer.current){const snapped=sliderShare(value,total,notches,travel.current,capture,held.current);held.current=snapped.held;value=snapped.value}
    else if(!notches.includes(value))value=Math.abs(value-payerCents)<=1&&value!==payerCents?stepShare(payerCents,total,notches,value>payerCents?1:-1):quarterShare(value,total)
    send(value)
   }}/>
  </div>
  {draft&&parseShare(draft.text,total)===null&&<p className="bs-error" role="alert">Enter $0.00–{splitMoney(total)}, with up to two decimal places.</p>}
  <span className="bi-sr-only" role="status" aria-live="polite">{announcement}</span>
 </div>
}
