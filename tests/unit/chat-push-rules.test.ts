import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_RULES, type DueSummary, type MessageContext, type Recipient,
  decideMessage, decideSummary, deliveryOptions, isQuietHours, localHour, messagePayload, previewText, readDueSummaries, readMessageContext,
} from '../../supabase/functions/send-chat-push/rules.ts'

const groupId = 'e9800000-0000-4000-8000-00000000000a'
const messageId = 'f0000000-0000-4000-8000-000000000001'
const ana = 'c0000000-0000-4000-8000-00000000000a'
const ben = 'c0000000-0000-4000-8000-00000000000b'
// 12:00 UTC = 17:30 in Kolkata: daytime.
const noon = Date.parse('2026-11-27T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

const device = { id: 's1', endpoint: 'https://push.example.test/ben', p256dh: 'k', auth: 'a' }
const recipient = (overrides: Partial<Recipient> = {}): Recipient => ({
  memberId: ben, level: 'all', mutedUntil: null, lastReadAt: iso(noon - 3600_000), lastSentAt: null, pendingCount: 0, pendingDueAt: null,
  unreadTrip: 1, unreadTotal: 3, subscriptions: [device], ...overrides,
})
const context = (overrides: Partial<MessageContext['message']> = {}, timezone = 'Asia/Kolkata'): MessageContext => ({
  trip: { groupId, name: 'Rishikesh', timezone },
  message: { id: messageId, groupId, senderId: ana, senderName: 'Asha', body: 'Rafting at 9 tomorrow', mentions: [], mentionsEveryone: false, createdAt: iso(noon), ...overrides },
  recipients: [],
})

test('an ordinary message: Trip as title, "Sender: text", the Chat URL, a tag per Trip and the badge', () => {
  const decision = decideMessage(context(), recipient(), noon)
  assert.equal(decision.action, 'send')
  if (decision.action !== 'send') return
  assert.equal(decision.outcome, 'sent')
  assert.deepEqual(decision.payload, {
    title: 'Rishikesh', body: 'Asha: Rafting at 9 tomorrow', tag: `rove-chat-${groupId}`, url: `/#chat=${groupId}`,
    groupId, messageId, kind: 'message', badge: 3,
  })
})

test('several unread: the push says how many, so a replaced notification never hides the rest', () => {
  const decision = decideMessage(context(), recipient({ unreadTrip: 5 }), noon)
  assert.equal(decision.action === 'send' && decision.payload.body, '5 new messages · Asha: Rafting at 9 tomorrow')
  const many = decideMessage(context(), recipient({ unreadTrip: 100 }), noon)
  assert.equal(many.action === 'send' && many.payload.body.startsWith('99+ new messages · '), true)
})

test('settings: Off skips everything; Mentions only skips ordinary messages; a mute acts like Mentions only until it ends', () => {
  assert.deepEqual(decideMessage(context(), recipient({ level: 'none' }), noon), { action: 'skip', reason: 'level' })
  assert.deepEqual(decideMessage(context({ mentions: [ben] }), recipient({ level: 'none' }), noon), { action: 'skip', reason: 'level' })
  assert.deepEqual(decideMessage(context(), recipient({ level: 'mentions' }), noon), { action: 'skip', reason: 'level' })
  assert.deepEqual(decideMessage(context(), recipient({ mutedUntil: iso(noon + 3600_000) }), noon), { action: 'skip', reason: 'muted' })
  assert.equal(decideMessage(context(), recipient({ mutedUntil: iso(noon - 1) }), noon).action, 'send', 'an ended mute')
})

test('mentions and @everyone break through Mentions only, a mute, quiet hours and the cool-down, as their own notification', () => {
  const night = Date.parse('2026-11-27T19:30:00Z') // 01:00 in Kolkata
  for (const message of [{ mentions: [ben] }, { mentionsEveryone: true }]) {
    const decision = decideMessage(context(message), recipient({ level: 'mentions', mutedUntil: iso(night + 3600_000), lastSentAt: iso(night - 5_000) }), night)
    assert.equal(decision.action, 'send')
    if (decision.action !== 'send') continue
    assert.equal(decision.outcome, 'mention')
    assert.equal(decision.payload.kind, 'mention')
    assert.equal(decision.payload.tag, `rove-mention-${messageId}`)
    assert.equal(decision.payload.body, 'Asha: Rafting at 9 tomorrow', 'a mention never reads as a summary')
  }
  // Someone else's mention is an ordinary message for me.
  assert.equal(decideMessage(context({ mentions: [ana] }), recipient({ level: 'mentions' }), noon).action, 'skip')
})

test('quiet hours (23:00–07:00 in the Trip timezone) hold back ordinary messages', () => {
  const at = (utc: string) => Date.parse(`2026-11-27T${utc}:00Z`)
  // Kolkata is UTC+5:30.
  assert.equal(isQuietHours(at('17:29'), 'Asia/Kolkata'), false, '22:59')
  assert.equal(isQuietHours(at('17:30'), 'Asia/Kolkata'), true, '23:00')
  assert.equal(isQuietHours(at('01:29'), 'Asia/Kolkata'), true, '06:59')
  assert.equal(isQuietHours(at('01:30'), 'Asia/Kolkata'), false, '07:00')
  assert.equal(localHour(at('12:00'), 'Not/AZone'), 12, 'an unknown zone falls back to UTC')
  assert.deepEqual(decideMessage(context(), recipient(), at('19:00')), { action: 'skip', reason: 'quiet' })
  // The same instant is daytime for a Trip in another zone.
  assert.equal(decideMessage(context({}, 'America/New_York'), recipient(), at('19:00')).action, 'send')
})

test('a burst is collapsed: inside the cool-down a message waits for the summary', () => {
  const decision = decideMessage(context(), recipient({ lastSentAt: iso(noon - 20_000), unreadTrip: 2 }), noon)
  assert.deepEqual(decision, { action: 'defer', reason: 'cooldown', dueAt: iso(noon - 20_000 + DEFAULT_RULES.cooldownMs) })
  assert.equal(decideMessage(context(), recipient({ lastSentAt: iso(noon - DEFAULT_RULES.cooldownMs) }), noon).action, 'send', 'cool-down over')
})

test('someone reading the chat right now gets no push; it waits, and is dropped once read', () => {
  const decision = decideMessage(context(), recipient({ lastReadAt: iso(noon - 5_000) }), noon)
  assert.deepEqual(decision, { action: 'defer', reason: 'active', dueAt: iso(noon + DEFAULT_RULES.activeWindowMs) })
  // A mention while reading waits too.
  assert.equal(decideMessage(context({ mentions: [ben] }), recipient({ lastReadAt: iso(noon - 5_000) }), noon).action, 'defer')
  assert.deepEqual(decideMessage(context(), recipient({ unreadTrip: 0 }), noon), { action: 'skip', reason: 'read' })
  assert.deepEqual(decideMessage(context(), recipient({ subscriptions: [] }), noon), { action: 'skip', reason: 'no_device' })
})

const due = (overrides: Partial<Recipient> = {}): DueSummary => ({
  trip: { groupId, name: 'Rishikesh', timezone: 'Asia/Kolkata' },
  recipient: recipient({ unreadTrip: 5, pendingCount: 4, ...overrides }),
  pendingCount: 4,
  latest: { id: messageId, body: 'Got chai for everyone', senderName: 'Asha' },
})

test('a due summary replaces the Trip notification: "Rishikesh · 5 new messages"', () => {
  const decision = decideSummary(due(), noon)
  assert.equal(decision.action, 'send')
  if (decision.action !== 'send') return
  assert.deepEqual(decision.payload, {
    title: 'Rishikesh', body: '5 new messages · Asha: Got chai for everyone', tag: `rove-chat-${groupId}`, url: `/#chat=${groupId}`,
    groupId, messageId, kind: 'summary', badge: 3,
  })
  const one = decideSummary(due({ unreadTrip: 1 }), noon)
  assert.equal(one.action === 'send' && one.payload.body, 'Asha: Got chai for everyone')
})

test('a summary is dropped when read, muted, off, Mentions only, in quiet hours, or while reading', () => {
  assert.deepEqual(decideSummary(due({ unreadTrip: 0 }), noon), { action: 'clear', reason: 'read' })
  assert.deepEqual(decideSummary(due({ level: 'mentions' }), noon), { action: 'clear', reason: 'level' })
  assert.deepEqual(decideSummary(due({ level: 'none' }), noon), { action: 'clear', reason: 'level' })
  assert.deepEqual(decideSummary(due({ mutedUntil: iso(noon + 1000) }), noon), { action: 'clear', reason: 'muted' })
  assert.deepEqual(decideSummary(due(), Date.parse('2026-11-27T20:00:00Z')), { action: 'clear', reason: 'quiet' })
  assert.deepEqual(decideSummary(due({ lastReadAt: iso(noon - 1000) }), noon), { action: 'clear', reason: 'active' })
  assert.deepEqual(decideSummary(due({ subscriptions: [] }), noon), { action: 'clear', reason: 'no_device' })
})

test('bodies are one line and cut with an ellipsis', () => {
  assert.equal(previewText('  Two\nlines\t here ', 140), 'Two lines here')
  const long = previewText('x'.repeat(300), 140)
  assert.equal(Array.from(long).length, 140)
  assert.ok(long.endsWith('…'))
  assert.equal(previewText('🌴'.repeat(200), 10), `${'🌴'.repeat(9)}…`, 'counts characters, never splits an emoji')
  const payload = messagePayload(context().trip, { ...context().message, body: 'y'.repeat(500) }, recipient(), 'message')
  assert.ok(Array.from(payload.body).length <= DEFAULT_RULES.bodyMax)
})

test('delivery: mentions are urgent; ordinary pushes collapse at the push service by Trip (topic of 32 characters)', () => {
  const ordinary = deliveryOptions(messagePayload(context().trip, context().message, recipient(), 'message'))
  assert.deepEqual(ordinary, { ttl: 43200, urgency: 'normal', topic: groupId.replace(/-/gu, '') })
  assert.equal(ordinary.topic?.length, 32)
  assert.deepEqual(deliveryOptions(messagePayload(context().trip, context().message, recipient(), 'mention')), { ttl: 86400, urgency: 'high' })
})

test('reads the database JSON defensively', () => {
  assert.equal(readMessageContext(null), null)
  assert.equal(readMessageContext({ message: {}, trip: {} }), null)
  const parsed = readMessageContext({
    message: { id: messageId, group_id: groupId, sender_id: ana, sender_name: 'Asha', body: 'hi', mentions: [ben, 3], mentions_everyone: true, created_at: iso(noon) },
    trip: { group_id: groupId, name: 'Rishikesh', timezone: 'Asia/Kolkata' },
    recipients: [
      { member_id: ben, level: 'loud', unread_trip: 2, unread_total: -1, subscriptions: [device, { id: 'x', endpoint: 'http://insecure', p256dh: 'k', auth: 'a' }] },
      { level: 'all' },
    ],
  })
  assert.ok(parsed)
  assert.deepEqual(parsed?.message.mentions, [ben])
  assert.equal(parsed?.recipients.length, 1)
  assert.equal(parsed?.recipients[0].level, 'all', 'an unknown level is the default')
  assert.equal(parsed?.recipients[0].unreadTotal, 0)
  assert.deepEqual(parsed?.recipients[0].subscriptions, [device], 'only https endpoints')
  assert.deepEqual(readDueSummaries('nope'), [])
  assert.equal(readDueSummaries([{ trip: { group_id: groupId }, recipient: { member_id: ben }, latest: null }])[0].latest, null)
})
