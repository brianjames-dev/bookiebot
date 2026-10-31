import { useLayoutEffect, useRef, type RefObject } from "react"
import { useGlassContact } from "./glass-contact"

// One CSS transition owns the lens. Pointer samples only retarget it;
// they never move the page or publish a React update for every pixel of travel.
export function useNavigationLens(ref: RefObject<HTMLDivElement | null>, value: string) {
  const previous = useRef(value)
  const contact = useGlassContact(ref, {
    paint: host => {
      if (!host.style.getPropertyValue("--bb-nav-lens-left")) host.style.setProperty("--bb-nav-lens-left", "var(--bb-nav-finger-left)")
    },
    release: host => host.style.removeProperty("--bb-nav-lens-left"),
  })
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const reduce = () => { if (media.matches) host.dataset.navMoving = "false" }
    media.addEventListener("change", reduce)
    return () => {
      media.removeEventListener("change", reduce)
    }
  }, [ref])
  useLayoutEffect(() => {
    if (previous.current === value) return
    previous.current = value
    const host = ref.current
    if (!host || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    host.dataset.navMoving = "true"
    const finish = () => { host.dataset.navMoving = "false" }
    const timer = window.setTimeout(finish, 460)
    return () => { window.clearTimeout(timer); finish() }
  }, [ref, value])
  return contact
}
