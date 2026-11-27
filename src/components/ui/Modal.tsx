import { type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock'
import type { CSSProperties } from 'react'

interface Props {
  onClose: () => void
  children: ReactNode
  testId?: string
}

const overlay: CSSProperties = {
  position: 'fixed',
  // Starts below the status bar so nothing scrolls under it (iOS blurs content there).
  top: 'env(safe-area-inset-top, 0px)',
  right: 0,
  bottom: 0,
  left: 0,
  zIndex: 9999,
  background: 'rgba(15, 11, 8, 0.92)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  overflowY: 'auto',
  overflowX: 'hidden',
  overscrollBehavior: 'none',
  padding: '16px 16px calc(16px + env(safe-area-inset-bottom, 0px))',
}

export const sheetStyle: CSSProperties = {
  width: '100%',
  maxWidth: 480,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 20,
  padding: 22,
  margin: 'auto',
  flexShrink: 0,
}

export function Modal({ onClose, children, testId }: Props) {
  useBodyScrollLock()

  return createPortal(
    <div style={overlay} onClick={onClose} data-testid={testId}>
      <div style={sheetStyle} onClick={e => e.stopPropagation()} className="animate-slide-up">
        {children}
      </div>
    </div>,
    document.body,
  )
}
