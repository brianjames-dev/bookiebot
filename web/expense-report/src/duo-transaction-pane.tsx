import {useLayoutEffect,useRef,type ReactNode} from 'react'
import {ArrowLeft,ChartNoAxesColumn,Pencil,UsersRound,Trash2,X} from 'lucide-react'
import {TransactionIcon} from './daily-transactions'
import {recordedEntry} from './recorded-transaction-view'
import {transactionMerchant,transactionText} from './transaction-identity'
import type {RecordedTransaction} from './transactions-screen'
import type {TransactionOperation} from './transaction-change-summary'

const actions=[['update','Edit',Pencil],['split','Split',UsersRound],['delete','Delete',Trash2]] as const
const titles:Partial<Record<TransactionOperation,string>>={update:'Edit purchase',move:'Edit purchase',split:'Split purchase',delete:'Delete purchase',cancel_split:'Remove split',undo:'Undo change'}

export function DuoTransactionPane({row,operation,reviewing,graphOpen,locked,onAction,onOptions,onGraph,onClose,editor,status,aliases}:{row:RecordedTransaction;operation:TransactionOperation|null;reviewing:boolean;graphOpen:boolean;locked:boolean;onAction:(operation:'update'|'split'|'delete')=>void;onOptions:()=>void;onGraph:()=>void;onClose:()=>void;editor:ReactNode;status:ReactNode;aliases?:Record<string,string>}){
 const heading=useRef<HTMLHeadingElement>(null)
 const entry=recordedEntry(row),copy=transactionText(entry,transactionMerchant(entry))
 const amount=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(row.amountCents/100)
 const title=reviewing?'Review '+(operation==='delete'?'deletion':operation==='split'?'split':'change'):operation?titles[operation]??'Transaction':'Transaction'
 useLayoutEffect(()=>{if(!graphOpen)heading.current?.focus({preventScroll:true})},[row.id,operation,reviewing,graphOpen])
 return <aside className="bb-duo-action-pane" id="bb-duo-transaction-pane" role="region" aria-label="Transaction options and editor" data-peek={graphOpen} onKeyDown={event=>{if(event.key==='Escape'&&!locked){event.preventDefault();onClose()}}}>
  <header className="bb-duo-pane-heading">
   {operation&&!reviewing&&!graphOpen&&<button type="button" className="bb-recorded-graph-toggle" aria-label="Back to transaction actions" disabled={locked} onClick={onOptions}><ArrowLeft aria-hidden="true"/></button>}
   <h2 ref={heading} tabIndex={-1}>{title}</h2>
   <div className="bb-duo-pane-tools">
    <button type="button" className="bb-recorded-graph-toggle" aria-label={graphOpen?'Return to transaction editor':'Show Daily Spending'} aria-expanded={graphOpen} aria-controls="bb-recorded-days-graph" disabled={locked} onClick={onGraph}>{graphOpen?<Pencil aria-hidden="true"/>:<ChartNoAxesColumn aria-hidden="true"/>}</button>
    <button type="button" className="bb-recorded-graph-toggle" aria-label="Close transaction options" disabled={locked} onClick={onClose}><X aria-hidden="true"/></button>
   </div>
  </header>
  <div className="bb-duo-pane-content" hidden={graphOpen}>
   <div className="bb-duo-entry-context">
    <TransactionIcon entry={entry} aliases={aliases} eager/>
    <div><strong>{copy.primary}</strong><span>{copy.item?`${copy.category} · ${copy.item}`:copy.category}</span></div>
    <strong className="bb-duo-entry-amount">{amount}</strong>
   </div>
   {!operation&&<div className="bb-duo-entry-actions" role="group" aria-label={`Actions for ${copy.primary}`}>
    {actions.map(([op,label,Icon])=><button key={op} type="button" className={`bb-recorded-action bb-recorded-action-${op}`} data-active={operation===op} disabled={locked||!row.capabilities[op]} aria-label={`${label} ${copy.primary}`} onClick={()=>onAction(op)}><Icon aria-hidden="true"/><span>{label}</span></button>)}
   </div>}
   {!operation&&<p className="bb-duo-action-hint">Choose an action for this entry.</p>}
   {status}
   <div className="bb-duo-editor-host">{editor}</div>
  </div>
 </aside>
}
