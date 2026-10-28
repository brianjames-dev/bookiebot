import { ArrowRight, Check, Undo2, X } from "lucide-react"
import { CustomSplitShares } from "./custom-split"

export type TransactionOperation = "update" | "move" | "delete" | "split" | "cancel_split" | "undo"
export interface TransactionChangeSummary {
  operation: TransactionOperation
  title: string
  date: string
  category: string
  location: string
  person: string
  amountCents: number
  before: Record<string, string>
  after: Record<string, string>
  destination?: string
  share?: {method: string; payerCents: number; partnerCents: number; payerBasisPoints?: number; payerName?: string; partnerName?: string}
  restoration?: {operation: "update" | "move"; current: Record<string, string>; currentCategory: string; restoredCategory: string}
}

const categories: Record<string, string> = {grocery: "Grocery", gas: "Gas", food: "Food", shopping: "Shopping", need_expenses: "Needs"}
const fieldNames: Record<string, string> = {item: "Description", source: "Income source", amount: "Amount", location: "Merchant", person: "Person / card"}
const completed: Record<TransactionOperation, string> = {update: "Transaction updated", move: "Transaction moved", delete: "Transaction deleted", split: "Split saved", cancel_split: "Split removed", undo: "Change undone"}
const money = (cents: number) => new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"}).format(cents / 100)
const amount = (value: string) => Math.round(Number(value.replace(/[$,]/g, "")) * 100)
const method = (value: string) => ({income: "By income", equal: "50/50", fronted: "Fronted", custom: "Custom split"}[value] ?? value)
function valueLabel(field: string, value: string) {
  return field === "amount" ? money(amount(value)) : value || "—"
}

export function TransactionChangeDetails({summary, saved = false}: {summary: TransactionChangeSummary; saved?: boolean}) {
  const title = summary.after.item || summary.after.source || summary.title
  const date = summary.date ? new Date(summary.date + "T12:00:00").toLocaleDateString(undefined, {month: "short", day: "numeric"}) : "Undated"
  const restoration = summary.operation === "undo" ? summary.restoration : undefined
  const before = restoration?.current ?? summary.before
  const changes = summary.operation === "update" || restoration?.operation === "update" ? Object.entries(summary.after).filter(([field, value]) => field !== "date" &&
    (field === "amount" ? amount(value) !== amount(before[field] ?? "") : value !== before[field])) : []
  const category = restoration?.restoredCategory ?? (summary.operation === "move" ? categories[summary.destination ?? ""] || summary.category : summary.category)
  return <div className="bb-change-details">
    <div className="bb-change-context"><h3>{title}</h3>{(summary.after.location || summary.location) && <p>{summary.after.location || summary.location}</p>}
      <div className="bb-change-meta"><span>{date}</span><span>{category}</span><span>{summary.after.person || summary.person}</span></div>
    </div>
    {changes.length > 0 && <div className="bb-change-comparisons">{changes.map(([field, value]) => <div className="bb-change-comparison" key={field}>
      <p className="bb-change-label">{field === "amount" && summary.share ? "Full purchase amount" : fieldNames[field] || field}</p>
      <div className="bb-change-values"><div className="bb-change-before"><span>{restoration && !saved ? "Current" : "Previous"}</span><strong>{valueLabel(field, before[field] ?? "")}</strong></div>
        <ArrowRight size={18} aria-hidden="true"/><div className="bb-change-after"><span>{restoration ? saved ? "Restored" : "Restore to" : saved ? "Updated" : "New value"}</span><strong>{valueLabel(field, value)}</strong></div></div>
    </div>)}</div>}
    {!changes.some(([field]) => field === "amount") && <div className="bb-change-total"><span>{summary.share ? "Full purchase amount" : "Amount"}</span><strong>{money(summary.amountCents)}</strong></div>}
    {summary.operation === "move" && <div className="bb-change-category"><span>{summary.category}</span><ArrowRight size={16} aria-hidden="true"/><strong>{category}</strong></div>}
    {restoration?.operation === "move" && <div className="bb-change-comparison bb-change-restoration">
      <p className="bb-change-label">Category</p><div className="bb-change-values">
        <div className="bb-change-before"><span>{saved ? "Previous" : "Current"}</span><strong>{restoration.currentCategory}</strong></div>
        <ArrowRight size={18} aria-hidden="true"/><div className="bb-change-after"><span>{saved ? "Restored" : "Restore to"}</span><strong>{category}</strong></div>
      </div></div>}
    {summary.share && <div className="bb-change-split"><p className="bb-change-label">{method(summary.share.method)}</p>{summary.share.method === "custom" && summary.share.payerBasisPoints !== undefined
      ? <CustomSplitShares payerName={summary.share.payerName ?? "You"} partnerName={summary.share.partnerName ?? "Partner"} payerCents={summary.share.payerCents}
          partnerCents={summary.share.partnerCents} payerBasisPoints={summary.share.payerBasisPoints}/>
      : <div className="bb-change-share-values">
      <div><span>Your share</span><strong>{money(summary.share.payerCents)}</strong></div><div><span>Partner’s share</span><strong>{money(summary.share.partnerCents)}</strong></div>
    </div>}<p className="bb-change-footnote">{saved ? "Repayments are unchanged." : "No repayment will be marked received."}</p></div>}
  </div>
}

export function TransactionCompletion({summary, canUndo, disabled, onUndo, onDismiss}: {
  summary?: TransactionChangeSummary; canUndo: boolean; disabled: boolean; onUndo: () => void; onDismiss: () => void
}) {
  return <section role="status" className="bb-transaction-completion" aria-label="Saved transaction change">
    <div className="bb-change-status"><span className="bb-change-check"><Check size={18} aria-hidden="true"/></span><h2>{summary ? completed[summary.operation] || "Change saved" : "Change saved"}</h2>
      <button type="button" className="bb-change-dismiss" aria-label="Dismiss transaction result" disabled={disabled} onClick={onDismiss}><X size={17} aria-hidden="true"/></button></div>
    {summary ? <TransactionChangeDetails summary={summary} saved/> : <p className="bb-change-legacy">Your transaction change was saved.</p>}
    {canUndo && <div className="bb-change-footer"><button type="button" className="bb-change-undo" disabled={disabled} onClick={onUndo}><Undo2 size={17} aria-hidden="true"/>Undo this change</button></div>}
  </section>
}
