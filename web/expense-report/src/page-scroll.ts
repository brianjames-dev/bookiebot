// Duo keeps the document stationary through a fold. Only its page surface
// scrolls; ordinary phones continue to use the browser's document scroller.
export function pageScrollSurface() {
  return document.querySelector<HTMLElement>('.bb-page[data-duo-enabled="true"]')
}

export function readPageScroll() {
  const surface = pageScrollSurface()
  return surface
    ? { x: surface.scrollLeft, y: surface.scrollTop, maxY: Math.max(0, surface.scrollHeight - surface.clientHeight) }
    : { x: window.scrollX, y: window.scrollY, maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) }
}

export function scrollPageTo(options: ScrollToOptions) {
  const surface = pageScrollSurface()
  if (surface) surface.scrollTo(options)
  else window.scrollTo(options)
}

export function observePageScroll(callback: () => void) {
  const scroll = (event: Event) => {
    if (event.target === window || event.target === document || event.target === pageScrollSurface()) callback()
  }
  // Element scroll events do not bubble. Capture also observes the Duo page,
  // while ignoring horizontal charts and independently scrolling dialogs.
  window.addEventListener("scroll", scroll, { passive: true, capture: true })
  return () => window.removeEventListener("scroll", scroll, true)
}

export function lockPageScroll() {
  const root = document.documentElement
  const surface = pageScrollSurface()
  const scroller = surface ?? root
  const padded = surface ?? document.body
  const position = readPageScroll()
  const previous = { overflow: scroller.style.overflow, padding: padded.style.paddingRight, lock: root.dataset.bbModalScrollLock }
  const scrollbar = Math.max(0, surface ? surface.offsetWidth - surface.clientWidth : window.innerWidth - root.clientWidth)
  const padding = Number.parseFloat(window.getComputedStyle(padded).paddingRight) || 0
  root.dataset.bbModalScrollLock = "true"
  root.style.setProperty("--bb-viewport-scrollbar-width", `${scrollbar}px`)
  if (scrollbar) padded.style.paddingRight = `${padding + scrollbar}px`
  scroller.style.overflow = "hidden"
  return () => {
    padded.style.paddingRight = previous.padding
    scroller.style.overflow = previous.overflow
    if (previous.lock === undefined) delete root.dataset.bbModalScrollLock
    else root.dataset.bbModalScrollLock = previous.lock
    root.style.setProperty("--bb-viewport-scrollbar-width", `${Math.max(0, surface ? surface.offsetWidth - surface.clientWidth : window.innerWidth - root.clientWidth)}px`)
    // Focus restoration can move the active scroll surface on dialog exit.
    const current = readPageScroll()
    if (current.x !== position.x || current.y !== position.y) scrollPageTo({ left: position.x, top: position.y, behavior: "instant" })
  }
}
