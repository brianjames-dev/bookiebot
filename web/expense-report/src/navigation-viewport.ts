import { useLayoutEffect, type RefObject } from "react"

// Document coordinates avoid the fixed-position layer WebKit can retain after
// the folded viewport and the Overview's document scroll lock change together.
export function navigationViewportBottom(scrollY: number, height: number, visual?: { offsetTop: number; height: number; scale?: number } | null) {
  // A zoomed viewport reports a different CSS coordinate scale. Keep the
  // existing unzoomed layout anchor until native rotation/zoom settles.
  const unzoomed = visual && visual.height > 0 && Math.abs((visual.scale ?? 1) - 1) < .01
  return scrollY + (unzoomed ? visual.offsetTop + visual.height : height)
}

export function useNavigationViewport(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const host = ref.current
    if (!enabled || !host) return
    let frame = 0
    const update = () => {
      frame = 0
      const parent = host.offsetParent as HTMLElement | null
      const origin = parent ? parent.getBoundingClientRect().top + window.scrollY + parent.clientTop : 0
      const bottom = navigationViewportBottom(window.scrollY, window.innerHeight, window.visualViewport) - origin
      const value = `${bottom}px`
      if (host.style.getPropertyValue("--bb-nav-viewport-bottom") !== value) host.style.setProperty("--bb-nav-viewport-bottom", value)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    const visual = window.visualViewport
    update()
    for (const name of ["scroll", "resize", "orientationchange", "pageshow"]) window.addEventListener(name, schedule, { passive: true })
    visual?.addEventListener("resize", schedule)
    visual?.addEventListener("scroll", schedule)
    return () => {
      cancelAnimationFrame(frame)
      for (const name of ["scroll", "resize", "orientationchange", "pageshow"]) window.removeEventListener(name, schedule)
      visual?.removeEventListener("resize", schedule)
      visual?.removeEventListener("scroll", schedule)
      host.style.removeProperty("--bb-nav-viewport-bottom")
    }
  }, [ref, enabled])
}
