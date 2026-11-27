import { type ReactNode, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock'
import type { CSSProperties } from 'react'
import { useTriggerOrigin } from './motion'

interface Props {
  onClose: () => void
  children: ReactNode
  testId?: string
}

// Layout from .dialog-overlay / .dialog-card (global.css, docs/DESIGN-SYSTEM.md §6); above everything.
const overlay: CSSProperties = { zIndex: 9999 }

export function Modal({ onClose, children, testId }: Props) {
  useBodyScrollLock()
  const card = useRef<HTMLDivElement>(null)
  useTriggerOrigin(card)

  return createPortal(
    <div style={overlay} onClick={onClose} data-testid={testId} className="dialog-overlay m-backdrop">
      <div ref={card} onClick={e => e.stopPropagation()} className="dialog-card m-dialog">
        {children}
      </div>
    </div>,
    document.body,
  )
}
