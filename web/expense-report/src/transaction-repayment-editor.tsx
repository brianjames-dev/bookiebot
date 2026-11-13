import {Children,cloneElement,isValidElement,useEffect,useLayoutEffect,useRef,type ReactElement,type ReactNode} from 'react'
import {ArrowUp,ArrowDown,Clock3} from 'lucide-react'
import type {RecordedTransaction} from './transactions-screen'
import {InlineTransactionEditor,transactionMotion,type InlineEditorProps} from './transaction-inline-editor'
import {TransactionIcon} from './daily-transactions'
import {recordedEntry} from './recorded-transaction-view'
import {StepMotion} from './transaction-step-motion'
import {ChangedMoney,ChangedText} from './transaction-value-motion'
import {splitMoney} from './transaction-split-model'
import {repaymentLabel} from './transaction-repayment-model'
import './transaction-repayment.css'

/** Two native row tracks keep the pill below the price without moving metadata. */
export function repaymentRow(row:RecordedTransaction,node:ReactNode,open:boolean,onOpen:()=>void,locked:boolean,retain=false):ReactNode {
 const details=row.repayment
 if(!details||(!details.outstandingCents&&!retain)||!isValidElement<{className:string;children:ReactNode}>(node))return node
 const incoming=details.direction==='incoming',key='split:'+row.id+':',children=Children.toArray(node.props.children)
 const has=(child:ReactNode,name:string)=>isValidElement<{className:string}>(child)&&String(child.props.className).split(' ').includes(name)
 const names=children.filter(child=>has(child,'bb-daily-transaction-name')),meta=children.filter(child=>has(child,'bb-daily-transaction-meta'))
 const price=children.filter(child=>has(child,'bb-daily-transaction-money')||has(child,'bb-daily-day-total')).map(child=>cloneElement(child as ReactElement<{className:string;title?:string}>,{className:(child as ReactElement<{className:string}>).props.className+' sp-money-slot',title:details.accounting==='legacy_net'?'Historical recorded amount. See repayment details for the purchase and settlement history.':incoming?'Purchase total minus confirmed repayments received.':'Confirmed repayments paid so far. This purchase context is excluded from spending totals.'}))
 const used=[...names,...meta,...children.filter(child=>has(child,'bb-daily-transaction-money')||has(child,'bb-daily-day-total'))]
 const label=`${incoming?details.partnerName+' owes you':'You owe '+details.payerName} ${splitMoney(details.outstandingCents)}. View repayment details`
 return cloneElement(node,{'data-has-pending-split':true} as any,...children.filter(child=>!used.includes(child)),
  <div className="sp-row-primary" key="primary">{names}{price}</div>,
  <div className="sp-row-secondary" key="secondary">{meta}<button type="button" className="sp-cue" data-direction={incoming?'receive':'send'} data-split-entry={row.id} aria-label={label} aria-expanded={open} aria-controls={'repayment-'+row.id} disabled={locked} onClick={event=>{event.stopPropagation();onOpen()}}><span className="sp-pill">{incoming?<ArrowUp aria-hidden="true"/>:<ArrowDown aria-hidden="true"/>}<span><ChangedMoney value={splitMoney(details.outstandingCents)} motionKey={key+'remaining'}/> {incoming?'Owed':'Due'}</span></span></button></div>)
}

/** Both row Split and repayment Edit split render this same nested native editor. */
export function TransactionRepaymentEditor({row,open,compact,editing,editor,onClose,onEdit,locked}:{row:RecordedTransaction;open:boolean;compact:boolean;editing:boolean;editor:InlineEditorProps;onClose:()=>void;onEdit:()=>void;locked:boolean}){
 const rootRef=useRef<HTMLElement>(null),previous=useRef({mode:'summary',open:false}),cached=useRef(row)
 if(open)cached.current=row
 const shown=open?row:cached.current,details=shown.repayment!,incoming=details.direction==='incoming',key='split:'+shown.id+':',mode=editing?(editor.snapshot?.review?'review':'edit'):'summary'
 useLayoutEffect(()=>{
  const root=rootRef.current!,summary=root.querySelector<HTMLElement>(':scope > .bi-step-viewport > .bi-step-edit')!,edit=root.querySelector<HTMLElement>('.sp-management > .bi-step-viewport > .bi-step-edit')
  if(!edit)return
  let frame=0
  const measure=()=>{const style=getComputedStyle(summary),inset=(parseFloat(style.paddingTop)||0)+(parseFloat(style.paddingBottom)||0),height=compact?Math.max(0,edit.getBoundingClientRect().height-inset):0,current=parseFloat(root.style.getPropertyValue('--sp-summary-height'))||0;if(Math.abs(height-current)>.01)root.style.setProperty('--sp-summary-height',height.toFixed(4)+'px')}
  measure();const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure)});observer.observe(summary);observer.observe(edit)
  return()=>{observer.disconnect();cancelAnimationFrame(frame)}
 },[compact])
 useEffect(()=>{
  const changed=open&&(previous.current.open?previous.current.mode!==mode:mode!=='summary');previous.current={mode,open};if(!changed)return
  const frame=requestAnimationFrame(()=>{const selector=mode==='review'?'.sp-management .bi-step-review .bi-primary':editing?'.sp-management .bi-step-edit .bi-cancel':'.sp-summary-footer .bi-primary:not(:disabled),.sp-summary-footer .bi-cancel';rootRef.current?.querySelector<HTMLButtonElement>(selector)?.focus({preventScroll:true})});return()=>cancelAnimationFrame(frame)
 },[mode,open])
 const yourShare=incoming?details.payerShareCents:details.partnerShareCents,otherShare=details.grossCents-yourShare
 const status=<span className="rp-status"><Clock3 aria-hidden="true"/>{details.outstandingCents===0?'Settled':details.pendingCents?'Payment reported':details.settledCents?'Partly repaid':compact?'Pending':'Awaiting repayment'}</span>
 const method=<ChangedText value={repaymentLabel(shown)} motionKey={key+'method'}/>
 const balance=<div className="rp-balance"><span className="rp-person-name">{incoming?details.partnerName+' owes you':'You owe '+details.payerName}</span><strong className="rp-balance-amount"><ChangedMoney value={splitMoney(details.outstandingCents)} motionKey={key+'remaining'}/></strong>{!compact&&status}</div>
 return <section ref={rootRef} className={'sp-detail'+(compact?' sp-detail-inline':'')} data-entry-id={shown.id} data-direction={incoming?'receive':'send'} data-view={mode} role="region" aria-label="Split repayment details" aria-busy={locked} id={'repayment-'+shown.id} onKeyDown={event=>{if(event.key==='Escape'&&!locked){event.stopPropagation();event.preventDefault();mode==='review'?editor.onBack():editing?editor.onCancel():onClose()}}}>
  <StepMotion review={editing} open={open} mode="slide" duration={transactionMotion.duration} edit={<div className="sp-summary">
   <header className="sp-detail-heading">{compact?balance:<h2>Split details</h2>}</header>
   {!compact&&<><div className="rp-purchase"><TransactionIcon entry={recordedEntry(shown)} eager/><div className="rp-merchant"><strong>{shown.location||shown.title}</strong><span>{shown.categoryLabel} · {shown.date}</span></div></div>{balance}</>}
   {compact&&<div className="rp-inline-status">{status}<span>{method}</span></div>}
   <section className="rp-allocation" aria-label="Purchase allocation"><div className="rp-split-heading"><span>Purchase split</span><span>{!compact&&method}</span></div>
    <div className="rp-split-track" role="img" aria-label={`${details.payerName}'s share ${splitMoney(details.payerShareCents)}; ${details.partnerName}'s share ${splitMoney(details.partnerShareCents)}`}><span data-person="you" style={{flex:yourShare,display:yourShare||locked?'block':'none'}}/><span data-person="partner" style={{flex:otherShare,display:otherShare||locked?'block':'none'}}/></div>
    <div className="rp-shares">{[[incoming?details.payerName:details.partnerName,yourShare,'you'],[incoming?details.partnerName:details.payerName,otherShare,'partner']].map(([name,amount,person])=><div className="rp-share" key={person}><span className="rp-avatar" data-person={person} aria-hidden="true">{String(name)[0]}</span><div><span>{name}{person==='you'?' (You)':''}</span><strong><ChangedMoney value={splitMoney(Number(amount))} motionKey={key+person}/></strong></div></div>)}</div>
   </section>
   <dl className="rp-payment-summary" aria-label="Purchase and repayments"><div><dt>Purchase total</dt><dd>{splitMoney(details.grossCents)}</dd></div><div><dt>{incoming?'Received back':'Repaid by you'}</dt><dd>{splitMoney(details.settledCents)}</dd></div></dl>
   {details.pendingCents>0&&<p className="sp-pending-note">{splitMoney(details.pendingCents)} reported, awaiting confirmation. Only confirmed repayments count as paid.</p>}
   {details.clearedCents>0&&<p className="sp-pending-note">{splitMoney(details.clearedCents)} cleared without a repayment.</p>}
   {details.editReason&&<p className="sp-edit-reason" id={'reason-'+shown.id}>{details.editReason}</p>}
   <footer className="bi-editor-footer sp-summary-footer"><button className="bi-cancel" type="button" disabled={locked} onClick={onClose}>Close</button><button className="bi-primary" type="button" onClick={onEdit} disabled={!details.canEdit||!shown.capabilities.split||locked} aria-describedby={details.editReason?'reason-'+shown.id:undefined}>Edit split</button></footer>
  </div>} confirm={<InlineTransactionEditor {...editor} embedded/>}/>
 </section>
}
