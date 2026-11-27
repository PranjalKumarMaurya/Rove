// The top bar's resting/raised look (motion.css, "Top bar"). At the top of the page
// the bar sits flat on it; once the page has scrolled, `data-topbar-raised` on <html>
// fades in its bottom line and a faint background. Hysteresis (on past 12px, off
// under 4px) keeps it from flickering on small scrolls and iOS rubber-banding.
const RAISE_AT = 12
const LOWER_AT = 4

export function startTopBar(): void {
  if (typeof window === 'undefined') return
  const root = document.documentElement
  let raised = false
  let queued = false
  const update = () => {
    queued = false
    const y = window.scrollY
    const next = raised ? y > LOWER_AT : y > RAISE_AT
    if (next === raised) return
    raised = next
    if (next) root.dataset.topbarRaised = 'true'
    else delete root.dataset.topbarRaised
  }
  window.addEventListener('scroll', () => {
    if (queued) return
    queued = true
    requestAnimationFrame(update)
  }, { passive: true })
  update()
}
