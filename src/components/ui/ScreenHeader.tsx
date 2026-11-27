import { type ReactNode } from 'react'
import { IconBack } from './icons'

/**
 * The header of a screen pushed above another (a Trip's To-dos and Settings): the
 * round back button on the left, then the title (t-display) and an optional subtitle,
 * laid out like the Trip header it sits above (.app-topbar, docs/DESIGN-SYSTEM.md §6).
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
          <IconBack size={20} />
        </button>
        <span className="flex-1" />
        {actions}
      </div>
      <div className="min-w-0">
        <h1 className="t-display line-clamp-2" style={{ color: 'var(--text-primary)' }}>{title}</h1>
        {subtitle && <p className="t-footnote mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>{subtitle}</p>}
      </div>
    </header>
  )
}
