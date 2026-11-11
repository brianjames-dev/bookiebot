import { useLayoutEffect, type RefObject } from "react"

// A fixed viewport coordinate never depends on document scroll or contributes
// to page height. Explicit resize updates recover the anchor after folding.
export function navigationViewportBottom(height: number, visual?: { offsetTop: number; height: number; scale?: number } | null) {
  // A zoomed viewport reports a different CSS coordinate scale. Keep the
  // existing unzoomed layout anchor until native rotation/zoom settles.
  const unzoomed = visual && visual.height > 0 && Math.abs((visual.scale ?? 1) - 1) < .01
  return unzoomed ? visual.offsetTop + visual.height : height
}

export function useNavigationViewport(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const host = ref.current
    if (!enabled || !host) return
    let frame = 0
    const update = () => {
      frame = 0
      const bottom = navigationViewportBottom(window.innerHeight, window.visualViewport)
      const value = `${bottom}px`
      if (host.style.getPropertyValue("--bb-nav-viewport-bottom") !== value) host.style.setProperty("--bb-nav-viewport-bottom", value)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const visual = window.visualViewport
    update()
    for (const name of ["resize", "orientationchange", "pageshow"]) window.addEventListener(name, schedule)
    visual?.addEventListener("resize", schedule)
    return () => {
      cancelAnimationFrame(frame)
      for (const name of ["resize", "orientationchange", "pageshow"]) window.removeEventListener(name, schedule)
      visual?.removeEventListener("resize", schedule)
      host.style.removeProperty("--bb-nav-viewport-bottom")
    }
  }, [ref, enabled])
}
