import { type ReactNode } from 'react'

export function BrandMark() {
  return <p className="brand-mark"><span className="brand-mark__dot" aria-hidden="true" />ROVE</p>
}

/**
 * One full-height column for every screen outside the workspace (auth, onboarding,
 * invitations, interstitials): brand mark or eyebrow, serif title, lede, content.
 */
export function ScreenFrame({ testId, eyebrow = <BrandMark />, title, lede, top, centered = true, busy, className, children }: {
  /** Extra classes on the screen, e.g. room for a bottom nav. */
  className?: string
  testId?: string
  eyebrow?: ReactNode
  title: ReactNode
  lede?: ReactNode
  /** Small controls pinned above the content (back, sign out). */
  top?: ReactNode
  /** Vertically centre the content when it is shorter than the screen. */
  centered?: boolean
  busy?: boolean
  children?: ReactNode
}) {
  return (
    <main data-testid={testId} className={className ? `screen ${className}` : 'screen'} aria-busy={busy || undefined}>
      {top && <div className="flex min-h-11 items-center justify-between gap-3">{top}</div>}
      <div className={centered ? 'my-auto py-8' : 'pb-4 pt-6'}>
        {eyebrow}
        <h1 className="screen-title mt-4">{title}</h1>
        {lede && <p className="screen-lede mt-3">{lede}</p>}
        {children && <div className="mt-8">{children}</div>}
      </div>
    </main>
  )
}
