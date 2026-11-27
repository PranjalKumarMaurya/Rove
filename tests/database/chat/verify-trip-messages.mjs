// Migration 095, checked as real users through RLS: the active Members of a Trip
// can post and read that Trip's chat; nobody else can, nobody can post as
// someone else, bodies are 1-2000 characters after trimming, a retried send
// (same client_id) never doubles, leaving the Trip ends access, and messages
// can be neither edited nor deleted.
import assert from 'node:assert/strict'
import { createLocalStack } from '../../support/local-stack.mjs'
import { createTrip, createUsers, quote, sqlAs } from '../../support/db-fixtures.mjs'

const stack = createLocalStack({ projectId: 'trip-chat-db', basePort: 59250 })
const tripA = 'e9500000-0000-4000-8000-00000000000a'
const tripB = 'e9500000-0000-4000-8000-00000000000b'

function ok(result, label) {
  assert.equal(result.ok, true, `${label}: ${result.error ?? ''}`)
  return result.rows
}
function refused(result, label) {
  assert.equal(result.ok, false, `${label}: expected a refusal`)
  return result.error
}

try {
  stack.start()
  stack.migrate()
  const user = createUsers(stack, ['ana', 'ben', 'cam', 'stranger'])
  const a = createTrip(stack, { groupId: tripA, name: 'Bali', members: { [user.ana]: 'owner', [user.ben]: 'member', [user.cam]: 'member' } })
  const b = createTrip(stack, { groupId: tripB, name: 'Goa', members: { [user.stranger]: 'owner' } })
  const m = { ana: a.memberIds[user.ana], ben: a.memberIds[user.ben], cam: a.memberIds[user.cam], stranger: b.memberIds[user.stranger] }

  const send = (who, { group = tripA, sender, body, clientId = crypto.randomUUID() }) => sqlAs(stack, who,
    `INSERT INTO public.trip_messages (group_id, sender_id, body, client_id)
     VALUES (${quote(group)}, ${quote(sender)}, ${quote(body)}, ${quote(clientId)}) RETURNING id;`)
  const bodies = (who, group = tripA) => ok(sqlAs(stack, who,
    `SELECT body FROM public.trip_messages WHERE group_id = ${quote(group)} ORDER BY created_at, id;`), 'read messages').map((row) => row[0])
  const total = () => Number(stack.psql('SELECT count(*) FROM public.trip_messages;'))

  // 1. Members send and read their Trip's messages (insert ... returning, as the app does).
  const first = ok(send(user.ana, { sender: m.ana, body: 'Landed! Cab queue is huge' }), 'ana sends')[0][0]
  ok(send(user.ben, { sender: m.ben, body: 'See you at the villa' }), 'ben sends')
  for (const who of [user.ana, user.ben, user.cam]) {
    assert.deepEqual(bodies(who), ['Landed! Cab queue is huge', 'See you at the villa'], 'every member reads the chat')
  }
  ok(send(user.stranger, { group: tripB, sender: m.stranger, body: 'Goa only' }), 'stranger posts in own Trip')

  // 2. People in other Trips can't read or post; signed-out callers have no access at all.
  assert.deepEqual(bodies(user.stranger), [], 'outsider reads nothing of A')
  assert.deepEqual(bodies(user.ana, tripB), [], 'members of A read nothing of B')
  refused(send(user.stranger, { sender: m.stranger, body: 'let me in' }), 'outsider posts into A as self')
  refused(send(user.stranger, { sender: m.ana, body: 'let me in' }), 'outsider posts into A as a member')
  refused(send(user.ana, { group: tripB, sender: m.stranger, body: 'hi Goa' }), 'member posts into B')
  assert.match(refused(sqlAs(stack, null, 'SELECT count(*) FROM public.trip_messages;'), 'anon read'), /permission denied/u)
  assert.match(refused(send(null, { sender: m.ana, body: 'anon' }), 'anon post'), /permission denied/u)

  // 3. Nobody can post as another member, nor pick the id or timestamp.
  refused(send(user.ben, { sender: m.ana, body: 'I am Ana' }), 'ben posts as ana')
  refused(send(user.ben, { sender: m.stranger, body: 'cross-trip sender' }), 'sender from another Trip')
  assert.match(refused(sqlAs(stack, user.ben, `INSERT INTO public.trip_messages (group_id, sender_id, body, client_id, created_at)
    VALUES (${quote(tripA)}, ${quote(m.ben)}, 'backdated', ${quote(crypto.randomUUID())}, '2020-01-01');`), 'set created_at'), /permission denied/u)

  // 4. Empty, whitespace-only and over-2000-character bodies are refused; exactly 2000 is fine.
  const before = total()
  for (const [body, label] of [['', 'empty'], ['   ', 'spaces only'], ['  \n\t\r\n ', 'whitespace only'],
    ['\u00a0\u3000', 'non-breaking spaces only'], ['x'.repeat(2001), '2001 chars'],
    [`  ${'y'.repeat(2001)}  `, '2001 chars after trimming']]) {
    assert.match(refused(send(user.ana, { sender: m.ana, body }), label), /check constraint/u)
  }
  ok(send(user.ana, { sender: m.ana, body: `  ${'z'.repeat(2000)}\n ` }), '2000 chars after trimming')
  // Characters, not bytes or UTF-16 units: 2000 emoji fit; letters next to the trimmed set (v, f) are kept.
  ok(send(user.ana, { sender: m.ana, body: '🌴'.repeat(2000) }), '2000 emoji')
  ok(send(user.ana, { sender: m.ana, body: 'v' }), 'a lone v is not whitespace')
  assert.equal(total(), before + 3)

  // 5. A retried send (same client_id) is refused, so it never doubles; another sender may reuse the value.
  const clientId = crypto.randomUUID()
  ok(send(user.cam, { sender: m.cam, body: 'Dinner at 8?', clientId }), 'first attempt')
  assert.match(refused(send(user.cam, { sender: m.cam, body: 'Dinner at 8?', clientId }), 'retry'), /duplicate key/u)
  assert.equal(bodies(user.ana).filter((body) => body === 'Dinner at 8?').length, 1, 'one copy only')
  ok(send(user.ben, { sender: m.ben, body: 'Same id, other sender', clientId }), 'unique per sender')

  // 6. Nobody can update or delete, not even the sender or the Owner.
  for (const who of [user.ana, user.ben]) {
    assert.match(refused(sqlAs(stack, who, `UPDATE public.trip_messages SET body = 'edited' WHERE id = ${quote(first)};`), 'update'), /permission denied/u)
    assert.match(refused(sqlAs(stack, who, `DELETE FROM public.trip_messages WHERE id = ${quote(first)};`), 'delete'), /permission denied/u)
  }
  assert.equal(stack.psql(`SELECT body FROM public.trip_messages WHERE id = ${quote(first)};`), 'Landed! Cab queue is huge')

  // 7. A removed member can no longer read or post; the others keep the history, including theirs.
  stack.psql(`UPDATE public.group_members SET status = 'inactive' WHERE id = ${quote(m.cam)};`)
  assert.deepEqual(bodies(user.cam), [], 'removed member reads nothing')
  refused(send(user.cam, { sender: m.cam, body: 'still here?' }), 'removed member posts')
  assert.equal(bodies(user.ana).includes('Dinner at 8?'), true, 'their messages stay for the crew')

  // 8. Realtime is wired: in the publication with full replica identity.
  assert.equal(stack.psql(`SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
    AND schemaname = 'public' AND tablename = 'trip_messages';`), '1')
  assert.equal(stack.psql(`SELECT relreplident FROM pg_class WHERE oid = 'public.trip_messages'::regclass;`), 'f')
  assert.equal(stack.psql(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.trip_messages'::regclass;`), 't')

  stack.stop()
  console.log(JSON.stringify({ membersSendAndRead: 'passed', otherTripsShutOut: 'passed', noImpersonation: 'passed', bodyLength: 'passed',
    retryNeverDoubles: 'passed', noUpdateOrDelete: 'passed', removedMemberShutOut: 'passed', realtime: 'passed', cleanup: 'passed' }))
} catch (error) {
  try { stack.stop() } catch { /* keep the primary failure */ }
  console.error(error instanceof Error && /^[a-z0-9-]+$/u.test(error.message) ? error.message : 'trip-chat-db-verification-failed')
  if (process.env.TRIP_DEBUG === '1') console.error(error)
  process.exitCode = 1
}
