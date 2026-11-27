// Trip chat rules. Pure functions (no React, no Supabase) so they run under
// `node --test`: body validation, merging server rows with optimistic sends,
// grouping into bubbles and days, and the only rich text there is (links).
import { dayKey, formatDay, formatTime } from '../trip/tripTime.ts'

/** A row of `trip_messages` as the app reads it. */
export interface ChatMessage {
  id: string
  group_id: string
  sender_id: string
  body: string
  client_id: string
  created_at: string
  /** The message this one quotes (same Trip), if any. */
  reply_to: string | null
  /** Members mentioned (`group_members.id`), resolved when sent. */
  mentions: string[]
  mentions_everyone: boolean
}

/** What a send carries besides the text. */
export interface SendExtras {
  replyTo: string | null
  mentions: string[]
  mentionsEveryone: boolean
}

export const NO_EXTRAS: SendExtras = { replyTo: null, mentions: [], mentionsEveryone: false }

/** Why a send failed, when the server said so: @everyone used within the hour. */
export type SendFailure = 'everyone_limit'

/** A message this device is sending (or failed to send). */
export interface PendingMessage extends SendExtras {
  clientId: string
  senderId: string
  body: string
  /** Local clock, only for ordering pending messages among themselves. */
  createdAt: string
  status: 'sending' | 'failed'
  failure?: SendFailure
}

export type MessageStatus = 'sent' | 'sending' | 'failed'

export interface DisplayMessage extends SendExtras {
  /** Stable across pending → sent, so the bubble never remounts. */
  key: string
  id: string | null
  senderId: string
  body: string
  clientId: string
  createdAt: string
  status: MessageStatus
  failure?: SendFailure
}

const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/iu.test(value)

/**
 * A `trip_messages` row from the API or Realtime, or null if it is not one. The
 * Phase 1 columns (reply_to, mentions, mentions_everyone) default when absent.
 */
export function readChatMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (!['id', 'group_id', 'sender_id', 'body', 'client_id', 'created_at'].every((key) => typeof row[key] === 'string')) return null
  return {
    id: row.id as string, group_id: row.group_id as string, sender_id: row.sender_id as string, body: row.body as string,
    client_id: row.client_id as string, created_at: row.created_at as string,
    reply_to: isUuid(row.reply_to) ? row.reply_to : null,
    mentions: Array.isArray(row.mentions) ? row.mentions.filter(isUuid) : [],
    mentions_everyone: row.mentions_everyone === true,
  }
}

export const CHAT_BODY_MAX = 2000
export const CHAT_PAGE_SIZE = 50
/** Consecutive messages from one person within this gap share one group. */
export const GROUP_GAP_MS = 5 * 60 * 1000

/** Matches the database's trimmed set (migration 095), plus everything JS calls whitespace. */
const EDGE_SPACE = /^[\s\u200b\ufeff]+|[\s\u200b\ufeff]+$/gu

export type BodyCheck = { ok: true; body: string } | { ok: false; reason: 'empty' | 'too_long'; length: number }

/** Trim and check a draft. Length counts characters (code points), like Postgres `char_length`. */
export function validateBody(raw: string): BodyCheck {
  const body = raw.replace(EDGE_SPACE, '')
  const length = Array.from(body).length
  if (length === 0) return { ok: false, reason: 'empty', length }
  if (length > CHAT_BODY_MAX) return { ok: false, reason: 'too_long', length }
  return { ok: true, body }
}

const messageKey = (senderId: string, clientId: string) => `${senderId}:${clientId}`

function byTimeThenId(a: { created_at: string; id: string }, b: { created_at: string; id: string }) {
  const diff = Date.parse(a.created_at) - Date.parse(b.created_at)
  return diff !== 0 ? diff : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Add `incoming` rows to `existing`, once each (by id), oldest first. */
export function mergeServerRows(existing: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  if (!incoming.length) return existing as ChatMessage[]
  const byId = new Map(existing.map((row) => [row.id, row]))
  let changed = false
  for (const row of incoming) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row)
      changed = true
    }
  }
  return changed ? [...byId.values()].sort(byTimeThenId) : existing as ChatMessage[]
}

/**
 * What to show: every server row, then this device's pending sends that the
 * server does not have yet (matched by sender + client_id), in the order typed.
 */
export function mergeWithPending(server: readonly ChatMessage[], pending: readonly PendingMessage[]): DisplayMessage[] {
  const delivered = new Set(server.map((row) => messageKey(row.sender_id, row.client_id)))
  const shown: DisplayMessage[] = server.map((row) => ({
    key: messageKey(row.sender_id, row.client_id), id: row.id, senderId: row.sender_id, body: row.body,
    clientId: row.client_id, createdAt: row.created_at, status: 'sent',
    replyTo: row.reply_to, mentions: row.mentions, mentionsEveryone: row.mentions_everyone,
  }))
  const waiting = pending.filter((item) => !delivered.has(messageKey(item.senderId, item.clientId)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  for (const item of waiting) {
    shown.push({
      key: messageKey(item.senderId, item.clientId), id: null, senderId: item.senderId, body: item.body,
      clientId: item.clientId, createdAt: item.createdAt, status: item.status, failure: item.failure,
      replyTo: item.replyTo, mentions: item.mentions, mentionsEveryone: item.mentionsEveryone,
    })
  }
  return shown
}

/** Pending sends the server now has are done; drop them. */
export function settledPending(server: readonly ChatMessage[], pending: readonly PendingMessage[]): PendingMessage[] {
  const delivered = new Set(server.map((row) => messageKey(row.sender_id, row.client_id)))
  const left = pending.filter((item) => !delivered.has(messageKey(item.senderId, item.clientId)))
  return left.length === pending.length ? pending as PendingMessage[] : left
}

// ─── Timestamps and runs ───────────────────────────────────────────────

function previousDay(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10)
}

/** "Today", "Yesterday", "Sun 15 Nov", or "Sun 15 Nov 2025" in an earlier year, in the Trip's timezone. */
export function dayLabel(iso: string, timeZone: string, nowMs: number): string {
  const key = dayKey(iso, timeZone)
  const today = dayKey(new Date(nowMs).toISOString(), timeZone)
  if (key === today) return 'Today'
  if (key === previousDay(today)) return 'Yesterday'
  const label = formatDay(iso, timeZone)
  return key.slice(0, 4) === today.slice(0, 4) ? label : `${label} ${key.slice(0, 4)}`
}

export interface MessageGroup {
  kind: 'group'
  /** The first message's key: stable while later messages join the run. */
  key: string
  senderId: string
  mine: boolean
  messages: DisplayMessage[]
}

/** iMessage-style centred timestamp: "Today 9:41" → { day: 'Today', time: '09:41' }. */
export interface TimeSeparator {
  kind: 'time'
  key: string
  day: string
  time: string
}

/** "Unread messages": above the first message from others that arrived after the person last read. */
export interface UnreadDivider {
  kind: 'unread'
  key: 'unread'
}

export type TimelineItem = TimeSeparator | MessageGroup | UnreadDivider

/** A timestamp separator goes above a message more than this after the one before it (and at every new day). */
export const SEPARATOR_GAP_MS = 15 * 60 * 1000

/**
 * Split messages (oldest first) into timestamp separators and runs. A
 * separator starts the list, every new Trip-time day, and any gap over 15
 * minutes. A run is consecutive messages from one person, each within 5
 * minutes of the one before, with no separator between them.
 */
export function buildTimeline(messages: readonly DisplayMessage[], { timeZone, nowMs, me, unreadKey = null }: {
  timeZone: string
  nowMs: number
  me: string
  /** The message the unread divider goes above (it also starts a new run). */
  unreadKey?: string | null
}): TimelineItem[] {
  const items: TimelineItem[] = []
  let day = ''
  let group: MessageGroup | null = null
  let lastMs = Number.NEGATIVE_INFINITY
  for (const message of messages) {
    const ms = Date.parse(message.createdAt)
    const thisDay = dayKey(message.createdAt, timeZone)
    if (thisDay !== day || ms - lastMs > SEPARATOR_GAP_MS) {
      day = thisDay
      items.push({ kind: 'time', key: `time:${message.key}`, day: dayLabel(message.createdAt, timeZone, nowMs), time: formatTime(message.createdAt, timeZone) })
      group = null
    }
    if (message.key === unreadKey) {
      items.push({ kind: 'unread', key: 'unread' })
      group = null
    }
    if (group && group.senderId === message.senderId && ms - lastMs <= GROUP_GAP_MS) {
      group.messages.push(message)
    } else {
      group = { kind: 'group', key: message.key, senderId: message.senderId, mine: message.senderId === me, messages: [message] }
      items.push(group)
    }
    lastMs = ms
  }
  return items
}

/**
 * The status line under my most recent message, iMessage-style: "Delivered"
 * once the server has it, "Sending…" while in flight, nothing otherwise
 * (a failed message carries its own "Not delivered" line).
 */
export function latestStatus(messages: readonly DisplayMessage[], me: string): { key: string; text: 'Delivered' | 'Sending…' } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.senderId !== me) continue
    if (message.status === 'sent') return { key: message.key, text: 'Delivered' }
    if (message.status === 'sending') return { key: message.key, text: 'Sending…' }
    return null
  }
  return null
}

// ─── Links ──────────────────────────────────────────────────────────

export type TextSegment = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string }

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/giu
/** Punctuation that usually ends the sentence rather than the link. */
const TRAILING = /[.,;:!?'"’”)\]}>]$/u
const count = (text: string, char: string) => text.split(char).length - 1

/** Split text into plain runs and http(s)/www links. Nothing else is formatted. */
export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let cursor = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    let raw = match[0]
    const start = match.index ?? 0
    // Drop sentence punctuation one character at a time, but keep a closing
    // bracket that belongs to the URL, e.g. Wikipedia's "Foo_(bar)".
    while (TRAILING.test(raw)) {
      const last = raw.slice(-1)
      if (last === ')' && count(raw, '(') >= count(raw, ')')) break
      raw = raw.slice(0, -1)
    }
    if (!/[a-z0-9]/iu.test(raw.replace(/^(?:https?:\/\/|www\.)/iu, ''))) continue
    if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) })
    const href = /^https?:\/\//iu.test(raw) ? raw : `https://${raw}`
    segments.push({ kind: 'link', text: raw, href })
    cursor = start + raw.length
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}

/** Within `slack` px of the bottom counts as "at the newest message". */
export function isNearBottom({ scrollTop, scrollHeight, clientHeight }: { scrollTop: number; scrollHeight: number; clientHeight: number },
  slack = 48): boolean {
  return scrollHeight - scrollTop - clientHeight <= slack
}
