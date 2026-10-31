import { useLayoutEffect, useRef, type RefObject } from "react"

const HOLD_DELAY_MS = 100
const DRAG_DISTANCE_PX = 4

// All glass surfaces use the same contact lifecycle. Only actual input queues
// work; a stationary hold and normal scrolling never run an animation loop.
export function useGlassContact(ref: RefObject<HTMLDivElement | null>, callbacks: {
  paint?: (host: HTMLDivElement) => void
  release?: (host: HTMLDivElement) => void
} = {}) {
  const latest = useRef(callbacks)
  latest.current = callbacks
  const control = useRef<{ start: (x?: number, y?: number) => void; move: (x: number, y: number) => void; release: () => void } | null>(null)
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    let frame = 0, timer = 0, active = false
    let client: { x: number; y: number } | null = null, start: { x: number; y: number } | null = null
    const paint = () => {
      frame = 0
      if (!client || !active) return
      const box = host.getBoundingClientRect()
      if (!box.width || !box.height) return
      const originY = parseFloat(getComputedStyle(host).getPropertyValue("--bb-glass-origin-y")) || .5
      // Store viewport distances from the fixed transform origin. CSS divides
      // by its animated scale, keeping a still finger anchored during lift.
      host.style.setProperty("--bb-glass-dx", `${client.x - box.left - box.width / 2}px`)
      host.style.setProperty("--bb-glass-dy", `${client.y - box.top - box.height * originY}px`)
      latest.current.paint?.(host)
      if (host.dataset.glassContact !== "true") host.dataset.glassContact = "true"
    }
    const activate = () => {
      window.clearTimeout(timer); timer = 0
      active = true
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const release = () => {
      client = null; start = null; active = false
      cancelAnimationFrame(frame); frame = 0; window.clearTimeout(timer); timer = 0
      if (host.dataset.glassContact === "true") host.dataset.glassContact = "false"
      // Keep the last light origin while fading out; clearing it here would
      // visibly jump the highlight back to the middle on release.
      latest.current.release?.(host)
    }
    control.current = {
      start: (x, y) => {
        cancelAnimationFrame(frame); frame = 0; window.clearTimeout(timer)
        // Fast taps avoid geometry reads, light/lens writes and a growth/reverse
        // pulse. A held contact or intentional drag opts into that effect.
        const box = x === undefined || y === undefined ? host.getBoundingClientRect() : null
        client = { x: x ?? box!.left + box!.width / 2, y: y ?? box!.top + box!.height / 2 }
        start = client
        if (active) activate()
        else timer = window.setTimeout(activate, HOLD_DELAY_MS)
      },
      move: (x, y) => {
        if (!client) return
        client = { x, y }
        if (!active) {
          if (start && Math.hypot(x - start.x, y - start.y) >= DRAG_DISTANCE_PX) activate()
          return
        }
        if (!frame) frame = requestAnimationFrame(paint)
      },
      release,
    }
    return () => {
      release(); control.current = null
      host.style.removeProperty("--bb-glass-dx"); host.style.removeProperty("--bb-glass-dy")
    }
  }, [ref])
  return {
    start: (x?: number, y?: number) => control.current?.start(x, y),
    move: (x: number, y: number) => control.current?.move(x, y),
    release: () => control.current?.release(),
  }
}
