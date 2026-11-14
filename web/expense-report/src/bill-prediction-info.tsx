import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {Popover} from 'konsta/react'
import {Sparkles,X} from 'lucide-react'
import type {BillPrediction} from './types'
import './bill-prediction-info.css'

type Item={label:string;prediction:BillPrediction}
const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100)
const month=(value:string)=>new Date(value+'-01T12:00:00').toLocaleDateString('en-US',{month:'short',year:'numeric'})

export function BillPredictionSummary({items}:{items:Item[]}){
 return <div className="bb-bill-prediction-summary">
  <dl>{items.map(({label,prediction:p})=><div key={label}><dt>{label}<small>{p.source==='configured'?'Configured estimate':`Average of ${p.sampleCount} past ${p.sampleCount===1?'bill':'bills'}`}{p.firstMonth&&p.lastMonth?` · ${month(p.firstMonth)}${p.firstMonth===p.lastMonth?'':` – ${month(p.lastMonth)}`}`:''}</small></dt><dd>{money(p.amountCents)}</dd></div>)}</dl>
  <p>Based on your recorded bill amounts. Enter the actual amount when it arrives; it replaces the prediction.</p>
 </div>
}

/** Small visual marker, full native tap target and an unclipped explanation. */
export function BillPredictionInfo({items}:{items:Item[]}){
 const [open,setOpen]=useState(false),id=useId(),trigger=useRef<HTMLButtonElement>(null),popover=useRef<HTMLDivElement>(null),panel=useRef<HTMLDivElement>(null)
 const close=(focus=false)=>{setOpen(false);if(focus)trigger.current?.focus({preventScroll:true})}
 useEffect(()=>setOpen(false),[items])
 useLayoutEffect(()=>{
  if(!open||!popover.current||!trigger.current)return
  const node=popover.current
  const contain=()=>{
  const anchor=trigger.current!.getBoundingClientRect(),viewport=window.visualViewport
  const shell=document.querySelector('.bb-page.bb-app-shell'),overlay=shell?.getAttribute('data-duo-landscape')==='true'?parseFloat(getComputedStyle(shell).getPropertyValue('--bb-duo-overlay'))||0:0
  const left=(viewport?.offsetLeft??0)+16,right=left+(viewport?.width??innerWidth)-32-overlay
  const top=(viewport?.offsetTop??0)+16,bottom=top+(viewport?.height??innerHeight)-32
  node.style.setProperty('--prediction-width',`${Math.min(320,right-left)}px`)
  node.style.setProperty('--prediction-max-height',`${Math.max(100,bottom-top)}px`)
  node.style.setProperty('--prediction-left',`${Math.max(left,Math.min(anchor.right-node.offsetWidth,right-node.offsetWidth))}px`)
  node.style.setProperty('--prediction-top',`${Math.max(top,Math.min(anchor.bottom+8+node.offsetHeight>bottom?anchor.top-node.offsetHeight-8:anchor.bottom+8,bottom-node.offsetHeight))}px`)
  }
  contain();const observer=new ResizeObserver(contain);observer.observe(node);return()=>observer.disconnect()
 },[open])
 useEffect(()=>{
  if(!open)return
  const outside=(event:Event)=>{if(event.target instanceof Node&&!popover.current?.contains(event.target)&&!trigger.current?.contains(event.target)){
   if(event.type==='focusin'&&trigger.current&&event.target.contains(trigger.current))return
   close()
  }}
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close(true)}}
  const scroll=(event:Event)=>{if(!(event.target instanceof Node&&popover.current?.contains(event.target)))close()}
  const change=()=>close()
  const frame=requestAnimationFrame(()=>panel.current?.querySelector<HTMLButtonElement>('button')?.focus({preventScroll:true}))
  document.addEventListener('pointerdown',outside);document.addEventListener('focusin',outside);document.addEventListener('keydown',escape);document.addEventListener('scroll',scroll,true)
  window.addEventListener('resize',change);window.addEventListener('bookiebot:screen-change',change)
  return()=>{cancelAnimationFrame(frame);document.removeEventListener('pointerdown',outside);document.removeEventListener('focusin',outside);document.removeEventListener('keydown',escape);document.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',change);window.removeEventListener('bookiebot:screen-change',change)}
 },[open])
 const label=`Explain predicted ${items.map(item=>item.label).join(', ')}`
 return <><button ref={trigger} type="button" className="bb-bill-prediction-info" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}><Sparkles aria-hidden="true"/></button>
  {typeof document!=='undefined'&&createPortal(<Popover ref={popover} className="bb-bill-prediction-popover" opened={open} target={trigger} backdrop={false} role="dialog" aria-label="Predicted bill" aria-hidden={!open} id={id} inert={!open}>
   <div ref={panel}><header><h3>Predicted bill{items.length===1?'':'s'}</h3><button type="button" aria-label="Close prediction explanation" onClick={()=>close(true)}><X size={16} aria-hidden="true"/></button></header><BillPredictionSummary items={items}/></div>
  </Popover>,trigger.current?.closest('dialog[open]')??document.body)}
 </>
}
