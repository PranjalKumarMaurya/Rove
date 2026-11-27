import { type ComponentProps, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { announce } from '../../lib/celebrate'
import { NeonBtn } from './NeonBtn'

export type AsyncStatus = 'idle' | 'busy' | 'done' | 'error'

/** How long "Saved ✓" stays before the caller closes or resets (motion.css: the check draws in 280ms). */
export const DONE_HOLD_MS = 700

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * The state behind an AsyncButton. `busy()` before the request; `await done()` after it
 * succeeds (shows the tick and resolves once it has been seen), then close or `reset()`;
 * `fail()` when it fails (idle label again, with a small nudge).
 */
export function useAsyncStatus(initial: AsyncStatus = 'idle') {
  const [status, setStatus] = useState<AsyncStatus>(initial)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const busy = useCallback(() => setStatus('busy'), [])
  const fail = useCallback(() => setStatus('error'), [])
  const reset = useCallback(() => setStatus('idle'), [])
  const done = useCallback(() => new Promise<void>((resolve) => {
    setStatus('done')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(resolve, DONE_HOLD_MS)
  }), [])
  return { status, busy, done, fail, reset, set: setStatus }
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return ''
}

interface LabelProps {
  status: AsyncStatus
  /** Shown beside the spinner while busy, e.g. "Saving…". */
  busyLabel?: ReactNode
  /** Shown beside the check when done, e.g. "Saved". */
  doneLabel?: ReactNode
  /** Busy text that changes in place (an upload count) without replaying the swap: give it a stable key. */
  busyKey?: string
  /** The idle label (also shown again after an error). */
  children: ReactNode
}

/**
 * The moving part of an async button, usable inside any button: idle label → spinner +
 * "Saving…" → a check that draws itself + "Saved". Labels crossfade and slide 6px; the
 * old one lifts out. Only the current label is in the accessibility tree, so the
 * button's name is what it shows. Disable the button while busy or done yourself
 * (`asyncDisabled`), or use AsyncButton.
 */
export function AsyncLabel({ status, busyLabel = 'Saving…', doneLabel = 'Saved', busyKey, children }: LabelProps) {
  const key = status === 'busy' ? `busy:${busyKey ?? textOf(busyLabel)}` : status === 'done' ? 'done' : `idle:${textOf(children)}`
  const content = status === 'busy'
    ? <><span className="abtn__icon" aria-hidden="true"><span className="abtn__spinner" /></span><span>{busyLabel}</span></>
    : status === 'done'
      ? <><span className="abtn__icon" aria-hidden="true">
          <svg className="abtn__check" width="16" height="16" viewBox="0 0 16 16" focusable="false"><path d="M3.5 8.4l3 3 6-6.6" pathLength={1} /></svg>
        </span><span>{doneLabel}</span></>
      : children

  // The label that just left, kept for its exit (~140ms). Replaced if the state moves on again.
  const last = useRef({ key, content })
  const changed = useRef(false)
  const [leaving, setLeaving] = useState<{ id: number; content: ReactNode } | null>(null)
  useLayoutEffect(() => {
    if (last.current.key !== key) {
      changed.current = true
      setLeaving({ id: Date.now(), content: last.current.content })
    }
    last.current = { key, content }
  })
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(null), 180)
    return () => window.clearTimeout(timer)
  }, [leaving])

  // Screen readers hear the outcome through the app's one status region (SuccessTick), without the visual tick.
  const doneText = textOf(doneLabel)
  useEffect(() => { if (status === 'done') announce(doneText || 'Done') }, [status, doneText])

  return (
    <span className="abtn__stack">
      {leaving && <span key={`out-${leaving.id}`} className="abtn__label abtn__label--out" aria-hidden="true">{leaving.content}</span>}
      <span key={key} className={`abtn__label${changed.current ? ' abtn__label--in' : ''}`}>{content}</span>
    </span>
  )
}

/** Busy and done buttons take no presses (a second submit, or a tap on "Saved"). */
export const asyncDisabled = (status: AsyncStatus) => status === 'busy' || status === 'done'

/** One small sideways nudge when `status` turns to error (none under reduced motion). */
export function useErrorNudge(ref: RefObject<HTMLElement | null>, status: AsyncStatus) {
  const previous = useRef(status)
  useEffect(() => {
    if (status === 'error' && previous.current !== 'error' && ref.current && !reducedMotion()) {
      ref.current.animate?.([
        { transform: 'translateX(0)' }, { transform: 'translateX(-2px)' }, { transform: 'translateX(2px)' }, { transform: 'translateX(0)' },
      ], { duration: 260, easing: 'cubic-bezier(0.77, 0, 0.175, 1)' })
    }
    previous.current = status
  }, [ref, status])
}

type Props = ComponentProps<typeof NeonBtn> & Omit<LabelProps, 'status'> & { status?: AsyncStatus }

/**
 * A NeonBtn that moves through idle → busy (spinner + "Saving…") → done (a check that
 * draws itself + "Saved"), or back to idle on error with a 2px nudge (AsyncLabel). It is
 * disabled while busy or done, and holds at least its idle width so it never jumps.
 */
export function AsyncButton({ status = 'idle', busyLabel, doneLabel, busyKey, children, disabled, className = '', style, ...rest }: Props) {
  const ref = useRef<HTMLButtonElement>(null)
  const idleWidth = useRef<number | null>(null)
  const settled = status === 'idle' || status === 'error'
  // The idle size, measured whenever the idle label is showing.
  useLayoutEffect(() => {
    if (settled && ref.current) idleWidth.current = ref.current.offsetWidth
  })
  useErrorNudge(ref, status)

  return (
    <NeonBtn ref={ref} {...rest} disabled={disabled || asyncDisabled(status)} aria-busy={status === 'busy' || undefined}
      data-status={status} className={`abtn ${className}`}
      style={{ ...style, ...(settled || idleWidth.current === null ? null : { minWidth: idleWidth.current }) }}>
      <AsyncLabel status={status} busyLabel={busyLabel} doneLabel={doneLabel} busyKey={busyKey}>{children}</AsyncLabel>
    </NeonBtn>
  )
}
