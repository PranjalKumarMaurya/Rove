// Chat push end to end on a local stack, with no real push service: a message
// insert fires the trigger, pg_net calls the `send-chat-push` Edge Function (stub
// mode: it encrypts and signs each push as for real, then records it in
// trip_private.chat_push_log instead of sending), and pg_cron's tick sends the
// collapsed summary once the cool-down has passed. Checks who is notified,
// collapsing, mentions, settings, quiet hours, payloads, the badge, removal of
// gone subscriptions, that reactions never push, and the shared secret.
import assert from 'node:assert/strict'
import { createECDH, randomBytes } from 'node:crypto'
import { generateVapidKeys } from '../../../scripts/generate-vapid.mjs'
import { createLocalStack } from '../../support/local-stack.mjs'
import { createTrip, createUsers, quote, sqlAs } from '../../support/db-fixtures.mjs'

const secret = randomBytes(24).toString('hex')
const vapid = generateVapidKeys()
const COOLDOWN_SECONDS = 10
const stack = createLocalStack({
  projectId: 'trip-chat-push', basePort: 59450, edgeRuntime: true, noVerifyJwt: ['send-chat-push'],
  functionSecrets: {
    CHAT_PUSH_STUB: '1', CHAT_PUSH_SECRET: secret, CHAT_PUSH_COOLDOWN_SECONDS: COOLDOWN_SECONDS,
    VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:test@example.test',
  },
})
const tripA = 'e9800000-0000-4000-8000-00000000000a'
const tripNight = 'e9800000-0000-4000-8000-00000000000b'

/** A fixed-offset zone where it is now between `from` and `to` o'clock (Etc/GMT signs are inverted). */
function zoneWhereHourIs(from, to) {
  const utc = new Date().getUTCHours()
  for (let offset = -11; offset <= 13; offset += 1) {
    const hour = (utc + offset + 24) % 24
    if (hour >= from && hour <= to) return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`
  }
  throw new Error('no-zone')
}

/** What a browser's PushSubscription would hand the app: a P-256 public key and 16 auth bytes. */
function browserKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label, timeoutMs = 45_000) {
  const start = Date.now()
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timeout-${label}`)
    await sleep(500)
  }
}

function ok(result, label) {
  assert.equal(result.ok, true, `${label}: ${result.error ?? ''}`)
  return result.rows
}

try {
  stack.start()
  stack.migrate()
  stack.psql(`SELECT vault.create_secret(${quote(`${stack.internalFunctionsUrl}/send-chat-push`)}, 'chat_push_url');
    SELECT vault.create_secret(${quote(secret)}, 'chat_push_secret');`)
  const user = createUsers(stack, ['ana', 'ben', 'cam', 'dev'])
  const a = createTrip(stack, { groupId: tripA, name: 'Rishikesh', timezone: zoneWhereHourIs(10, 19),
    members: { [user.ana]: 'owner', [user.ben]: 'member', [user.cam]: 'member', [user.dev]: 'member' } })
  const night = createTrip(stack, { groupId: tripNight, name: 'Night owls', timezone: zoneWhereHourIs(1, 4),
    members: { [user.ana]: 'owner', [user.ben]: 'member' } })
  const m = { ana: a.memberIds[user.ana], ben: a.memberIds[user.ben], cam: a.memberIds[user.cam], dev: a.memberIds[user.dev] }
  const n = { ana: night.memberIds[user.ana], ben: night.memberIds[user.ben] }

  // Devices: ben has two, cam one that the push service has dropped, dev none.
  const subscribe = (who, endpoint) => {
    const keys = browserKeys()
    return ok(sqlAs(stack, who, `SELECT public.save_push_subscription(${quote(endpoint)}, ${quote(keys.p256dh)}, ${quote(keys.auth)}, 'Test');`), `subscribe ${endpoint}`)[0][0]
  }
  subscribe(user.ben, 'https://push.example.test/ben-phone')
  subscribe(user.ben, 'https://push.example.test/ben-laptop')
  subscribe(user.cam, 'https://push.example.test/cam/gone')
  subscribe(user.ana, 'https://push.example.test/ana-phone')

  const send = (who, sender, body, { group = tripA, mentions = [], everyone = false } = {}) => ok(sqlAs(stack, who,
    `INSERT INTO public.trip_messages (group_id, sender_id, body, client_id, mentions, mentions_everyone)
     VALUES (${quote(group)}, ${quote(sender)}, ${quote(body)}, ${quote(crypto.randomUUID())},
       ARRAY[${mentions.map((id) => `${quote(id)}::uuid`).join(',')}]::uuid[], ${everyone}) RETURNING id;`), `send ${body}`)[0][0]
  const logs = (member) => stack.psql(`SELECT coalesce(json_agg(json_build_object('kind', kind, 'endpoint', endpoint, 'message_id', message_id, 'payload', payload) ORDER BY id), '[]')
    FROM trip_private.chat_push_log WHERE member_id = ${quote(member)};`)
  const logsOf = (member) => JSON.parse(logs(member))
  const state = (member, group = tripA) => stack.psql(`SELECT pending_count || '|' || (pending_due_at IS NOT NULL) FROM trip_private.chat_push_state
    WHERE group_id = ${quote(group)} AND member_id = ${quote(member)};`)
  const responses = () => stack.psql(`SELECT string_agg(coalesce(status_code::text, 'error:' || coalesce(error_msg, '')), ',') FROM net._http_response;`)
  const callFunction = (headers, body = { flush: true }) => fetch(`${stack.apiUrl}/functions/v1/send-chat-push`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })

  // 0. Only the database may call it: no secret or a wrong one is refused. (This also warms the function up.)
  assert.equal((await callFunction({})).status, 401, 'no secret')
  assert.equal((await callFunction({ 'x-chat-push-secret': 'nope' })).status, 401, 'wrong secret')
  assert.equal((await callFunction({ 'x-chat-push-secret': secret }, { hello: 1 })).status, 400, 'right secret, nonsense body')
  // Joining a Trip counts as having read it, just now; let that pass the "reading right now" window (20 s).
  await sleep(21_000)

  // 1. A message notifies every other member with a device; the payload is the Trip, "Sender: text", the Chat URL and the badge.
  const first = send(user.ana, m.ana, 'Landed! The cab queue is huge, meet at gate 4')
  const benFirst = await until(() => logsOf(m.ben).length >= 2 && logsOf(m.ben), 'first-push')
  assert.deepEqual(benFirst.map((row) => row.endpoint).sort(), ['https://push.example.test/ben-laptop', 'https://push.example.test/ben-phone'], 'both of ben’s devices')
  assert.deepEqual(benFirst[0].payload, {
    title: 'Rishikesh', body: 'ana: Landed! The cab queue is huge, meet at gate 4', tag: `rove-chat-${tripA}`, url: `/#chat=${tripA}`,
    groupId: tripA, messageId: first, kind: 'message', badge: 1,
  })
  assert.equal(benFirst[0].message_id, first)
  assert.deepEqual(logsOf(m.ana), [], 'never the sender')
  assert.deepEqual(logsOf(m.dev), [], 'no device, no push')
  // cam's push service answered 410: that subscription is gone, and nothing was logged as sent.
  await until(() => stack.psql(`SELECT count(*) FROM public.push_subscriptions WHERE endpoint LIKE '%/gone';`) === '0', 'gone-removed')
  assert.deepEqual(logsOf(m.cam), [])
  assert.ok(stack.psql(`SELECT last_used_at IS NOT NULL FROM public.push_subscriptions WHERE endpoint = 'https://push.example.test/ben-phone';`) === 't')

  // 2. A burst is collapsed: inside the cool-down nothing more is sent; then one summary replaces the notification (same tag).
  send(user.ana, m.ana, 'Actually gate 5')
  send(user.cam, m.cam, 'On my way')
  send(user.ana, m.ana, 'Got chai for everyone')
  await until(() => state(m.ben) === '3|true', 'pending-3')
  assert.equal(logsOf(m.ben).length, 2, 'no push inside the cool-down')
  const summary = await until(() => logsOf(m.ben).find((row) => row.kind === 'summary'), 'summary', 90_000)
  assert.equal(summary.payload.title, 'Rishikesh')
  assert.equal(summary.payload.body, '4 new messages · ana: Got chai for everyone')
  assert.equal(summary.payload.tag, `rove-chat-${tripA}`, 'replaces the earlier notification')
  assert.equal(summary.payload.badge, 4)
  await until(() => state(m.ben) === '0|false', 'pending-cleared')

  // 3. Reading catches up: no summary for what you have already read.
  await sleep(COOLDOWN_SECONDS * 1000 + 500)
  ok(sqlAs(stack, user.ben, `SELECT public.mark_chat_read(${quote(tripA)}, now());`), 'ben reads')
  const pushesBefore = logsOf(m.ben).length
  send(user.ana, m.ana, 'ben is reading this live')
  await until(() => state(m.ben) === '1|true', 'deferred-while-reading')
  ok(sqlAs(stack, user.ben, `SELECT public.mark_chat_read(${quote(tripA)}, now());`), 'ben reads it')
  await until(() => state(m.ben) === '0|false', 'cleared-after-reading', 90_000)
  assert.equal(logsOf(m.ben).length, pushesBefore, 'read in the app: no push at all')

  // 4. "Mentions only": ordinary messages are skipped; a mention still arrives, as its own notification.
  ok(sqlAs(stack, user.ben, `INSERT INTO public.trip_notification_prefs (group_id, member_id, level) VALUES (${quote(tripA)}, ${quote(m.ben)}, 'mentions');`), 'ben: mentions only')
  await sleep(COOLDOWN_SECONDS * 1000 + 500)
  send(user.ana, m.ana, 'ordinary chatter')
  const mention = send(user.ana, m.ana, '@ben can you book the rafting?', { mentions: [m.ben] })
  const mentionLog = await until(() => logsOf(m.ben).find((row) => row.message_id === mention), 'mention')
  assert.equal(mentionLog.kind, 'mention')
  assert.equal(mentionLog.payload.tag, `rove-mention-${mention}`)
  assert.equal(mentionLog.payload.body, 'ana: @ben can you book the rafting?')
  assert.equal(logsOf(m.ben).some((row) => row.payload.body.includes('ordinary chatter')), false, 'ordinary message skipped')
  // @everyone reaches everyone with a device, mute or not, even inside the cool-down.
  ok(sqlAs(stack, user.ben, `UPDATE public.trip_notification_prefs SET level = 'all', muted_until = now() + interval '8 hours' WHERE member_id = ${quote(m.ben)};`), 'ben mutes 8 h')
  const everyone = send(user.cam, m.cam, '@everyone bus leaves at 6', { everyone: true })
  await until(() => logsOf(m.ben).some((row) => row.message_id === everyone && row.kind === 'mention'), 'everyone-ben')
  await until(() => logsOf(m.ana).some((row) => row.message_id === everyone && row.kind === 'mention'), 'everyone-ana')
  // "Off" means off, mentions too.
  ok(sqlAs(stack, user.ben, `UPDATE public.trip_notification_prefs SET level = 'none', muted_until = NULL WHERE member_id = ${quote(m.ben)};`), 'ben: off')
  const handled = () => Number(stack.psql('SELECT count(*) FROM net._http_response;'))
  const handledBefore = handled()
  const ignored = send(user.ana, m.ana, '@ben are you there?', { mentions: [m.ben] })
  await until(() => handled() > handledBefore, 'ignored-processed')
  assert.equal(logsOf(m.ben).some((row) => row.message_id === ignored), false, 'level none: nothing')

  // 5. Quiet hours (it is night in this Trip's timezone): ordinary messages wait, mentions do not.
  const quiet = send(user.ana, n.ana, 'everyone asleep?', { group: tripNight })
  const nightMention = send(user.ana, n.ana, '@ben you up?', { group: tripNight, mentions: [n.ben] })
  await until(() => logsOf(n.ben).some((row) => row.message_id === nightMention), 'night-mention')
  assert.equal(logsOf(n.ben).some((row) => row.message_id === quiet), false, 'quiet hours hold ordinary messages')

  // 6. Reactions never push (no trigger; nothing is even queued).
  const queued = stack.psql('SELECT count(*) FROM net._http_response;')
  ok(sqlAs(stack, user.ben, `INSERT INTO public.trip_message_reactions (group_id, message_id, member_id, emoji)
    VALUES (${quote(tripA)}, ${quote(first)}, ${quote(m.ben)}, '❤️');`), 'ben reacts')
  await sleep(1500)
  assert.equal(stack.psql('SELECT count(*) FROM net._http_response;'), queued, 'a reaction calls nothing')

  // Every call pg_net made succeeded.
  assert.match(responses(), /^200(,200)*$/u, `function responses: ${responses()}`)

  stack.stop()
  console.log(JSON.stringify({ secretChecked: 'passed', payload: 'passed', goneRemoved: 'passed', burstCollapsed: 'passed', summaryByCron: 'passed',
    readSkipsPush: 'passed', mentionsOnly: 'passed', everyoneBreaksMute: 'passed', levelNone: 'passed', quietHours: 'passed', reactionsSilent: 'passed', cleanup: 'passed' }))
} catch (error) {
  try { stack.stop() } catch { /* keep the primary failure */ }
  console.error(error instanceof Error && /^[a-z0-9-]+$/u.test(error.message) ? error.message : 'trip-chat-push-verification-failed')
  if (process.env.TRIP_DEBUG === '1') console.error(error)
  process.exitCode = 1
}
