import { useLayoutEffect, useRef, type RefObject } from "react"

// One CSS transition owns the lens. Pointer samples only retarget it;
// they never move the page or publish a React update for every pixel of travel.
export function useNavigationLens(ref: RefObject<HTMLDivElement | null>, value: string) {
  const controller = useRef<{ move: (x: number) => void; release: () => void } | null>(null)
  const previous = useRef(value)
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    let frame = 0, pointerX: number | null = null
    const paint = () => {
      frame = 0
      if (pointerX === null) return
      const box = host.getBoundingClientRect(), computed = getComputedStyle(host)
      // The held bar gently lifts in viewport space; the lens is positioned in
      // its unscaled layout space so it stays directly beneath the finger.
      const scaleX = box.width / parseFloat(computed.width) || 1
      const inset = parseFloat(computed.getPropertyValue("--bb-nav-inset"))
      const count = parseInt(computed.getPropertyValue("--bb-nav-count"), 10)
      const width = (box.width / scaleX - 2 * parseFloat(computed.paddingLeft)) / count + 2 * inset
      if (!Number.isFinite(width) || !width) return
      const x = Math.max(inset, Math.min(box.width / scaleX - width - inset, (pointerX - box.left) / scaleX - width / 2))
      host.style.setProperty("--bb-nav-lens-left", `${x}px`)
    }
    const release = () => {
      pointerX = null; cancelAnimationFrame(frame); frame = 0
      host.dataset.navContact = "false"
      host.style.removeProperty("--bb-nav-lens-left")
    }
    controller.current = {
      move: x => {
        pointerX = x
        if (host.dataset.navContact !== "true") host.dataset.navContact = "true"
        if (!frame) frame = requestAnimationFrame(paint)
      },
      release,
    }
    const reduce = () => { if (media.matches) host.dataset.navMoving = "false" }
    media.addEventListener("change", reduce)
    return () => {
      controller.current = null; release()
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
  return {
    move: (x: number) => controller.current?.move(x),
    release: () => controller.current?.release(),
  }
}
