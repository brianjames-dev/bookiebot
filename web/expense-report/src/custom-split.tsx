import "./custom-split.css"

const money = (cents: number) => new Intl.NumberFormat("en-US", {style: "currency", currency: "USD"}).format(cents / 100)
const percent = (basis: number) => `${(basis / 100).toFixed(2)}%`
interface Shares {
  payerName: string; partnerName: string; payerCents: number; partnerCents: number; payerBasisPoints: number
}

export function CustomSplitShares({payerName, partnerName, payerCents, partnerCents, payerBasisPoints, onChange, disabled}: Shares & {
  onChange?: (basis: number) => void; disabled?: boolean
}) {
  return <div className="bb-custom-split-shares" aria-live="polite" aria-atomic="true">
    {[{name: payerName, cents: payerCents, basis: payerBasisPoints, payer: true},
      {name: partnerName, cents: partnerCents, basis: 10_000 - payerBasisPoints, payer: false}].map(side =>
      <div key={side.name}><span>{side.name}</span><strong>{money(side.cents)}</strong>
        {onChange ? <label className="bb-custom-split-percentage"><input type="number" inputMode="decimal" min="0" max="100" step="0.01"
          required disabled={disabled} aria-label={`${side.name}'s percentage`} value={side.basis / 100}
          onChange={event => {
            const value = Number(event.target.value)
            if (Number.isFinite(value)) {
              const basis = Math.max(0, Math.min(10_000, Math.round(value * 100)))
              onChange(side.payer ? basis : 10_000 - basis)
            }
          }} /><span aria-hidden="true">%</span></label> : <span className="bb-custom-split-percent">{percent(side.basis)}</span>}
      </div>)}
  </div>
}

export function CustomSplitControl({grossCents, payerBasisPoints, payerName, partnerName, disabled, onChange}: {
  grossCents: number; payerBasisPoints: number; payerName: string; partnerName: string; disabled: boolean; onChange: (basis: number) => void
}) {
  const payerCents = Math.floor((grossCents * payerBasisPoints + 5_000) / 10_000)
  return <div className="bb-custom-split-control" role="group" aria-label="Custom split">
    <CustomSplitShares payerName={payerName} partnerName={partnerName} payerCents={payerCents} partnerCents={grossCents - payerCents}
      payerBasisPoints={payerBasisPoints} disabled={disabled} onChange={onChange}/>
    <label className="bb-custom-split-slider">{payerName}’s share<input type="range" min="0" max="100" step="0.01" value={payerBasisPoints / 100} disabled={disabled}
      aria-label={`${payerName}'s share percentage`} aria-valuetext={`${payerName}: ${percent(payerBasisPoints)}, ${money(payerCents)}; ${partnerName}: ${percent(10_000 - payerBasisPoints)}, ${money(grossCents - payerCents)}`}
      onChange={event => onChange(Math.max(0, Math.min(10_000, Math.round(Number(event.target.value) * 100))))}/></label>
    <p className="bb-custom-split-hint">Adjust the slider or enter either percentage.</p>
  </div>
}
