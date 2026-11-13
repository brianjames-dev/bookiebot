import type {RecordedTransaction} from './transactions-screen'
import {splitMoney} from './transaction-split-model'
import {TransactionIcon} from './daily-transactions'
import {recordedEntry} from './recorded-transaction-view'
import {transactionMerchant,transactionText} from './transaction-identity'

export const transactionHasActions=(row:RecordedTransaction)=>row.capabilities.update||row.capabilities.split||row.capabilities.delete
export function TransactionEntryContext({row,aliases}:{row:RecordedTransaction;aliases?:Record<string,string>}){
 const entry=recordedEntry(row),copy=transactionText(entry,transactionMerchant(entry,aliases))
 return <div className="bb-duo-entry-context"><TransactionIcon entry={entry} aliases={aliases} eager/><div><strong>{copy.primary}</strong><span>{copy.item?`${copy.category} · ${copy.item}`:copy.category}</span></div><strong className="bb-duo-entry-amount">{splitMoney(row.displayAmountCents??row.amountCents)}</strong></div>
}

export function RecordedTransactionDetails({row,onClose,locked=false,pane=false,aliases}:{row:RecordedTransaction;onClose:()=>void;locked?:boolean;pane?:boolean;aliases?:Record<string,string>}){
 const offset=/^Offset(?: ·| to )/i.test(row.title)||/^Offset to /i.test(row.location)
 const explanation=offset?'This offset settles part of a shared split. Its recorded settlement can be viewed or reversed in Shared.':row.notice||row.reasons.update||'This recorded entry is available for inspection.'
 if(pane)return <section className="bb-recorded-detail-pane" id={'recorded-details-'+row.id} role="region" aria-label="Recorded transaction details"><TransactionEntryContext row={row} aliases={aliases}/><p className="bb-duo-action-hint">{explanation}</p></section>
 return <section className="bb-recorded-detail" id={'recorded-details-'+row.id} role="region" aria-label="Recorded transaction details">
  <header><h3>{offset?'Offset transaction':'Transaction details'}</h3><span>{row.location||row.title}</span><strong>{splitMoney(row.displayAmountCents??row.amountCents)}</strong></header>
  <dl><div><dt>Date</dt><dd>{row.date?new Date(row.date+'T12:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'Not recorded'}</dd></div><div><dt>Category</dt><dd>{row.categoryLabel}</dd></div><div><dt>Card</dt><dd>{row.person}</dd></div>{row.fields.item&&<div><dt>Item</dt><dd>{row.fields.item}</dd></div>}</dl>
  <p>{explanation}</p>
  <footer className="bi-editor-footer"><button className="bi-cancel" type="button" disabled={locked} onClick={onClose}>Close</button></footer>
 </section>
}
