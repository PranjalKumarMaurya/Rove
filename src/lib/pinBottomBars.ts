// In an installed iPhone web app, bars pinned with `position: fixed; bottom: 0`
// are sometimes left too high after the keyboard closes, after a sheet unlocks
// the page, or when the app comes back from the background, and only drop into
// place on the next touch. When any of those happens, make the browser lay the
// fixed bars out again: re-layer them for one frame and nudge the scroll position
// (a no-op visually, but it makes Safari recompute where "bottom" is).
let pending = 0

export function repinBottomBars(): void {
  if (typeof window === 'undefined') return
  window.cancelAnimationFrame(pending)
  const root = document.documentElement
  root.dataset.repin = 'true'
  pending = window.requestAnimationFrame(() => {
    const y = window.scrollY
    window.scrollTo(window.scrollX, y > 0 ? y - 1 : y + 1)
    window.scrollTo(window.scrollX, y)
    pending = window.requestAnimationFrame(() => { delete root.dataset.repin })
  })
}

/** Repin now and a little later (the keyboard animates out over ~250ms). */
function soon() {
  repinBottomBars()
  window.setTimeout(repinBottomBars, 320)
}

export function startPinBottomBars(): void {
  if (typeof window === 'undefined') return
  // A field lost focus: the keyboard is closing.
  document.addEventListener('focusout', (event) => {
    const target = event.target as HTMLElement | null
    if (target && /^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName)) soon()
  })
  // The visible area grew back to the full screen (keyboard gone, rotation).
  window.visualViewport?.addEventListener('resize', () => {
    if (Math.abs(window.innerHeight - (window.visualViewport?.height ?? window.innerHeight)) < 2) soon()
  })
  window.addEventListener('orientationchange', soon)
  window.addEventListener('pageshow', soon)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') soon() })
}
