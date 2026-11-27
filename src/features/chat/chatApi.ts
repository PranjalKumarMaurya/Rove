import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { LiveStatus } from '../trip/useLiveRefetch'
import {
  CHAT_PAGE_SIZE, NO_EXTRAS, mergeServerRows, readChatMessage, settledPending, type ChatMessage, type PendingMessage, type SendExtras,
} from './chatRules'
import { applyReaction, readReaction, replaceReactions, type Reaction, type ReactionEmoji } from './chatSocial'

const COLUMNS = 'id, group_id, sender_id, body, client_id, created_at, reply_to, mentions, mentions_everyone'
/** Catch-up reads reach this far behind the newest row: a message committed late can carry an earlier timestamp. */
const CATCH_UP_OVERLAP_MS = 60_000
const CATCH_UP_LIMIT = 200
/** Reactions are read for this many messages per request (the ids go in the URL). */
const REACTION_BATCH = 80

export class ChatError extends Error {
  constructor(code = 'trip_chat_failed') { super(code) }
}

export interface ChatPage {
  /** Oldest first, ready to display. */
  rows: ChatMessage[]
  /** Older messages exist beyond this page. */
  hasMore: boolean
}

function readRows(data: unknown[] | null): ChatMessage[] {
  return (data ?? []).map(readChatMessage).filter((row): row is ChatMessage => row !== null)
}

function toPage(data: unknown[] | null): ChatPage {
  const rows = readRows(data)
  const hasMore = rows.length > CHAT_PAGE_SIZE
  return { rows: rows.slice(0, CHAT_PAGE_SIZE).reverse(), hasMore }
}

/** The newest 50 messages of a Trip (read newest first, returned oldest first). */
export async function loadLatestMessages(groupId: string): Promise<ChatPage> {
  const { data, error } = await supabase.from('trip_messages').select(COLUMNS).eq('group_id', groupId)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(CHAT_PAGE_SIZE + 1)
  if (error) throw new ChatError()
  return toPage(data)
}

/** The 50 messages before `before` (strictly older, ties broken by id). */
export async function loadEarlierMessages(groupId: string, before: Pick<ChatMessage, 'id' | 'created_at'>): Promise<ChatPage> {
  const at = `"${before.created_at}"`
  const { data, error } = await supabase.from('trip_messages').select(COLUMNS).eq('group_id', groupId)
    .or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${before.id})`)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(CHAT_PAGE_SIZE + 1)
  if (error) throw new ChatError()
  return toPage(data)
}

/** Everything from shortly before `latest` on, oldest first (merged by id, so overlap is harmless). */
async function loadSince(groupId: string, latest: ChatMessage): Promise<ChatMessage[]> {
  const from = new Date(Date.parse(latest.created_at) - CATCH_UP_OVERLAP_MS).toISOString()
  const { data, error } = await supabase.from('trip_messages').select(COLUMNS).eq('group_id', groupId)
    .gte('created_at', from).order('created_at').order('id').limit(CATCH_UP_LIMIT)
  if (error) throw new ChatError()
  return readRows(data)
}

/** Specific messages (the ones replies quote, when they are older than what is loaded). */
async function loadMessagesById(groupId: string, ids: readonly string[]): Promise<ChatMessage[]> {
  if (!ids.length) return []
  const { data, error } = await supabase.from('trip_messages').select(COLUMNS).eq('group_id', groupId).in('id', [...ids])
  if (error) throw new ChatError()
  return readRows(data)
}

/**
 * Post a message. `clientId` is made once per message and reused on every retry:
 * if an earlier attempt did reach the server (the reply was lost), the unique
 * (sender_id, client_id) refuses the copy and we return the stored row instead.
 * @everyone a second time within the hour is refused as `everyone_rate_limited`.
 */
export async function sendMessage(groupId: string, senderId: string, body: string, clientId: string, extras: SendExtras = NO_EXTRAS): Promise<ChatMessage> {
  const { data, error } = await supabase.from('trip_messages')
    .insert({
      group_id: groupId, sender_id: senderId, body, client_id: clientId,
      reply_to: extras.replyTo, mentions: extras.mentions, mentions_everyone: extras.mentionsEveryone,
    }).select(COLUMNS).single()
  const row = readChatMessage(data)
  if (!error && row) return row
  if (error?.message?.includes('everyone_rate_limited')) throw new ChatError('everyone_rate_limited')
  if (error?.code !== '23505') throw new ChatError()
  const { data: existing, error: readError } = await supabase.from('trip_messages').select(COLUMNS)
    .eq('group_id', groupId).eq('sender_id', senderId).eq('client_id', clientId).maybeSingle()
  const stored = readChatMessage(existing)
  if (readError || !stored) throw new ChatError()
  return stored
}

/** Reactions on these messages. */
async function loadReactions(groupId: string, messageIds: readonly string[]): Promise<Reaction[]> {
  const out: Reaction[] = []
  for (let index = 0; index < messageIds.length; index += REACTION_BATCH) {
    const { data, error } = await supabase.from('trip_message_reactions').select('message_id, member_id, emoji')
      .eq('group_id', groupId).in('message_id', messageIds.slice(index, index + REACTION_BATCH))
    if (error) throw new ChatError()
    for (const row of data ?? []) {
      const reaction = readReaction(row)
      if (reaction) out.push(reaction)
    }
  }
  return out
}

/** Toggle my reaction on; a duplicate (already on, e.g. from another device) is fine. */
async function addReaction(groupId: string, reaction: Reaction): Promise<void> {
  const { error } = await supabase.from('trip_message_reactions')
    .insert({ group_id: groupId, message_id: reaction.message_id, member_id: reaction.member_id, emoji: reaction.emoji })
  if (error && error.code !== '23505') throw new ChatError()
}

async function removeReaction(groupId: string, reaction: Reaction): Promise<void> {
  const { error } = await supabase.from('trip_message_reactions').delete()
    .eq('group_id', groupId).eq('message_id', reaction.message_id).eq('member_id', reaction.member_id).eq('emoji', reaction.emoji)
  if (error) throw new ChatError()
}

/** When I last read this Trip's chat (my own row only; nobody else's is readable). */
export async function loadMyReadPoint(groupId: string, memberId: string): Promise<string | null> {
  const { data, error } = await supabase.from('trip_chat_reads').select('last_read_at')
    .eq('group_id', groupId).eq('member_id', memberId).maybeSingle()
  if (error) throw new ChatError()
  return typeof data?.last_read_at === 'string' ? data.last_read_at : null
}

/** Move my read point forward to `readAt` (the newest message seen); the server never moves it back. */
export async function markChatRead(groupId: string, readAt: string): Promise<void> {
  const { error } = await supabase.rpc('mark_chat_read', { p_group_id: groupId, p_read_at: readAt })
  if (error) throw new ChatError()
}

/**
 * The Trip's chat, live. Loads the newest page, appends rows as Realtime reports
 * them (Realtime only delivers rows the subscriber may SELECT under RLS), and
 * catches up through RLS once subscribed, when the app becomes visible again and
 * every 30 s, in case the socket dropped. Rows are merged by id, never doubled.
 * Reactions for the loaded messages come along the same way; messages that
 * replies quote but that are older than the loaded pages are fetched by id.
 */
export function useTripChat(groupId: string, me: string) {
  const [rows, setRows] = useState<ChatMessage[]>([])
  const [pending, setPending] = useState<PendingMessage[]>([])
  const [reactions, setReactions] = useState<Reaction[]>([])
  const [quoted, setQuoted] = useState<Record<string, ChatMessage>>({})
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [live, setLive] = useState<LiveStatus>('connecting')
  const rowsRef = useRef<ChatMessage[]>([])
  const pendingRef = useRef<PendingMessage[]>([])
  const reactionsRef = useRef<Reaction[]>([])
  const hasMoreRef = useRef(false)
  const mounted = useRef(true)
  const updatePending = useCallback((change: (current: PendingMessage[]) => PendingMessage[]) => {
    const next = change(pendingRef.current)
    if (next === pendingRef.current) return
    pendingRef.current = next
    setPending(next)
  }, [])
  const updateReactions = useCallback((change: (current: Reaction[]) => Reaction[]) => {
    const next = change(reactionsRef.current)
    if (next === reactionsRef.current) return
    reactionsRef.current = next
    setReactions(next)
  }, [])
  const loaded = useRef(false)

  /** Read reactions for these messages and replace what was known about them. */
  const refreshReactions = useCallback(async (ids: readonly string[]) => {
    if (!ids.length) return
    try {
      const fresh = await loadReactions(groupId, ids)
      if (mounted.current) updateReactions((current) => replaceReactions(current, ids, fresh))
    } catch { /* the next catch-up tries again */ }
  }, [groupId, updateReactions])

  const apply = useCallback((incoming: ChatMessage[]) => {
    if (!mounted.current || !incoming.length) return
    const next = mergeServerRows(rowsRef.current, incoming)
    if (next === rowsRef.current) return
    rowsRef.current = next
    setRows(next)
    updatePending((current) => settledPending(next, current))
  }, [updatePending])

  const loadFirst = useCallback(async () => {
    try {
      const page = await loadLatestMessages(groupId)
      if (!mounted.current) return
      loaded.current = true
      setError(false)
      hasMoreRef.current = page.hasMore
      setHasMore(page.hasMore)
      rowsRef.current = mergeServerRows(rowsRef.current, page.rows)
      setRows(rowsRef.current)
      void refreshReactions(page.rows.map((row) => row.id))
    } catch {
      if (mounted.current) setError(true)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [groupId, refreshReactions])

  const catchUp = useCallback(async () => {
    const latest = rowsRef.current[rowsRef.current.length - 1]
    if (!loaded.current || !latest) {
      await loadFirst()
      return
    }
    try {
      apply(await loadSince(groupId, latest))
      // Reactions on the recent messages (where nearly all of them happen).
      void refreshReactions(rowsRef.current.slice(-CHAT_PAGE_SIZE).map((row) => row.id))
    } catch { /* the next nudge or poll tries again */ }
  }, [apply, groupId, loadFirst, refreshReactions])

  useEffect(() => {
    mounted.current = true
    void loadFirst()
    return () => { mounted.current = false }
  }, [loadFirst])

  const catchUpRef = useRef(catchUp)
  useEffect(() => { catchUpRef.current = catchUp }, [catchUp])

  useEffect(() => {
    let active = true
    // A unique topic per mount (see useLiveRefetch): StrictMode mounts twice.
    const channel = supabase.channel(`trip-chat:${groupId}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trip_messages', filter: `group_id=eq.${groupId}` }, (payload) => {
        const row = readChatMessage(payload.new)
        if (active && row && row.group_id === groupId) apply([row])
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trip_message_reactions', filter: `group_id=eq.${groupId}` }, (payload) => {
        const reaction = readReaction(payload.new)
        if (active && reaction && (payload.new as { group_id?: string }).group_id === groupId) updateReactions((current) => applyReaction(current, reaction, true))
      })
      // Realtime cannot filter DELETE events, and under RLS they carry only the key
      // (which includes group_id, migration 097): keep this Trip's.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'trip_message_reactions' }, (payload) => {
        const reaction = readReaction(payload.old)
        if (active && reaction && (payload.old as { group_id?: string }).group_id === groupId) updateReactions((current) => applyReaction(current, reaction, false))
      })
    channel.subscribe((state) => {
      if (!active) return
      if (state === 'SUBSCRIBED') {
        setLive('live')
        void catchUpRef.current()
      } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
        setLive('offline')
      }
    })
    const onVisible = () => { if (document.visibilityState === 'visible') void catchUpRef.current() }
    document.addEventListener('visibilitychange', onVisible)
    const poll = window.setInterval(onVisible, 30_000)
    return () => {
      active = false
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
      void supabase.removeChannel(channel)
    }
  }, [apply, groupId, updateReactions])

  // Messages that replies quote but that are not loaded: fetch them once each.
  const asked = useRef(new Set<string>())
  useEffect(() => {
    const known = new Set(rows.map((row) => row.id))
    const missing = [...new Set(rows.flatMap((row) => row.reply_to ? [row.reply_to] : []))]
      .filter((id) => !known.has(id) && !asked.current.has(id))
    if (!missing.length) return
    for (const id of missing) asked.current.add(id)
    void loadMessagesById(groupId, missing).then((found) => {
      if (!mounted.current || !found.length) return
      setQuoted((current) => ({ ...current, ...Object.fromEntries(found.map((row) => [row.id, row])) }))
    }).catch(() => { for (const id of missing) asked.current.delete(id) })
  }, [groupId, rows])

  /** Prepend the page before the oldest loaded message. Resolves to the rows added. */
  const loadEarlier = useCallback(async (): Promise<ChatMessage[]> => {
    const oldest = rowsRef.current[0]
    if (!oldest || loadingEarlier) return []
    setLoadingEarlier(true)
    try {
      const page = await loadEarlierMessages(groupId, oldest)
      if (!mounted.current) return []
      hasMoreRef.current = page.hasMore
      setHasMore(page.hasMore)
      apply(page.rows)
      void refreshReactions(page.rows.map((row) => row.id))
      return page.rows
    } catch {
      return []
    } finally {
      if (mounted.current) setLoadingEarlier(false)
    }
  }, [apply, groupId, loadingEarlier, refreshReactions])

  const attempt = useCallback(async (item: PendingMessage) => {
    try {
      apply([await sendMessage(groupId, item.senderId, item.body, item.clientId, item)])
    } catch (caught) {
      if (!mounted.current) return
      const failure = caught instanceof ChatError && caught.message === 'everyone_rate_limited' ? 'everyone_limit' as const : undefined
      updatePending((current) => current.map((entry) => entry.clientId === item.clientId ? { ...entry, status: 'failed', failure } : entry))
    }
  }, [apply, groupId, updatePending])

  /** Show the message at once as pending, then post it. `body` must already be validated. */
  const send = useCallback((body: string, extras: SendExtras = NO_EXTRAS) => {
    const item: PendingMessage = { clientId: crypto.randomUUID(), senderId: me, body, createdAt: new Date().toISOString(), status: 'sending', ...extras }
    updatePending((current) => [...current, item])
    void attempt(item)
  }, [attempt, me, updatePending])

  /**
   * Resend a failed message with the same client_id, so it can never post twice.
   * After an @everyone refusal it goes without @everyone (the text stays as typed).
   */
  const retry = useCallback((clientId: string) => {
    const failed = pendingRef.current.find((entry) => entry.clientId === clientId && entry.status === 'failed')
    if (!failed) return
    const item: PendingMessage = {
      ...failed, status: 'sending', failure: undefined,
      mentionsEveryone: failed.failure === 'everyone_limit' ? false : failed.mentionsEveryone,
    }
    updatePending((current) => current.map((entry) => entry.clientId === clientId ? item : entry))
    void attempt(item)
  }, [attempt, updatePending])

  /** Turn my `emoji` on this message on or off: shown at once, undone if the server refuses. */
  const toggleReaction = useCallback((messageId: string, emoji: ReactionEmoji) => {
    const reaction: Reaction = { message_id: messageId, member_id: me, emoji }
    const on = !reactionsRef.current.some((entry) => entry.message_id === messageId && entry.member_id === me && entry.emoji === emoji)
    updateReactions((current) => applyReaction(current, reaction, on))
    void (on ? addReaction(groupId, reaction) : removeReaction(groupId, reaction)).catch(() => {
      if (mounted.current) updateReactions((current) => applyReaction(current, reaction, !on))
    })
  }, [groupId, me, updateReactions])

  /**
   * Make sure a message is loaded (to scroll to what a reply quotes), reading
   * earlier pages up to `maxPages`. Resolves to whether it is now in the list.
   */
  const ensureLoaded = useCallback(async (id: string, maxPages = 6): Promise<boolean> => {
    for (let page = 0; page <= maxPages; page += 1) {
      if (rowsRef.current.some((row) => row.id === id)) return true
      if (!hasMoreRef.current || page === maxPages) return false
      const oldest = rowsRef.current[0]
      if (!oldest) return false
      try {
        const earlier = await loadEarlierMessages(groupId, oldest)
        if (!mounted.current) return false
        hasMoreRef.current = earlier.hasMore
        setHasMore(earlier.hasMore)
        apply(earlier.rows)
        void refreshReactions(earlier.rows.map((row) => row.id))
      } catch {
        return false
      }
    }
    return false
  }, [apply, groupId, refreshReactions])

  return {
    rows, pending, reactions, quoted, hasMore, loading, error, loadingEarlier, live,
    loadEarlier, send, retry, toggleReaction, ensureLoaded, reload: loadFirst,
  }
}
