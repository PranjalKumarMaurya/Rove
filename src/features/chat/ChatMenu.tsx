import { useLayoutEffect, useRef, useState } from 'react'
import { IconCopy, IconReply } from '../../components/ui/icons'
import { Sheet } from '../../components/ui/Sheet'
import { lockBodyScroll } from '../../hooks/useBodyScrollLock'
import type { DisplayMessage } from './chatRules'
import { REACTION_NAMES, REACTIONS, type ReactionEmoji, type ReactionSummary } from './chatSocial'

/** Where the long-pressed bubble is on screen, so the menu grows out of it. */
export interface MenuAnchor { top: number; bottom: number; left: number; right: number }

/**
 * iMessage-style message menu on a native modal <dialog> (focus trapped, Escape
 * closes, focus returns to the bubble's actions): the tapback bar above a copy
 * of the bubble, and Reply and Copy below it. The same menu opens from a long
 * press, a right click, the hover button on a desktop and the (screen reader
 * reachable) "Message actions" button, so every gesture has a twin.
 */
export function MessageMenu({ message, mine, anchor, reactions, canReply, onReact, onReply, onCopy, onClose }: {
  message: DisplayMessage
  mine: boolean
  anchor: MenuAnchor
  reactions: ReactionSummary[]
  /** Only messages the server has can be quoted. */
  canReply: boolean
  onReact: (emoji: ReactionEmoji) => void
  onReply: () => void
  onCopy: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const stackRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef<HTMLButtonElement>(null)
  const [place, setPlace] = useState<{ top: number; side: number } | null>(null)
  // Lifting the finger after a long press lands on the backdrop: only a tap that also
  // started there closes the menu.
  const downOnBackdrop = useRef(false)

  useLayoutEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const unlock = lockBodyScroll()
    if (dialog && !dialog.open) dialog.showModal()
    firstRef.current?.focus({ preventScroll: true })
    return () => {
      if (dialog?.open) dialog.close()
      unlock()
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  // The copy of the bubble sits where the bubble is; the whole stack is kept on screen.
  useLayoutEffect(() => {
    const stack = stackRef.current
    const bar = barRef.current
    if (!stack || !bar) return
    const gap = 8
    const height = stack.offsetHeight
    const viewport = window.visualViewport?.height ?? window.innerHeight
    const safeTop = document.querySelector('.status-shield')?.getBoundingClientRect().bottom ?? 0
    const wanted = anchor.top - bar.offsetHeight - gap
    const top = Math.max(safeTop + gap, Math.min(wanted, viewport - height - gap))
    const side = mine ? Math.max(gap, window.innerWidth - anchor.right) : Math.max(gap, anchor.left)
    setPlace({ top, side })
  }, [anchor, mine])

  const mineSet = new Set(reactions.filter((entry) => entry.mine).map((entry) => entry.emoji))
  return (
    <dialog ref={ref} className="chat-menu" aria-label="Message actions" data-testid="chat-menu"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onPointerDown={(event) => { downOnBackdrop.current = event.target === event.currentTarget }}
      onClick={(event) => {
        if (event.target === event.currentTarget && downOnBackdrop.current) onClose()
        downOnBackdrop.current = false
      }}>
      <div ref={stackRef} className="chat-menu__stack" data-side={mine ? 'mine' : 'theirs'}
        style={place ? { top: place.top, [mine ? 'right' : 'left']: place.side } : { visibility: 'hidden' }}>
        <div ref={barRef} className="chat-menu__tapbacks" role="group" aria-label="React">
          {REACTIONS.map((emoji, index) => {
            const on = mineSet.has(emoji)
            return (
              <button key={emoji} ref={index === 0 ? firstRef : undefined} type="button" className="chat-menu__tapback" aria-pressed={on}
                aria-label={on ? `Remove ${REACTION_NAMES[emoji]}` : `React with ${REACTION_NAMES[emoji]}`}
                onClick={() => { onReact(emoji); onClose() }}>
                <span aria-hidden="true">{emoji}</span>
              </button>
            )
          })}
        </div>
        <div className={`chat-menu__preview chat-bubble t-body${mine ? ' chat-bubble--mine' : ''}`} aria-hidden="true">{message.body}</div>
        <div className="chat-menu__list" role="menu" aria-label="Message">
          <button type="button" role="menuitem" className="chat-menu__item t-body" disabled={!canReply} onClick={() => { onReply(); onClose() }}>
            <span className="flex-1">Reply</span><IconReply size="md" />
          </button>
          <button type="button" role="menuitem" className="chat-menu__item t-body" onClick={() => { onCopy(); onClose() }}>
            <span className="flex-1">Copy</span><IconCopy size="md" />
          </button>
        </div>
      </div>
    </dialog>
  )
}

/** Who reacted to a message, by tapback; your own can be taken back here too. */
export function ReactionsSheet({ reactions, nameOf, me, onToggle, onClose }: {
  reactions: ReactionSummary[]
  nameOf: (memberId: string) => string
  me: string
  onToggle: (emoji: ReactionEmoji) => void
  onClose: () => void
}) {
  return (
    <Sheet title="Reactions" onClose={onClose} testId="chat-reactions-sheet">
      <ul className="flex flex-col gap-3">
        {reactions.map((entry) => {
          const names = [...entry.memberIds].sort((a, b) => (a === me ? -1 : b === me ? 1 : nameOf(a).localeCompare(nameOf(b))))
            .map((id) => (id === me ? 'You' : nameOf(id)))
          return (
            <li key={entry.emoji} className="chat-reactions-row">
              <span className="chat-reactions-row__emoji" aria-hidden="true">{entry.emoji}</span>
              <span className="min-w-0 flex-1">
                <span className="sr-only">{REACTION_NAMES[entry.emoji]}: </span>
                <span className="t-callout block" style={{ color: 'var(--text-primary)' }}>{names.join(', ')}</span>
                <span className="t-footnote block" style={{ color: 'var(--text-tertiary)' }}>{entry.count === 1 ? '1 person' : `${entry.count} people`}</span>
              </span>
              {entry.mine && (
                <button type="button" className="btn-quiet t-footnote" onClick={() => onToggle(entry.emoji)}>Remove mine</button>
              )}
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}
