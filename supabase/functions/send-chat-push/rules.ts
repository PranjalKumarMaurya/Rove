// Who gets a chat push, when, and what it says (docs/CHAT-PLAN.md §4). Pure:
// no Deno, no network, so it runs under `node --test` (tests/unit/chat-push-rules.test.ts).
//
// - Every other active Member with a subscribed device, as their per-Trip setting allows:
//   'all' (default), 'mentions' (only mentions and @everyone), 'none' (nothing).
//   "Mute for 8 hours" acts like 'mentions' until it ends.
// - Mentions and @everyone always notify unless the setting is 'none' (even when muted,
//   in quiet hours, or within the cool-down), each as its own notification.
// - Ordinary messages are collapsed per Trip: one notification tag per Trip, and at most one
//   push per recipient per Trip in any cool-down (60 s). Messages inside the cool-down wait;
//   once it ends a summary ("5 new messages · Asha: …") replaces the earlier notification.
// - Quiet hours (23:00–07:00 in the Trip's timezone) hold ordinary messages back entirely.
// - Someone reading the chat right now (read state moved in the last 20 s) gets no push; if
//   they leave with messages unread, the summary catches them up.
// - Reactions never push (only messages reach this code).

export type NotifyLevel = 'all' | 'mentions' | 'none'
export type PushKind = 'message' | 'mention' | 'summary'

export interface PushRules {
  cooldownMs: number
  activeWindowMs: number
  /** Quiet hours, local hours in the Trip's timezone: from `quietStartHour` to `quietEndHour`. */
  quietStartHour: number
  quietEndHour: number
  /** Notification body length, in characters. */
  bodyMax: number
}

export const DEFAULT_RULES: PushRules = { cooldownMs: 60_000, activeWindowMs: 20_000, quietStartHour: 23, quietEndHour: 7, bodyMax: 140 }

export interface DeviceSubscription { id: string; endpoint: string; p256dh: string; auth: string }

export interface Recipient {
  memberId: string
  level: NotifyLevel
  mutedUntil: string | null
  lastReadAt: string | null
  lastSentAt: string | null
  pendingCount: number
  pendingDueAt: string | null
  /** Unread messages from others in this Trip (capped at 100 by the database). */
  unreadTrip: number
  /** Across all of the person's Trips: the app badge. */
  unreadTotal: number
  subscriptions: DeviceSubscription[]
}

export interface TripInfo { groupId: string; name: string; timezone: string }

export interface MessageInfo {
  id: string
  groupId: string
  senderId: string
  senderName: string
  body: string
  mentions: string[]
  mentionsEveryone: boolean
  createdAt: string
}

export interface MessageContext { message: MessageInfo; trip: TripInfo; recipients: Recipient[] }

export interface DueSummary { trip: TripInfo; recipient: Recipient; pendingCount: number; latest: { id: string; body: string; senderName: string } | null }

/** What the service worker receives (public/sw-push.js). */
export interface PushPayload {
  title: string
  body: string
  /** One per Trip for ordinary messages and summaries (each replaces the last); one per message for mentions. */
  tag: string
  /** Opens the Trip's Chat. */
  url: string
  groupId: string
  messageId: string | null
  kind: PushKind
  /** Unread messages across every Trip, for the Home Screen badge. */
  badge: number
}

export type Decision =
  | { action: 'send'; payload: PushPayload; outcome: 'sent' | 'mention' }
  | { action: 'defer'; dueAt: string; reason: 'cooldown' | 'active' }
  | { action: 'skip'; reason: 'level' | 'muted' | 'quiet' | 'read' | 'no_device' }

export type SummaryDecision =
  | { action: 'send'; payload: PushPayload }
  | { action: 'clear'; reason: 'level' | 'muted' | 'quiet' | 'read' | 'active' | 'no_device' }

// ─── Reading the database's JSON ──────────────────────────────────────

const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const textOrNull = (value: unknown) => typeof value === 'string' ? value : null
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function readLevel(value: unknown): NotifyLevel {
  return value === 'mentions' || value === 'none' ? value : 'all'
}

function readTrip(value: unknown): TripInfo | null {
  const trip = record(value)
  const groupId = text(trip.group_id)
  if (!groupId) return null
  return { groupId, name: text(trip.name, 'Rove') || 'Rove', timezone: text(trip.timezone, 'UTC') || 'UTC' }
}

export function readRecipient(value: unknown): Recipient | null {
  const row = record(value)
  const memberId = text(row.member_id)
  if (!memberId) return null
  const subscriptions = Array.isArray(row.subscriptions) ? row.subscriptions.map(record)
    .filter((sub) => text(sub.id) && /^https:\/\//u.test(text(sub.endpoint)) && text(sub.p256dh) && text(sub.auth))
    .map((sub) => ({ id: text(sub.id), endpoint: text(sub.endpoint), p256dh: text(sub.p256dh), auth: text(sub.auth) })) : []
  return {
    memberId, level: readLevel(row.level), mutedUntil: textOrNull(row.muted_until), lastReadAt: textOrNull(row.last_read_at),
    lastSentAt: textOrNull(row.last_sent_at), pendingCount: count(row.pending_count), pendingDueAt: textOrNull(row.pending_due_at),
    unreadTrip: count(row.unread_trip), unreadTotal: count(row.unread_total), subscriptions,
  }
}

/** `chat_push_message_context`'s result, or null when the message is gone (or its Trip archived). */
export function readMessageContext(value: unknown): MessageContext | null {
  const root = record(value)
  const message = record(root.message)
  const trip = readTrip(root.trip)
  const id = text(message.id)
  if (!trip || !id) return null
  return {
    trip,
    message: {
      id, groupId: text(message.group_id), senderId: text(message.sender_id), senderName: text(message.sender_name, 'Someone') || 'Someone',
      body: text(message.body), mentions: Array.isArray(message.mentions) ? message.mentions.filter((entry): entry is string => typeof entry === 'string') : [],
      mentionsEveryone: message.mentions_everyone === true, createdAt: text(message.created_at),
    },
    recipients: (Array.isArray(root.recipients) ? root.recipients : []).map(readRecipient).filter((entry): entry is Recipient => entry !== null),
  }
}

/** `chat_push_claim_due`'s result. */
export function readDueSummaries(value: unknown): DueSummary[] {
  if (!Array.isArray(value)) return []
  const out: DueSummary[] = []
  for (const raw of value) {
    const row = record(raw)
    const trip = readTrip(row.trip)
    const recipient = readRecipient(row.recipient)
    if (!trip || !recipient) continue
    const latest = record(row.latest)
    out.push({
      trip, recipient, pendingCount: count(row.pending_count),
      latest: text(latest.id) ? { id: text(latest.id), body: text(latest.body), senderName: text(latest.sender_name, 'Someone') || 'Someone' } : null,
    })
  }
  return out
}

// ─── Time ─────────────────────────────────────────────────────────────

/** The hour (0–23) at `ms` in `timeZone` (UTC if the zone is unknown). */
export function localHour(ms: number, timeZone: string): number {
  const read = (zone: string) => {
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date(ms)).find((part) => part.type === 'hour')?.value
    return Number(hour) % 24
  }
  try { return read(timeZone) } catch { return read('UTC') }
}

export function isQuietHours(ms: number, timeZone: string, rules: PushRules = DEFAULT_RULES): boolean {
  const hour = localHour(ms, timeZone)
  const { quietStartHour: start, quietEndHour: end } = rules
  if (start === end) return false
  return start > end ? hour >= start || hour < end : hour >= start && hour < end
}

const at = (iso: string | null) => {
  const ms = iso ? Date.parse(iso) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

// ─── Text ─────────────────────────────────────────────────────────────

/** One line, at most `max` characters (code points), with an ellipsis when cut. */
export function previewText(body: string, max: number): string {
  const flat = body.replace(/\s+/gu, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`
}

const countLabel = (unread: number) => unread >= 100 ? '99+ new messages' : `${unread} new messages`

/** The URL a notification opens: the Trip's Chat (handled by AuthBoundary). */
export const chatUrl = (groupId: string) => `/#chat=${groupId}`
export const tripTag = (groupId: string) => `rove-chat-${groupId}`
export const mentionTag = (messageId: string) => `rove-mention-${messageId}`

export function messagePayload(trip: TripInfo, message: MessageInfo, recipient: Recipient, kind: 'message' | 'mention', rules: PushRules = DEFAULT_RULES): PushPayload {
  const line = `${message.senderName}: ${message.body}`
  // A burst that reached this person before (several unread) reads as a summary, so the
  // replaced notification never hides that there is more than this one message.
  const body = kind === 'message' && recipient.unreadTrip > 1 ? `${countLabel(recipient.unreadTrip)} · ${line}` : line
  return {
    title: trip.name, body: previewText(body, rules.bodyMax), tag: kind === 'mention' ? mentionTag(message.id) : tripTag(trip.groupId),
    url: chatUrl(trip.groupId), groupId: trip.groupId, messageId: message.id, kind, badge: recipient.unreadTotal,
  }
}

export function summaryPayload(summary: DueSummary, rules: PushRules = DEFAULT_RULES): PushPayload {
  const { trip, recipient, latest } = summary
  const unread = recipient.unreadTrip
  const line = latest ? `${latest.senderName}: ${latest.body}` : ''
  const body = unread > 1 || !latest ? [countLabel(unread), line].filter(Boolean).join(' · ') : line
  return {
    title: trip.name, body: previewText(body, rules.bodyMax), tag: tripTag(trip.groupId), url: chatUrl(trip.groupId),
    groupId: trip.groupId, messageId: latest?.id ?? null, kind: unread > 1 ? 'summary' : 'message', badge: recipient.unreadTotal,
  }
}

// ─── Decisions ────────────────────────────────────────────────────────

export function mentionsRecipient(message: MessageInfo, memberId: string): boolean {
  return message.senderId !== memberId && (message.mentionsEveryone || message.mentions.includes(memberId))
}

function readingNow(recipient: Recipient, nowMs: number, rules: PushRules): boolean {
  const read = at(recipient.lastReadAt)
  return read !== null && nowMs - read < rules.activeWindowMs
}

/** What to do for one recipient of one new message. */
export function decideMessage(context: MessageContext, recipient: Recipient, nowMs: number, rules: PushRules = DEFAULT_RULES): Decision {
  const { message, trip } = context
  if (!recipient.subscriptions.length) return { action: 'skip', reason: 'no_device' }
  if (recipient.level === 'none') return { action: 'skip', reason: 'level' }
  const mentioned = mentionsRecipient(message, recipient.memberId)
  const active = readingNow(recipient, nowMs, rules)
  if (mentioned && !active) {
    return { action: 'send', outcome: 'mention', payload: messagePayload(trip, message, recipient, 'mention', rules) }
  }
  if (!mentioned) {
    if (recipient.level === 'mentions') return { action: 'skip', reason: 'level' }
    const muted = at(recipient.mutedUntil)
    if (muted !== null && muted > nowMs) return { action: 'skip', reason: 'muted' }
    if (isQuietHours(nowMs, trip.timezone, rules)) return { action: 'skip', reason: 'quiet' }
  }
  if (recipient.unreadTrip === 0) return { action: 'skip', reason: 'read' }
  const lastSent = at(recipient.lastSentAt)
  const coolUntil = lastSent === null ? nowMs : lastSent + rules.cooldownMs
  if (active) {
    return { action: 'defer', reason: 'active', dueAt: new Date(Math.max(coolUntil, nowMs + rules.activeWindowMs)).toISOString() }
  }
  if (coolUntil > nowMs) return { action: 'defer', reason: 'cooldown', dueAt: new Date(coolUntil).toISOString() }
  return { action: 'send', outcome: 'sent', payload: messagePayload(trip, message, recipient, 'message', rules) }
}

/** A summary whose time has come: send it, or drop it if it is no longer wanted. */
export function decideSummary(summary: DueSummary, nowMs: number, rules: PushRules = DEFAULT_RULES): SummaryDecision {
  const { recipient, trip } = summary
  if (!recipient.subscriptions.length) return { action: 'clear', reason: 'no_device' }
  if (recipient.level !== 'all') return { action: 'clear', reason: 'level' }
  const muted = at(recipient.mutedUntil)
  if (muted !== null && muted > nowMs) return { action: 'clear', reason: 'muted' }
  if (isQuietHours(nowMs, trip.timezone, rules)) return { action: 'clear', reason: 'quiet' }
  if (recipient.unreadTrip === 0 || !summary.latest) return { action: 'clear', reason: 'read' }
  if (readingNow(recipient, nowMs, rules)) return { action: 'clear', reason: 'active' }
  return { action: 'send', payload: summaryPayload(summary, rules) }
}

/** Push service options: mentions are urgent; ordinary messages collapse by Trip at the push service too. */
export function deliveryOptions(payload: PushPayload): { ttl: number; urgency: 'normal' | 'high'; topic?: string } {
  return payload.kind === 'mention'
    ? { ttl: 24 * 3600, urgency: 'high' }
    // Topic: at most 32 URL-safe characters; a Trip id without its dashes is exactly that.
    : { ttl: 12 * 3600, urgency: 'normal', topic: payload.groupId.replace(/-/gu, '').slice(0, 32) }
}
