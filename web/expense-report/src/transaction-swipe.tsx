import React,{createContext,useContext,useLayoutEffect,useRef,useState} from 'react'
import {Pencil,UsersRound,Trash2} from 'lucide-react'
import type {DailyTransaction} from './transaction-identity'
import type {RecordedTransaction} from './transactions-screen'
import type {ReactNode} from 'react'
interface SwipeState { manager: {close?: (instant?:boolean)=>void}; rows: Map<string,RecordedTransaction>; locked:boolean; onAction:(row:RecordedTransaction,operation:'update'|'split'|'delete')=>void }
const settings={buttonWidth:54,duration:420}

export const TransactionSwipeContext=createContext<SwipeState|null>(null)
export const wrapTransactionRow=(entry:DailyTransaction,position:number,children:ReactNode,standalone=false)=><TransactionSwipeRow entry={entry} position={position} standalone={standalone}>{children}</TransactionSwipeRow>
const actions=[['update','Update',Pencil],['split','Split',UsersRound],['delete','Delete',Trash2]] as const
function TransactionSwipeRow({entry,position,children,standalone=false}:{entry:DailyTransaction;position:number;children:ReactNode;standalone?:boolean}){
 const context=useContext(TransactionSwipeContext)!,shell=useRef<HTMLDivElement>(null),x=useRef(0),target=useRef(0),drag=useRef<{id:number;startX:number;startY:number;start:number;active:boolean;vertical:boolean}|null>(null),suppressed=useRef(false),settleTimer=useRef<ReturnType<typeof setTimeout>|null>(null)
 const initial=0
 const [side,setSide]=useState(initial)
 const recorded=context.rows.get(entry.id??'')
 const available=actions.filter(([operation])=>recorded?.capabilities[operation])
 const actionWidth=settings.buttonWidth*available.length
 const revealWidth=()=>Math.min(actionWidth,Math.max(0,(shell.current?.clientWidth??actionWidth+12)-12))+12
 const readonly=context.locked||entry.status==='scheduled'||!recorded||!available.length
 const paint=(value:number,animate=false)=>{
  const el=shell.current;if(!el)return
  const width=revealWidth()
  if(settleTimer.current!==null){clearTimeout(settleTimer.current);settleTimer.current=null}
  const group=el.closest<HTMLElement>('.bb-daily-day-group'),row=el.querySelector<HTMLElement>('.bb-daily-transaction')!,bead=group?.querySelector<HTMLElement>(`.bb-daily-bead[data-entry="${position}"]`),viewport=bead?.closest<HTMLElement>('.bb-recorded-swipe-icon-viewport')
  const easing='cubic-bezier(.2,.85,.25,1)'
  const duration=animate&&!matchMedia('(prefers-reduced-motion: reduce)').matches?settings.duration:0
  const transition=`${duration}ms ${easing}`,closing=duration>0&&Math.abs(value)<.1&&el.dataset.side==='left'
  el.dataset.side=closing?'left':value<-.1?'left':value>.1?'right':'closed'
  el.dataset.revealed=String(closing||Math.abs(value)>.1)
  el.style.setProperty('--bb-recorded-reveal',String(Math.min(1,Math.abs(value)/width)))
  row.style.transition=`transform ${transition},border-radius ${transition}`
  row.style.transform=`translate3d(${value}px,0,0)`
  const access=el.querySelector<HTMLElement>('.bb-recorded-row-access')
  if(access){access.style.transition=`transform ${transition}`;access.style.transform=`translate3d(${value}px,0,0)`}
  // The existing day motion reads this invisible anchor on resize. Keep it
  // stationary while the visible row and persistent painted logo slide.
  const anchor=row.querySelector<HTMLElement>('.bb-daily-row-icon-anchor')!
  if(!standalone){anchor.style.setProperty('transition',`transform ${transition}`,'important');anchor.style.transform=`translate3d(${-value}px,0,0)`}
  if(bead){
   // Clip against a fixed row window. Animating an inset on the moving bead
   // erases it before it reaches the edge and lets it leak on the way back.
   if(viewport&&(Math.abs(value)>.1||closing)){
    const bounds=el.getBoundingClientRect(),origin=viewport.getBoundingClientRect()
    viewport.style.clipPath=`inset(${bounds.top-origin.top}px ${origin.right-bounds.right}px ${origin.bottom-bounds.bottom}px ${bounds.left-origin.left}px)`
   }else if(viewport)viewport.style.clipPath=''
   bead.style.setProperty('transition',`translate ${transition}`,'important')
   bead.style.translate=`${value}px 0`
   bead.style.clipPath=''
  }
  if(closing)settleTimer.current=setTimeout(()=>{settleTimer.current=null;if(target.current!==0||!el.isConnected)return;el.dataset.side='closed';el.dataset.revealed='false';if(viewport)viewport.style.clipPath=''},duration+20)
  x.current=value
 }
 const close=(instant=false)=>{target.current=0;setSide(0);paint(0,!instant)}
 const reveal=(next:number,animate=true)=>{
  if(readonly)return
  next=next<0?-1:0
  if(next){context.manager.close?.();context.manager.close=close}
  target.current=next;setSide(next);paint(next*revealWidth(),animate)
 }
 useLayoutEffect(()=>{
  const el=shell.current!,group=el.closest<HTMLElement>('.bb-daily-day-group')!,ownedBead=group.querySelector<HTMLElement>(`.bb-daily-bead[data-entry="${position}"]`)
  const closeOnDay=(event:Event)=>{if((event.target as Element).closest('.bb-daily-day-header'))close(true)}
  group.addEventListener('click',closeOnDay,true)
  const frame=requestAnimationFrame(()=>{if(initial&&!readonly&&group.querySelector('.bb-daily-day-header')?.getAttribute('aria-expanded')==='true')reveal(initial,false)})
  return()=>{cancelAnimationFrame(frame);if(settleTimer.current!==null)clearTimeout(settleTimer.current);group.removeEventListener('click',closeOnDay,true);const bead=ownedBead;if(bead){bead.style.translate='';bead.style.clipPath='';bead.style.removeProperty('transition');const viewport=bead.closest<HTMLElement>('.bb-recorded-swipe-icon-viewport');if(viewport)viewport.style.clipPath=''}}
 },[position,entry.id])
 useLayoutEffect(()=>{const id=requestAnimationFrame(()=>paint(target.current*revealWidth(),false));return()=>cancelAnimationFrame(id)},[actionWidth,settings.duration])
 function down(event:React.PointerEvent){
  if(readonly||event.button!==0||(event.target as Element).closest('.bb-recorded-swipe-actions'))return
  if(shell.current?.closest<HTMLElement>('.bb-daily-day-group')?.dataset.moving==='true')return
  const row=shell.current!.querySelector<HTMLElement>('.bb-daily-transaction')!,actual=new DOMMatrix(getComputedStyle(row).transform).m41
  paint(actual,false)
  drag.current={id:event.pointerId,startX:event.clientX,startY:event.clientY,start:actual,active:false,vertical:false}
 }
 function move(event:React.PointerEvent){
  const d=drag.current;if(!d||d.id!==event.pointerId||d.vertical)return
  const dx=event.clientX-d.startX,dy=event.clientY-d.startY
  if(!d.active){if(Math.abs(dy)>8&&Math.abs(dy)>Math.abs(dx)){d.vertical=true;return}if(Math.abs(dx)<9||Math.abs(dx)<Math.abs(dy)*1.2)return;d.active=true;context.manager.close?.();context.manager.close=close;shell.current?.setPointerCapture(event.pointerId)}
  const width=revealWidth(),raw=d.start+dx,value=raw>0?Math.min(10,raw*.06):-(Math.min(-raw,width)+Math.min(18,Math.max(0,-raw-width)*.12))
  paint(value);event.preventDefault()
 }
 function up(event:React.PointerEvent){
  const d=drag.current;if(!d||d.id!==event.pointerId)return;drag.current=null
  if(d.active){suppressed.current=true;reveal(x.current< -revealWidth()*.3?-1:0);setTimeout(()=>{suppressed.current=false},100)}
 }
 function activate(operation:'update'|'split'|'delete'){if(readonly||!recorded)return;reveal(0);context.onAction(recorded,operation)}
 return <div className="bb-recorded-swipe" ref={shell} data-readonly={readonly} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={()=>{drag.current=null;paint(target.current*revealWidth(),true)}} style={{'--bb-recorded-button-width':`${settings.buttonWidth}px`,'--bb-recorded-action-width':`${actionWidth}px`,'--bb-recorded-action-count':available.length} as React.CSSProperties}>
  {available.length>0&&<div className="bb-recorded-swipe-actions bb-recorded-actions-left" role="group" aria-label={`Actions for ${entry.location||entry.item}`} inert={side!==-1} aria-hidden={side!==-1}>
   {available.map(([op,label,Icon])=><button type="button" className={`bb-recorded-action bb-recorded-action-${op}`} key={op} disabled={readonly} onClick={()=>activate(op)} aria-label={`${label} ${entry.location||entry.item}`}><Icon aria-hidden="true"/><span>{label}</span></button>)}
  </div>}
  {children}
  {/* Zero-detail activation preserves keyboard/assistive access; pointer taps do not reveal actions. */}
  {!readonly&&<button type="button" className="bb-recorded-row-access" aria-label={`Show actions for ${entry.location||entry.item}`} aria-expanded={side!==0} style={{transform:`translateX(${target.current*revealWidth()}px)`}} onClick={event=>{if(event.detail===0&&!suppressed.current)reveal(target.current?0:-1)}} onKeyDown={event=>{if(event.key==='ArrowLeft'){event.preventDefault();reveal(-1)}if(event.key==='ArrowRight'){event.preventDefault();reveal(0)}if(event.key==='Escape'){event.preventDefault();reveal(0)}}}/>}
 </div>
}
