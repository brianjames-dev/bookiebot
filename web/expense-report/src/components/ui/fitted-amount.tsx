import { useLayoutEffect, useRef } from "react"
import { alignAmountFraction, decimalAmountParts, type AmountAppearance } from "../../amount-typography"

/** Keep the complete amount on one line at the largest size its column permits. */
export function FittedAmount({ children, className, appearance, intrinsic = false }: { children: string; className: string; appearance?: Readonly<AmountAppearance>; intrinsic?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const measurementRef = useRef<HTMLSpanElement | null>(null)
  const textRef = useRef<HTMLSpanElement | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    const measurement = measurementRef.current
    const text = textRef.current
    if (!container || !measurement || !text) return
    let disposed = false
    let resizeFrame = 0
    let lastAvailable = -1
    let lastNatural = -1

    const applyScale = (scale: number) => {
      const value = String(scale)
      if (container.style.getPropertyValue("--bb-amount-fit") !== value) {
        container.style.setProperty("--bb-amount-fit", value)
      }
    }

    const fit = () => {
      if (disposed) return
      // Settings can change while this headline's page is hidden. Update the
      // lift now, before its first reveal, even when no width can be fitted yet.
      if (appearance) alignAmountFraction(text)
      const natural = measurement.getBoundingClientRect().width
      if (intrinsic && natural > 0) {
        // Give compact flex-row amounts an independent preferred width. Using
        // the shrinking painted text as their width would remove 1px per fit.
        const width = `${Math.ceil(natural) + 1}px`
        if (container.style.width !== width) container.style.width = width
      }
      const available = container.clientWidth
      if (available <= 0 || natural <= 0) return
      if (available === lastAvailable && natural === lastNatural) return
      lastAvailable = available
      lastNatural = natural
      // Leave one CSS pixel for font/layout rounding. The probe never inherits
      // the fitted size, so growing the viewport restores the original size.
      const target = Math.max(0, available - 1)
      let scale = Math.min(1, target / natural)
      applyScale(scale)
      // Font hinting and glyph rounding are not perfectly proportional to font
      // size. Verify the rendered amount, not only the natural-size estimate.
      const rendered = text.getBoundingClientRect().width
      if (rendered > target) {
        scale *= target / rendered
        applyScale(scale)
        if (text.getBoundingClientRect().width > target) {
          let low = 0
          let high = scale
          for (let pass = 0; pass < 12; pass += 1) {
            const middle = (low + high) / 2
            applyScale(middle)
            if (text.getBoundingClientRect().width <= target) low = middle
            else high = middle
          }
          applyScale(low)
        }
      }
      if (appearance) alignAmountFraction(text)
    }

    fit()
    // Keep resize writes outside observer delivery: intrinsic flex amounts can
    // change their own preferred width as the viewport changes.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; fit() })
    })
    observer?.observe(container)
    observer?.observe(measurement)
    window.addEventListener("resize", fit)
    document.fonts?.addEventListener("loadingdone", fit)
    void document.fonts?.ready.then(fit)

    return () => {
      disposed = true
      cancelAnimationFrame(resizeFrame)
      observer?.disconnect()
      window.removeEventListener("resize", fit)
      document.fonts?.removeEventListener("loadingdone", fit)
    }
  }, [children, appearance?.size, appearance?.emphasis, intrinsic])

  const parts = appearance ? decimalAmountParts(children) : null
  const content = parts ? <><span className="bb-amount-integer">{parts.integer}</span><span className="bb-amount-fraction" style={{fontSize: `${appearance!.size}%`, opacity: appearance!.emphasis / 100}}>{parts.fraction}</span></> : children

  return (
    <div ref={containerRef} className={`${className} bb-fitted-amount`}>
      <span className="bb-fitted-amount-measure-box" aria-hidden="true">
        <span ref={measurementRef} className="bb-fitted-amount-measure">{content}</span>
      </span>
      <span ref={textRef} className="bb-fitted-amount-text">{content}</span>
    </div>
  )
}
