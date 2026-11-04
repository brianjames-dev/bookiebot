import React,{useLayoutEffect,useRef,useState} from 'react'
import {Check,Undo2,X} from 'lucide-react'
export type UndoNotice={id:number;title:string;deadline:number;seconds:number}
export function UndoPopup({notice,onUndo,onDismiss,returnFocus}:{notice:UndoNotice;onUndo:()=>void;onDismiss:()=>void;returnFocus:()=>HTMLElement|null}){
 const box=useRef<HTMLDivElement>(null),undo=useRef<HTMLButtonElement>(null),latest=useRef({onUndo,onDismiss,returnFocus}),finish=useRef<(undo:boolean)=>void>(()=>{}),[closing,setClosing]=useState(false)
 latest.current={onUndo,onDismiss,returnFocus}
 useLayoutEffect(()=>{
  const el=box.current!,reduced=matchMedia('(prefers-reduced-motion: reduce)').matches,animations:Animation[]=[];let disposed=false,ending=false
  const timer=setTimeout(()=>finish.current(false),Math.max(0,notice.deadline-Date.now()))
  if(!reduced)animations.push(el.animate([{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}],{duration:180,easing:'ease-out'}))
  const progress=el.querySelector<HTMLElement>('.bi-undo-time')!
  if(!reduced)animations.push(progress.animate([{transform:'scaleX(1)'},{transform:'scaleX(0)'}],{duration:Math.max(0,notice.deadline-Date.now()),easing:'linear',fill:'both'}))
  undo.current?.focus({preventScroll:true})
  finish.current=async wantsUndo=>{
   if(ending||disposed)return;ending=true;clearTimeout(timer);setClosing(true)
   const eligible=wantsUndo&&Date.now()<notice.deadline
   if(!reduced){const exit=el.animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(4px)'}],{duration:150,easing:'ease-in',fill:'both'});animations.push(exit);await exit.finished.catch(()=>{})}
   if(!disposed)(eligible?latest.current.onUndo:latest.current.onDismiss)()
  }
  return()=>{disposed=true;clearTimeout(timer);animations.forEach(a=>a.cancel());queueMicrotask(()=>latest.current.returnFocus()?.focus({preventScroll:true}))}
 },[notice.id])
 return <div className="bi-undo-overlay"><div ref={box} className="bi-undo-popup" role="dialog" aria-modal="true" aria-labelledby="bi-undo-title" aria-describedby="bi-undo-description" data-expires-at={notice.deadline} data-closing={closing} onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();finish.current(false)}
  if(event.key==='Tab'){const buttons=[...box.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];if(!buttons.length){event.preventDefault();return}const current=buttons.indexOf(event.target as HTMLButtonElement),next=(current+(event.shiftKey?-1:1)+buttons.length)%buttons.length;event.preventDefault();buttons[next].focus()}
 }}>
  <Check aria-hidden="true"/><span id="bi-undo-title">{notice.title}</span>
  <span id="bi-undo-description" className="bi-sr-only">Undo is available for {notice.seconds} seconds.</span>
  <button ref={undo} type="button" disabled={closing} onClick={()=>finish.current(true)}><Undo2 aria-hidden="true"/>Undo</button>
  <button type="button" className="bi-undo-dismiss" aria-label="Dismiss undo" disabled={closing} onClick={()=>finish.current(false)}><X aria-hidden="true"/></button>
  <span className="bi-undo-time" aria-hidden="true"/>
 </div></div>
}
