import {useLayoutEffect,useRef,useState} from 'react'
import {ArrowLeft,ArrowRight,ChevronDown} from 'lucide-react'
import type {RecordedTransaction} from './transactions-screen'
import type {TransactionChangeSummary,TransactionOperation} from './transaction-change-summary'
import {StepMotion} from './transaction-step-motion'
import {NotchedSplitControl} from './transaction-split-control'
import {splitMoney,splitMethodLabel,type SplitMethod} from './transaction-split-model'
import './transaction-inline-editor.css'

export const transactionMotion={duration:440,rollDuration:1200,strikeDelay:360,strikeDuration:300,strikeHold:700,fadeDuration:260,undoSeconds:8,reorderLift:160,reorderGap:220,reorderTravel:400,reorderLand:180,reorderHeight:6,reorderSpace:3}
export type InlineSnapshot={row:RecordedTransaction;operation:TransactionOperation;draft:Record<string,string>;destination:string;method:SplitMethod;payerCents:number;review:TransactionChangeSummary|null;canReview:boolean;locked:boolean;busy:boolean;categories:Record<string,string>;persons:string[];error:string}
type Props={snapshot:InlineSnapshot|null;onField:(key:string,value:string)=>void;onCategory:(value:string)=>void;onShare:(value:number,method:SplitMethod)=>void;onValidity:(value:boolean)=>void;onReview:()=>void;onConfirm:()=>void;onBack:()=>void;onCancel:()=>void;onRemoveSplit:()=>void}
const names:Record<string,string>={amount:'Amount',item:'Item',source:'Income source',location:'Merchant',person:'Card',category:'Category'}
export function transactionReviewChanges(summary:TransactionChangeSummary,row:RecordedTransaction){
 const restoration=summary.operation==='undo'?summary.restoration:undefined,before=restoration?.current??summary.before
 const changes=Object.entries(summary.after).filter(([key,value])=>key!=='date'&&(key==='amount'?Math.round(Number(value.replace(/[$,]/g,''))*100)!==Math.round(Number((before[key]??'').replace(/[$,]/g,''))*100):value!==(before[key]??''))).map(([key,value])=>({field:key,label:names[key]??key,before:key==='amount'?splitMoney(Math.round(Number((before[key]??'0').replace(/[$,]/g,''))*100)):before[key]||'—',after:key==='amount'?splitMoney(Math.round(Number(value.replace(/[$,]/g,''))*100)):value||'—'}))
 if(summary.operation==='move'||restoration?.operation==='move')changes.splice(1,0,{field:'category',label:'Category',before:restoration?.currentCategory??summary.category,after:restoration?.restoredCategory??summary.destination??summary.category})
 if(summary.share){
  const share=summary.share,payer=share.payerName??row.splitOptions?.payerName??'You',partner=share.partnerName??row.splitOptions?.partnerName??'Partner',old=row.splitOptions?.payerCents??row.amountCents
  const prior=row.split?splitMethodLabel(row.split as SplitMethod,0,partner):'Not split',next=splitMethodLabel(share.method as SplitMethod,0,partner).replace(' · 0/100','')
  for(const change of[{field:'split-method',label:'Split',before:prior.replace(' · 0/100',''),after:next},{field:'payer-share',label:`${payer}’s share`,before:splitMoney(old),after:splitMoney(share.payerCents)},{field:'partner-share',label:`${partner} owes ${payer}`,before:splitMoney(row.amountCents-old),after:splitMoney(share.partnerCents)}])if(change.before!==change.after)changes.push(change)
 }
 return changes
}
export function InlineTransactionEditor(props:Props){
 const cached=useRef<Props|null>(null),[shown,setShown]=useState(false)
 if(props.snapshot)cached.current=props
 const current=props.snapshot?props:cached.current,snapshot=current?.snapshot,open=Boolean(props.snapshot)
 useLayoutEffect(()=>{if(!open){setShown(false);return}const frame=requestAnimationFrame(()=>setShown(true));return()=>cancelAnimationFrame(frame)},[open])
 if(!current||!snapshot)return null
 const {row,operation,draft,destination,method,payerCents,review,canReview,locked,busy,categories,persons,error}=snapshot
 const field=(key:string,label=names[key]??key)=><label key={key}>{label}<input type="text" aria-label={label} inputMode={key==='amount'?'decimal':undefined} disabled={locked} value={draft[key]??''} onChange={event=>current.onField(key,event.target.value)}/></label>
 const payer=row.splitOptions?.payerName??'You',partner=row.splitOptions?.partnerName??'Partner',incomeTarget=row.splitOptions?.incomePayerCents
 const editing=operation==='update'||operation==='move',title=editing?'Update purchase':operation==='split'?'Split purchase':operation==='delete'?'Delete purchase':operation==='undo'?'Undo change':'Remove split'
 const changes=review?transactionReviewChanges(review,row):[]
 return <div className="bi-expansion" data-open={shown&&open} aria-hidden={!open} inert={!open}><div className="bi-expansion-clip"><section className="bi-editor" data-operation={operation} data-review={Boolean(review)} data-design="levels" role="region" aria-label="Edit transaction">
  <span className="bi-sr-only">{title}</span>
  <StepMotion review={Boolean(review)} open={open} mode="slide" duration={transactionMotion.duration} edit={<>
   <form className="bi-fields" onSubmit={event=>{event.preventDefault();if(canReview&&!locked)current.onReview()}}>
   {editing?<>
    <div className="bi-key-fields"><label>Amount<span className="bi-money-input"><span aria-hidden="true">$</span><input type="text" inputMode="decimal" aria-label="Amount" disabled={locked} value={draft.amount??''} onChange={event=>current.onField('amount',event.target.value)}/></span></label>{row.capabilities.move&&<label>Category<span className="bi-select"><select aria-label="Update category" disabled={locked} value={destination} onChange={event=>current.onCategory(event.target.value)}>{Object.entries(categories).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select><ChevronDown aria-hidden="true"/></span></label>}</div>
    {row.editableFields.filter(key=>['item','source'].includes(key)).map(key=>field(key))}
    {['food','shopping','need_expenses'].includes(destination)&&!row.editableFields.includes('item')&&field('item')}
    <div className="bi-secondary-fields">{row.editableFields.includes('location')&&field('location')}{row.editableFields.includes('person')&&<label>Card<span className="bi-select"><select aria-label="Person or card" disabled={locked} value={draft.person??''} onChange={event=>current.onField('person',event.target.value)}>{[...new Set([draft.person,...persons])].filter(Boolean).map(value=><option key={value} value={value}>{value}</option>)}</select><ChevronDown aria-hidden="true"/></span></label>}</div>
   </>:operation==='split'?<><NotchedSplitControl total={row.amountCents} payerCents={payerCents} method={method} incomeBasis={incomeTarget===undefined?5000:Math.round(incomeTarget/row.amountCents*10000)} incomeTarget={incomeTarget} payerName={payer} partnerName={partner} allowCustom={row.splitOptions?.custom??false} capture={7} disabled={locked||Boolean(review)} onChange={current.onShare} onValidityChange={current.onValidity}/>{row.capabilities.cancel_split&&<button type="button" className="bi-cancel" disabled={locked} onClick={current.onRemoveSplit}>Remove split</button>}</>:<div className="bi-delete-copy"><p>{operation==='delete'?'Remove this recorded purchase?':operation==='cancel_split'?'Remove this split?':'Undo this change?'}</p><span>{operation==='delete'?'Only this entry is removed. Its saved history is retained.':'Repayments remain separate.'}</span></div>}
   <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={current.onCancel}>Cancel</button><button type="submit" className="bi-primary" disabled={!canReview||locked}>{busy?'Preparing review…':operation==='delete'?'Review deletion':operation==='split'?'Review split':'Review change'}</button></footer>
   </form>
  </>} confirm={<>
   {review&&<><dl className="bi-review-changes" aria-label="Changes to review">{changes.map(change=><div className="bi-review-change" key={change.field} data-field={change.field}><dt>{change.label}</dt><dd><del>{change.before}</del><span className="bi-review-new"><ArrowRight aria-hidden="true"/><span>{change.field==='category'?(categories[change.after]??change.after):change.after}</span></span></dd></div>)}</dl>
    {operation==='delete'&&<p className="bi-footnote">{row.title} · {splitMoney(row.amountCents)}. Only this purchase will be removed.</p>}
    {review.share&&<p className="bs-review-note">No repayment will be marked received.</p>}
   </>}
   <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={current.onBack}><ArrowLeft aria-hidden="true"/>Back</button><button type="button" className="bi-primary" disabled={locked||!review} onClick={current.onConfirm} aria-label={`Confirm ${operation==='move'?'update':operation}`}>{busy?'Saving…':operation==='delete'?'Delete purchase':operation==='split'?'Save split':operation==='cancel_split'?'Remove split':operation==='undo'?'Undo change':'Save changes'}</button></footer>
  </>}/>
  {error&&<p role="alert" className="bs-error">{error}</p>}
 </section></div></div>
}
