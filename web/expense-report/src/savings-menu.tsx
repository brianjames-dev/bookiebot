import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react'
import {createPortal} from 'react-dom'
import {ChevronRight,Ellipsis} from 'lucide-react'

type Action={label:string;icon:ReactNode;onSelect:()=>void;destructive?:boolean}
/** Reimbursements' options markup/materials; only its entries and placement vary. */
export function SavingsMenu({label,actions}:{label:string;actions:Action[]}){
 const [open,setOpen]=useState(false),[position,setPosition]=useState({left:16,top:16,width:320}),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement>(null)
 const stage=document.body
 useLayoutEffect(()=>{
  if(!open||!stage||!trigger.current||!panel.current)return
  const place=()=>{const anchor=trigger.current!.getBoundingClientRect(),page=document.querySelector<HTMLElement>('.bb-page'),overlay=page?parseFloat(getComputedStyle(page).getPropertyValue('--bb-duo-overlay'))||0:0,width=Math.min(340,window.innerWidth-overlay-32),height=panel.current!.offsetHeight,left=Math.max(16,Math.min(anchor.right-width,window.innerWidth-overlay-width-16)),below=anchor.bottom+8,top=Math.max(16,Math.min(below+height>window.innerHeight-16?anchor.top-height-8:below,window.innerHeight-height-16));setPosition(prev=>prev.left===left&&prev.top===top&&prev.width===width?prev:{left,top,width})}
  place();const observer=new ResizeObserver(place);observer.observe(panel.current);observer.observe(stage);return()=>observer.disconnect()
 },[open,stage])
 useEffect(()=>{
  if(!open)return
  const outside=(event:Event)=>{const path=event.composedPath();if(path.includes(trigger.current!)||path.includes(panel.current!))return;setOpen(false)}
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus({preventScroll:true})}}
  const scroll=()=>setOpen(false)
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);window.addEventListener('scroll',scroll,true)
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);window.removeEventListener('scroll',scroll,true)}
 },[open])
 return <div className="sr-options-anchor"><button ref={trigger} type="button" className="sr-options" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(!open)}><Ellipsis aria-hidden="true"/></button>{open&&stage&&createPortal(<section ref={panel} className="sr-options-panel bi-product" role="dialog" aria-label={label} style={{position:'fixed',left:position.left,top:position.top,right:'auto',width:position.width}}><nav className="sr-options-menu" aria-label={label+' actions'}>{actions.map(action=><button key={action.label} type="button" className={action.destructive?'sr-destructive':undefined} onClick={()=>{setOpen(false);action.onSelect()}}>{action.icon}<span>{action.label}</span><ChevronRight aria-hidden="true"/></button>)}</nav></section>,stage)}</div>
}
