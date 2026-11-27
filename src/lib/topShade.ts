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
    // A sheet pins the body with `top: -scrollY`, so read that too.
    const offset = window.scrollY || -parseInt(document.body.style.top || '0', 10) || 0
    const next = offset > 2
    if (next !== scrolled) {
      scrolled = next
      if (next) root.dataset.scrolled = 'true'
      else delete root.dataset.scrolled
    }
  }
  window.addEventListener('scroll', update, { passive: true })
  new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ['style'] })
  update()
}
