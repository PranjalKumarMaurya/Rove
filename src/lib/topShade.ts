// iOS 26 blurs page content that scrolls under the status bar, in a band deeper
// than the status bar itself. While the page is scrolled, `data-scrolled` on
// <html> grows the solid strip behind the status bar (global.css) to cover that
// band, so the top of the app stays plain. At the top nothing is under it, so
// the strip stays status-bar height and doesn't cover the header.
export function startTopShade(): void {
  if (typeof window === 'undefined') return
  const root = document.documentElement
  let scrolled = false
  const update = () => {
    // While a pop-up or sheet is open the page behind is pinned and nothing
    // scrolls under the status bar (pop-ups start below it), so keep the strip
    // status-bar height; growing it would cover the pop-up's top edge.
    const locked = document.body.dataset.scrollLocked === 'true'
    const next = !locked && window.scrollY > 2
    if (next !== scrolled) {
      scrolled = next
      if (next) root.dataset.scrolled = 'true'
      else delete root.dataset.scrolled
    }
  }
  window.addEventListener('scroll', update, { passive: true })
  new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ['style', 'data-scroll-locked'] })
  update()
}
