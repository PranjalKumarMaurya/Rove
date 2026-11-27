import assert from 'node:assert/strict'
import test from 'node:test'

import { type PushSender, type PushStore, type RecordEntry, createPushHandler, sameSecret } from '../../supabase/functions/send-chat-push/handler.ts'

const groupId = 'e9800000-0000-4000-8000-00000000000a'
const messageId = 'f0000000-0000-4000-8000-000000000001'
const noon = Date.parse('2026-11-27T12:00:00Z')
const secret = 'shared-secret'

const sub = (id: string, endpoint: string) => ({ id, endpoint, p256dh: 'key', auth: 'auth' })
const recipient = (memberId: string, overrides: Record<string, unknown> = {}) => ({
  member_id: memberId, level: 'all', muted_until: null, last_read_at: null, last_sent_at: null, pending_count: 0, pending_due_at: null,
  unread_trip: 1, unread_total: 1, subscriptions: [sub(`${memberId}-1`, `https://push.example.test/${memberId}`)], ...overrides,
})

function setup({ recipients = [recipient('ben')], due = [] as unknown[], stub = false, failing = new Set<string>() } = {}) {
  const recorded: RecordEntry[][] = []
  const sent: { endpoint: string; body: string; topic?: string }[] = []
  const store: PushStore = {
    messageContext: async (id) => id === messageId ? {
      message: { id, group_id: groupId, sender_id: 'ana', sender_name: 'Asha', body: 'Rafting at 9', mentions: [], mentions_everyone: false, created_at: new Date(noon).toISOString() },
      trip: { group_id: groupId, name: 'Rishikesh', timezone: 'Asia/Kolkata' },
      recipients,
    } : null,
    claimDue: async () => due,
    record: async (entries) => { recorded.push(entries) },
  }
  const sender: PushSender = {
    stub,
    send: async (subscription, payload, options) => {
      if (subscription.endpoint.endsWith('/gone')) return { ok: false, gone: true, status: 410 }
      if (failing.has(subscription.endpoint)) return { ok: false, gone: false, status: 500 }
      sent.push({ endpoint: subscription.endpoint, body: payload.body, topic: options.topic })
      return { ok: true }
    },
  }
  const lines: string[] = []
  const handle = createPushHandler({ secret, store, sender, ready: true, now: () => noon, log: (line) => lines.push(line) })
  const call = (body: unknown, headers: Record<string, string> = { 'x-chat-push-secret': secret }) =>
    handle(new Request('http://function/send-chat-push', { method: 'POST', headers, body: JSON.stringify(body) }))
  return { recorded, sent, lines, call, handle }
}

test('the shared secret is required and compared exactly', async () => {
  const { call, handle } = setup()
  assert.equal((await call({ message_id: messageId }, {})).status, 401)
  assert.equal((await call({ message_id: messageId }, { 'x-chat-push-secret': 'shared-secreT' })).status, 401)
  assert.equal((await handle(new Request('http://function/send-chat-push'))).status, 405)
  assert.equal(sameSecret('abc', ''), false, 'no secret configured: nothing is accepted')
  assert.equal(sameSecret('abc', 'abc'), true)
  assert.equal(sameSecret('abcd', 'abc'), false)
})

test('not configured (no VAPID keys outside stub mode): 503, nothing read', async () => {
  let read = false
  const handle = createPushHandler({
    secret, ready: false, sender: { stub: false, send: async () => ({ ok: true }) },
    store: { messageContext: async () => { read = true; return null }, claimDue: async () => [], record: async () => {} },
  })
  const response = await handle(new Request('http://f', { method: 'POST', headers: { 'x-chat-push-secret': secret }, body: '{"message_id":"x"}' }))
  assert.equal(response.status, 503)
  assert.equal(read, false)
})

test('a message: sends to each device, records outcomes, removes gone devices, logs no content', async () => {
  const { call, recorded, sent, lines } = setup({ recipients: [
    recipient('ben', { subscriptions: [sub('b1', 'https://push.example.test/ben'), sub('b2', 'https://push.example.test/old/gone')] }),
    recipient('cam', { level: 'none' }),
    recipient('dev', { last_sent_at: new Date(noon - 10_000).toISOString(), unread_trip: 2 }),
    recipient('eve', { subscriptions: [sub('e1', 'https://push.example.test/eve-broken')] }),
  ], failing: new Set(['https://push.example.test/eve-broken']) })
  const response = await call({ message_id: messageId })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { sent: 2, deferred: 1, skipped: 1, cleared: 0, removed: 1, failed: 1 })
  assert.deepEqual(sent, [{ endpoint: 'https://push.example.test/ben', body: 'Asha: Rafting at 9', topic: groupId.replace(/-/gu, '') }])
  const byMember = Object.fromEntries(recorded[0].map((entry) => [entry.member_id, entry]))
  assert.deepEqual({ ...byMember.ben, log: [] }, { group_id: groupId, member_id: 'ben', outcome: 'sent', ok: ['b1'], gone: ['b2'], log: [] })
  assert.equal(byMember.ben.log.length, 0, 'real sends are not logged')
  assert.equal(byMember.cam.outcome, 'none')
  assert.equal(byMember.dev.outcome, 'deferred')
  assert.equal(byMember.dev.due_at, new Date(noon + 50_000).toISOString())
  assert.ok(lines.every((line) => !/Rafting|Asha|push\.example/u.test(line)), 'logs carry outcome codes only')
})

test('stub mode records every would-be push with its payload', async () => {
  const { call, recorded, sent } = setup({ stub: true })
  await call({ message_id: messageId })
  assert.equal(sent.length, 1)
  const [entry] = recorded[0]
  assert.equal(entry.log.length, 1)
  assert.equal(entry.log[0].endpoint, 'https://push.example.test/ben')
  assert.equal(entry.log[0].payload.title, 'Rishikesh')
  assert.equal(entry.log[0].kind, 'message')
})

test('a message that is gone (or a Trip archived) does nothing', async () => {
  const { call, recorded } = setup()
  const response = await call({ message_id: 'f0000000-0000-4000-8000-0000000000ff' })
  assert.deepEqual(await response.json(), { sent: 0, deferred: 0, skipped: 0, cleared: 0, removed: 0, failed: 0 })
  assert.equal(recorded.length, 0)
})

test('flush: due summaries are sent or cleared', async () => {
  const trip = { group_id: groupId, name: 'Rishikesh', timezone: 'Asia/Kolkata' }
  const latest = { id: messageId, body: 'Got chai', sender_name: 'Asha' }
  const { call, recorded, sent } = setup({ due: [
    { trip, recipient: recipient('ben', { unread_trip: 4 }), pending_count: 3, latest },
    { trip, recipient: recipient('cam', { unread_trip: 0 }), pending_count: 1, latest },
  ] })
  const response = await call({ flush: true })
  assert.deepEqual(await response.json(), { sent: 1, deferred: 0, skipped: 0, cleared: 1, removed: 0, failed: 0 })
  assert.deepEqual(sent.map((row) => row.body), ['4 new messages · Asha: Got chai'])
  assert.deepEqual(recorded[0].map((entry) => `${entry.member_id}:${entry.outcome}`).sort(), ['ben:sent', 'cam:cleared'])
})

test('bad requests are refused without touching the database', async () => {
  const { call, recorded } = setup()
  assert.equal((await call({ message_id: 'not-a-uuid' })).status, 400)
  assert.equal((await call({})).status, 400)
  assert.equal(recorded.length, 0)
})
