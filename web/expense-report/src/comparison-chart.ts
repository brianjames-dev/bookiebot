// Both months use one dollar axis. Rounded headroom keeps the larger value
// from masquerading as a full/empty progress target.
function upperBound(value: number) {
  if (value <= 0) return 0
  const target = value * 1.08
  const magnitude = 10 ** Math.floor(Math.log10(target))
  const steps = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10]
  const rounded = (steps.find(step => step * magnitude >= target) ?? 10) * magnitude
  return Math.max(.01, Math.ceil(Number((rounded * 100).toPrecision(12))) / 100)
}

export function comparisonChart(values: readonly number[]) {
  const amounts = values.map(value => Number.isFinite(value) ? value : 0)
  const lower = upperBound(Math.max(0, ...amounts.map(value => -value)))
  const minimum = lower ? -lower : 0
  const maximum = upperBound(Math.max(0, ...amounts)) || (minimum === 0 ? 1 : 0)
  const position = (value: number) => (value - minimum) / (maximum - minimum) * 100
  const zero = position(0)
  return { minimum, maximum, zero, bars: amounts.map(value => {
    const end = position(value)
    return { start: Math.min(zero, end), width: Math.abs(end - zero) }
  }) }
}

export function comparisonAxisLabel(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value)
}
