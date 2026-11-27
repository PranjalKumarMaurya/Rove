// Migration 097, checked as real users through RLS: replies stay inside a Trip,
// mentions name only active Members of it, @everyone works once an hour per
// person, reactions are toggled only by their owner, read state and unread
// counts are private to each person, push subscriptions and notification
// settings are each person's own, and the push plumbing is out of clients' reach.
import assert from 'node:assert/strict'
import { createLocalStack } from '../../support/local-stack.mjs'
import { createTrip, createUsers, quote, sqlAs } from '../../support/db-fixtures.mjs'

const stack = createLocalStack({ projectId: 'trip-chat-social', basePort: 59400 })
const tripA = 'e9700000-0000-4000-8000-00000000000a'
const tripB = 'e9700000-0000-4000-8000-00000000000b'
// Shapes the database checks: a 65-byte P-256 key and 16 auth bytes, base64url.
const p256dh = `B${'A'.repeat(86)}`
const auth = 'A'.repeat(22)

function ok(result, label) {
  assert.equal(result.ok, true, `${label}: ${result.error ?? ''}`)
  return result.rows
}
function refused(result, label) {
  assert.equal(result.ok, false, `${label}: expected a refusal`)
  return result.error
}
const uuidArray = (ids) => `ARRAY[${ids.map((id) => `${quote(id)}::uuid`).join(', ')}]::uuid[]`

try {
  stack.start()
  stack.migrate()
  const user = createUsers(stack, ['ana', 'ben', 'cam', 'dev', 'stranger'])
  const a = createTrip(stack, { groupId: tripA, name: 'Bali', members: { [user.ana]: 'owner', [user.ben]: 'member', [user.cam]: 'member' } })
  const b = createTrip(stack, { groupId: tripB, name: 'Goa', members: { [user.stranger]: 'owner', [user.ana]: 'member' } })
  const m = { ana: a.memberIds[user.ana], ben: a.memberIds[user.ben], cam: a.memberIds[user.cam], stranger: b.memberIds[user.stranger], anaB: b.memberIds[user.ana] }

  const send = (who, { group = tripA, sender, body = 'hi', replyTo = null, mentions = [], everyone = false }) => sqlAs(stack, who,
    `INSERT INTO public.trip_messages (group_id, sender_id, body, client_id, reply_to, mentions, mentions_everyone)
     VALUES (${quote(group)}, ${quote(sender)}, ${quote(body)}, ${quote(crypto.randomUUID())}, ${replyTo ? quote(replyTo) : 'NULL'},
       ${uuidArray(mentions)}, ${everyone}) RETURNING id;`)
  const sent = (who, options, label) => ok(send(who, options), label)[0][0]

  // ─── 1. Replies: same Trip only; deleting the original leaves the reply unquoted ───
  const question = sent(user.ana, { sender: m.ana, body: 'Who has the villa address?' }, 'ana asks')
  const answer = sent(user.ben, { sender: m.ben, body: 'Jalan Petitenget 12', replyTo: question }, 'ben replies')
  assert.equal(ok(sqlAs(stack, user.cam, `SELECT reply_to FROM public.trip_messages WHERE id = ${quote(answer)};`), 'read reply')[0][0], question)
  const goaOnly = sent(user.stranger, { group: tripB, sender: m.stranger, body: 'Goa only' }, 'goa message')
  assert.match(refused(send(user.ben, { sender: m.ben, replyTo: goaOnly }), 'reply across Trips'), /foreign key/u)
  assert.match(refused(send(user.ben, { sender: m.ben, replyTo: crypto.randomUUID() }), 'reply to nothing'), /foreign key/u)
  // Phase 2 columns are the server's: clients cannot set them.
  for (const column of ['kind', 'edited_at', 'deleted_at', 'ref_type', 'ref_id']) {
    const value = column === 'kind' ? "'text'" : column === 'ref_id' ? quote(crypto.randomUUID()) : column === 'ref_type' ? "'expense'" : 'now()'
    assert.match(refused(sqlAs(stack, user.ana, `INSERT INTO public.trip_messages (group_id, sender_id, body, client_id, ${column})
      VALUES (${quote(tripA)}, ${quote(m.ana)}, 'x', ${quote(crypto.randomUUID())}, ${value});`), `set ${column}`), /permission denied/u)
  }
  const doomed = sent(user.cam, { sender: m.cam, body: 'to be removed' }, 'cam sends')
  const replyToDoomed = sent(user.ana, { sender: m.ana, body: 'quoting it', replyTo: doomed }, 'reply to doomed')
  stack.psql(`DELETE FROM public.trip_messages WHERE id = ${quote(doomed)};`)
  assert.equal(stack.psql(`SELECT coalesce(reply_to::text, 'null') || '|' || group_id FROM public.trip_messages WHERE id = ${quote(replyToDoomed)};`), `null|${tripA}`)

  // ─── 2. Mentions: active Members of this Trip, stored sorted and unique ───
  const mention = sent(user.ana, { sender: m.ana, body: '@ben @cam bring sarongs', mentions: [m.cam, m.ben, m.cam] }, 'mention two')
  assert.equal(stack.psql(`SELECT mentions::text FROM public.trip_messages WHERE id = ${quote(mention)};`), `{${[m.ben, m.cam].sort().join(',')}}`)
  assert.match(refused(send(user.ana, { sender: m.ana, mentions: [m.stranger] }), 'mention someone from another Trip'), /mention_not_member/u)
  assert.match(refused(send(user.ana, { sender: m.ana, mentions: [crypto.randomUUID()] }), 'mention a made-up id'), /mention_not_member/u)

  // ─── 3. @everyone: anyone may, once an hour per person per Trip ───
  const everyone = sent(user.ben, { sender: m.ben, body: '@everyone dinner at 8', everyone: true }, 'first @everyone')
  assert.match(refused(send(user.ben, { sender: m.ben, body: '@everyone again', everyone: true }), 'second @everyone within the hour'), /everyone_rate_limited/u)
  ok(send(user.ben, { sender: m.ben, body: 'ordinary messages are fine' }), 'ben keeps chatting')
  ok(send(user.cam, { sender: m.cam, body: '@everyone me too', everyone: true }), 'someone else may')
  ok(send(user.ana, { group: tripB, sender: m.anaB, body: '@everyone Goa', everyone: true }), 'ana in another Trip')
  stack.psql(`UPDATE public.trip_messages SET created_at = now() - interval '61 minutes' WHERE id = ${quote(everyone)};`)
  ok(send(user.ben, { sender: m.ben, body: '@everyone an hour later', everyone: true }), 'after an hour')

  // ─── 4. Reactions ───
  const react = (who, { group = tripA, message = question, member, emoji = '👍' }) => sqlAs(stack, who,
    `INSERT INTO public.trip_message_reactions (group_id, message_id, member_id, emoji)
     VALUES (${quote(group)}, ${quote(message)}, ${quote(member)}, ${quote(emoji)});`)
  const reactions = (who, message = question) => ok(sqlAs(stack, who, `SELECT member_id || ' ' || emoji FROM public.trip_message_reactions
    WHERE message_id = ${quote(message)} ORDER BY member_id, emoji;`), 'read reactions').map((row) => row[0])
  for (const emoji of ['👍', '❤️', '😂', '😮', '😢', '🙏', '✅']) ok(react(user.ben, { member: m.ben, emoji }), `ben reacts ${emoji}`)
  ok(react(user.cam, { member: m.cam, emoji: '❤️' }), 'cam reacts')
  assert.equal(reactions(user.ana).length, 8, 'every member sees every reaction')
  assert.match(refused(react(user.ben, { member: m.ben }), 'same reaction twice'), /duplicate key/u)
  assert.match(refused(react(user.ben, { member: m.ben, emoji: '🔥' }), 'emoji outside the set'), /check constraint/u)
  assert.match(refused(react(user.ben, { member: m.ben, emoji: '❤' }), 'heart without the emoji selector'), /check constraint/u)
  refused(react(user.ben, { member: m.cam }), 'react as someone else')
  refused(react(user.stranger, { member: m.stranger }), 'outsider reacts')
  refused(react(user.ana, { group: tripB, message: question, member: m.anaB }), 'reaction filed under the wrong Trip')
  assert.deepEqual(reactions(user.stranger), [], 'outsiders see no reactions')
  // Toggling off deletes your own row only.
  ok(sqlAs(stack, user.cam, `DELETE FROM public.trip_message_reactions WHERE message_id = ${quote(question)} AND member_id = ${quote(m.ben)};`), 'cam deletes ben’s')
  assert.equal(reactions(user.ana).length, 8, 'nothing of ben’s was removed')
  ok(sqlAs(stack, user.ben, `DELETE FROM public.trip_message_reactions WHERE message_id = ${quote(question)} AND member_id = ${quote(m.ben)} AND emoji = '😂';`), 'ben toggles 😂 off')
  assert.equal(reactions(user.ana).includes(`${m.ben} 😂`), false)
  assert.equal(reactions(user.ana).length, 7)
  assert.match(refused(sqlAs(stack, user.ben, `UPDATE public.trip_message_reactions SET emoji = '🙏' WHERE member_id = ${quote(m.ben)};`), 'update a reaction'), /permission denied/u)
  assert.equal(stack.psql(`SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'trip_message_reactions';`), '1')
  assert.equal(stack.psql(`SELECT relreplident FROM pg_class WHERE oid = 'public.trip_message_reactions'::regclass;`), 'f')

  // ─── 5. Read state and unread counts: private to each person ───
  const counts = (who) => Object.fromEntries(ok(sqlAs(stack, who, 'SELECT group_id, unread FROM public.get_my_unread_counts();'), 'unread counts')
    .map(([group, unread]) => [group, Number(unread)]))
  const markRead = (who, group, at) => sqlAs(stack, who, `SELECT public.mark_chat_read(${quote(group)}, ${at});`)
  // Everyone starts with what existed when they joined read (fixtures joined before any message).
  const total = (group, notFrom) => Number(stack.psql(`SELECT count(*) FROM public.trip_messages WHERE group_id = ${quote(group)} AND sender_id <> ${quote(notFrom)};`))
  assert.equal(counts(user.ben)[tripA], total(tripA, m.ben), 'ben: every message from others is unread')
  const latest = stack.psql(`SELECT max(created_at) FROM public.trip_messages WHERE group_id = ${quote(tripA)};`)
  ok(markRead(user.ben, tripA, `${quote(latest)}::timestamptz`), 'ben reads up to the newest')
  assert.equal(counts(user.ben)[tripA], 0)
  // Marking an older point does not move it back; a future time is clamped to now.
  ok(markRead(user.ben, tripA, "'2020-01-01'::timestamptz"), 'mark an older point')
  assert.equal(counts(user.ben)[tripA], 0, 'read state never moves backwards')
  const clamped = ok(markRead(user.cam, tripA, "now() + interval '10 days'"), 'mark the future')[0][0]
  assert.ok(Date.parse(clamped) <= Date.now() + 60_000, 'clamped to the server clock')
  sent(user.ana, { sender: m.ana, body: 'one more' }, 'ana sends again')
  sent(user.ana, { sender: m.ana, body: 'and another' }, 'and again')
  assert.equal(counts(user.ben)[tripA], 2, 'ben has two new ones')
  assert.equal(counts(user.cam)[tripA], 2, 'cam too')
  assert.equal(counts(user.ana)[tripA] >= 0, true)
  assert.equal(tripA in counts(user.stranger), false, 'outsiders get no count for A')
  assert.equal(counts(user.ana)[tripB], 1, 'ana counts per Trip: stranger’s Goa message')
  // Nobody sees or writes anyone else's read state.
  assert.deepEqual(ok(sqlAs(stack, user.ana, `SELECT member_id FROM public.trip_chat_reads WHERE group_id = ${quote(tripA)};`), 'ana reads reads'), [[m.ana]])
  assert.deepEqual(ok(sqlAs(stack, user.stranger, `SELECT member_id FROM public.trip_chat_reads WHERE group_id = ${quote(tripA)};`), 'outsider reads reads'), [])
  const benRead = stack.psql(`SELECT last_read_at FROM public.trip_chat_reads WHERE member_id = ${quote(m.ben)};`)
  ok(sqlAs(stack, user.ana, `UPDATE public.trip_chat_reads SET last_read_at = now() WHERE member_id = ${quote(m.ben)};`), 'ana updates ben’s read state')
  assert.equal(stack.psql(`SELECT last_read_at FROM public.trip_chat_reads WHERE member_id = ${quote(m.ben)};`), benRead, 'unchanged')
  refused(sqlAs(stack, user.ana, `INSERT INTO public.trip_chat_reads (group_id, member_id, last_read_at) VALUES (${quote(tripA)}, ${quote(m.ben)}, now());`), 'ana writes a row for ben')
  refused(markRead(user.stranger, tripA, 'now()'), 'outsider marks A read')
  // Someone who joins later starts at the moment they join, not with the whole history unread.
  stack.psql(`INSERT INTO public.group_members (group_id, profile_id, role, status)
    SELECT ${quote(tripA)}, id, 'member', 'active' FROM public.profiles WHERE auth_user_id = ${quote(user.dev)};`)
  assert.equal(counts(user.dev)[tripA], 0, 'a new member starts with nothing unread')
  const devMember = stack.psql(`SELECT id FROM public.group_members WHERE group_id = ${quote(tripA)} AND profile_id = (SELECT id FROM public.profiles WHERE auth_user_id = ${quote(user.dev)});`)
  sent(user.ana, { sender: m.ana, body: 'welcome dev' }, 'welcome')
  assert.equal(counts(user.dev)[tripA], 1)
  // Counts stop at 100 ("99+").
  stack.psql(`INSERT INTO public.trip_messages (group_id, sender_id, body, client_id)
    SELECT ${quote(tripA)}, ${quote(m.ana)}, 'flood ' || n, gen_random_uuid() FROM generate_series(1, 120) AS n;`)
  assert.equal(counts(user.dev)[tripA], 100)
  // A removed member gets no count and cannot mark read.
  stack.psql(`UPDATE public.group_members SET status = 'inactive' WHERE id = ${quote(devMember)};`)
  assert.equal(tripA in counts(user.dev), false)
  refused(markRead(user.dev, tripA, 'now()'), 'removed member marks read')

  // ─── 6. Push subscriptions: your own devices only ───
  const save = (who, endpoint, key = p256dh) => sqlAs(stack, who,
    `SELECT public.save_push_subscription(${quote(endpoint)}, ${quote(key)}, ${quote(auth)}, 'Test/1.0');`)
  const endpoints = (who) => ok(sqlAs(stack, who, 'SELECT endpoint FROM public.push_subscriptions ORDER BY endpoint;'), 'read subs').map((row) => row[0])
  ok(save(user.ana, 'https://push.example.test/ana-phone'), 'ana saves her phone')
  ok(save(user.ana, 'https://push.example.test/ana-laptop'), 'and her laptop')
  ok(save(user.ana, 'https://push.example.test/ana-phone'), 'saving again is fine (key refresh)')
  ok(sqlAs(stack, user.ben, `INSERT INTO public.push_subscriptions (profile_id, endpoint, p256dh, auth)
    VALUES ((SELECT id FROM public.profiles WHERE auth_user_id = ${quote(user.ben)}), 'https://push.example.test/ben', ${quote(p256dh)}, ${quote(auth)});`), 'ben inserts his own')
  assert.deepEqual(endpoints(user.ana), ['https://push.example.test/ana-laptop', 'https://push.example.test/ana-phone'])
  assert.deepEqual(endpoints(user.ben), ['https://push.example.test/ben'], 'ben sees only his')
  assert.deepEqual(endpoints(user.stranger), [])
  refused(sqlAs(stack, user.ben, `INSERT INTO public.push_subscriptions (profile_id, endpoint, p256dh, auth)
    VALUES ((SELECT id FROM public.profiles WHERE auth_user_id = ${quote(user.ana)}), 'https://push.example.test/fake', ${quote(p256dh)}, ${quote(auth)});`), 'ben files one for ana')
  ok(sqlAs(stack, user.ben, `DELETE FROM public.push_subscriptions WHERE endpoint LIKE '%ana%';`), 'ben deletes ana’s')
  assert.equal(endpoints(user.ana).length, 2, 'untouched')
  assert.match(refused(save(user.ana, 'http://push.example.test/plain'), 'plain http endpoint'), /invalid_subscription/u)
  assert.match(refused(save(user.ana, 'https://push.example.test/short-key', 'abc'), 'bad key'), /invalid_subscription/u)
  // The same browser, now signed in as ben: the endpoint moves to ben.
  ok(save(user.ben, 'https://push.example.test/ana-laptop'), 'ben signs in on ana’s laptop')
  assert.deepEqual(endpoints(user.ana), ['https://push.example.test/ana-phone'])
  assert.deepEqual(endpoints(user.ben), ['https://push.example.test/ana-laptop', 'https://push.example.test/ben'])
  ok(sqlAs(stack, user.ben, `DELETE FROM public.push_subscriptions WHERE endpoint = 'https://push.example.test/ana-laptop';`), 'ben signs out there')
  assert.deepEqual(endpoints(user.ben), ['https://push.example.test/ben'])
  assert.match(refused(save(null, 'https://push.example.test/anon'), 'anon saves'), /permission denied/u)

  // ─── 7. Notification settings: your own, per Trip ───
  const setLevel = (who, member, level, group = tripA) => sqlAs(stack, who,
    `INSERT INTO public.trip_notification_prefs (group_id, member_id, level, muted_until)
     VALUES (${quote(group)}, ${quote(member)}, ${quote(level)}, NULL)
     ON CONFLICT (group_id, member_id) DO UPDATE SET level = EXCLUDED.level, muted_until = EXCLUDED.muted_until;`)
  ok(setLevel(user.ben, m.ben, 'mentions'), 'ben: mentions only')
  ok(setLevel(user.ben, m.ben, 'none'), 'ben: off')
  ok(sqlAs(stack, user.ben, `UPDATE public.trip_notification_prefs SET muted_until = now() + interval '8 hours' WHERE member_id = ${quote(m.ben)};`), 'ben mutes 8 h')
  assert.match(refused(setLevel(user.ben, m.ben, 'loud'), 'unknown level'), /check constraint/u)
  refused(setLevel(user.ana, m.ben, 'all'), 'ana sets ben’s')
  refused(setLevel(user.stranger, m.stranger, 'all', tripA), 'outsider in A')
  assert.deepEqual(ok(sqlAs(stack, user.ana, 'SELECT member_id FROM public.trip_notification_prefs;'), 'ana reads prefs'), [], 'ben’s settings are his')
  assert.deepEqual(ok(sqlAs(stack, user.ben, 'SELECT level FROM public.trip_notification_prefs;'), 'ben reads prefs'), [['none']])

  // ─── 8. Signed out: nothing at all ───
  for (const table of ['trip_message_reactions', 'trip_chat_reads', 'push_subscriptions', 'trip_notification_prefs']) {
    assert.match(refused(sqlAs(stack, null, `SELECT count(*) FROM public.${table};`), `anon reads ${table}`), /permission denied/u)
  }
  assert.match(refused(sqlAs(stack, null, 'SELECT * FROM public.get_my_unread_counts();'), 'anon counts'), /permission denied/u)

  // ─── 9. The push plumbing is the server's ───
  for (const call of [`public.chat_push_message_context(${quote(question)})`, 'public.chat_push_claim_due(10)', "public.chat_push_record('[]'::jsonb)"]) {
    assert.match(refused(sqlAs(stack, user.ana, `SELECT ${call};`), `client calls ${call}`), /permission denied/u)
  }
  for (const table of ['chat_push_state', 'chat_push_log']) {
    assert.match(refused(sqlAs(stack, user.ana, `SELECT count(*) FROM trip_private.${table};`), `client reads ${table}`), /permission denied/u)
  }
  // With no Vault secrets, a message queues no request (the default on a fresh project).
  const queued = () => Number(stack.psql('SELECT count(*) FROM net.http_request_queue;'))
  const before = queued()
  sent(user.ben, { sender: m.ben, body: 'no push configured' }, 'send without secrets')
  assert.equal(queued(), before)
  assert.equal(stack.psql("SELECT schedule FROM cron.job WHERE jobname = 'rove-chat-push-summaries';"), '20 seconds')

  for (const table of ['trip_message_reactions', 'trip_chat_reads', 'push_subscriptions', 'trip_notification_prefs']) {
    assert.equal(stack.psql(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.${table}'::regclass;`), 't', `${table} forces RLS`)
  }

  stack.stop()
  console.log(JSON.stringify({ replies: 'passed', mentions: 'passed', everyoneRateLimit: 'passed', reactions: 'passed', readStatePrivate: 'passed',
    unreadCounts: 'passed', pushSubscriptions: 'passed', notificationPrefs: 'passed', anonShutOut: 'passed', pushPlumbingServerOnly: 'passed', cleanup: 'passed' }))
} catch (error) {
  try { stack.stop() } catch { /* keep the primary failure */ }
  console.error(error instanceof Error && /^[a-z0-9-]+$/u.test(error.message) ? error.message : 'trip-chat-social-db-verification-failed')
  if (process.env.TRIP_DEBUG === '1') console.error(error)
  process.exitCode = 1
}
