import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react'
import {StepMotion} from './transaction-step-motion'
import {transactionMotion} from './transaction-inline-editor'

/** Keep the expansion and both moving surfaces alive while editor routes change. */
export function EditorScenes({scene,open=true,children,fill=false}:{scene:string;open?:boolean;children:ReactNode;fill?:boolean}){
 const retained=useRef<{current:string;target:0|1;visit:number;slots:Array<{scene:string;node:ReactNode;visit:number}|null>}>({current:scene,target:0,visit:0,slots:[{scene,node:children,visit:0},null]})
 const state=retained.current
 if(open){
  if(scene!==state.current){state.target=state.target===0?1:0;state.current=scene;state.visit++}
  state.slots[state.target]={scene,node:children,visit:state.visit}
 }
 // Each incoming visit starts at its requested inner view. Reusing an old
 // summary/review instance would replay its own slide inside this outer one.
 // Current-view updates keep their visit, preserving drafts and native review.
 const slot=(index:number)=>{const entry=state.slots[index];return entry?<div className="bi-editor-scene" data-editor-scene={entry.scene} key={entry.visit}>{entry.node}</div>:null}
 return <div className="bi-editor-scenes" data-active-scene={state.current} data-fill={fill}>
  <StepMotion review={state.target===1} open mode="slide" duration={transactionMotion.duration} edit={slot(0)} confirm={slot(1)}/>
 </div>
}

/** The same expansion remains open when switching among a row's editor scenes. */
export function EditorExpansion({open,children,onCollapsed}:{open:boolean;children:ReactNode;onCollapsed?:()=>void}){
 // An active row restored by a fold is already open. Ordinary row openings
 // still animate because their mounted expansion starts with open=false.
 const [shown,setShown]=useState(open),[present,setPresent]=useState(open)
 const current=useRef({open,onCollapsed,notified:!open});current.current.open=open;current.current.onCollapsed=onCollapsed
 const complete=()=>{if(current.current.open||current.current.notified)return;current.current.notified=true;setPresent(false);current.current.onCollapsed?.()}
 useLayoutEffect(()=>{if(!open){setShown(false);if(matchMedia('(prefers-reduced-motion: reduce)').matches)complete();return}current.current.notified=false;setPresent(true);const frame=requestAnimationFrame(()=>setShown(true));return()=>cancelAnimationFrame(frame)},[open])
 useEffect(()=>{const media=matchMedia('(prefers-reduced-motion: reduce)'),change=()=>{if(media.matches&&!current.current.open)complete()};media.addEventListener('change',change);return()=>media.removeEventListener('change',change)},[])
 // Hidden/reflowed panes may never emit a transition event. Only presence
 // owners need this fallback; existing Transactions expansions stay unchanged.
 useEffect(()=>{if(open||!onCollapsed)return;const timer=window.setTimeout(complete,440);return()=>window.clearTimeout(timer)},[open,Boolean(onCollapsed)])
 return <div className="bi-expansion sp-inline-expansion" data-open={shown&&open} aria-hidden={!open} inert={!open} onTransitionEnd={event=>{if(event.target===event.currentTarget&&event.propertyName==='grid-template-rows')complete()}}><div className="bi-expansion-clip">{(present||open)&&children}</div></div>
}
