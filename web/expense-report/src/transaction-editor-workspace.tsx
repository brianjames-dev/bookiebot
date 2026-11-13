import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react'
import {StepMotion} from './transaction-step-motion'
import {transactionMotion} from './transaction-inline-editor'

/** Keep the expansion and both moving surfaces alive while editor routes change. */
export function EditorScenes({scene,open=true,children,fill=false}:{scene:string;open?:boolean;children:ReactNode;fill?:boolean}){
 const retained=useRef<{current:string;target:0|1;slots:Array<{scene:string;node:ReactNode}|null>}>({current:scene,target:0,slots:[{scene,node:children},null]})
 const state=retained.current
 if(open){
  if(scene!==state.current){state.target=state.target===0?1:0;state.current=scene}
  state.slots[state.target]={scene,node:children}
 }
 const slot=(index:number)=>{const entry=state.slots[index];return entry?<div className="bi-editor-scene" data-editor-scene={entry.scene} key={entry.scene}>{entry.node}</div>:null}
 return <div className="bi-editor-scenes" data-active-scene={state.current} data-fill={fill}>
  <StepMotion review={state.target===1} open mode="slide" duration={transactionMotion.duration} edit={slot(0)} confirm={slot(1)}/>
 </div>
}

/** The same expansion remains open when switching among a row's editor scenes. */
export function EditorExpansion({open,children}:{open:boolean;children:ReactNode}){
 const [shown,setShown]=useState(false),[present,setPresent]=useState(open)
 useLayoutEffect(()=>{if(!open){setShown(false);if(matchMedia('(prefers-reduced-motion: reduce)').matches)setPresent(false);return}setPresent(true);const frame=requestAnimationFrame(()=>setShown(true));return()=>cancelAnimationFrame(frame)},[open])
 useEffect(()=>{const media=matchMedia('(prefers-reduced-motion: reduce)'),change=()=>{if(media.matches&&!open)setPresent(false)};media.addEventListener('change',change);return()=>media.removeEventListener('change',change)},[open])
 return <div className="bi-expansion sp-inline-expansion" data-open={shown&&open} aria-hidden={!open} inert={!open} onTransitionEnd={event=>{if(event.target===event.currentTarget&&event.propertyName==='grid-template-rows'&&!open)setPresent(false)}}><div className="bi-expansion-clip">{(present||open)&&children}</div></div>
}
