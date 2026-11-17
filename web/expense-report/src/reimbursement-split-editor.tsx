import { useState } from "react"
import { InlineTransactionEditor, type InlineSnapshot } from "./transaction-inline-editor"
import type { RecordedTransaction } from "./transactions-screen"
import type { TransactionChangeSummary } from "./transaction-change-summary"
import type { SplitInputDraft } from "./transaction-split-control"
import type { SplitMethod } from "./transaction-split-model"
import type { LedgerAllocation, Run } from "./reimbursement-ledger"
import { useAppWorkStatus } from "./app-work-guard"

/** Native Transactions view; the existing canonical ledger remains its writer. */
export function ReimbursementSplitEditor({ allocation, incomePayerCents, active, disabled, blocked, run, close }: {
  allocation: LedgerAllocation; incomePayerCents?: number; active: boolean; disabled: boolean; blocked: boolean; run: Run; close: () => void
}) {
  const [source] = useState(allocation)
  const [income] = useState(incomePayerCents)
  const [payerCents, setPayerCents] = useState(source.payerShareCents)
  const [method, setMethod] = useState(source.method as SplitMethod)
  const [splitInput, setSplitInput] = useState<SplitInputDraft>(null)
  const [valid, setValid] = useState(true)
  const [review, setReview] = useState<TransactionChangeSummary | null>(null)
  const [finished, setFinished] = useState(false)
  const payerName = source.payerOwner[0].toUpperCase() + source.payerOwner.slice(1)
  const partnerName = source.partnerOwner[0].toUpperCase() + source.partnerOwner.slice(1)
  const changed = payerCents !== source.payerShareCents || method !== source.method
  const stale = source.version !== allocation.version
  const finish = () => { setPayerCents(source.payerShareCents); setMethod(source.method as SplitMethod); setSplitInput(null); setValid(true); setReview(null); close() }
  useAppWorkStatus({ label: "Split changes", dirty: !finished && (changed || splitInput !== null || Boolean(review)), onDiscard: finish })
  const row: RecordedTransaction = {
    id: source.id, actionId: source.id, month: source.expenseDate.slice(0, 7), version: String(source.version), date: source.expenseDate,
    title: source.item || source.category, location: source.location, person: source.payerPerson, kind: "expense", category: source.category, categoryLabel: source.category,
    amountCents: source.grossCents, split: source.method, fields: {}, editableFields: [], reasons: {},
    capabilities: { update: false, move: false, split: true, delete: false, undo: false, cancel_split: false },
    splitOptions: { custom: true, payerName, partnerName, payerCents: source.payerShareCents,
      payerBasisPoints: Math.round(source.payerShareCents / source.grossCents * 10_000), incomePayerCents: income },
  }
  const canReview = changed && valid && !blocked && !stale
  const snapshot: InlineSnapshot = { row, operation: "split", draft: {}, destination: source.category, method, payerCents, splitInput,
    review: (stale || blocked) && !finished ? null : review, canReview, locked: disabled, busy: disabled, categories: {}, persons: [],
    error: finished ? "" : stale ? "This expense changed. Cancel and reopen Edit split to review the latest amounts." : blocked ? "This split cannot be changed while a repayment or sheet update is pending." : "" }
  return <InlineTransactionEditor embedded active={active} snapshot={snapshot} onField={() => {}} onCategory={() => {}}
    onShare={(cents, next) => { setPayerCents(cents); setMethod(next) }} onValidity={setValid} onSplitInput={setSplitInput}
    onReview={() => { if (canReview && !disabled) setReview({ operation: "split", title: row.title, date: row.date, category: row.category,
      location: row.location, person: row.person, amountCents: row.amountCents, before: {}, after: {},
      share: { method, payerCents, partnerCents: row.amountCents - payerCents, payerName, partnerName } }) }}
    onBack={() => setReview(null)} onCancel={finish} onRemoveSplit={() => {}} onConfirm={() => {
      if (!review?.share || disabled || stale || blocked) return
      run({ operation: "edit_split", allocationId: source.id, version: source.version, grossCents: source.grossCents,
        method: review.share.method, payerShareCents: review.share.payerCents }, saved => { if (saved) { setFinished(true); close() } })
    }}/>
}
