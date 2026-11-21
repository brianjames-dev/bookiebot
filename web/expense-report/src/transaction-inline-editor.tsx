import {useLayoutEffect,useRef,useState} from 'react'
import {ArrowLeft,ArrowRight,ChevronDown,Ellipsis,Scissors} from 'lucide-react'
import type {RecordedTransaction} from './transactions-screen'
import type {TransactionChangeSummary,TransactionOperation} from './transaction-change-summary'
import {StepMotion} from './transaction-step-motion'
import {NotchedSplitControl,type SplitInputDraft} from './transaction-split-control'
import {splitMoney,splitMethodLabel,type SplitMethod} from './transaction-split-model'
import {SavingButton} from './report-loading'
import './transaction-inline-editor.css'

export const transactionMotion={duration:440,rollDuration:1200,strikeDelay:360,strikeDuration:300,strikeHold:700,fadeDuration:260,undoSeconds:8,reorderLift:160,reorderGap:220,reorderTravel:400,reorderLand:180,reorderHeight:6,reorderSpace:3}
export type InlineSnapshot={row:RecordedTransaction;operation:TransactionOperation;draft:Record<string,string>;destination:string;method:SplitMethod;payerCents:number;splitInput?:SplitInputDraft;review:TransactionChangeSummary|null;canReview:boolean;locked:boolean;busy:boolean;categories:Record<string,string>;persons:string[];error:string}
export type InlineEditorProps={embedded?:boolean;contained?:boolean;active?:boolean;snapshot:InlineSnapshot|null;onField:(key:string,value:string)=>void;onCategory:(value:string)=>void;onShare:(value:number,method:SplitMethod)=>void;onValidity:(value:boolean)=>void;onSplitInput?:(draft:SplitInputDraft)=>void;onReview:()=>void;onConfirm:()=>void;onBack:()=>void;onCancel:()=>void;onRemoveSplit:()=>void}
const names:Record<string,string>={amount:'Amount',item:'Item',source:'Income source',location:'Merchant',person:'Card',category:'Category',fromAccount:'From',toAccount:'To',goalName:'Savings goal'}
export function transactionReviewChanges(summary:TransactionChangeSummary,row:RecordedTransaction){
 const restoration=summary.operation==='undo'?summary.restoration:undefined,before=restoration?.current??summary.before
 const changes=Object.entries(summary.after).filter(([key,value])=>key!=='date'&&!(row.kind==='transfer'&&['goalId','goalName'].includes(key))&&(key==='amount'?Math.round(Number(value.replace(/[$,]/g,''))*100)!==Math.round(Number((before[key]??'').replace(/[$,]/g,''))*100):value!==(before[key]??''))).map(([key,value])=>({field:key,label:row.kind==='transfer'&&key==='item'?'Name':names[key]??key,before:key==='amount'?splitMoney(Math.round(Number((before[key]??'0').replace(/[$,]/g,''))*100)):before[key]||(key==='goalName'?'No goal':'—'),after:key==='amount'?splitMoney(Math.round(Number(value.replace(/[$,]/g,''))*100)):value||(key==='goalName'?'No goal':'—')}))
 if(summary.operation==='move'||restoration?.operation==='move')changes.splice(1,0,{field:'category',label:'Category',before:restoration?.currentCategory??summary.category,after:restoration?.restoredCategory??summary.destination??summary.category})
 if(summary.share){
  const share=summary.share,payer=share.payerName??row.splitOptions?.payerName??'You',partner=share.partnerName??row.splitOptions?.partnerName??'Partner',old=row.splitOptions?.payerCents??row.amountCents
  const prior=row.split?splitMethodLabel(row.split as SplitMethod,0,partner):'Not split',next=splitMethodLabel(share.method as SplitMethod,0,partner).replace(' · 0/100','')
  for(const change of[{field:'split-method',label:'Split',before:prior.replace(' · 0/100',''),after:next},{field:'payer-share',label:`${payer}’s share`,before:splitMoney(old),after:splitMoney(share.payerCents)},{field:'partner-share',label:`${partner} owes ${payer}`,before:splitMoney(row.amountCents-old),after:splitMoney(share.partnerCents)}])if(change.before!==change.after)changes.push(change)
 }
 if(summary.operation==='cancel_split'){
  const payer=row.splitOptions?.payerName??'You',partner=row.splitOptions?.partnerName??'Partner',old=row.splitOptions?.payerCents??row.amountCents
  for(const change of[{field:'split-method',label:'Split',before:splitMethodLabel(row.split as SplitMethod,0,partner).replace(' · 0/100',''),after:'Not split'},{field:'payer-share',label:`${payer}’s share`,before:splitMoney(old),after:splitMoney(row.amountCents)},{field:'partner-share',label:`${partner} owes ${payer}`,before:splitMoney(row.amountCents-old),after:splitMoney(0)}])if(change.before!==change.after)changes.push(change)
 }
 return changes
}
export function transferGoalEffects(effect:TransactionChangeSummary['transferEffect']){
 if(!effect)return []
 if(effect.goalBeforeId===effect.goalAfterId)return effect.goalBeforeId?[{name:effect.goalBeforeName,before:effect.savedBeforeCents,after:effect.savedAfterCents}]:[]
 const duplicateName=effect.goalBeforeName===effect.goalAfterName
 return [...(effect.goalBeforeId?[{name:effect.goalBeforeName+(duplicateName?' · previous':''),before:effect.savedBeforeCents,after:0}]:[]),...(effect.goalAfterId?[{name:effect.goalAfterName+(duplicateName?' · new':''),before:0,after:effect.savedAfterCents}]:[])]
}
export function InlineTransactionEditor(props:InlineEditorProps){
 const cached=useRef<InlineEditorProps|null>(null),[shown,setShown]=useState(false)
 if(props.snapshot)cached.current=props
 const current=props.snapshot?props:cached.current,snapshot=current?.snapshot,open=Boolean(props.snapshot)&&props.active!==false
 useLayoutEffect(()=>{if(!open){setShown(false);return}const frame=requestAnimationFrame(()=>setShown(true));return()=>cancelAnimationFrame(frame)},[open])
 if(!current||!snapshot)return null
 const {row,operation,draft,destination,method,payerCents,splitInput,review,canReview,locked,busy,categories,persons,error}=snapshot
 const transfer=row.kind==='transfer'
 const field=(key:string,label=names[key]??key)=><label key={key}>{label}<input type="text" aria-label={label} maxLength={transfer?80:undefined} inputMode={key==='amount'?'decimal':undefined} disabled={locked} value={draft[key]??''} onChange={event=>current.onField(key,event.target.value)}/></label>
 const payer=row.splitOptions?.payerName??'You',partner=row.splitOptions?.partnerName??'Partner',incomeTarget=row.splitOptions?.incomePayerCents
 const editing=operation==='update'||operation==='move',title=editing?(transfer?'Update transfer':'Update purchase'):operation==='split'?'Split purchase':operation==='delete'?(transfer?'Delete transfer':'Delete purchase'):operation==='undo'?'Undo change':'Remove split'
 const changes=review?transactionReviewChanges(review,row):[]
 const effect=review?.transferEffect
 const goalEffects=transferGoalEffects(effect)
 const content=<section className={"bi-editor"+(operation==='split'?' sp-management':'')+(props.embedded?' bi-editor-embedded':'')} data-kind={row.kind} data-operation={operation} data-review={Boolean(review)} data-design="levels" role="region" aria-label="Edit transaction">
  <span className="bi-sr-only">{title}</span>
  <StepMotion review={Boolean(review)} open={open} mode="slide" duration={transactionMotion.duration} edit={<>
   {operation==='split'&&<header className="sp-flow-heading"><h2>Edit split</h2><p className="sp-flow-context">{row.location||row.title} · {splitMoney(row.amountCents)}</p>{row.capabilities.cancel_split&&<details className="sp-split-options">
    <summary aria-label="Split options"><Ellipsis aria-hidden="true"/></summary>
    <div className="sp-split-options-panel"><button type="button" className="bb-report-menu-action bb-option-destructive" disabled={locked} onClick={current.onRemoveSplit}><Scissors aria-hidden="true"/>Remove split</button></div>
   </details>}</header>}
   <form className="bi-fields" onSubmit={event=>{event.preventDefault();if(canReview&&!locked)current.onReview()}}>
   {editing&&transfer?<>
    <div className="bi-key-fields"><label>Amount<span className="bi-money-input"><span aria-hidden="true">$</span><input type="text" inputMode="decimal" aria-label="Amount" disabled={locked} value={draft.amount??''} onChange={event=>current.onField('amount',event.target.value)}/></span></label>{field('item','Name')}</div>
    <div className="bi-secondary-fields">{field('fromAccount')}{field('toAccount')}</div>
    <label>Savings goal<span className="bi-select"><select aria-label="Savings goal" disabled={locked} value={draft.goalId??''} onChange={e=>current.onField('goalId',e.target.value)}><option value="">No goal</option>{row.transferOptions?.goals.filter(g=>!g.archived||g.id===row.fields.goalId).map(g=><option key={g.id} value={g.id} disabled={g.archived&&g.id!==row.fields.goalId}>{g.name}{g.archived?' (archived)':''}</option>)}</select><ChevronDown aria-hidden="true"/></span></label>
    <p className="bi-footnote">Only this transfer changes. Its recurring schedule continues.</p>
   </>:editing?<>
    <div className="bi-key-fields"><label>Amount<span className="bi-money-input"><span aria-hidden="true">$</span><input type="text" inputMode="decimal" aria-label="Amount" disabled={locked} value={draft.amount??''} onChange={event=>current.onField('amount',event.target.value)}/></span></label>{row.capabilities.move&&<label>Category<span className="bi-select"><select aria-label="Update category" disabled={locked} value={destination} onChange={event=>current.onCategory(event.target.value)}>{Object.entries(categories).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select><ChevronDown aria-hidden="true"/></span></label>}</div>
    {row.editableFields.filter(key=>['item','source'].includes(key)).map(key=>field(key))}
    {['food','shopping','need_expenses'].includes(destination)&&!row.editableFields.includes('item')&&field('item')}
    <div className="bi-secondary-fields">{row.editableFields.includes('location')&&field('location')}{row.editableFields.includes('person')&&<label>Card<span className="bi-select"><select aria-label="Person or card" disabled={locked} value={draft.person??''} onChange={event=>current.onField('person',event.target.value)}>{[...new Set([draft.person,...persons])].filter(Boolean).map(value=><option key={value} value={value}>{value}</option>)}</select><ChevronDown aria-hidden="true"/></span></label>}</div>
   </>:operation==='split'?<><NotchedSplitControl inputDraft={splitInput} onInputDraft={current.onSplitInput} total={row.amountCents} payerCents={payerCents} method={method} incomeBasis={incomeTarget===undefined?5000:Math.round(incomeTarget/row.amountCents*10000)} incomeTarget={incomeTarget} allowIncome={incomeTarget!==undefined} payerName={payer} partnerName={partner} allowCustom={row.splitOptions?.custom??false} capture={7} disabled={locked||Boolean(review)} onChange={current.onShare} onValidityChange={current.onValidity}/></>:<div className="bi-delete-copy"><p>{operation==='delete'?(transfer?'Remove this individual transfer?':'Remove this recorded purchase?'):operation==='cancel_split'?'Remove this split?':'Undo this change?'}</p><span>{transfer?'Saved and its linked goal adjust for this entry. The recurring schedule continues.':operation==='delete'?'Only this entry is removed. Its saved history is retained.':'Repayments remain separate.'}</span></div>}
   <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={current.onCancel}>Cancel</button><button type="submit" aria-label={operation==='split'?'Review split':undefined} className="bi-primary" disabled={!canReview||locked}>{busy?'Preparing review…':operation==='delete'?'Review deletion':operation==='split'?'Review':'Review change'}</button></footer>
   </form>
  </>} confirm={<>
   {operation==='split'&&<header className="sp-flow-heading"><h2>Review split</h2><p className="sp-flow-context">{row.location||row.title} · {splitMoney(row.amountCents)}</p></header>}
   {review&&<>{transfer&&<p className="bi-transfer-context" title={row.title}>{row.title} · {row.date}</p>}<dl className="bi-review-changes" aria-label="Changes to review">{changes.map(change=><div className="bi-review-change" key={change.field} data-field={change.field}><dt>{change.label}</dt><dd><del title={change.before}>{change.before}</del><span className="bi-review-new"><ArrowRight aria-hidden="true"/><span title={change.after}>{change.field==='category'?(categories[change.after]??change.after):change.after}</span></span></dd></div>)}</dl>
    {transfer&&effect&&<dl className="bi-transfer-effects" aria-label="Transfer savings adjustments">{[{name:'Saved contribution',before:effect.savedBeforeCents,after:effect.savedAfterCents},...goalEffects].map((value,index)=><div key={index}><dt title={value.name}>{value.name}</dt><dd>{splitMoney(value.before)} <ArrowRight aria-hidden="true"/> {splitMoney(value.after)}</dd></div>)}</dl>}
    {transfer?<p className="bi-footnote">Only this transfer changes. Its recurring schedule continues.</p>:operation==='delete'&&<p className="bi-footnote">{row.title} · {splitMoney(row.amountCents)}. Only this purchase will be removed.</p>}
    {(review.share||operation==='cancel_split')&&<p className="bs-review-note">No repayment will be marked received.</p>}
   </>}
   <footer className="bi-editor-footer"><button type="button" className="bi-cancel" disabled={locked} onClick={current.onBack}><ArrowLeft aria-hidden="true"/>Back</button><SavingButton type="button" className="bi-primary" disabled={locked||!review} saving={busy&&Boolean(review)} onClick={current.onConfirm} aria-label={`Confirm ${operation==='move'?'update':operation}`}>{operation==='delete'?(transfer?'Delete transfer':'Delete purchase'):operation==='split'?'Save':operation==='cancel_split'?'Remove split':operation==='undo'?'Undo change':'Save changes'}</SavingButton></footer>
  </>}/>
  {error&&<p role="alert" className="bs-error">{error}</p>}
 </section>
 return props.embedded||props.contained?content:<div className="bi-expansion" data-open={shown&&open} aria-hidden={!open} inert={!open}><div className="bi-expansion-clip">{content}</div></div>
}
