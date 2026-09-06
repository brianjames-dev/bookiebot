import { useLayoutEffect, useRef } from "react"

/** Keep the complete amount on one line at the largest size its column permits. */
export function FittedAmount({ children, className }: { children: string; className: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const measurementRef = useRef<HTMLSpanElement | null>(null)
  const textRef = useRef<HTMLSpanElement | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    const measurement = measurementRef.current
    const text = textRef.current
    if (!container || !measurement || !text) return
    let disposed = false
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
      const available = container.clientWidth
      const natural = measurement.getBoundingClientRect().width
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
    }

    fit()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit)
    // Only the visible child changes size. Both observed boxes retain their
    // independent dimensions, preventing ResizeObserver feedback loops.
    observer?.observe(container)
    observer?.observe(measurement)
    window.addEventListener("resize", fit)
    document.fonts?.addEventListener("loadingdone", fit)
    void document.fonts?.ready.then(fit)

    return () => {
      disposed = true
      observer?.disconnect()
      window.removeEventListener("resize", fit)
      document.fonts?.removeEventListener("loadingdone", fit)
    }
  }, [children])

  return (
    <div ref={containerRef} className={`${className} bb-fitted-amount`}>
      <span className="bb-fitted-amount-measure-box" aria-hidden="true">
        <span ref={measurementRef} className="bb-fitted-amount-measure">{children}</span>
      </span>
      <span ref={textRef} className="bb-fitted-amount-text">{children}</span>
    </div>
  )
}
