export interface AmountAppearance { size: number; emphasis: number }
export const DEFAULT_AMOUNT_APPEARANCE: Readonly<AmountAppearance> = Object.freeze({ size: 50, emphasis: 55 })
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">

export function amountAppearanceKey(owner: string) {
  return `bookiebot-amount-appearance:v1:${encodeURIComponent(owner.trim().toLowerCase())}`
}
function browserStorage(): PreferenceStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage } catch { return null }
}
export function loadRaisedCents(owner: string, storage = browserStorage()): boolean {
  try {
    const saved = JSON.parse(storage?.getItem(amountAppearanceKey(owner)) || "null")
    return saved?.version === 1 && typeof saved.raisedCents === "boolean" ? saved.raisedCents : true
  } catch { return true }
}
export function saveRaisedCents(owner: string, raisedCents: boolean, storage = browserStorage()) {
  try { storage?.setItem(amountAppearanceKey(owner), JSON.stringify({ version: 1, raisedCents })) }
  catch { /* A blocked/full browser store must leave the session controls usable. */ }
}

/** Split only complete USD currency strings; placeholders, percentages and suffixes stay intact. */
export function decimalAmountParts(value: string) {
  const match = /^([+-]?\$[\d,]+)(\.\d{2})$/.exec(value)
  return match ? { integer: match[1], fraction: match[2] } : null
}

let canvasContext: CanvasRenderingContext2D | null | undefined
function digitAscent(element: HTMLElement, digits: string) {
  const style = getComputedStyle(element)
  if (canvasContext === undefined) canvasContext = document.createElement("canvas").getContext("2d")
  if (canvasContext) {
    canvasContext.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const ascent = canvasContext.measureText(digits).actualBoundingBoxAscent
    if (Number.isFinite(ascent) && ascent > 0) return ascent
  }
  return parseFloat(style.fontSize) * .72
}
/** Align actual numeral ink, rather than differently sized line boxes. Called only during fitting. */
export function alignAmountFraction(text: HTMLElement) {
  const integer = text.querySelector<HTMLElement>(".bb-amount-integer")
  const fraction = text.querySelector<HTMLElement>(".bb-amount-fraction")
  if (!integer || !fraction) return
  const shift = Math.max(0, digitAscent(integer, (integer.textContent || "0").replace(/[^\d]/g, "")) - digitAscent(fraction, (fraction.textContent || "00").replace(/[^\d]/g, "")))
  const value = `${shift}px`
  if (fraction.style.getPropertyValue("--bb-cents-shift") !== value) fraction.style.setProperty("--bb-cents-shift", value)
}
