// Persistent icon surfaces shared by the collapsed preview and expanded rows.
// The browser owns interpolation; React does not render animation frames.
export const DAILY_PREVIEW_COUNT = 6
export const DAILY_CASCADE_WINDOW_MS = 216
const motion = { duration: 500, cascade: 36, curve: 34, spring: 5 }

type Point = { x: number; y: number }
type Pose = Point & { width: number; scale: number; opacity: number; badge: number }
type Geometry = { cx: number; cy: number; r: number }
type ManagedAnimation = Animation & { bsProperties: string[] }
type Flight = { ghost: HTMLElement; badge: HTMLElement | null; selfHole: HTMLElement | null; neighborClips?: HTMLElement[] }
type Controller = { section: HTMLElement; panel: HTMLElement; button: HTMLButtonElement; layer: HTMLElement; entryCount: number; target: boolean; instant: boolean; sequence: number; animations: Set<ManagedAnimation>; flights: Map<number, Flight>; echoClips?: HTMLElement[] }

export function createDailyDayMotion(section: HTMLElement, initialOpen: boolean) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const controller: Controller = { section, panel: section.querySelector<HTMLElement>('.bb-daily-day-panel')!, button: section.querySelector<HTMLButtonElement>('.bb-daily-day-header')!, layer: section.querySelector<HTMLElement>('.bb-daily-icon-layer')!, entryCount: Number(section.dataset.entryCount), target: initialOpen, instant: false, sequence: 0, animations: new Set(), flights: new Map() }
  const hasLogo = (scene: Controller, index: number) => scene.section.querySelector<HTMLElement>(`.bb-daily-bead[data-entry="${index}"]`)?.dataset.logo === 'true'
  // Small badge holes interpolate directly on their paint owner. Large circle
  // holes keep this shape fixed and move with transforms in trackCircleGap.
  function cutout({ cx, cy, r }: Geometry, size: number, padding = 0) {
    const n = (value: number) => Number(value.toFixed(4))
    return `path(evenodd, "M${-padding} ${-padding}H${size + padding}V${size + padding}H${-padding}Z M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx + r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx - r)} ${n(cy)}Z")`
  }
  const cssProperty = (property: string) => property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
  function cancel(controller: Controller, clear = false) {
    controller.sequence++;
    // Keep the same painted elements when motion ends or reverses. Swapping
    // an animated copy for a freshly rasterized static image can flash at
    // fractional screen coordinates even when their bounds are identical.
    if (!clear) for (const animation of controller.animations) {
      const target = (animation.effect as KeyframeEffect).target as HTMLElement | SVGElement;
      const style = getComputedStyle(target);
      for (const property of animation.bsProperties) target.style.setProperty(cssProperty(property), style.getPropertyValue(cssProperty(property)));
    }
    for (const animation of controller.animations) animation.cancel();
    controller.animations.clear();
    if (clear) {
      controller.flights.clear();
      controller.echoClips = undefined;
    }
  }
  function settle(controller: Controller, open = controller.target) {
    cancel(controller);
    controller.target = open;
    controller.section.dataset.moving = 'false';
    controller.button.setAttribute('aria-expanded', String(open));
    controller.panel.dataset.open = String(open);
    controller.panel.style.height = open ? 'auto' : '0px';
    controller.panel.inert = !open;
    controller.panel.setAttribute('aria-hidden', String(!open));
    const preview = controller.section.querySelector<HTMLElement>('.bb-daily-preview')!;
    // Both header and list icons are layout anchors. Each expense is painted
    // by one persistent bead, in the same rendering layer in either state.
    preview.style.visibility = 'hidden';
    preview.setAttribute('aria-hidden', 'true');
    controller.section.querySelector<HTMLElement>('.bb-daily-day-count')!.style.opacity = open ? '1' : '0';
    for (const entry of controller.section.querySelectorAll<HTMLElement>('.bb-daily-transaction')) {
      entry.querySelector<HTMLElement>('.bb-daily-row-icon-anchor')!.style.visibility = 'hidden';
      for (const copy of entry.querySelectorAll<HTMLElement>(':scope > :not(.bb-daily-row-icon-anchor)')) {
        copy.style.opacity = open ? '1' : '0';
        copy.style.transform = 'none';
      }
    }
  }
  function localRect(element: Element, origin: DOMRect) {
    const rect = element.getBoundingClientRect();
    return { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height };
  }
  function animate(controller: Controller, element: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
    if (controller.instant) {
      const target = element as HTMLElement | SVGElement
      for (const [property, value] of Object.entries(frames[frames.length - 1])) {
        if (!['offset', 'easing', 'composite'].includes(property)) target.style.setProperty(cssProperty(property), String(value))
      }
      return { finished: Promise.resolve() }
    }
    const animation = element.animate(frames, { fill: 'both', ...options }) as ManagedAnimation;
    animation.bsProperties = Object.keys(frames[0]).filter(property => !['offset', 'easing', 'composite'].includes(property));
    controller.animations.add(animation);
    animation.finished.catch(() => {});
    return animation;
  }
  function trackCircleGap(clip: HTMLElement, geometry: Geometry[], times: number[], total: number, size: number, radius: number) {
    const content = clip.querySelector<HTMLElement>(':scope > .bb-daily-clip-content')!
    // Distant earlier circles never touch this icon. Do not create a pair of
    // composited layers for an empty intersection, especially on large days.
    if (!gapVisible(geometry, size)) {
      clip.style.clipPath = 'none'
      clip.style.transform = content.style.transform = 'none'
      return
    }
    // Keep the large hole rigid: its position follows the upper circle using
    // transforms, rather than morphing a shape on the lower circle's clock.
    // The inverse child transform leaves the lower icon's paint in place.
    clip.style.clipPath = cutout({ cx: size / 2, cy: size / 2, r: radius }, size, radius * 2)
    const positions = geometry.map(({ cx, cy }) => ({
      x: Math.max(-radius, Math.min(size + radius, cx)) - size / 2,
      y: Math.max(-radius, Math.min(size + radius, cy)) - size / 2,
    }))
    const frames = (inverse: boolean) => positions.map(({ x, y }, frame) => ({ offset: times[frame] / total, transform: `translate3d(${inverse ? -x : x}px, ${inverse ? -y : y}px, 0)` }))
    animate(controller, clip, frames(false), { duration: total, easing: 'linear' })
    animate(controller, content, frames(true), { duration: total, easing: 'linear' })
  }
  function gapVisible(geometry: Geometry[], size: number) {
    // Include the swept bounds between samples, so a fast crossing is not
    // discarded just because both sampled centers lie outside the icon.
    return geometry.some((shape, index) => {
      const before = geometry[Math.max(0, index - 1)]
      const radius = Math.max(shape.r, before.r)
      return radius > 0 && Math.min(shape.cx, before.cx) - radius < size + .5 && Math.max(shape.cx, before.cx) + radius > -.5 && Math.min(shape.cy, before.cy) - radius < size + .5 && Math.max(shape.cy, before.cy) + radius > -.5
    })
  }
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  function progress(t: number) {
    const s = motion.spring ? .6 + motion.spring * .06 : 0;
    return 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;
  }
  function curve(a: Point, b: Point, t: number) {
    const dy = b.y - a.y;
    const p1 = { x: a.x + motion.curve * .25, y: a.y + dy * .22 };
    const p2 = { x: Math.max(2, b.x - motion.curve * .35), y: b.y - dy * .22 };
    const u = 1 - t;
    return {
      x: u ** 3 * a.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * b.x,
      y: u ** 3 * a.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * b.y,
    };
  }
  function flyer(controller: Controller, index: number, count: number): Flight {
    const ghost = controller.section.querySelector<HTMLElement>(`.bb-daily-bead[data-entry="${index}"]`)!
    const body = ghost.querySelector<HTMLElement>('.bb-daily-bead-body')!
    let badge: HTMLElement | null = null
    let selfHole: HTMLElement | null = null
    if (hasLogo(controller, index) && index < count) {
      badge = ghost.querySelector<HTMLElement>('.bb-daily-preview-dot')!
      selfHole = body
    }
    return { ghost, badge, selfHole }
  }
  function transition(controller: Controller, open: boolean, instant = false) {
    const { section, panel, button } = controller;
    for (const animation of controller.animations) animation.pause();
    const origin = section.getBoundingClientRect();
    const preview = section.querySelector<HTMLElement>('.bb-daily-preview')!;
    const eventCount = section.querySelector<HTMLElement>('.bb-daily-day-count')!;
    const countOpacity = Number(getComputedStyle(eventCount).opacity);
    const circles = [...preview.querySelectorAll<HTMLElement>('.bb-daily-preview-item')];
    const entryRows = [...section.querySelectorAll<HTMLElement>('.bb-daily-transaction')];
    const rows = entryRows.length ? entryRows : [...controller.layer.querySelectorAll<HTMLElement>('.bb-daily-bead')].map((_, index) => circles[index]);
    const count = Math.min(controller.entryCount, DAILY_PREVIEW_COUNT);
    const logos = [...controller.layer.querySelectorAll<HTMLElement>('.bb-daily-bead')].map(bead => bead.dataset.logo === 'true');
    const interrupted = section.dataset.moving === 'true';
    const previousTarget = controller.target;
    const height = panel.getBoundingClientRect().height;
    const samples = rows.map((row, i) => {
      const active = controller.flights.get(i);
      const header = localRect(circles[Math.min(i, count)], origin);
      const expanded = localRect(row.querySelector('.bb-daily-row-icon-anchor') || circles[Math.min(i, count)], origin);
      const start = active ? localRect(active.ghost, origin) : previousTarget ? expanded : header;
      return { header, expanded, start,
        opacity: active ? Number(getComputedStyle(active.ghost).opacity) : previousTarget || i < count ? 1 : 0,
        animate: i < count || (expanded.y + origin.top < innerHeight + 80 && expanded.y + origin.top + expanded.height > -80),
        badge: active?.badge ? new DOMMatrix(getComputedStyle(active.badge).transform).a : previousTarget ? 0 : 1,
        copy: [...row.querySelectorAll<HTMLElement>(':scope > :not(.bb-daily-row-icon-anchor)')].map(element => ({ element, opacity: Number(getComputedStyle(element).opacity) })),
      };
    });
    const overflowEcho = controller.layer.querySelector('.bb-daily-overflow');
    const overflowOpacity = overflowEcho ? Number(getComputedStyle(overflowEcho).opacity) : previousTarget ? 0 : 1;
    cancel(controller);
    const sequence = controller.sequence;
    controller.target = open;
    button.setAttribute('aria-expanded', String(open));
    panel.dataset.open = String(open);
    panel.inert = !open;
    panel.setAttribute('aria-hidden', String(!open));
    preview.setAttribute('aria-hidden', String(open));
    section.dataset.moving = 'true';
    preview.style.visibility = 'hidden';
    const fullHeight = panel.firstElementChild!.getBoundingClientRect().height;
    instant = instant || reduced.matches || typeof section.animate !== 'function';
    controller.instant = instant;
    const duration = motion.duration;
    const cascade = Math.min(motion.cascade, DAILY_CASCADE_WINDOW_MS / Math.max(1, rows.length - 1));
    const total = duration + Math.max(0, rows.length - 1) * cascade;
    const base = 28;
    const gap = 2;
    const pose = (index: number, time: number) => {
      const snapshot = samples[index];
      const shown = index < count;
      const delay = (open ? index : rows.length - 1 - index) * cascade;
      const t = clamp((time - delay) / duration);
      const p = progress(t);
      const target = open ? snapshot.expanded : snapshot.header;
      if (!snapshot.animate) return { ...target, scale: target.width / base, opacity: open ? 1 : 0, badge: 0 };
      const point = interrupted ? curve(snapshot.start, target, p) : curve(snapshot.header, snapshot.expanded, open ? p : 1 - p);
      const width = mix(snapshot.start.width, target.width, clamp(p));
      const opacity = !shown && !open ? snapshot.opacity * (1 - clamp((t - .72) / .28)) : mix(snapshot.opacity, 1, clamp(t / .16));
      const badgeTarget = open ? 0 : 1;
      const badge = shown && logos[index] ? mix(snapshot.badge, badgeTarget, clamp(open ? t / .35 : (t - .55) / .45)) : 0;
      return { ...point, width, scale: width / base, opacity, badge };
    };
    // One shared clock keeps overlap cutouts following the actual neighboring
    // beads, including after a bead has arrived and is waiting for the others.
    const times = instant ? [total] : Array.from(new Set([
      ...Array.from({ length: 91 }, (_, index) => total * index / 90),
      ...rows.flatMap((_, index) => { if (!samples[index].animate) return []; const delay = (open ? index : rows.length - 1 - index) * cascade; return [delay, delay + duration]; }),
    ])).sort((a, b) => a - b);
    const poses = times.map(time => rows.map((_, index) => pose(index, time)));
    const neighborHole = (current: Pose, previous: Pose, badge: boolean) => {
      const previousScale = previous.width / base;
      return {
        cx: ((previous.x + (badge ? base - 3 : base / 2) * previousScale) - current.x) / current.scale,
        cy: ((previous.y + (badge ? base - 3 : base / 2) * previousScale) - current.y) / current.scale,
        r: previous.opacity < .001 ? 0 : (badge ? previous.badge * (3 * previousScale + gap) : previous.width / 2 + gap) / current.scale,
      };
    };
    panel.style.height = `${height}px`;
    const jobs = [animate(controller, panel, [{ height: `${height}px` }, { height: `${open ? fullHeight : 0}px` }], { duration: total, easing: open ? 'cubic-bezier(.2,.65,.3,1)' : 'cubic-bezier(.42,0,.3,1)' }).finished.catch(() => {})];
    // Give the departing circles room before surfacing the old entry count.
    // On reversal, fade from the current presentation without a fresh delay.
    animate(controller, eventCount, [{ opacity: countOpacity }, { opacity: open ? 1 : 0 }], {
      duration: Math.min(open ? 220 : 160, duration * (open ? .4 : .3)),
      delay: open && countOpacity < .001 ? (count - 1) * cascade + duration * .2 : 0,
      easing: 'ease-in-out',
    });
    rows.forEach((row, i) => {
      const snapshot = samples[i];
      const delay = (open ? i : rows.length - 1 - i) * cascade;
      const anchor = row.querySelector<HTMLElement>('.bb-daily-row-icon-anchor');
      if (anchor) anchor.style.visibility = 'hidden';
      const flight = controller.flights.get(i) || flyer(controller, i, count);
      flight.ghost.dataset.entry = String(i);
      controller.flights.set(i, flight);
      const frames: Keyframe[] = times.map((time, frame) => {
        const point = poses[frame][i];
        return { offset: time / total, transform: `translate3d(${point.x}px, ${point.y}px, 0) scale(${point.scale})`, opacity: point.opacity };
      });
      if (!snapshot.animate) {
        const end = frames[frames.length - 1]
        flight.ghost.style.transform = String(end.transform)
        flight.ghost.style.opacity = String(end.opacity)
        snapshot.copy.forEach(({ element }) => { element.style.opacity = open ? '1' : '0' })
        return
      }
      // Visible previews stay opaque. A redundant 1→1 opacity effect changes
      // compositing as their nested clips start moving and can flash on iOS.
      if (frames.every(frame => frame.opacity === frames[0].opacity)) {
        flight.ghost.style.opacity = String(frames[0].opacity)
        frames.forEach(frame => { delete frame.opacity })
      }
      const moving = animate(controller, flight.ghost, frames, { duration: total, easing: 'linear' });
      if (flight.selfHole) {
        animate(controller, flight.selfHole, times.map((time, frame) => ({ offset: time / total, clipPath: cutout({ cx: base - 3, cy: base - 3, r: 4 * poses[frame][i].badge }, base) })), { duration: total, easing: 'linear' });
        animate(controller, flight.badge!, times.map((time, frame) => ({ offset: time / total, transform: `scale(${poses[frame][i].badge})` })), { duration: total, easing: 'linear' });
      }
      const neighbors: { previous: number; badge: boolean }[] = [];
      for (let previous = 0; previous < Math.min(i, count); previous++) {
        neighbors.push({ previous, badge: false });
        if (logos[previous]) neighbors.push({ previous, badge: true });
      }
      if (neighbors.length) {
        const holes = flight.neighborClips || [...flight.ghost.querySelectorAll<HTMLElement>('.bb-daily-clip')];
        flight.neighborClips = holes;
        neighbors.forEach(({ previous, badge }, hole) => {
          const geometry = times.map((_, frame) => neighborHole(poses[frame][i], poses[frame][previous], badge))
          if (badge && !gapVisible(geometry, base)) holes[hole].style.clipPath = 'none'
          else if (badge) animate(controller, holes[hole], geometry.map((shape, frame) => ({ offset: times[frame] / total, clipPath: cutout(shape, base) })), { duration: total, easing: 'linear' });
          else trackCircleGap(holes[hole], geometry, times, total, base, base / 2 + gap)
        });
      }
      snapshot.copy.forEach(({ element, opacity }) => {
        animate(controller, element, [{ opacity }, { opacity: open ? 1 : 0 }], { duration: duration * .4, delay: open ? delay + duration * .5 : delay, easing: 'ease-out' });
      });
      jobs.push(moving.finished.catch(() => {}));
    });
    if (controller.entryCount > count) {
      const source = circles[count];
      const rect = localRect(source, origin);
      const echo = controller.layer.querySelector<HTMLElement>('.bb-daily-overflow')!;
      echo.style.width = `${rect.width}px`;
      echo.style.height = `${rect.height}px`;
      echo.style.left = `${rect.x}px`;
      echo.style.top = `${rect.y}px`;
      echo.style.zIndex = '0';
      const neighbors: { previous: number; badge: boolean }[] = [];
      for (let previous = 0; previous < count; previous++) {
        neighbors.push({ previous, badge: false });
        if (logos[previous]) neighbors.push({ previous, badge: true });
      }
      const echoPose = { ...rect, scale: 1, opacity: 1, badge: 0 };
      const holes = controller.echoClips || [...echo.querySelectorAll<HTMLElement>('.bb-daily-clip')];
      controller.echoClips = holes;
      neighbors.forEach(({ previous, badge }, hole) => {
        const geometry = times.map((_, frame) => neighborHole(echoPose, poses[frame][previous], badge))
        if (badge && !gapVisible(geometry, base)) holes[hole].style.clipPath = 'none'
        else if (badge) animate(controller, holes[hole], geometry.map((shape, frame) => ({ offset: times[frame] / total, clipPath: cutout(shape, base) })), { duration: total, easing: 'linear' });
        else trackCircleGap(holes[hole], geometry, times, total, base, base / 2 + gap)
      });
      animate(controller, echo, [{ opacity: overflowOpacity, transform: 'scale(1)' }, { opacity: open ? 0 : 1, transform: `scale(${open ? .8 : 1})` }], { duration: duration * .25, delay: open ? count * cascade : duration * .75, easing: 'ease-in-out' });
    }
    if (instant) {
      for (const animation of controller.animations) {
        animation.pause();
        const timing = (animation.effect as KeyframeEffect).getTiming();
        animation.currentTime = (timing.delay || 0) + Number(timing.duration);
      }
      settle(controller, open);
      return;
    }
    Promise.all(jobs).then(() => {
      if (sequence !== controller.sequence) return;
      settle(controller, open);
    });
  }

  function fit() {
    const row = controller.button
    const preview = section.querySelector<HTMLElement>('.bb-daily-preview')!
    const count = preview.children.length
    const width = row.getBoundingClientRect().width
    const previewWidth = 28 * count - 8 * (count - 1)
    const amountWidth = row.querySelector<HTMLElement>('.bb-daily-day-total')!.getBoundingClientRect().width
    row.dataset.wide = String(previewWidth > width - 34 - amountWidth - 16 - 24)
    row.style.setProperty('--bb-daily-preview-indent', previewWidth > width - 42 ? '0px' : '42px')
  }
  let disposed = false
  let resizeFrame: number | null = null
  let measuredWidth = section.getBoundingClientRect().width
  const sync = () => { if (!disposed) { fit(); cancel(controller, true); transition(controller, controller.target, true) } }
  fit()
  transition(controller, initialOpen, true)
  section.dataset.motionReady = 'true'
  const observer = new ResizeObserver(() => {
    const width = section.getBoundingClientRect().width
    if (Math.abs(width - measuredWidth) < .5) return
    measuredWidth = width
    // Header wrapping also changes section height. Settle outside observer
    // delivery so WebKit never re-enters the same resize notification cycle.
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => { resizeFrame = null; sync() })
  })
  observer.observe(section)
  reduced.addEventListener('change', sync)
  document.fonts?.ready.then(sync)
  return {
    setOpen(open: boolean) {
      if (open === controller.target) return
      transition(controller, open)
    },
    dispose() {
      disposed = true
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      reduced.removeEventListener('change', sync)
      cancel(controller, true)
      delete section.dataset.motionReady
    },
  }
}
