import {
  memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject,
} from 'react'
import { IconClose, IconReply, IconSmile } from '../../components/ui/icons'
import { UserAvatar } from '../../components/ui/UserAvatar'
import { EDGE_WIDTH } from '../../lib/edgeSwipe'
import { useTripMemberProfiles } from '../groups/useTripMemberProfiles'
import { NotificationPrompt } from '../notifications/NotificationSettings'
import { resolveTripTimeZone } from '../trip/tripTime'
import type { TripTabProps } from '../workspace/tripTab'
import { loadMyReadPoint, markChatRead, useTripChat } from './chatApi'
import { MessageMenu, ReactionsSheet, type MenuAnchor } from './ChatMenu'
import {
  buildTimeline, CHAT_BODY_MAX, isNearBottom, latestStatus, mergeWithPending, validateBody, type ChatMessage, type DisplayMessage, type MessageGroup,
  type SendExtras,
} from './chatRules'
import {
  firstUnreadKey, insertMention, mentionOptions, mentionQuery, mentionsMe, quoteText, readPoint, REACTION_NAMES, resolveMentions, segmentMessage,
  summarizeReactions, type MentionMember, type MentionOption, type ReactionEmoji, type ReactionSummary,
} from './chatSocial'
import { markTripReadLocally, refreshUnread } from './unreadStore'
import './chat.css'

/** Show a character count once a draft gets this close to the limit. */
const COUNT_FROM = CHAT_BODY_MAX - 200
/** Hold this long (ms) for the message menu. */
const LONG_PRESS_MS = 450
/** Swipe a bubble this far right (px, after resistance) to reply. */
const SWIPE_REPLY = 52
/** Read state is written at most this often while new messages keep arriving. */
const READ_DEBOUNCE_MS = 700

type Person = { name: string; emoji: string | null }

/**
 * The Trip's group chat: every active Member reads and posts. Replies quote a
 * message, reactions (tapbacks) answer in one tap, @mentions name people, and
 * an "Unread messages" divider marks where the person left off. Fills the height
 * between its own top and the bottom bar (or the keyboard), with the composer
 * pinned at the bottom.
 */
export function ChatTab({ trip, roster }: TripTabProps) {
  const me = trip.groupMemberId
  const groupId = trip.groupId
  const timeZone = resolveTripTimeZone(trip.timezone)
  const chat = useTripChat(groupId, me)
  const { profiles } = useTripMemberProfiles(groupId)
  const rootRef = useRef<HTMLElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const keyboard = useChatViewport(rootRef, probeRef)

  const messages = useMemo(() => mergeWithPending(chat.rows, chat.pending), [chat.rows, chat.pending])
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const people = useMemo(() => {
    const emoji = new Map(profiles.map((profile) => [profile.groupMemberId, profile.avatarEmoji]))
    return new Map<string, Person>(roster.map((member) => [member.groupMemberId, { name: member.displayName, emoji: emoji.get(member.groupMemberId) ?? null }]))
  }, [profiles, roster])
  const nameOf = useCallback((memberId: string) => people.get(memberId)?.name ?? 'Former member', [people])
  /** Who can be @mentioned: the other active Members. */
  const mentionable = useMemo<MentionMember[]>(() => roster.filter((member) => member.status === 'active' && member.groupMemberId !== me)
    .map((member) => ({ id: member.groupMemberId, name: member.displayName })), [me, roster])

  // ─── Unread: where the person left off, read once when the chat opens ───
  const [readAt, setReadAt] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let active = true
    // A slow or failed read just means no divider.
    const timer = window.setTimeout(() => { if (active) setReadAt((current) => current === undefined ? null : current) }, 1500)
    void loadMyReadPoint(groupId, me).then((value) => {
      if (!active) return
      setReadAt(value)
      // Already read up to here: opening the chat writes nothing until something new arrives.
      marked.current = value
    }, () => { if (active) setReadAt(null) })
    return () => { active = false; window.clearTimeout(timer) }
  }, [groupId, me])
  const ready = !chat.loading && readAt !== undefined
  const unreadKey = useRef<string | null | undefined>(undefined)
  if (ready && unreadKey.current === undefined) unreadKey.current = firstUnreadKey(messages, readAt ?? null, me)

  // "Today" moves at midnight; re-evaluated whenever messages change, which is often enough for a label.
  const items = useMemo(() => buildTimeline(messages, { timeZone, nowMs: Date.now(), me, unreadKey: unreadKey.current ?? null }),
    // unreadKey is fixed once `ready`; `ready` re-runs this when it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messages, timeZone, me, ready])
  const status = useMemo(() => latestStatus(messages, me), [messages, me])
  const byId = useMemo(() => {
    const map = new Map<string, ChatMessage | DisplayMessage>(Object.entries(chat.quoted))
    for (const message of messages) if (message.id) map.set(message.id, message)
    return map
  }, [chat.quoted, messages])
  const reactionsFor = useCallback((id: string | null) => id ? summarizeReactions(chat.reactions, id, me) : [], [chat.reactions, me])

  // ─── Which bubbles animate: only ones that arrive after the first load. ───
  const firstKeys = useRef<Set<string> | null>(null)
  const firstLatestMs = useRef(0)
  if (!chat.loading && firstKeys.current === null) {
    firstKeys.current = new Set(messages.map((message) => message.key))
    firstLatestMs.current = messages.length ? Date.parse(messages[messages.length - 1].createdAt) : 0
  }
  const isNew = useCallback((message: DisplayMessage) => firstKeys.current !== null && !firstKeys.current.has(message.key)
    && (message.status !== 'sent' || Date.parse(message.createdAt) > firstLatestMs.current), [])

  // ─── Marking read: while the chat is visible and the person is at the newest message ───
  const atBottom = useRef(true)
  const marked = useRef<string | null>(null)
  const readTimer = useRef<number | undefined>(undefined)
  const scheduleRead = useCallback(() => {
    if (document.visibilityState !== 'visible' || !atBottom.current) return
    const point = readPoint(messagesRef.current)
    if (!point || (marked.current && Date.parse(point) <= Date.parse(marked.current))) return
    window.clearTimeout(readTimer.current)
    readTimer.current = window.setTimeout(() => {
      if (document.visibilityState !== 'visible' || !atBottom.current) return
      marked.current = point
      markTripReadLocally(groupId)
      void markChatRead(groupId, point).then(() => refreshUnread(), () => { marked.current = null })
    }, READ_DEBOUNCE_MS)
  }, [groupId])
  useEffect(() => {
    const onVisible = () => scheduleRead()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.clearTimeout(readTimer.current)
    }
  }, [scheduleRead])

  // ─── Scrolling ───
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
    scheduleRead()
  }, [scheduleRead])

  const onScroll = () => {
    const node = scrollRef.current
    if (!node) return
    atBottom.current = isNearBottom(node)
    if (atBottom.current) {
      setShowPill(false)
      scheduleRead()
    }
  }

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node || !ready) return
    const last = messages[messages.length - 1]
    if (prepend.current !== null) {
      // Older messages went in above: keep what the person was reading where it was.
      node.scrollTop = node.scrollHeight - prepend.current
      prepend.current = null
    } else if (lastKey.current === null) {
      // Opening: at the unread divider if there is one, else at the newest message.
      const divider = node.querySelector<HTMLElement>('[data-unread-divider]')
      if (divider) node.scrollTop += divider.getBoundingClientRect().top - node.getBoundingClientRect().top - 12
      else node.scrollTop = node.scrollHeight
      atBottom.current = isNearBottom(node)
      scheduleRead()
    } else if (last && last.key !== lastKey.current) {
      if (last.senderId === me && last.status !== 'sent') toBottom(true)
      else if (atBottom.current) toBottom(true)
      else setShowPill(true)
    }
    lastKey.current = last?.key ?? ''
  }, [ready, me, messages, toBottom, scheduleRead])

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

  // ─── Replies, the message menu, reactions ───
  const [replyTo, setReplyTo] = useState<DisplayMessage | null>(null)
  const [menu, setMenu] = useState<{ message: DisplayMessage; anchor: MenuAnchor } | null>(null)
  const [reactionsOf, setReactionsOf] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const composerRef = useRef<{ focus: () => void } | null>(null)

  const startReply = useCallback((message: DisplayMessage) => {
    if (!message.id) return
    setReplyTo(message)
    composerRef.current?.focus()
  }, [])
  const openMenu = useCallback((message: DisplayMessage, element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    setMenu({ message, anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } })
  }, [])
  const showToast = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast((current) => current === text ? null : current), 1600)
  }, [])
  const copy = useCallback((message: DisplayMessage) => {
    const done = () => showToast('Copied')
    try {
      void navigator.clipboard.writeText(message.body).then(done, () => showToast('Couldn’t copy'))
    } catch {
      showToast('Couldn’t copy')
    }
  }, [showToast])

  const { ensureLoaded, retry, toggleReaction, send: post } = chat
  /** Tap on a quote: scroll to the original (loading earlier pages if needed) and flash it. */
  const goToMessage = useCallback(async (id: string) => {
    const node = scrollRef.current
    if (!node) return
    if (!messagesRef.current.some((message) => message.id === id)) {
      prepend.current = node.scrollHeight - node.scrollTop
      const found = await ensureLoaded(id)
      if (!found) {
        prepend.current = null
        showToast('That message is too far back')
        return
      }
    }
    window.requestAnimationFrame(() => {
      const target = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
      if (!target) return
      target.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      const key = messagesRef.current.find((message) => message.id === id)?.key ?? null
      setFlash(key)
      window.setTimeout(() => setFlash((current) => current === key ? null : current), 1400)
    })
  }, [ensureLoaded, showToast])

  const send = useCallback((body: string, extras: SendExtras) => {
    post(body, extras)
    setReplyTo(null)
    atBottom.current = true
  }, [post])

  const empty = !chat.loading && !chat.error && messages.length === 0
  const handlers = useMemo<BubbleHandlers>(() => ({
    onRetry: retry, onReply: startReply, onMenu: openMenu, onShowReactions: setReactionsOf,
    onQuote: (id) => void goToMessage(id), onToggleReaction: toggleReaction,
  }), [retry, toggleReaction, goToMessage, openMenu, startReply])

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
              : item.kind === 'unread'
                ? <div key={item.key} className="chat__unread" role="separator" aria-label="Unread messages" data-unread-divider="" data-testid="chat-unread-divider">
                  <span className="t-caption t-semibold">Unread messages</span>
                </div>
                : <Group key={item.key} group={item} person={people.get(item.senderId)} isNew={isNew} me={me} nameOf={nameOf}
                  byId={byId} reactionsFor={reactionsFor} flash={flash} handlers={handlers}
                  status={status && item.messages.some((message) => message.key === status.key) ? status : null} />)}
          </div>
        </div>
        <button type="button" className="chat__pill t-footnote" data-show={showPill} aria-hidden={!showPill} tabIndex={showPill ? 0 : -1}
          onClick={() => toBottom(true)}>
          New messages <span aria-hidden="true">↓</span>
        </button>
        {toast && <p role="status" className="chat__toast t-footnote" key={toast}>{toast}</p>}
      </div>
      <NotificationPrompt />
      <Composer focusRef={composerRef} members={mentionable} replyTo={replyTo} replyName={replyTo ? (replyTo.senderId === me ? 'yourself' : nameOf(replyTo.senderId)) : ''}
        onCancelReply={() => setReplyTo(null)} onSend={send} />
      {menu && (
        <MessageMenu message={menu.message} mine={menu.message.senderId === me} anchor={menu.anchor} reactions={reactionsFor(menu.message.id)}
          canReply={Boolean(menu.message.id)} onClose={() => setMenu(null)}
          onReact={(emoji) => { if (menu.message.id) toggleReaction(menu.message.id, emoji) }}
          onReply={() => startReply(menu.message)} onCopy={() => copy(menu.message)} />
      )}
      {reactionsOf && reactionsFor(reactionsOf).length > 0 && (
        <ReactionsSheet reactions={reactionsFor(reactionsOf)} nameOf={nameOf} me={me} onClose={() => setReactionsOf(null)}
          onToggle={(emoji) => toggleReaction(reactionsOf, emoji)} />
      )}
    </section>
  )
}

interface BubbleHandlers {
  onRetry: (clientId: string) => void
  onReply: (message: DisplayMessage) => void
  onMenu: (message: DisplayMessage, element: HTMLElement) => void
  onShowReactions: (messageId: string) => void
  onQuote: (messageId: string) => void
  onToggleReaction: (messageId: string, emoji: ReactionEmoji) => void
}

type BubblePosition = 'single' | 'first' | 'middle' | 'last'

/**
 * One run of messages from one person. Others' runs: name above the first
 * bubble, avatar beside the last one, aligned to its bottom. The last bubble of
 * every run carries the tail.
 */
const Group = memo(function Group({ group, person, isNew, me, nameOf, byId, reactionsFor, flash, handlers, status }: {
  group: MessageGroup
  person: Person | undefined
  isNew: (message: DisplayMessage) => boolean
  me: string
  nameOf: (memberId: string) => string
  byId: Map<string, ChatMessage | DisplayMessage>
  reactionsFor: (messageId: string | null) => ReactionSummary[]
  flash: string | null
  handlers: BubbleHandlers
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
        const quoted = message.replyTo ? byId.get(message.replyTo) ?? null : null
        return (
          <div key={message.key} className="chat-run__line">
            {!group.mine && (tail
              ? <UserAvatar size={28} name={name} emoji={person?.emoji} className="chat-run__avatar" />
              : <span className="chat-run__avatar-space" aria-hidden="true" />)}
            <Bubble message={message} mine={group.mine} position={position} tail={tail} animate={isNew(message)} me={me} nameOf={nameOf}
              quoted={quoted} reactions={reactionsFor(message.id)} flash={flash === message.key} handlers={handlers} />
          </div>
        )
      })}
      {status && <span className="chat-run__status t-caption" aria-live="off">{status.text}</span>}
    </div>
  )
})

/** Long press (and right click) for the menu; a swipe to the right to reply. Touch scrolling stays the browser's. */
function useBubbleGestures(onMenu: () => void, onReply: (() => void) | null) {
  const press = useRef<{ id: number; x: number; y: number; swiping: boolean; timer: number } | null>(null)
  const fired = useRef(false)
  const [offset, setOffset] = useState(0)
  const offsetRef = useRef(0)
  const move = (value: number) => { offsetRef.current = value; setOffset(value) }
  const end = () => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
    if (offsetRef.current) move(0)
  }
  useEffect(() => () => { if (press.current) window.clearTimeout(press.current.timer) }, [])

  return {
    offset,
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      // The left edge belongs to the system back swipe.
      if (event.clientX <= EDGE_WIDTH) return
      fired.current = false
      const timer = window.setTimeout(() => {
        if (press.current && !press.current.swiping) {
          fired.current = true
          press.current = null
          navigator.vibrate?.(8)
          onMenu()
        }
      }, LONG_PRESS_MS)
      press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, swiping: false, timer }
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const state = press.current
      if (!state || state.id !== event.pointerId) return
      const dx = event.clientX - state.x
      const dy = event.clientY - state.y
      if (!state.swiping) {
        if (Math.hypot(dx, dy) > 10) window.clearTimeout(state.timer)
        if (onReply && event.pointerType !== 'mouse' && dx > 12 && dx > Math.abs(dy) * 1.5) {
          state.swiping = true
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* a pointer that is already gone */ }
        } else if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
          end()
          return
        }
      }
      // Follows the finger with resistance, never past 72px, never to the left.
      if (state.swiping) move(Math.max(0, Math.min(72, dx * 0.6)))
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) {
      const state = press.current
      if (state && state.id === event.pointerId && state.swiping && offsetRef.current >= SWIPE_REPLY) onReply?.()
      end()
    },
    onPointerCancel: end,
    onContextMenu(event: ReactMouseEvent<HTMLElement>) {
      event.preventDefault()
      if (fired.current) return
      end()
      onMenu()
    },
    /** A long press must not also follow a link or retry. */
    onClickCapture(event: ReactMouseEvent<HTMLElement>) {
      if (!fired.current) return
      fired.current = false
      event.preventDefault()
      event.stopPropagation()
    },
  }
}

const Bubble = memo(function Bubble({ message, mine, position, tail, animate, me, nameOf, quoted, reactions, flash, handlers }: {
  message: DisplayMessage
  mine: boolean
  position: BubblePosition
  tail: boolean
  animate: boolean
  me: string
  nameOf: (memberId: string) => string
  quoted: ChatMessage | DisplayMessage | null
  reactions: ReactionSummary[]
  flash: boolean
  handlers: BubbleHandlers
}) {
  // Decided once, at mount: a re-render (pending → sent) never replays the entrance.
  const [entering] = useState(animate)
  const [hadReactions] = useState(reactions.length > 0)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const mentioned = useMemo(() => message.mentions.map((id) => ({ id, name: nameOf(id) })), [message.mentions, nameOf])
  const segments = useMemo(() => segmentMessage(message.body, mentioned, message.mentionsEveryone, me),
    [me, mentioned, message.body, message.mentionsEveryone])
  const failed = message.status === 'failed'
  const toMe = mentionsMe(message, me)
  const openMenu = () => { if (bubbleRef.current) handlers.onMenu(message, bubbleRef.current) }
  const gestures = useBubbleGestures(openMenu, message.id ? () => handlers.onReply(message) : null)
  const quotedSender = quoted ? ('sender_id' in quoted ? quoted.sender_id : quoted.senderId) : null
  const quotedName = quotedSender === me ? 'You' : quotedSender ? nameOf(quotedSender) : null
  const quotedBody = quoted ? quoteText(quoted.body) : null

  return (
    <div className={`chat-row${entering ? (mine ? ' chat-row--sent' : ' chat-row--arrived') : ''}`} data-status={message.status} data-pos={position}
      data-message-id={message.id ?? undefined} data-has-reactions={reactions.length ? 'true' : undefined}>
      <span className="chat-row__swipe" aria-hidden="true" style={{ opacity: Math.min(1, gestures.offset / SWIPE_REPLY) }}><IconReply size="sm" /></span>
      <div className="chat-row__body" style={gestures.offset ? { transform: `translateX(${gestures.offset}px)`, transition: 'none' } : undefined}>
        <div ref={bubbleRef} data-testid="chat-bubble"
          className={`chat-bubble t-body${mine ? ' chat-bubble--mine' : ''}${tail ? ' chat-bubble--tail' : ''}${toMe ? ' chat-bubble--to-me' : ''}${flash ? ' chat-bubble--flash' : ''}`}
          onPointerDown={gestures.onPointerDown} onPointerMove={gestures.onPointerMove} onPointerUp={gestures.onPointerUp}
          onPointerCancel={gestures.onPointerCancel} onContextMenu={gestures.onContextMenu} onClickCapture={gestures.onClickCapture}
          onClick={failed ? () => handlers.onRetry(message.clientId) : undefined}>
          {message.replyTo && (
            <button type="button" className="chat-quote" data-testid="chat-quote" onClick={(event) => { event.stopPropagation(); handlers.onQuote(message.replyTo as string) }}
              aria-label={quotedName ? `Reply to ${quotedName}: ${quotedBody}. Show the message` : 'Reply to an earlier message. Show it'}>
              <span className="chat-quote__name t-caption t-semibold" aria-hidden="true">{quotedName ?? 'Earlier message'}</span>
              <span className="chat-quote__text t-footnote" aria-hidden="true">{quotedBody ?? 'Tap to find it'}</span>
            </button>
          )}
          {segments.map((segment, index) => segment.kind === 'link'
            ? <a key={index} href={segment.href} target="_blank" rel="noopener noreferrer" data-layout-exempt="inline">{segment.text}</a>
            : segment.kind === 'mention'
              ? <span key={index} className={`chat-mention${segment.me ? ' chat-mention--me' : ''}`}>{segment.text}</span>
              : <span key={index}>{segment.text}</span>)}
          {toMe && <span className="sr-only"> (mentions you)</span>}
          {message.status === 'sending' && <span className="sr-only"> (sending)</span>}
          {reactions.length > 0 && message.id && <ReactionCluster reactions={reactions} mine={mine} live={!hadReactions} onOpen={() => handlers.onShowReactions(message.id as string)} />}
        </div>
        <button type="button" className="chat-row__more" aria-label="Message actions" onClick={openMenu}><IconSmile size="md" /></button>
      </div>
      {failed && (
        <button type="button" className="chat-row__retry t-caption" onClick={() => handlers.onRetry(message.clientId)}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z" />
          </svg>
          {message.failure === 'everyone_limit' ? '@everyone works once an hour · Tap to send without it' : 'Not delivered · Tap to retry'}
        </button>
      )}
    </div>
  )
})

/** The tapbacks on a bubble's top corner, with counts; tap for who reacted. Chips pop in when they change. */
function ReactionCluster({ reactions, mine, live, onOpen }: {
  reactions: ReactionSummary[]
  mine: boolean
  /** The bubble had no reactions when it appeared: everything here arrived live and pops. */
  live: boolean
  onOpen: () => void
}) {
  // Chips shown when the cluster first rendered stay still; any chip mounted later (a new
  // emoji, or a changed count, which remounts it by key) pops once.
  const shown = useRef<Set<string> | null>(null)
  const key = (entry: ReactionSummary) => `${entry.emoji}:${entry.count}:${entry.mine}`
  if (shown.current === null) shown.current = new Set(live ? [] : reactions.map(key))
  const label = reactions.map((entry) => `${entry.count} ${REACTION_NAMES[entry.emoji]}`).join(', ')
  return (
    <button type="button" className="chat-reacts" data-side={mine ? 'mine' : 'theirs'} data-testid="chat-reactions" data-layout-exempt="hit-area"
      aria-label={`Reactions: ${label}. Show who reacted`} onClick={(event) => { event.stopPropagation(); onOpen() }}
      onPointerDown={(event) => event.stopPropagation()}>
      {reactions.map((entry) => (
        <span key={key(entry)} className={`chat-reacts__chip${entry.mine ? ' is-mine' : ''}${shown.current?.has(key(entry)) ? '' : ' is-new'}`} aria-hidden="true">
          <span className="chat-reacts__emoji">{entry.emoji}</span>
          {entry.count > 1 && <span className="t-num">{entry.count}</span>}
        </span>
      ))}
    </button>
  )
}

const Composer = memo(function Composer({ focusRef, members, replyTo, replyName, onCancelReply, onSend }: {
  /** Lets the chat put the cursor in the field (after choosing Reply). */
  focusRef: { current: { focus: () => void } | null }
  members: MentionMember[]
  replyTo: DisplayMessage | null
  replyName: string
  onCancelReply: () => void
  onSend: (body: string, extras: SendExtras) => void
}) {
  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [closedAt, setClosedAt] = useState<number | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const hardwareKeyboard = useHardwareKeyboard()
  const check = validateBody(draft)
  const length = check.ok ? Array.from(check.body).length : check.length
  const tooLong = !check.ok && check.reason === 'too_long'
  const hasText = draft.trim() !== ''

  useEffect(() => {
    focusRef.current = { focus: () => fieldRef.current?.focus() }
    return () => { focusRef.current = null }
  }, [focusRef])

  // ─── @mentions: a picker above the composer while an @word is being typed ───
  const query = mentionQuery(draft, caret)
  const options: MentionOption[] = query && closedAt !== query.start ? mentionOptions(query.query, members) : []
  const picking = options.length > 0
  const activeIndex = Math.min(active, Math.max(0, options.length - 1))
  useEffect(() => { setActive(0) }, [query?.start, query?.query])

  const choose = (option: MentionOption) => {
    if (!query) return
    const name = option.kind === 'everyone' ? 'everyone' : option.member.name
    const next = insertMention(draft, query.start, caret, name)
    placeCaret.current = next.caret
    setDraft(next.text)
    setCaret(next.caret)
  }
  // After a mention is inserted: the caret goes right after it, in the same commit, so
  // keystrokes that follow land there.
  const placeCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const field = fieldRef.current
    const at = placeCaret.current
    if (!field || at === null) return
    placeCaret.current = null
    if (document.activeElement !== field) field.focus()
    field.setSelectionRange(at, at)
  }, [draft])

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
    const mentions = resolveMentions(check.body, members)
    onSend(check.body, { replyTo: replyTo?.id ?? null, mentions: mentions.ids, mentionsEveryone: mentions.everyone })
    setDraft('')
    setCaret(0)
    setClosedAt(null)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picking && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((activeIndex + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        choose(options[activeIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setClosedAt(query?.start ?? null)
        return
      }
    }
    if (event.key === 'Escape' && replyTo) {
      event.preventDefault()
      onCancelReply()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || !hardwareKeyboard) return
    event.preventDefault()
    submit()
  }

  const trackCaret = () => setCaret(fieldRef.current?.selectionStart ?? 0)
  const listId = `${id}-mentions`

  return (
    <form className="chat__composer" onSubmit={submit}>
      {picking && (
        <ul id={listId} role="listbox" aria-label="Mention someone" className="chat-mentions" data-testid="mention-picker">
          {options.map((option, index) => {
            const label = option.kind === 'everyone' ? 'everyone' : option.member.name
            return (
              <li key={option.kind === 'everyone' ? 'everyone' : option.member.id} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex}
                className="chat-mentions__option" onPointerDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
                {option.kind === 'everyone'
                  ? <span className="chat-mentions__all" aria-hidden="true">@</span>
                  : <UserAvatar size={28} name={option.member.name} />}
                <span className="min-w-0 flex-1 truncate t-headline">{label}</span>
                {option.kind === 'everyone' && <span className="t-footnote shrink-0" style={{ color: 'var(--text-tertiary)' }}>Notify the whole crew</span>}
              </li>
            )
          })}
        </ul>
      )}
      {replyTo && (
        <div className="chat-replying" data-testid="chat-replying">
          <span className="chat-replying__bar" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block t-caption t-semibold chat-replying__name">Replying to {replyName}</span>
            <span className="block t-footnote truncate chat-replying__text">{quoteText(replyTo.body)}</span>
          </span>
          <button type="button" className="close-x" aria-label="Cancel reply" onClick={onCancelReply} onPointerDown={(event) => event.preventDefault()}>
            <IconClose size="sm" />
          </button>
        </div>
      )}
      <div className="chat__pill-field" data-has-text={hasText}>
        <label htmlFor={id} className="sr-only">Message</label>
        <textarea ref={fieldRef} id={id} rows={1} value={draft} placeholder="Message" enterKeyHint={hardwareKeyboard ? 'send' : 'enter'}
          aria-invalid={tooLong || undefined} aria-describedby={length >= COUNT_FROM ? `${id}-count` : undefined}
          aria-autocomplete="list" aria-controls={picking ? listId : undefined} aria-expanded={picking}
          aria-activedescendant={picking ? `${listId}-${activeIndex}` : undefined}
          className="chat__field t-body" onChange={(event) => { setDraft(event.target.value); setCaret(event.target.selectionStart ?? event.target.value.length) }}
          onSelect={trackCaret} onKeyUp={trackCaret} onClick={trackCaret} onKeyDown={onKeyDown} />
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
})

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
