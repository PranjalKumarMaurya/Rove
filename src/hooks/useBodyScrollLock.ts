import { useEffect } from 'react'

// While any sheet, dialog or modal is open, the page behind it must not move.
// `overflow: hidden` alone is ignored by iPhone Safari (the page still scrolls
// and rubber-bands when you drag outside the scrollable sheet), so the body is
// pinned in place with `position: fixed` at its current offset and put back,
// scroll position included, when the last lock is released. Locks nest.

let locks = 0
let saved: { scrollY: number; style: string | null } | null = null

export function lockBodyScroll(): () => void {
  if (typeof document === 'undefined') return () => {}
  const body = document.body
  if (locks === 0) {
    saved = { scrollY: window.scrollY, style: body.getAttribute('style') }
    body.style.position = 'fixed'
    body.style.top = `-${saved.scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
    body.style.overflow = 'hidden'
    body.dataset.scrollLocked = 'true'
  }
  locks += 1
  let released = false
  return () => {
    if (released) return
    released = true
    locks -= 1
    if (locks > 0 || !saved) return
    const { scrollY, style } = saved
    saved = null
    if (style === null) body.removeAttribute('style')
    else body.setAttribute('style', style)
    delete body.dataset.scrollLocked
    window.scrollTo(0, scrollY)
  }
}

export function useBodyScrollLock() {
  useEffect(() => lockBodyScroll(), [])
}
