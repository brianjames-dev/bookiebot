import {useLayoutEffect,useRef,useState,type ReactNode} from 'react'
import {EditorExpansion} from './transaction-editor-workspace'

// Deliberately slower than an editor's 440ms slide. Row selection changes
// context; it must not look like navigating forward within that editor.
export const billSelectionMotion={duration:600,easing:'cubic-bezier(.45,0,.55,1)'}
type Entry={id:string;order:number;isNew:boolean;node:ReactNode}
type Props={billId:string;open:boolean;order:number;isNew:boolean;wide:boolean;locked:boolean;children:ReactNode}

function BillEditorEntry({entry,open,wide,locked,onClosed}:{entry:Entry;open:boolean;wide:boolean;locked:boolean;onClosed:()=>void}){
 const element=useRef<HTMLElement>(null),latest=useRef({open,onClosed}),motion=useRef<Animation|null>(null)
 const [ready,setReady]=useState(wide)
 const state=useRef({initialized:false,wide,open,generation:0})
 latest.current={open,onClosed}
 useLayoutEffect(()=>{if(open)setReady(true)},[open])
 useLayoutEffect(()=>{
  const node=element.current!,s=state.current,generation=++s.generation,opacity=getComputedStyle(node).opacity
  motion.current?.cancel();motion.current=null
  const changed=s.initialized&&s.open!==open,newVisit=!s.initialized
  const folded=s.initialized&&s.wide!==wide;s.initialized=true;s.open=open;s.wide=wide
  const settle=()=>{node.dataset.billMoving='false';node.style.opacity=wide&&!open?'0':'1';if(!open&&wide)latest.current.onClosed()}
  if(!wide||folded||matchMedia('(prefers-reduced-motion: reduce)').matches||(!changed&&!newVisit)){settle();return}
  node.dataset.billMoving='true'
  const from=newVisit?'0':opacity,to=open?'1':'0'
  const animation=node.animate([{opacity:from},{opacity:to}],{...billSelectionMotion,fill:'both'})
  motion.current=animation
  animation.finished.then(()=>{if(s.generation!==generation)return;node.style.opacity=to;animation.cancel();motion.current=null;settle()}).catch(()=>{})
  return()=>{++s.generation;animation.cancel()}
 },[open,wide])
 useLayoutEffect(()=>{const media=matchMedia('(prefers-reduced-motion: reduce)'),settle=()=>{if(!media.matches)return;motion.current?.cancel();motion.current=null;const node=element.current;if(node){node.dataset.billMoving='false';node.style.opacity='1'}if(!latest.current.open)latest.current.onClosed()};media.addEventListener('change',settle);return()=>media.removeEventListener('change',settle)},[])
 return <section ref={element} className="bb-bills-editor" aria-label="Bill editor" aria-hidden={!open} data-bill-slot={entry.id} data-new={entry.isNew} data-open={open} data-present="true" inert={!open||locked} style={{order:entry.order}}>
  <EditorExpansion open={wide||open&&ready} onCollapsed={()=>{if(!latest.current.open)latest.current.onClosed()}}>{entry.node}</EditorExpansion>
 </section>
}

/** Keep each live editor mounted through folding; retain outgoing row content
 * until its simultaneous collapse or pane crossfade finishes. */
export function BillEditorWorkspace({billId,open,order,isNew,wide,locked,children}:Props){
 const records=useRef(new Map<string,Entry>()),active=useRef<string|null>(null),previousWide=useRef(wide),root=useRef<HTMLDivElement>(null)
 const [,redraw]=useState(0)
 active.current=open?billId:null
 if(open)records.current.set(billId,{id:billId,order,isNew,node:children})
 const remove=(id:string)=>{if(active.current===id)return;if(records.current.delete(id))redraw(v=>v+1)}
 useLayoutEffect(()=>{
  if(previousWide.current!==wide){previousWide.current=wide;let removed=false;for(const id of records.current.keys())if(id!==active.current){records.current.delete(id);removed=true}if(removed)redraw(v=>v+1)}
  const list=root.current?.closest('.bb-bills')
  for(const row of list?.querySelectorAll<HTMLElement>('.bb-bills-row[data-bill-id]')??[])row.dataset.editorAnchor=String(records.current.has(row.dataset.billId!))
 })
 return <div className="bb-bill-editor-workspace" ref={root}>
  {[...records.current.values()].map(entry=><BillEditorEntry key={entry.id} entry={entry} open={open&&entry.id===billId} wide={wide} locked={locked} onClosed={()=>remove(entry.id)}/>)}
  {!records.current.size&&<section className="bb-bills-editor bb-bills-editor-empty" aria-label="Bill editor" data-open="false"><p className="bb-bills-empty">Choose a bill to manage it.</p></section>}
 </div>
}
