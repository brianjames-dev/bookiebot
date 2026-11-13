import type {RecordedTransaction} from './transactions-screen'
import {splitMoney} from './transaction-split-model'

export const transactionHasActions=(row:RecordedTransaction)=>row.capabilities.update||row.capabilities.split||row.capabilities.delete
export function RecordedTransactionDetails({row,onClose,locked=false}:{row:RecordedTransaction;onClose:()=>void;locked?:boolean}){
 const offset=/^Offset(?: ·| to )/i.test(row.title)||/^Offset to /i.test(row.location)
 return <section className="bb-recorded-detail" id={'recorded-details-'+row.id} role="region" aria-label="Recorded transaction details">
  <header><h3>{offset?'Offset transaction':'Transaction details'}</h3><span>{row.location||row.title}</span><strong>{splitMoney(row.displayAmountCents??row.amountCents)}</strong></header>
  <dl><div><dt>Date</dt><dd>{row.date?new Date(row.date+'T12:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'Not recorded'}</dd></div><div><dt>Category</dt><dd>{row.categoryLabel}</dd></div><div><dt>Card</dt><dd>{row.person}</dd></div>{row.fields.item&&<div><dt>Item</dt><dd>{row.fields.item}</dd></div>}</dl>
  <p>{offset?'This offset settles part of a shared balance. Its recorded settlement can be viewed or reversed in Shared.':row.notice||row.reasons.update||'This recorded entry is available for inspection.'}</p>
  <footer className="bi-editor-footer"><button className="bi-cancel" type="button" disabled={locked} onClick={onClose}>Close</button></footer>
 </section>
}
