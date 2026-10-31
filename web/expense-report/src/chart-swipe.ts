import { useLayoutEffect, useRef, type MouseEvent, type TouchEvent } from "react"

const GAP = 16
type Sample = { x: number; time: number }
type Gesture = {
  id: number; x: number; y: number; origin: number; width: number
  axis: "pending" | "horizontal" | "vertical"; moved: boolean; samples: Sample[]
}

// Follow the finger through the whole page. Only the ends (and travel beyond
// one neighboring page) receive continuous rubber-band resistance.
export function chartDragOffset(offset: number, width: number, index: number, count: number) {
  const stride = width + GAP
  const low = index < count - 1 ? -stride : 0
  const high = index > 0 ? stride : 0
  const rubber = (distance: number) => width * 0.55 * distance / (width + 0.55 * distance)
  return offset < low ? low - rubber(low - offset) : offset > high ? high + rubber(offset - high) : offset
}

export function chartReleaseIndex(index: number, count: number, width: number, offset: number, velocity: number) {
  const projected = offset + Math.max(-3, Math.min(3, velocity)) * 180
  const direction = Math.abs(projected) >= Math.min(160, width * 0.28) ? (projected < 0 ? 1 : -1) : 0
  return Math.max(0, Math.min(count - 1, index + direction))
}

export function chartReleaseVelocity(samples: Sample[], now: number) {
  const last = samples[samples.length - 1]
  if (!last || now - last.time > 80) return 0
  const first = samples.find(sample => sample.time >= last.time - 80) ?? last
  return last.time > first.time ? (last.x - first.x) / (last.time - first.time) : 0
}

// A critically damped spring starts with the release velocity, instead of
// stopping the finger's motion and restarting a fixed CSS easing curve.
export function chartSpring(from: number, to: number, velocity: number) {
  const displacement = from - to
  const speed = Math.max(-3, Math.min(3, velocity)) * 1000
  const frames: { transform: string; offset: number }[] = []
  let duration = 0
  const positions: number[] = []
  for (let step = 0; step <= 42; step++) {
    const time = step / 60, decay = Math.exp(-22 * time)
    const coefficient = speed + 22 * displacement
    const position = to + (displacement + coefficient * time) * decay
    positions.push(position)
    duration = time * 1000
    if (step >= 12 && Math.abs(position - to) < 0.1 && Math.abs((speed - 22 * coefficient * time) * decay) < 3) break
  }
  positions.forEach((position, index) => frames.push({ transform: `translate3d(${index === positions.length - 1 ? to : position}px, 0, 0)`, offset: index / (positions.length - 1) }))
  return { frames, duration }
}

function visibleX(track: HTMLDivElement | null, fallback: number) {
  if (!track) return fallback
  const transform = window.getComputedStyle(track).transform
  const matrix = transform.match(/^matrix(3d)?\((.+)\)$/)
  return matrix ? Number(matrix[2].split(",")[matrix[1] ? 12 : 4]) : fallback
}

export function useChartSwipe({ index, count, onSelect, onDragStart, ignoreTarget }: {
  index: number; count: number; onSelect: (index: number) => void
  onDragStart: () => void; ignoreTarget: (target: EventTarget | null) => boolean
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const options = useRef({ index, count, onSelect, onDragStart, ignoreTarget })
  useLayoutEffect(() => { options.current = { index, count, onSelect, onDragStart, ignoreTarget } })
  const gesture = useRef<Gesture | null>(null)
  const animation = useRef<Animation | null>(null)
  const frame = useRef<number | null>(null)
  const pendingX = useRef(0)
  const targetIndex = useRef<number | null>(null)
  const suppressClickUntil = useRef(0)
  const width = () => viewportRef.current?.getBoundingClientRect().width || window.innerWidth
  const dragging = (value: boolean) => { if (viewportRef.current) viewportRef.current.dataset.dragging = String(value) }
  const stopFrame = () => { if (frame.current !== null) window.cancelAnimationFrame(frame.current); frame.current = null }
  const stopAnimation = () => { animation.current?.cancel(); animation.current = null; if (viewportRef.current) viewportRef.current.dataset.settling = "false" }
  const paint = (x: number) => { if (trackRef.current) trackRef.current.style.transform = `translate3d(${x}px, 0, 0)` }
  const settle = (next: number, velocity = 0, immediate = false) => {
    stopFrame()
    const track = trackRef.current, to = -next * (width() + GAP)
    const from = visibleX(track, to)
    stopAnimation()
    dragging(false)
    targetIndex.current = next
    paint(to)
    if (!track || immediate || window.matchMedia("(prefers-reduced-motion: reduce)").matches || Math.abs(from - to) < 0.1) return
    const spring = chartSpring(from, to, velocity)
    const motion = track.animate(spring.frames, { duration: spring.duration, easing: "linear" })
    animation.current = motion
    if (viewportRef.current) viewportRef.current.dataset.settling = "true"
    motion.onfinish = () => { if (animation.current === motion) stopAnimation() }
  }

  useLayoutEffect(() => {
    if (targetIndex.current !== index) {
      gesture.current = null
      settle(index, 0, targetIndex.current === null)
    }
  }, [index])
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    let previousWidth = width()
    const resize = () => {
      if (width() === previousWidth) return
      previousWidth = width()
      gesture.current = null
      settle(options.current.index, 0, true)
    }
    const observer = new ResizeObserver(resize)
    if (viewport) observer.observe(viewport)
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const reduce = () => { if (media.matches) settle(options.current.index, 0, true) }
    media.addEventListener("change", reduce)
    return () => { observer.disconnect(); media.removeEventListener("change", reduce); stopFrame(); stopAnimation() }
  }, [])

  const onTouchStartCapture = (event: TouchEvent<HTMLDivElement>) => {
    suppressClickUntil.current = 0
    if (event.touches.length !== 1 || options.current.ignoreTarget(event.target)) {
      const previous = gesture.current
      gesture.current = null
      if (previous) {
        if (previous.moved) suppressClickUntil.current = performance.now() + 750
        settle(options.current.index)
      }
      return
    }
    const touch = event.touches[0], now = performance.now(), size = width()
    const origin = visibleX(trackRef.current, -options.current.index * (size + GAP))
    stopAnimation()
    paint(origin)
    gesture.current = { id: touch.identifier, x: touch.clientX, y: touch.clientY, origin, width: size, axis: "pending", moved: false, samples: [{ x: touch.clientX, time: now }] }
  }
  const onTouchMoveCapture = (event: TouchEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current) return
    if (event.touches.length !== 1) {
      if (current.moved) suppressClickUntil.current = performance.now() + 750
      gesture.current = null
      settle(options.current.index)
      return
    }
    const touch = event.touches[0]
    if (touch.identifier !== current.id) return
    const dx = touch.clientX - current.x, dy = touch.clientY - current.y, now = performance.now()
    if (Math.hypot(dx, dy) > 8) current.moved = true
    current.samples.push({ x: touch.clientX, time: now })
    current.samples = current.samples.filter(sample => sample.time >= now - 100)
    if (current.axis === "pending" && current.moved) {
      if (Math.abs(dy) > Math.abs(dx) * 1.15) current.axis = "vertical"
      else if (Math.abs(dx) > Math.abs(dy) * 1.15) {
        current.axis = "horizontal"
        dragging(true)
        options.current.onDragStart()
      }
    }
    if (current.axis !== "horizontal") return
    // Claimed horizontal drags must not scrub chart nodes underneath the finger.
    // No touch event is canceled; vertical movement stays entirely native.
    event.stopPropagation()
    const { index: active, count: total } = options.current
    pendingX.current = -active * (current.width + GAP) + chartDragOffset(current.origin + active * (current.width + GAP) + dx, current.width, active, total)
    if (frame.current === null) frame.current = window.requestAnimationFrame(() => { frame.current = null; paint(pendingX.current) })
  }
  const finish = (event: TouchEvent<HTMLDivElement>, canceled: boolean) => {
    const current = gesture.current
    gesture.current = null
    if (!current) return
    if (current.moved) suppressClickUntil.current = performance.now() + 750
    const { index: active, count: total } = options.current
    const touch = Array.from(event.changedTouches).find(item => item.identifier === current.id)
    const horizontal = current.axis === "horizontal"
    if (horizontal) event.stopPropagation()
    const velocity = chartReleaseVelocity(current.samples, performance.now())
    const offset = current.origin + active * (current.width + GAP) + (touch?.clientX ?? current.x) - current.x
    const next = !canceled && horizontal ? chartReleaseIndex(active, total, current.width, offset, velocity) : active
    settle(next, horizontal && !canceled ? velocity : 0)
    if (next !== active) options.current.onSelect(next)
  }
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    // Preserve keyboard/programmatic activation and the next deliberate tap.
    if (event.detail === 0 || (gesture.current?.axis !== "horizontal" && performance.now() >= suppressClickUntil.current)) return
    event.preventDefault()
    event.stopPropagation()
  }
  return { viewportRef, trackRef, onTouchStartCapture, onTouchMoveCapture,
    onTouchEndCapture: (event: TouchEvent<HTMLDivElement>) => finish(event, false),
    onTouchCancelCapture: (event: TouchEvent<HTMLDivElement>) => finish(event, true), onClickCapture }
}
