/** Exact half-up cent rounding, including amounts whose products exceed Number's safe integer range. */
export function ratioShareCents(gross: number, ratio: [number, number]): number {
  const [numerator, denominator] = ratio.map(value => BigInt(value))
  return Number((2n * BigInt(gross) * numerator + denominator) / (2n * denominator))
}
