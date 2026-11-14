import type {CurrentBillIntent} from './bill-current-charge'

export function BillCurrentOffer({intent,locked,onKeep,onReview}:{intent:CurrentBillIntent;locked:boolean;onKeep:()=>void;onReview:()=>void}){
 const month=new Date(intent.month+'-01T12:00:00').toLocaleDateString('en-US',{month:'long'})
 const amount=intent.recordedAmountCents
 return <div className="bb-bills-current-offer">
  <header className="sp-flow-heading bb-bill-heading"><h2>Update {month} too?</h2><p className="sp-flow-context">{intent.name}</p></header>
  <p className="bi-footnote">Future charges now use your new settings. {month} already has a recorded charge.</p>
  {amount!==undefined&&<dl className="bi-review-changes"><div className="bi-review-change"><dt>{month} recorded cash</dt><dd><span className="bi-review-new">{new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(amount/100)}</span></dd></div></dl>}
  <footer className="bi-editor-footer"><button className="bi-cancel" type="button" disabled={locked} onClick={onKeep}>Keep {month} as is</button><button className="bi-primary" type="button" disabled={locked} onClick={onReview}>Review charge</button></footer>
 </div>
}
