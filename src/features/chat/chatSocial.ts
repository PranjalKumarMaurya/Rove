// Chat Phase 1 rules (docs/CHAT-PLAN.md 1.1–1.4). Pure, so they run under
// `node --test`: reactions, mentions (picker, resolving and rendering), and where
// the unread divider goes.
import { type DisplayMessage, type TextSegment, linkify } from './chatRules.ts'

// ─── Reactions ─────────────────────────────────────────────────────────

/** The tapbacks, in the order they show (the database allows exactly these). */
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '✅'] as const
export type ReactionEmoji = (typeof REACTIONS)[number]

export const REACTION_NAMES: Record<ReactionEmoji, string> = {
  '👍': 'Thumbs up', '❤️': 'Heart', '😂': 'Laugh', '😮': 'Wow', '😢': 'Sad', '🙏': 'Thanks', '✅': 'Done',
}

export interface Reaction {
  message_id: string
  member_id: string
  emoji: ReactionEmoji
}

export const isReactionEmoji = (value: unknown): value is ReactionEmoji => typeof value === 'string' && (REACTIONS as readonly string[]).includes(value)

export function readReaction(value: unknown): Reaction | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.message_id !== 'string' || typeof row.member_id !== 'string' || !isReactionEmoji(row.emoji)) return null
  return { message_id: row.message_id, member_id: row.member_id, emoji: row.emoji }
}

const reactionKey = (reaction: Reaction) => `${reaction.message_id}:${reaction.member_id}:${reaction.emoji}`

/** Add (`on`) or remove one reaction; returns the same array when nothing changes. */
export function applyReaction(list: readonly Reaction[], reaction: Reaction, on: boolean): Reaction[] {
  const key = reactionKey(reaction)
  const has = list.some((entry) => reactionKey(entry) === key)
  if (has === on) return list as Reaction[]
  return on ? [...list, reaction] : list.filter((entry) => reactionKey(entry) !== key)
}

/** Merge rows read from the server for these messages: they replace what was known about them. */
export function replaceReactions(list: readonly Reaction[], messageIds: readonly string[], rows: readonly Reaction[]): Reaction[] {
  const ids = new Set(messageIds)
  return [...list.filter((entry) => !ids.has(entry.message_id)), ...rows.filter((entry) => ids.has(entry.message_id))]
}

export interface ReactionSummary {
  emoji: ReactionEmoji
  count: number
  mine: boolean
  memberIds: string[]
}

/** One message's reactions, by emoji in tapback order. */
export function summarizeReactions(list: readonly Reaction[], messageId: string, me: string): ReactionSummary[] {
  const byEmoji = new Map<ReactionEmoji, string[]>()
  for (const entry of list) {
    if (entry.message_id !== messageId) continue
    const members = byEmoji.get(entry.emoji) ?? []
    if (!members.includes(entry.member_id)) members.push(entry.member_id)
    byEmoji.set(entry.emoji, members)
  }
  return REACTIONS.filter((emoji) => byEmoji.has(emoji)).map((emoji) => {
    const memberIds = byEmoji.get(emoji) ?? []
    return { emoji, count: memberIds.length, mine: memberIds.includes(me), memberIds }
  })
}

// ─── Mentions ─────────────────────────────────────────────────────────

export interface MentionMember { id: string; name: string }

/** The word after `@` the caret is in, if the person is typing a mention. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  if (at > 0 && !/\s/u.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  // Names can have spaces ("Asha K"), but not line breaks, and a mention is short.
  if (/[\n\r]/u.test(query) || Array.from(query).length > 30 || /\s{2}/u.test(query)) return null
  return { start: at, query }
}

export const EVERYONE = 'everyone'

export type MentionOption = { kind: 'member'; member: MentionMember } | { kind: 'everyone' }

/** Picker options for a query: members whose name (or a word of it) starts with it, then "everyone". */
export function mentionOptions(query: string, members: readonly MentionMember[], limit = 6): MentionOption[] {
  const q = query.trim().toLocaleLowerCase()
  const matches = members.filter((member) => {
    const name = member.name.toLocaleLowerCase()
    return !q || name.startsWith(q) || name.split(/\s+/u).some((word) => word.startsWith(q))
  }).sort((a, b) => a.name.localeCompare(b.name))
  const options: MentionOption[] = matches.slice(0, limit).map((member) => ({ kind: 'member', member }))
  if (EVERYONE.startsWith(q)) options.push({ kind: 'everyone' })
  return options
}

/** Replace the `@query` being typed with the chosen name and a space; returns the new text and caret. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `
  const after = text.slice(caret).replace(/^\s+/u, '')
  return { text: `${text.slice(0, start)}${insert}${after}`, caret: start + insert.length }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
/** `@Name` as a whole: at the start or after a space, and not followed by more letters or digits. */
const mentionPattern = (name: string) => new RegExp(`(^|\\s)@${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'iu')

/**
 * The mentions a message makes, resolved to member ids: every `@Name` of a
 * Member (longest names first, so "@Asha K" is not also "@Asha"), and `@everyone`.
 */
export function resolveMentions(body: string, members: readonly MentionMember[]): { ids: string[]; everyone: boolean } {
  let rest = body
  const ids: string[] = []
  for (const member of [...members].filter((entry) => entry.name.trim()).sort((a, b) => b.name.length - a.name.length)) {
    const pattern = mentionPattern(member.name.trim())
    if (pattern.test(rest)) {
      if (!ids.includes(member.id)) ids.push(member.id)
      rest = rest.replace(new RegExp(pattern.source, 'giu'), '$1')
    }
  }
  return { ids: ids.sort(), everyone: mentionPattern(EVERYONE).test(rest) }
}

export type MessageSegment = TextSegment | { kind: 'mention'; text: string; me: boolean }

/**
 * Text, links and mention chips. A chip is `@Name` for a Member the message
 * mentions (by their current name) or `@everyone` when it mentions everyone.
 */
export function segmentMessage(body: string, mentioned: readonly MentionMember[], everyone: boolean, me: string): MessageSegment[] {
  const names = mentioned.filter((member) => member.name.trim())
    .map((member) => ({ name: member.name.trim(), me: member.id === me }))
  if (everyone) names.push({ name: EVERYONE, me: true })
  names.sort((a, b) => b.name.length - a.name.length)
  if (!names.length) return linkify(body)
  const alternatives = names.map((entry) => escapeRegExp(entry.name)).join('|')
  const pattern = new RegExp(`(^|\\s)@(${alternatives})(?![\\p{L}\\p{N}_])`, 'giu')
  const out: MessageSegment[] = []
  for (const segment of linkify(body)) {
    if (segment.kind !== 'text') { out.push(segment); continue }
    let cursor = 0
    for (const match of segment.text.matchAll(pattern)) {
      const start = (match.index ?? 0) + match[1].length
      if (start > cursor) out.push({ kind: 'text', text: segment.text.slice(cursor, start) })
      const name = match[2]
      const entry = names.find((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())
      out.push({ kind: 'mention', text: `@${name}`, me: entry?.me ?? false })
      cursor = start + 1 + name.length
    }
    if (cursor < segment.text.length) out.push({ kind: 'text', text: segment.text.slice(cursor) })
  }
  return out
}

export function mentionsMe(message: Pick<DisplayMessage, 'senderId' | 'mentions' | 'mentionsEveryone'>, me: string): boolean {
  return message.senderId !== me && (message.mentionsEveryone || message.mentions.includes(me))
}

// ─── Unread ───────────────────────────────────────────────────────────

/**
 * The first message from someone else after `lastReadAt`: the unread divider goes
 * above it. Null when there is nothing unread (or the read point is unknown).
 */
export function firstUnreadKey(messages: readonly DisplayMessage[], lastReadAt: string | null, me: string): string | null {
  if (!lastReadAt) return null
  const read = Date.parse(lastReadAt)
  if (!Number.isFinite(read)) return null
  const first = messages.find((message) => message.status === 'sent' && message.senderId !== me && Date.parse(message.createdAt) > read)
  return first?.key ?? null
}

/** How far the person has now read: the newest message the server has (theirs or not). */
export function readPoint(messages: readonly DisplayMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].status === 'sent') return messages[index].createdAt
  }
  return null
}

/** "99+" from 100 on (the database stops counting there). */
export const unreadLabel = (count: number) => count >= 100 ? '99+' : String(count)

/** One line for a quoted message: whitespace folded, cut at `max` characters. */
export function quoteText(body: string, max = 120): string {
  const flat = body.replace(/\s+/gu, ' ').trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}
