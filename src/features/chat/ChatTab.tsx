import {
  memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject,
} from 'react'
import { UserAvatar } from '../../components/ui/UserAvatar'
import { useTripMemberProfiles } from '../groups/useTripMemberProfiles'
import { resolveTripTimeZone } from '../trip/tripTime'
import type { TripTabProps } from '../workspace/tripTab'
import { useTripChat } from './chatApi'
import {
  buildTimeline, CHAT_BODY_MAX, isNearBottom, latestStatus, linkify, mergeWithPending, validateBody, type DisplayMessage, type MessageGroup,
} from './chatRules'
import './chat.css'

/** Show a character count once a draft gets this close to the limit. */
const COUNT_FROM = CHAT_BODY_MAX - 200

/**
 * The Trip's group chat: every active Member reads and posts plain text. Fills
 * the height between its own top and the bottom bar (or the keyboard), with the
 * composer pinned at the bottom.
 */
export function ChatTab({ trip, roster }: TripTabProps) {
  const me = trip.groupMemberId
  const timeZone = resolveTripTimeZone(trip.timezone)
  const chat = useTripChat(trip.groupId, me)
  const { profiles } = useTripMemberProfiles(trip.groupId)
  const rootRef = useRef<HTMLElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const keyboard = useChatViewport(rootRef, probeRef)

  const messages = useMemo(() => mergeWithPending(chat.rows, chat.pending), [chat.rows, chat.pending])
  // "Today" moves at midnight; re-evaluated whenever messages change, which is often enough for a label.
  const items = useMemo(() => buildTimeline(messages, { timeZone, nowMs: Date.now(), me }), [messages, timeZone, me])
  const status = useMemo(() => latestStatus(messages, me), [messages, me])

  const people = useMemo(() => {
    const emoji = new Map(profiles.map((profile) => [profile.groupMemberId, profile.avatarEmoji]))
    return new Map(roster.map((member) => [member.groupMemberId, { name: member.displayName, emoji: emoji.get(member.groupMemberId) ?? null }]))
  }, [profiles, roster])

  // ─── Which bubbles animate: only ones that arrive after the first load. ───
  const firstKeys = useRef<Set<string> | null>(null)
  const firstLatestMs = useRef(0)
  if (!chat.loading && firstKeys.current === null) {
    firstKeys.current = new Set(messages.map((message) => message.key))
    firstLatestMs.current = messages.length ? Date.parse(messages[messages.length - 1].createdAt) : 0
  }
  const isNew = useCallback((message: DisplayMessage) => firstKeys.current !== null && !firstKeys.current.has(message.key)
    && (message.status !== 'sent' || Date.parse(message.createdAt) > firstLatestMs.current), [])

  // ─── Scrolling ───
  const atBottom = useRef(true)
  const [showPill, setShowPill] = useState(false)
  const prepend = useRef<number | null>(null)
  const lastKey = useRef<string | null>(null)

  const toBottom = useCallback((smooth = false) => {
    const node = scrollRef.current
    if (!node) return
    // Glide over a short distance; jump when far up (a long smooth scroll feels slow and fights new arrivals).
    const far = node.scrollHeight - node.scrollTop - node.clientHeight > node.clientHeight * 1.5
    node.scrollTo({ top: node.scrollHeight, behavior: smooth && !far && !prefersReducedMotion() ? 'smooth' : 'auto' })
    atBottom.current = true
    setShowPill(false)
  }, [])

  const onScroll = () => {
    const node = scrollRef.current
    if (!node) return
    atBottom.current = isNearBottom(node)
    if (atBottom.current) setShowPill(false)
  }

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node || chat.loading) return
    const last = messages[messages.length - 1]
    if (prepend.current !== null) {
      // Older messages went in above: keep what the person was reading where it was.
      node.scrollTop = node.scrollHeight - prepend.current
      prepend.current = null
    } else if (lastKey.current === null) {
      node.scrollTop = node.scrollHeight
    } else if (last && last.key !== lastKey.current) {
      if (last.senderId === me && last.status !== 'sent') toBottom(true)
      else if (atBottom.current) toBottom(true)
      else setShowPill(true)
    }
    lastKey.current = last?.key ?? ''
  }, [chat.loading, me, messages, toBottom])

  // The list's box changes (keyboard, composer growing, rotation) or its content
  // reflows: stay on the newest message if that is where the person was.
  useEffect(() => {
    const node = scrollRef.current
    const log = logRef.current
    if (!node || !log || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { if (atBottom.current) node.scrollTop = node.scrollHeight })
    observer.observe(node)
    observer.observe(log)
    return () => observer.disconnect()
  }, [])

  const loadEarlier = async () => {
    const node = scrollRef.current
    if (node) prepend.current = node.scrollHeight - node.scrollTop
    const added = await chat.loadEarlier()
    if (!added.length) prepend.current = null
  }

  const empty = !chat.loading && !chat.error && messages.length === 0

  return (
    <section ref={rootRef} data-testid="chat-tab" className="chat" data-keyboard={keyboard ? 'open' : 'closed'} aria-label="Trip chat">
      <div ref={probeRef} className="chat__probe" aria-hidden="true" />
      <div className="chat__list">
        <div ref={scrollRef} className="chat__scroll" onScroll={onScroll}>
          {chat.hasMore && (
            <div className="chat__earlier">
              <button type="button" className="chat__earlier-btn t-footnote m-press" onClick={() => void loadEarlier()} disabled={chat.loadingEarlier}>
                {chat.loadingEarlier ? 'Loading…' : 'Load earlier messages'}
              </button>
            </div>
          )}
          {chat.loading && <p className="chat__note t-callout">Loading messages…</p>}
          {chat.error && !messages.length && (
            <div className="chat__note">
              <p className="t-callout">Couldn’t load messages.</p>
              <button type="button" className="chat__earlier-btn t-footnote m-press" onClick={() => void chat.reload()}>Try again</button>
            </div>
          )}
          {empty && <p className="chat__empty t-title3 t-voice">No messages yet. Say hi to the crew.</p>}
          <div ref={logRef} role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages" className="chat__log">
            {items.map((item) => item.kind === 'time'
              ? <p key={item.key} className="chat__stamp t-caption t-num"><span className="t-semibold">{item.day}</span> {item.time}</p>
              : <Group key={item.key} group={item} person={people.get(item.senderId)} isNew={isNew} onRetry={chat.retry}
                status={status && item.messages.some((message) => message.key === status.key) ? status : null} />)}
          </div>
        </div>
        <button type="button" className="chat__pill t-footnote" data-show={showPill} aria-hidden={!showPill} tabIndex={showPill ? 0 : -1}
          onClick={() => toBottom(true)}>
          New messages <span aria-hidden="true">↓</span>
        </button>
      </div>
      <Composer onSend={(body) => { chat.send(body); atBottom.current = true }} />
    </section>
  )
}

type BubblePosition = 'single' | 'first' | 'middle' | 'last'

/**
 * One run of messages from one person. Others' runs: name above the first
 * bubble, avatar beside the last one, aligned to its bottom. The last bubble of
 * every run carries the tail.
 */
const Group = memo(function Group({ group, person, isNew, onRetry, status }: {
  group: MessageGroup
  person: { name: string; emoji: string | null } | undefined
  isNew: (message: DisplayMessage) => boolean
  onRetry: (clientId: string) => void
  /** "Delivered" / "Sending…", when this run holds my latest message. */
  status: { key: string; text: string } | null
}) {
  const name = person?.name ?? 'Former member'
  const count = group.messages.length
  return (
    <div className={`chat-run${group.mine ? ' chat-run--mine' : ''}`}>
      {!group.mine && <span className="chat-run__name t-caption">{name}</span>}
      {group.messages.map((message, index) => {
        const position: BubblePosition = count === 1 ? 'single' : index === 0 ? 'first' : index === count - 1 ? 'last' : 'middle'
        const tail = index === count - 1
        return (
          <div key={message.key} className="chat-run__line">
            {!group.mine && (tail
              ? <UserAvatar size={28} name={name} emoji={person?.emoji} className="chat-run__avatar" />
              : <span className="chat-run__avatar-space" aria-hidden="true" />)}
            <Bubble message={message} mine={group.mine} position={position} tail={tail} animate={isNew(message)} onRetry={onRetry} />
          </div>
        )
      })}
      {status && <span className="chat-run__status t-caption" aria-live="off">{status.text}</span>}
    </div>
  )
})

const Bubble = memo(function Bubble({ message, mine, position, tail, animate, onRetry }: {
  message: DisplayMessage
  mine: boolean
  position: BubblePosition
  tail: boolean
  animate: boolean
  onRetry: (clientId: string) => void
}) {
  // Decided once, at mount: a re-render (pending → sent) never replays the entrance.
  const [entering] = useState(animate)
  const segments = useMemo(() => linkify(message.body), [message.body])
  const failed = message.status === 'failed'
  return (
    <div className={`chat-row${entering ? (mine ? ' chat-row--sent' : ' chat-row--arrived') : ''}`} data-status={message.status} data-pos={position}>
      <div className={`chat-bubble t-body${mine ? ' chat-bubble--mine' : ''}${tail ? ' chat-bubble--tail' : ''}`}
        onClick={failed ? () => onRetry(message.clientId) : undefined}>
        {segments.map((segment, index) => segment.kind === 'link'
          ? <a key={index} href={segment.href} target="_blank" rel="noopener noreferrer">{segment.text}</a>
          : <span key={index}>{segment.text}</span>)}
        {message.status === 'sending' && <span className="sr-only"> (sending)</span>}
      </div>
      {failed && (
        <button type="button" className="chat-row__retry t-caption" onClick={() => onRetry(message.clientId)}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z" />
          </svg>
          Not delivered · Tap to retry
        </button>
      )}
    </div>
  )
})

function Composer({ onSend }: { onSend: (body: string) => void }) {
  const [draft, setDraft] = useState('')
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const hardwareKeyboard = useHardwareKeyboard()
  const check = validateBody(draft)
  const length = check.ok ? Array.from(check.body).length : check.length
  const tooLong = !check.ok && check.reason === 'too_long'
  const hasText = draft.trim() !== ''

  // Grow with the text from 1 to 5 lines, then scroll inside.
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.style.height = 'auto'
    const max = parseFloat(getComputedStyle(field).maxHeight) || Infinity
    field.style.height = `${Math.min(field.scrollHeight, max)}px`
    field.style.overflowY = field.scrollHeight > max ? 'auto' : 'hidden'
  }, [draft])

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (!check.ok) return
    onSend(check.body)
    setDraft('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || !hardwareKeyboard) return
    event.preventDefault()
    submit()
  }

  return (
    <form className="chat__composer" onSubmit={submit}>
      <div className="chat__pill-field" data-has-text={hasText}>
        <label htmlFor={id} className="sr-only">Message</label>
        <textarea ref={fieldRef} id={id} rows={1} value={draft} placeholder="Message" enterKeyHint={hardwareKeyboard ? 'send' : 'enter'}
          aria-invalid={tooLong || undefined} aria-describedby={length >= COUNT_FROM ? `${id}-count` : undefined}
          className="chat__field t-body" onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        {/* Inside the pill, bottom-right; shows once there is text. Pressing it must not take focus
            from the field, or the iPhone keyboard closes after every message. */}
        <button type="submit" className="chat__send" aria-label="Send" disabled={!check.ok} onPointerDown={(event) => event.preventDefault()}>
          <span className="chat__send-dot">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
              strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
          </span>
        </button>
      </div>
      {length >= COUNT_FROM && (
        <span id={`${id}-count`} className={`chat__count t-caption t-num${tooLong ? ' is-over' : ''}`}>
          {tooLong ? `${length - CHAT_BODY_MAX} over the limit` : `${CHAT_BODY_MAX - length} left`}
        </span>
      )}
    </form>
  )
}

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** A device with a fine pointer and hover (a laptop, an iPad with a keyboard and trackpad): Enter sends. */
function useHardwareKeyboard(): boolean {
  const query = '(hover: hover) and (pointer: fine)'
  const [matches, setMatches] = useState(() => {
    try { return window.matchMedia(query).matches } catch { return false }
  })
  useEffect(() => {
    let list: MediaQueryList
    try { list = window.matchMedia(query) } catch { return }
    const onChange = () => setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [])
  return matches
}

/**
 * Size the chat to the visible screen: from its own top down to the bottom bar
 * (the probe's height, `--chat-bottom-clear`), or down to the keyboard when it
 * is open (iPhone keeps the layout viewport and shrinks the visual one, so the
 * keyboard is read from `visualViewport`). The parent's bottom padding (room
 * for the bar in scrolling tabs) is cancelled so the page itself never scrolls.
 * Returns whether the keyboard is open.
 */
function useChatViewport(rootRef: RefObject<HTMLElement>, probeRef: RefObject<HTMLDivElement>): boolean {
  const [keyboard, setKeyboard] = useState(false)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const viewport = window.visualViewport
    let frame = 0
    const update = () => {
      const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight
      const open = viewport ? window.innerHeight - visibleBottom > 120 : false
      const clear = open ? 8 : probeRef.current?.offsetHeight ?? 0
      const top = root.getBoundingClientRect().top
      const pad = root.parentElement ? parseFloat(getComputedStyle(root.parentElement).paddingBottom) || 0 : 0
      root.style.height = `${Math.max(220, Math.floor(visibleBottom - top - clear))}px`
      root.style.marginBottom = `${-pad}px`
      setKeyboard(open)
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    update()
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, { passive: true })
    // The tab's entrance (a 6px rise) and late font loads move our top.
    root.parentElement?.addEventListener('animationend', schedule)
    void document.fonts?.ready.then(schedule)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(document.body)
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule)
      root.parentElement?.removeEventListener('animationend', schedule)
      observer?.disconnect()
    }
  }, [probeRef, rootRef])
  return keyboard
}
