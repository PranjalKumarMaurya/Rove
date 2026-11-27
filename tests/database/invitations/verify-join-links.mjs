// Migration 096, checked as real users: Trip join links ("anyone with the link
// can join"). Only an Owner turns the link on, off or rotates it; any active
// member can read the active proof; anon sees the Trip only while the link is
// active; a stranger with a verified email joins as a member (idempotently); a
// closed, rotated-away, archived or removed case is refused; the tables are not
// reachable directly.
import assert from 'node:assert/strict'
import { createLocalStack } from '../../support/local-stack.mjs'
import { createTrip, createUsers, quote, sqlAs } from '../../support/db-fixtures.mjs'

const stack = createLocalStack({ projectId: 'join-links-db', basePort: 59300 })
const tripA = 'e9600000-0000-4000-8000-00000000000a'
const tripB = 'e9600000-0000-4000-8000-00000000000b'
const unknownProof = 'f'.repeat(64)

function ok(result, label) {
  assert.equal(result.ok, true, `${label}: ${result.error ?? ''}`)
  return result.rows
}
function refused(result, label) {
  assert.equal(result.ok, false, `${label}: expected a refusal`)
  return result.error
}
const value = (result, label) => JSON.parse(ok(result, label)[0][0])

try {
  stack.start()
  stack.migrate()
  const user = createUsers(stack, ['owner', 'ana', 'ben', 'stranger', 'second', 'third', 'unverified', 'outsider'])
  stack.psql(`UPDATE auth.users SET email_confirmed_at = NULL WHERE id = ${quote(user.unverified)};`)
  const a = createTrip(stack, { groupId: tripA, name: 'Bali', members: { [user.owner]: 'owner', [user.ana]: 'member', [user.ben]: 'member' } })
  createTrip(stack, { groupId: tripB, name: 'Goa', members: { [user.outsider]: 'owner' } })

  const getLink = (who, groupId = tripA) => sqlAs(stack, who, `SELECT public.get_trip_join_link(${quote(groupId)})::text;`)
  const setLink = (who, enabled, rotate = false, groupId = tripA) => sqlAs(stack, who,
    `SELECT public.set_trip_join_link(${quote(groupId)}, ${enabled}, ${rotate})::text;`)
  const inspect = (who, proof) => value(sqlAs(stack, who, `SELECT public.inspect_trip_join_link(${quote(proof)})::text;`), 'inspect')
  const join = (who, proof, requestId = crypto.randomUUID()) => sqlAs(stack, who,
    `SELECT public.join_trip_with_link(${quote(proof)}, ${requestId === null ? 'NULL' : quote(requestId)})::text;`)
  const memberStatus = (authUserId, groupId = tripA) => stack.psql(`SELECT member.role || ':' || member.status
    FROM public.group_members AS member JOIN public.profiles AS profile ON profile.id = member.profile_id
    WHERE member.group_id = ${quote(groupId)} AND profile.auth_user_id = ${quote(authUserId)};`)
  const audit = (operation) => Number(stack.psql(`SELECT count(*) FROM public.group_audit_events
    WHERE group_id = ${quote(tripA)} AND details ->> 'operation' = ${quote(operation)};`))
  const storedProofs = () => Number(stack.psql('SELECT count(*) FROM trip_private.trip_join_link_proofs;'))

  // 1. Off by default; only the Owner can turn it on.
  assert.deepEqual(value(getLink(user.ana), 'member reads empty'), { active: false })
  assert.match(refused(setLink(user.ana, true), 'member enables'), /not_authorized/u)
  assert.match(refused(setLink(user.outsider, true), 'outsider enables'), /not_authorized/u)
  assert.match(refused(setLink(null, true), 'anon enables'), /permission denied/u)
  assert.match(refused(setLink(user.owner, false, true), 'rotate while disabling'), /invalid_request/u)
  const enabled = value(setLink(user.owner, true), 'owner enables')
  assert.equal(enabled.outcome, 'enabled')
  assert.equal(enabled.active, true)
  assert.match(enabled.proof, /^[0-9a-f]{64}$/u)
  const proof1 = enabled.proof
  assert.equal(audit('join_link_enabled'), 1)
  assert.deepEqual(value(setLink(user.owner, true), 'owner enables again'), { outcome: 'unchanged', active: true, proof: proof1 })
  assert.equal(audit('join_link_enabled'), 1, 'no-op writes no audit row')
  // The links table holds only the sha256.
  assert.equal(stack.psql(`SELECT count(*) FROM public.trip_join_links WHERE group_id = ${quote(tripA)}
    AND proof_verifier = extensions.digest(${quote(proof1)}, 'sha256') AND revoked_at IS NULL;`), '1')

  // 2. Members (and the Owner) can read the active proof; non-members can't.
  for (const who of [user.owner, user.ana, user.ben]) {
    const link = value(getLink(who), 'member reads link')
    assert.equal(link.active, true)
    assert.equal(link.proof, proof1)
  }
  assert.match(refused(getLink(user.outsider), 'outsider reads'), /not_authorized/u)
  assert.match(refused(getLink(user.stranger), 'stranger reads'), /not_authorized/u)
  assert.match(refused(getLink(null), 'anon reads'), /permission denied/u)

  // 3. Anon sees the Trip only for an active link; unknown proofs are 'closed'.
  assert.deepEqual(inspect(null, proof1),
    { outcome: 'continue', trip_name: 'Bali', destination: 'Goa', start_date: '2026-11-01', end_date: '2026-11-05' })
  assert.deepEqual(inspect(null, unknownProof), { outcome: 'closed' })
  assert.deepEqual(inspect(null, 'not-a-proof'), { outcome: 'closed' })
  assert.equal(inspect(user.stranger, proof1).outcome, 'ready')
  assert.equal(inspect(user.ana, proof1).outcome, 'already_member')
  assert.equal(inspect(user.unverified, proof1).outcome, 'verification_required')

  // 4. A stranger with a verified email joins as a member.
  const joined = value(join(user.stranger, proof1), 'stranger joins')
  assert.equal(joined.outcome, 'joined')
  assert.equal(joined.group_id, tripA)
  assert.equal(memberStatus(user.stranger), 'member:active')
  assert.equal(audit('join_link_joined'), 1)
  // 5. Joining twice is idempotent (same or a new request id).
  const twice = value(join(user.stranger, proof1), 'stranger joins again')
  assert.equal(twice.outcome, 'already_member')
  assert.equal(twice.group_id, tripA)
  assert.equal(audit('join_link_joined'), 1, 'no second audit row')
  assert.equal(inspect(user.stranger, proof1).outcome, 'already_member')
  assert.equal(value(getLink(user.stranger), 'new member reads').proof, proof1)
  // An unverified email is refused; anon can't call join; unknown proofs are closed.
  assert.match(refused(join(user.unverified, proof1), 'unverified joins'), /verification_required/u)
  assert.equal(memberStatus(user.unverified), '')
  assert.match(refused(join(null, proof1), 'anon joins'), /permission denied/u)
  assert.match(refused(join(user.second, unknownProof), 'unknown proof'), /link_closed/u)
  assert.match(refused(join(user.second, 'nope'), 'malformed proof'), /link_closed/u)
  assert.match(refused(join(user.second, proof1, null), 'no request id'), /invalid_request/u)

  // 6. Turning it off: only the Owner; the link becomes 'closed' and joining fails.
  assert.match(refused(setLink(user.ana, false), 'member disables'), /not_authorized/u)
  assert.deepEqual(value(setLink(user.owner, false), 'owner disables'), { outcome: 'disabled', active: false })
  assert.equal(audit('join_link_disabled'), 1)
  assert.equal(storedProofs(), 0, 'a revoked proof is not kept')
  assert.deepEqual(inspect(null, proof1), { outcome: 'closed' }, 'revoked looks the same as unknown')
  assert.deepEqual(inspect(user.second, proof1), { outcome: 'closed' })
  assert.match(refused(join(user.second, proof1), 'join closed link'), /link_closed/u)
  assert.equal(memberStatus(user.second), '')
  assert.deepEqual(value(getLink(user.ana), 'member reads after disable'), { active: false })
  assert.deepEqual(value(setLink(user.owner, false), 'disable again'), { outcome: 'unchanged', active: false })

  // 7. Rotating kills the old proof; the new one works. Members can't rotate.
  const proof2 = value(setLink(user.owner, true), 're-enable').proof
  assert.notEqual(proof2, proof1)
  assert.match(refused(setLink(user.ben, true, true), 'member rotates'), /not_authorized/u)
  const rotated = value(setLink(user.owner, true, true), 'owner rotates')
  assert.equal(rotated.outcome, 'rotated')
  const proof3 = rotated.proof
  assert.notEqual(proof3, proof2)
  assert.equal(audit('join_link_rotated'), 1)
  assert.equal(storedProofs(), 1)
  assert.equal(stack.psql(`SELECT count(*) FROM public.trip_join_links WHERE group_id = ${quote(tripA)} AND revoked_at IS NULL;`), '1')
  assert.deepEqual(inspect(null, proof2), { outcome: 'closed' })
  assert.match(refused(join(user.second, proof2), 'old proof'), /link_closed/u)
  assert.equal(value(getLink(user.ana), 'member reads rotated').proof, proof3)
  assert.equal(value(join(user.second, proof3), 'new proof joins').outcome, 'joined')
  assert.equal(memberStatus(user.second), 'member:active')
  // At most one active link per Trip, even bypassing the RPCs.
  assert.throws(() => stack.psql(`INSERT INTO public.trip_join_links (group_id, proof_verifier, created_by)
    VALUES (${quote(tripA)}, extensions.digest('x', 'sha256'), ${quote(a.memberIds[user.owner])});`), 'second active link')

  // 8. A removed member gets 'removed' and can't rejoin through the link.
  stack.psql(`UPDATE public.group_members SET status = 'inactive' WHERE id = ${quote(a.memberIds[user.ben])};`)
  assert.deepEqual(inspect(user.ben, proof3), { outcome: 'removed' })
  assert.match(refused(join(user.ben, proof3), 'removed rejoins'), /membership_removed/u)
  assert.equal(memberStatus(user.ben), 'member:inactive')
  assert.match(refused(getLink(user.ben), 'removed reads'), /not_authorized/u)

  // 9. An archived Trip is refused everywhere.
  stack.psql(`UPDATE public.groups SET archived_at = now() WHERE id = ${quote(tripA)};`)
  assert.deepEqual(inspect(null, proof3), { outcome: 'archived' })
  assert.deepEqual(inspect(user.third, proof3), { outcome: 'archived' })
  assert.match(refused(join(user.third, proof3), 'join archived'), /trip_archived/u)
  assert.equal(memberStatus(user.third), '')
  assert.match(refused(setLink(user.owner, true, true), 'rotate archived'), /trip_archived/u)
  assert.deepEqual(value(getLink(user.ana), 'read archived'), { active: false })
  stack.psql(`UPDATE public.groups SET archived_at = NULL WHERE id = ${quote(tripA)};`)

  // 10. No direct table access for anon or authenticated (read or write).
  for (const who of [null, user.owner, user.ana]) {
    assert.match(refused(sqlAs(stack, who, 'SELECT count(*) FROM public.trip_join_links;'), 'select links'), /permission denied/u)
    assert.match(refused(sqlAs(stack, who, 'SELECT count(*) FROM trip_private.trip_join_link_proofs;'), 'select proofs'), /permission denied/u)
    assert.match(refused(sqlAs(stack, who, `UPDATE public.trip_join_links SET revoked_at = now();`), 'update links'), /permission denied/u)
    assert.match(refused(sqlAs(stack, who, `INSERT INTO public.trip_join_links (group_id, proof_verifier, created_by)
      VALUES (${quote(tripA)}, extensions.digest('y', 'sha256'), ${quote(a.memberIds[user.owner])});`), 'insert links'), /permission denied/u)
  }
  // anon can reach only the inspection function.
  assert.match(refused(sqlAs(stack, null, `SELECT public.trip_join_link_set_impl(${quote(tripA)}, false, false);`), 'anon impl'), /permission denied/u)
  assert.match(refused(sqlAs(stack, null, `SELECT public.trip_join_link_join_impl(${quote(proof3)}, gen_random_uuid());`), 'anon join impl'), /permission denied/u)
  // The proof still works after all that (nothing was changed directly).
  assert.equal(inspect(null, proof3).outcome, 'continue')

  stack.stop()
  console.log(JSON.stringify({ ownerOnlyToggle: 'passed', membersReadProof: 'passed', anonPreview: 'passed', strangerJoins: 'passed', idempotentJoin: 'passed', disabledCloses: 'passed', rotation: 'passed', removedRefused: 'passed', archivedRefused: 'passed', unverifiedRefused: 'passed', noDirectAccess: 'passed', cleanup: 'passed' }))
} catch (error) {
  try { stack.stop() } catch { /* keep the primary failure */ }
  console.error(error instanceof Error && /^[a-z0-9-]+$/u.test(error.message) ? error.message : 'join-links-db-verification-failed')
  if (process.env.TRIP_DEBUG === '1') console.error(error)
  process.exitCode = 1
}
