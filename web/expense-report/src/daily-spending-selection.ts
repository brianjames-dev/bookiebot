import { useEffect, useRef, type PointerEvent } from 'react'
import { readPageScroll } from './page-scroll'

/** Scrubbing commits once on release. Native vertical pan/cancel stays scrolling. */
export function useDailySpendingSelection(labels:string[],onSelect:(label:string)=>void){
 const ref=useRef<HTMLDivElement>(null),current=useRef({labels,onSelect})
 current.current={labels,onSelect}
 const press=useRef<{id:number;x:number;y:number;scroll:number;moved:boolean}|null>(null),suppressUntil=useRef(0)
 const key=labels.join('\0')
 const cancel=()=>{if(press.current)suppressUntil.current=performance.now()+800;press.current=null}
 useEffect(cancel,[key])
 const onPointerDown=(event:PointerEvent<HTMLDivElement>)=>{
  if(!event.isPrimary||event.button!==0){cancel();return}
  suppressUntil.current=0
  press.current={id:event.pointerId,x:event.clientX,y:event.clientY,scroll:readPageScroll().y,moved:false}
 }
 const onPointerMove=(event:PointerEvent<HTMLDivElement>)=>{
  const start=press.current
  if(!start||start.id!==event.pointerId)return
  if(readPageScroll().y!==start.scroll){cancel();return}
  if(Math.hypot(event.clientX-start.x,event.clientY-start.y)>4)start.moved=true
 }
 const onPointerUp=(event:PointerEvent<HTMLDivElement>)=>{
  const start=press.current;press.current=null
  if(!start||start.id!==event.pointerId)return
  if(!start.moved&&Math.hypot(event.clientX-start.x,event.clientY-start.y)<=4)return
  // A drag that exits/cancels must not fall through to Recharts' stale hover click.
  suppressUntil.current=performance.now()+800
  if(readPageScroll().y!==start.scroll)return
  const surface=ref.current,grid=surface?.querySelector('.recharts-cartesian-grid-horizontal line')?.getBoundingClientRect(),bounds=surface?.getBoundingClientRect()
  if(!grid||!bounds||grid.width<=0||event.clientX<grid.left||event.clientX>grid.right||event.clientY<bounds.top||event.clientY>bounds.bottom)return
  const values=current.current.labels,index=Math.min(values.length-1,Math.floor((event.clientX-grid.left)/grid.width*values.length))
  if(index<0||!values[index])return
  current.current.onSelect(values[index])
 }
 return {ref,onPointerDown,onPointerMove,onPointerUp,onPointerCancel:cancel,onLostPointerCapture:cancel,onPointerLeave:cancel,
  click(label:unknown,keyboard=false){if((keyboard||performance.now()>=suppressUntil.current)&&label!==undefined&&label!==null)current.current.onSelect(String(label))}}
}
