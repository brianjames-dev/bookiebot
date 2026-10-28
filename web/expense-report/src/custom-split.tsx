import { useState } from "react"
import "./custom-split.css"

const money = (cents: number) => new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"}).format(cents / 100)
const percent = (cents: number, total: number) => `${(cents / total * 100).toFixed(2)}%`
interface Shares { payerName: string; partnerName: string; payerCents: number; partnerCents: number }

export function CustomSplitShares({payerName, partnerName, payerCents, partnerCents}: Shares) {
  const total = payerCents + partnerCents
  return <div className="bb-custom-split-shares" aria-live="polite" aria-atomic="true">
    {[{name: payerName, cents: payerCents}, {name: partnerName, cents: partnerCents}].map(side =>
      <div key={side.name}><span>{side.name}</span><strong>{money(side.cents)}</strong>
        <span className="bb-custom-split-percent">{percent(side.cents, total)}</span></div>)}
  </div>
}

export function CustomSplitControl({grossCents, payerCents, payerName, partnerName, disabled, onChange, onValidityChange}: {
  grossCents: number; payerCents: number; payerName: string; partnerName: string; disabled: boolean; onChange: (cents: number) => void; onValidityChange: (valid: boolean) => void
}) {
  const [draft, setDraft] = useState<{payer: boolean; text: string} | null>(null)
  const parsed = (text: string) => {
    if (!/^\d+(?:\.\d{0,2})?$/.test(text)) return null
    const cents = Math.round(Number(text) * 100)
    return Number.isSafeInteger(cents) && cents >= 0 && cents <= grossCents ? cents : null
  }
  return <div className="bb-custom-split-control" role="group" aria-label="Custom split">
    <div className="bb-custom-split-shares" aria-live="polite" aria-atomic="true">
      {[{name: payerName, cents: payerCents, payer: true}, {name: partnerName, cents: grossCents - payerCents, payer: false}].map(side =>
        <div key={side.name}><span>{side.name}</span><label className="bb-custom-split-amount"><span aria-hidden="true">$</span>
          <input type="number" inputMode="decimal" min="0" max={grossCents / 100} step="0.01" required disabled={disabled}
            aria-label={`${side.name}'s share amount`} value={draft?.payer === side.payer ? draft.text : (side.cents / 100).toFixed(2)}
            onChange={event => {
              const text = event.target.value, cents = parsed(text)
              setDraft({payer: side.payer, text}); onValidityChange(cents !== null)
              if (cents !== null) onChange(side.payer ? cents : grossCents - cents)
            }} onBlur={() => { if (draft && parsed(draft.text) !== null) setDraft(null) }}/>
        </label><span className="bb-custom-split-percent">{percent(side.cents, grossCents)}</span></div>)}
    </div>
    <label className="bb-custom-split-slider">{payerName}’s share<input type="range" min="0" max={grossCents} step="1" value={payerCents} disabled={disabled}
      aria-label={`${payerName}'s share amount slider`} aria-valuetext={`${payerName}: ${money(payerCents)}, ${percent(payerCents, grossCents)}; ${partnerName}: ${money(grossCents - payerCents)}, ${percent(grossCents - payerCents, grossCents)}`}
      onChange={event => { setDraft(null); onValidityChange(true); onChange(Math.max(0, Math.min(grossCents, Math.round(Number(event.target.value))))) }}/></label>
    <p className="bb-custom-split-hint" role={draft && parsed(draft.text) === null ? "status" : undefined}>{draft && parsed(draft.text) === null
      ? `Enter an amount between $0.00 and ${money(grossCents)}, using up to two decimal places.`
      : "Adjust the slider or enter either dollar amount."}</p>
  </div>
}
