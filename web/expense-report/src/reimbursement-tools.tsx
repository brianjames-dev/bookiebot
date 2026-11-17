import {ReimbursementSaveButton} from './reimbursement-feedback'
import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {ArrowLeft,ArrowLeftRight,Check,ChevronRight,Ellipsis,History,RotateCcw,RotateCw,RefreshCw,X} from 'lucide-react'
import type {LedgerReset,LedgerSnapshot,Run} from './reimbursement-ledger'
import {scrollPageTo} from './page-scroll'

export type ReimbursementScene='summary'|'offset'|'payment'|'reset'|'reset-history'|'reset-undo'|'reset-redo'
const money=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100)
const person=(name:string)=>name?name[0].toUpperCase()+name.slice(1):'Partner'
const date=(reset:LedgerReset)=>{const time=new Date(reset.createdAt);return Number.isFinite(+time)?time.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'America/Los_Angeles'}):'Date unavailable'}

export function useShortReimbursementPane(wide:boolean){
 const [height,setHeight]=useState(()=>typeof window==='undefined'?800:window.innerHeight)
 useEffect(()=>{const resize=()=>setHeight(window.innerHeight);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize)},[])
 return wide&&height<550
}
export function SelectionClose({onClose,disabled}:{onClose:()=>void;disabled:boolean}){
 return <button type="button" className="bb-recorded-graph-toggle sr-detail-close" aria-label="Close reimbursement details" disabled={disabled} onClick={onClose}><X aria-hidden="true"/></button>
}
export function HistoryFilter({onClear}:{onClear:()=>void}){
 return <button type="button" className="bb-recorded-day-chip sr-history-filter" aria-label="Show current activity" onClick={onClear}><History aria-hidden="true"/><span>All history</span><X aria-hidden="true"/></button>
}
export function BalanceSides({wide,partner,owner,to,from}:{wide:boolean;partner:string;owner:string;to:number;from:number}){
 if(!wide)return <div className="sr-summary-sides"><div><span>Owed to you</span><strong>{money(to)}</strong></div><ArrowLeftRight aria-hidden="true"/><div><span>You owe</span><strong>{money(from)}</strong></div></div>
 return <div className={'sr-summary-sides'+(wide?' sr-balance-sides':'')}><div>{wide&&<span className="sr-person sr-partner" aria-hidden="true">{partner[0]}</span>}<div><span>Owed to you</span><strong>{money(to)}</strong></div></div><ArrowLeftRight aria-hidden="true"/><div>{wide&&<span className="sr-person" aria-hidden="true">{owner[0]}</span>}<div><span>You owe</span><strong>{money(from)}</strong></div></div></div>
}
export function ReimbursementOptions({history,setHistory,setSelected,setScene,headerActions,wide,disabled,refreshing,refresh}:{history:boolean;setHistory:(v:boolean)=>void;setSelected:(v:string)=>void;setScene:(v:ReimbursementScene)=>void;headerActions?:HTMLElement|null;wide:boolean;disabled:boolean;refreshing:boolean;refresh:()=>void}){
 const [open,setOpen]=useState(false),ref=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null)
 useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node))setOpen(false)},escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus()}};window.addEventListener('pointerdown',outside);window.addEventListener('keydown',escape);return()=>{window.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',escape)}},[open])
 const go=(scene:ReimbursementScene)=>{setOpen(false);setSelected('');setScene(scene);if(!wide)scrollPageTo({top:0,behavior:'instant'})}
 const tools=<div className="sr-options-anchor" ref={ref}>{wide&&<button type="button" className="sr-refresh" aria-label="Refresh reimbursements" aria-busy={refreshing} disabled={disabled||refreshing} onClick={refresh}><RefreshCw aria-hidden="true" className={refreshing?"sr-refresh-spinning":undefined}/></button>}<button ref={trigger} type="button" className="sr-options" aria-label="Reimbursement options" aria-expanded={open} disabled={disabled} onClick={()=>setOpen(!open)}><Ellipsis/></button>{open&&<section className="sr-options-panel bi-product" role="dialog" aria-label="Options"><nav className="sr-options-menu" aria-label="Reimbursement tools"><button type="button" aria-pressed={history} onClick={()=>{setHistory(!history);setSelected('');setOpen(false)}}><History/><span>Reimbursement history</span>{history?<Check/>:<ChevronRight/>}</button><button type="button" disabled={disabled} onClick={()=>go('reset-history')}><RotateCcw/><span>Reset history</span><ChevronRight/></button><button type="button" className="sr-destructive" disabled={disabled} onClick={()=>go('reset')}><RotateCw/><span>Reset balances</span><ChevronRight/></button></nav></section>}</div>
 return headerActions?createPortal(tools,headerActions):tools
}
export function ReimbursementResetFlow({scene,snapshot,pageSize=3,disabled,run,setScene,resetId,setResetId,close}:{scene:string;snapshot:LedgerSnapshot;pageSize?:number;disabled:boolean;run:Run;setScene:(scene:ReimbursementScene,direction?:'forward'|'backward')=>void;resetId:string;setResetId:(id:string)=>void;close:()=>void}){
 const resets=[...(snapshot.resets??[])].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)),selected=Math.max(0,resets.findIndex(r=>r.id===resetId)),reset=resets[selected],review=scene!=='reset-history',undone=reset?.status==='undone',page=Math.floor(selected/pageSize),visible=resets.slice(page*pageSize,(page+1)*pageSize)
 const [expected]=useState(()=>reset),stale=review&&(!reset||expected?.id!==reset.id||expected.version!==reset.version||expected.status!==reset.status)
 const allowed=reset&&(undone?reset.canRedo:reset.canUndo)
 const totals={to:0,from:0};for(const entry of reset?.entries??[])totals[entry.payerOwner===snapshot.ownerKey?'to':'from']+=entry.amountCents
 return <><header className="sr-editor-heading"><h2>{review?undone?'Redo reset':'Undo reset':'Reset history'}</h2></header>{review&&reset?<>
  <p className="sr-reset-description">{date(reset)} · {person(reset.actorOwner)} · {reset.entries.length} {reset.entries.length===1?'expense':'expenses'}</p>
  <p className="sr-reset-description">{undone?'Clear these balances again?':'Restore these balances?'}</p>
  <div className="sr-reset-values"><div><span>Owed to you</span><strong>{money(totals.to)}</strong></div><div><span>You owed</span><strong>{money(totals.from)}</strong></div></div>
  {reset.note&&<p className="bi-footnote sr-reset-note" title={reset.note}>{reset.note}</p>}<p className="bi-footnote">No payment recorded. Purchases stay unchanged.</p>
  {(stale||!allowed)&&<p className="bi-footnote" role="status">This reset or its expenses changed, or are still syncing. Go back and review the current history.</p>}
  <footer className="bi-editor-footer"><button className="bi-cancel" disabled={disabled} onClick={()=>setScene('reset-history','backward')}><ArrowLeft/>Back</button><ReimbursementSaveButton operation={undone?"redo_reset":"undo_reset"} className="bi-primary" disabled={disabled||stale||!allowed} onClick={()=>{if(stale||!allowed)return;run({operation:undone?'redo_reset':'undo_reset',resetId:reset.id,version:expected.version},saved=>{if(saved)setScene('reset-history','backward')})}}>{undone?'Confirm redo':'Confirm undo'}</ReimbursementSaveButton></footer>
 </>:<>
  {!resets.length?<p className="bi-footnote">No resets recorded.</p>:<div className="sr-reset-list" aria-label="Balance resets">{visible.map(r=><button type="button" className="sr-reset-row" key={r.id} disabled={disabled} aria-label={`Review reset from ${date(r)} by ${person(r.actorOwner)}`} onClick={()=>{setResetId(r.id);setScene(r.status==='undone'?'reset-redo':'reset-undo')}}><span className="sr-reset-copy"><strong>{r.status==='undone'?'Reset undone':'Balances reset'}</strong><small>{date(r)} · {person(r.actorOwner)}</small></span><span className="sr-reset-amount"><strong>{money(r.entries.reduce((sum,e)=>sum+e.amountCents,0))}</strong><small>{r.entries.length} {r.entries.length===1?'expense':'expenses'}</small></span><ChevronRight aria-hidden="true"/></button>)}</div>}
  <footer className="bi-editor-footer sr-reset-list-footer">{page>0&&<button className="bi-cancel" disabled={disabled} onClick={()=>setResetId(resets[(page-1)*pageSize].id)}>Newer resets</button>}{(page+1)*pageSize<resets.length&&<button className="bi-cancel" disabled={disabled} onClick={()=>setResetId(resets[(page+1)*pageSize].id)}>Earlier resets</button>}<button className="bi-cancel sr-reset-close" disabled={disabled} onClick={close}>Cancel</button></footer>
 </>}</>
}
