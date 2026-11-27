import { type ReactNode } from 'react'
import { IconBack } from './icons'

/**
 * The one header for every screen with a way back (a Trip, its To-dos and Settings,
 * Profile's pages): the round back button on the left, round icon buttons on the
 * right, then the title (t-display) and an optional subtitle (.app-topbar,
 * docs/DESIGN-SYSTEM.md §6). It ends with --space-3; the content below starts with
 * --space-3, so content begins --space-6 under the subtitle.
 */
export function ScreenHeader({ title, subtitle, onBack, backLabel, actions }: {
  title: ReactNode
  subtitle?: ReactNode
  onBack: () => void
  /** The back button's accessible name, e.g. "Back to Goa trip". */
  backLabel: string
  /** Round icon buttons on the right. */
  actions?: ReactNode
}) {
  return (
    <header className="app-topbar app-topbar--stacked">
      <div className="flex items-center gap-2">
        <button type="button" className="round-btn" aria-label={backLabel} onClick={onBack}>
          <IconBack size="md" />
        </button>
        <span className="flex-1" />
        {actions}
      </div>
      <div className="min-w-0">
        <h1 className="t-display line-clamp-2" style={{ color: 'var(--text-primary)' }}>{title}</h1>
        {subtitle && <p className="t-footnote truncate" style={{ color: 'var(--text-secondary)' }}>{subtitle}</p>}
      </div>
    </header>
  )
}
