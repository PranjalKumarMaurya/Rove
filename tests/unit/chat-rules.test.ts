import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTimeline, CHAT_BODY_MAX, dayLabel, isNearBottom, latestStatus, linkify, mergeServerRows, mergeWithPending, settledPending, validateBody,
  type ChatMessage, type DisplayMessage, type MessageGroup, type PendingMessage,
} from '../../src/features/chat/chatRules.ts'

const tz = 'Asia/Kolkata'
const [me, ana, ben] = ['m-me', 'm-ana', 'm-ben']

function row(id: string, sender: string, createdAt: string, body = id, clientId = `c-${id}`): ChatMessage {
  return { id, group_id: 'g', sender_id: sender, body, client_id: clientId, created_at: createdAt }
}
const shown = (rows: ChatMessage[]): DisplayMessage[] => mergeWithPending(rows, [])

test('a body is trimmed and must be 1-2000 characters', () => {
  assert.deepEqual(validateBody('  hi there \n'), { ok: true, body: 'hi there' })
  assert.deepEqual(validateBody('line one\n\nline two'), { ok: true, body: 'line one\n\nline two' }, 'inner newlines kept')
  assert.equal(validateBody('').ok, false)
  assert.deepEqual(validateBody(' \n\t\u00a0\u3000 '), { ok: false, reason: 'empty', length: 0 })
  assert.equal(validateBody('x'.repeat(CHAT_BODY_MAX)).ok, true)
  assert.deepEqual(validateBody('x'.repeat(CHAT_BODY_MAX + 1)), { ok: false, reason: 'too_long', length: 2001 })
  // Characters, not UTF-16 units: 2000 emoji fit, as in Postgres char_length.
  assert.equal(validateBody('🌴'.repeat(CHAT_BODY_MAX)).ok, true)
  assert.equal(validateBody(`  ${'a'.repeat(CHAT_BODY_MAX)}  `).ok, true, 'surrounding space does not count')
})

test('server rows merge once each by id, oldest first', () => {
  const a = row('a', ana, '2026-11-27T10:00:00Z')
  const b = row('b', ben, '2026-11-27T10:01:00Z')
  const c = row('c', ana, '2026-11-27T10:01:00Z')
  const merged = mergeServerRows([b], [c, a, b])
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c'], 'time, then id for ties')
  const same = [a, b]
  assert.equal(mergeServerRows(same, [a]), same, 'nothing new keeps the same array (no re-render)')
})

test('optimistic sends show after server rows until the server has them, matched by client_id', () => {
  const server = [row('a', ana, '2026-11-27T10:00:00Z')]
  const pending: PendingMessage[] = [
    { clientId: 'p2', senderId: me, body: 'second', createdAt: '2026-11-27T10:05:01Z', status: 'failed' },
    { clientId: 'p1', senderId: me, body: 'first', createdAt: '2026-11-27T10:05:00Z', status: 'sending' },
  ]
  const before = mergeWithPending(server, pending)
  assert.deepEqual(before.map((m) => [m.body, m.status]), [['a', 'sent'], ['first', 'sending'], ['second', 'failed']])
  const pendingKey = before[1].key

  // The server echoes p1 (by Realtime or the insert's reply): one copy, same key, now sent.
  const echoed = [...server, row('srv-1', me, '2026-11-27T10:05:02Z', 'first', 'p1')]
  const after = mergeWithPending(echoed, pending)
  assert.deepEqual(after.map((m) => [m.body, m.status]), [['a', 'sent'], ['first', 'sent'], ['second', 'failed']])
  assert.equal(after[1].key, pendingKey, 'the bubble keeps its key, so it does not remount or re-animate')
  assert.deepEqual(settledPending(echoed, pending).map((p) => p.clientId), ['p2'])
  assert.equal(settledPending(server, pending), pending, 'unchanged when nothing settled')

  // The same client_id from another sender is a different message.
  const other = mergeWithPending([row('x', ana, '2026-11-27T10:06:00Z', 'not mine', 'p2')], pending)
  assert.equal(other.filter((m) => m.clientId === 'p2').length, 2)
})

const label = (item: ReturnType<typeof buildTimeline>[number]) =>
  item.kind === 'time' ? `[${item.day} ${item.time}]` : item.messages.map((m) => m.id).join()

test('runs: consecutive messages from one person within 5 minutes, broken by another sender or a timestamp', () => {
  const now = Date.parse('2026-11-27T12:00:00Z')
  const items = buildTimeline(shown([
    row('1', ana, '2026-11-27T05:00:00Z'), // 10:30 IST
    row('2', ana, '2026-11-27T05:04:00Z'),
    row('3', ana, '2026-11-27T05:09:00Z'), // exactly 5 min after #2: same run
    row('4', ana, '2026-11-27T05:14:01Z'), // 5 min 1 s: new run, no timestamp
    row('5', me, '2026-11-27T05:15:00Z'),
    row('6', ana, '2026-11-27T05:16:00Z'), // someone else spoke in between: new run
  ]), { timeZone: tz, nowMs: now, me })
  assert.deepEqual(items.map(label), ['[Today 10:30]', '1,2,3', '4', '5', '6'])
  const groups = items.filter((item): item is MessageGroup => item.kind === 'group')
  assert.deepEqual(groups.map((g) => g.mine), [false, false, true, false])
  assert.equal(groups[0].key, groups[0].messages[0].key, 'keyed by its first message')
})

test('a timestamp goes above the first message, after gaps over 15 minutes and at each new Trip-time day', () => {
  const now = Date.parse('2026-11-27T12:00:00Z') // Fri 27 Nov, 17:30 IST
  const items = buildTimeline(shown([
    row('old', ben, '2025-12-31T10:00:00Z'),
    row('sun', ana, '2026-11-15T12:50:00Z'), // 18:20 IST
    row('sun2', ana, '2026-11-15T13:05:00Z'), // 15 min later: no timestamp, but a new run (> 5 min)
    row('sun3', ana, '2026-11-15T13:20:01Z'), // 15 min 1 s later: timestamp
    row('late', ana, '2026-11-25T18:28:00Z'), // 23:58 IST, Wed 25 Nov
    row('mid', ana, '2026-11-25T18:31:00Z'), // 00:01 IST Thu 26 Nov: 3 min later but a new day
    row('utc-prev', me, '2026-11-26T20:00:00Z'), // 01:30 IST Fri 27 Nov: "Today" in IST though 26 Nov in UTC
  ]), { timeZone: tz, nowMs: now, me })
  assert.deepEqual(items.map(label), ['[Wed 31 Dec 2025 15:30]', 'old', '[Sun 15 Nov 18:20]', 'sun', 'sun2', '[Sun 15 Nov 18:50]', 'sun3',
    '[Wed 25 Nov 23:58]', 'late', '[Yesterday 00:01]', 'mid', '[Today 01:30]', 'utc-prev'])
})

test('"Delivered" sits under my latest message once saved; "Sending…" while in flight; nothing after a failure', () => {
  const server = [row('a', me, '2026-11-27T10:00:00Z'), row('b', ana, '2026-11-27T10:01:00Z')]
  assert.deepEqual(latestStatus(shown(server), me), { key: shown(server)[0].key, text: 'Delivered' }, 'even if others spoke since')
  const sending = mergeWithPending(server, [{ clientId: 'p', senderId: me, body: 'x', createdAt: '2026-11-27T10:02:00Z', status: 'sending' }])
  assert.deepEqual(latestStatus(sending, me), { key: `${me}:p`, text: 'Sending…' })
  const failed = mergeWithPending(server, [{ clientId: 'p', senderId: me, body: 'x', createdAt: '2026-11-27T10:02:00Z', status: 'failed' }])
  assert.equal(latestStatus(failed, me), null)
  assert.equal(latestStatus(shown([row('c', ana, '2026-11-27T10:00:00Z')]), me), null, 'nothing of mine')
})

test('Today and Yesterday across a month boundary and in another timezone', () => {
  const now = Date.parse('2026-12-01T01:00:00Z')
  assert.equal(dayLabel('2026-11-30T20:00:00Z', 'Asia/Kolkata', now), 'Today', 'already 1 Dec in India')
  assert.equal(dayLabel('2026-11-30T20:00:00Z', 'UTC', now), 'Yesterday')
  assert.equal(dayLabel('2026-11-30T20:00:00Z', 'America/New_York', now), 'Today', 'still 30 Nov in New York')
  assert.equal(dayLabel('2026-11-29T12:00:00Z', 'America/New_York', now), 'Yesterday')
  assert.equal(dayLabel('2026-11-28T12:00:00Z', 'UTC', now), 'Sat 28 Nov')
})

test('links: http(s) and www become links; trailing punctuation stays text; nothing else is formatted', () => {
  assert.deepEqual(linkify('no links, *no bold*'), [{ kind: 'text', text: 'no links, *no bold*' }])
  assert.deepEqual(linkify('Villa: https://maps.app.goo.gl/abc123.'), [
    { kind: 'text', text: 'Villa: ' },
    { kind: 'link', text: 'https://maps.app.goo.gl/abc123', href: 'https://maps.app.goo.gl/abc123' },
    { kind: 'text', text: '.' },
  ])
  assert.deepEqual(linkify('(see www.airbnb.com/rooms/42)'), [
    { kind: 'text', text: '(see ' },
    { kind: 'link', text: 'www.airbnb.com/rooms/42', href: 'https://www.airbnb.com/rooms/42' },
    { kind: 'text', text: ')' },
  ])
  assert.deepEqual(linkify('https://en.wikipedia.org/wiki/Bali_(province)!'), [
    { kind: 'link', text: 'https://en.wikipedia.org/wiki/Bali_(province)', href: 'https://en.wikipedia.org/wiki/Bali_(province)' },
    { kind: 'text', text: '!' },
  ])
  assert.deepEqual(linkify('a http://x.io b HTTPS://Y.IO/q?a=1&b=2'), [
    { kind: 'text', text: 'a ' }, { kind: 'link', text: 'http://x.io', href: 'http://x.io' },
    { kind: 'text', text: ' b ' }, { kind: 'link', text: 'HTTPS://Y.IO/q?a=1&b=2', href: 'HTTPS://Y.IO/q?a=1&b=2' },
  ])
  assert.deepEqual(linkify('javascript:alert(1) and ftp://x'), [{ kind: 'text', text: 'javascript:alert(1) and ftp://x' }], 'only http(s)')
  assert.deepEqual(linkify('https://...'), [{ kind: 'text', text: 'https://...' }], 'no host, no link')
})

test('near the bottom means within 48px', () => {
  assert.equal(isNearBottom({ scrollTop: 552, scrollHeight: 1000, clientHeight: 400 }), true)
  assert.equal(isNearBottom({ scrollTop: 551, scrollHeight: 1000, clientHeight: 400 }), false)
  assert.equal(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 }), true, 'short list')
})
