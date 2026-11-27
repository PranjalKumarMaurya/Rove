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
}

/** A message this device is sending (or failed to send). */
export interface PendingMessage {
  clientId: string
  senderId: string
  body: string
  /** Local clock, only for ordering pending messages among themselves. */
  createdAt: string
  status: 'sending' | 'failed'
}

export type MessageStatus = 'sent' | 'sending' | 'failed'

export interface DisplayMessage {
  /** Stable across pending → sent, so the bubble never remounts. */
  key: string
  id: string | null
  senderId: string
  body: string
  clientId: string
  createdAt: string
  status: MessageStatus
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
  }))
  const waiting = pending.filter((item) => !delivered.has(messageKey(item.senderId, item.clientId)))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  for (const item of waiting) {
    shown.push({
      key: messageKey(item.senderId, item.clientId), id: null, senderId: item.senderId, body: item.body,
      clientId: item.clientId, createdAt: item.createdAt, status: item.status,
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

export type TimelineItem = TimeSeparator | MessageGroup

/** A timestamp separator goes above a message more than this after the one before it (and at every new day). */
export const SEPARATOR_GAP_MS = 15 * 60 * 1000

/**
 * Split messages (oldest first) into timestamp separators and runs. A
 * separator starts the list, every new Trip-time day, and any gap over 15
 * minutes. A run is consecutive messages from one person, each within 5
 * minutes of the one before, with no separator between them.
 */
export function buildTimeline(messages: readonly DisplayMessage[], { timeZone, nowMs, me }: {
  timeZone: string
  nowMs: number
  me: string
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
