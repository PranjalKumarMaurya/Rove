// Migration 093, checked as real users through RLS: a booking with a "Who's on
// this" list is visible only to the people on it and whoever added it, and so
// are its audience rows, its scanned document and that document's file. A
// booking with no list is for everyone. An unreviewed booking document is only
// its uploader's; a scanned bill is the whole Trip's. Expenses stay visible to
// everyone, including the cost of a private booking.
import assert from 'node:assert/strict'
import { createLocalStack } from '../../support/local-stack.mjs'
import { createTrip, createUsers, quote, sqlAs } from '../../support/db-fixtures.mjs'

const stack = createLocalStack({ projectId: 'private-bookings-db', basePort: 59100 })
const tripA = 'e9300000-0000-4000-8000-00000000000a'
const tripB = 'e9300000-0000-4000-8000-00000000000b'
const bucket = 'trip-documents'

function ok(result, label) {
  assert.equal(result.ok, true, `${label}: ${result.error ?? ''}`)
  return result.rows
}
function refused(result, label) {
  assert.equal(result.ok, false, `${label}: expected a refusal`)
  return result.error
}
const count = (who, sql, label) => Number(ok(sqlAs(stack, who, sql), label)[0][0])

try {
  stack.start()
  stack.migrate()
  const user = createUsers(stack, ['owner', 'ana', 'ben', 'cam', 'stranger'])
  const a = createTrip(stack, { groupId: tripA, name: 'Bali', members: { [user.owner]: 'owner', [user.ana]: 'member', [user.ben]: 'member', [user.cam]: 'member' } })
  createTrip(stack, { groupId: tripB, name: 'Goa', members: { [user.stranger]: 'owner' } })
  const m = { owner: a.memberIds[user.owner], ana: a.memberIds[user.ana], ben: a.memberIds[user.ben], cam: a.memberIds[user.cam] }
  const everyone = [user.owner, user.ana, user.ben, user.cam]

  const sees = (who, eventId) => count(who, `SELECT count(*) FROM public.trip_events WHERE id = ${quote(eventId)};`, 'read event') === 1
  const audienceRows = (who, eventId) => count(who, `SELECT count(*) FROM public.trip_event_audience WHERE event_id = ${quote(eventId)};`, 'read audience')
  const seesDocument = (who, documentId) => count(who, `SELECT count(*) FROM public.trip_documents WHERE id = ${quote(documentId)};`, 'read document') === 1
  const seesFile = (who, path) => count(who, `SELECT count(*) FROM storage.objects WHERE bucket_id = '${bucket}' AND name = ${quote(path)};`, 'read file') === 1
  const setAudience = (who, eventId, ids) => sqlAs(stack, who,
    `SELECT public.set_trip_event_audience(${quote(tripA)}, ${quote(eventId)}, ARRAY[${ids.map(quote).join(',')}]::uuid[]);`)

  // A document and its file, as the Storage API and the app would leave them.
  function scanned(uploader, extracted) {
    const id = crypto.randomUUID()
    const path = `${tripA}/${crypto.randomUUID()}/voucher.pdf`
    stack.psql(`INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('${bucket}', ${quote(path)}, ${quote(uploader)});`)
    stack.psql(`INSERT INTO public.trip_documents (id, group_id, storage_path, file_name, mime_type, size_bytes, uploaded_by, parse_status, extracted)
      VALUES (${quote(id)}, ${quote(tripA)}, ${quote(path)}, 'voucher.pdf', 'application/pdf', 100,
        ${quote(a.memberIds[uploader])}, 'parsed', ${quote(JSON.stringify(extracted))}::jsonb);`)
    return { id, path }
  }

  // 1. An entry added the usual way (insert ... returning) with no list is for everyone.
  const dinner = ok(sqlAs(stack, user.ana, `INSERT INTO public.trip_events (group_id, event_type, title, starts_at, created_by)
    VALUES (${quote(tripA)}, 'food', 'Group dinner', '2026-12-13T12:00:00Z', ${quote(m.ana)}) RETURNING id;`), 'add public entry')[0][0]
  for (const who of everyone) assert.equal(sees(who, dinner), true, 'public entry visible to every member')
  assert.equal(sees(user.stranger, dinner), false, 'outsider sees nothing')

  // 2. A scanned booking is its uploader's until it is added with who's on it.
  const hotel = scanned(user.ana, { title: 'Villa Lumbung', eventType: 'hotel', partySize: 2 })
  assert.equal(seesDocument(user.ana, hotel.id), true)
  assert.equal(seesFile(user.ana, hotel.path), true)
  for (const who of [user.owner, user.ben, user.cam]) {
    assert.equal(seesDocument(who, hotel.id), false, 'unreviewed booking hidden from others')
    assert.equal(seesFile(who, hotel.path), false, 'unreviewed booking file hidden from others')
  }
  // Nobody else can add it to the itinerary either.
  assert.match(refused(sqlAs(stack, user.ben, `SELECT public.create_event_from_document(${quote(hotel.id)}, 'hotel', 'Villa', '2026-12-12T07:00:00Z');`), 'other member adds'), /document_unavailable/u)

  // 3. Ana adds it for Ben only (booked on his behalf): Ben and Ana see it, nobody else, the Owner included.
  const villa = ok(sqlAs(stack, user.ana, `SELECT public.create_event_from_document(p_document_id => ${quote(hotel.id)},
    p_event_type => 'hotel', p_title => 'Villa Lumbung', p_starts_at => '2026-12-12T07:00:00Z',
    p_member_ids => ARRAY[${quote(m.ben)}]::uuid[]);`), 'add private booking')[0][0]
  assert.equal(sees(user.ana, villa), true, 'whoever added it sees it')
  assert.equal(sees(user.ben, villa), true, 'people on it see it')
  for (const who of [user.owner, user.cam, user.stranger]) assert.equal(sees(who, villa), false, 'others do not')
  assert.equal(audienceRows(user.ben, villa), 1)
  assert.equal(audienceRows(user.cam, villa), 0, 'who is on it is hidden too')
  assert.equal(audienceRows(user.owner, villa), 0)
  for (const who of [user.ana, user.ben]) {
    assert.equal(seesDocument(who, hotel.id), true)
    assert.equal(seesFile(who, hotel.path), true)
  }
  for (const who of [user.owner, user.cam, user.stranger]) {
    assert.equal(seesDocument(who, hotel.id), false, 'document follows the booking')
    assert.equal(seesFile(who, hotel.path), false, 'file follows the booking')
  }

  // 4. People not on it can't change, delete or re-target it.
  assert.deepEqual(ok(sqlAs(stack, user.cam, `UPDATE public.trip_events SET title = 'Mine now' WHERE id = ${quote(villa)} RETURNING id;`), 'hidden update'), [])
  assert.deepEqual(ok(sqlAs(stack, user.owner, `DELETE FROM public.trip_events WHERE id = ${quote(villa)} RETURNING id;`), 'hidden delete'), [])
  assert.match(refused(setAudience(user.cam, villa, [m.cam]), 'hidden audience change'), /trip_event_not_found/u)
  refused(sqlAs(stack, user.cam, `INSERT INTO public.trip_event_audience (group_id, event_id, group_member_id)
    VALUES (${quote(tripA)}, ${quote(villa)}, ${quote(m.cam)});`), 'add self to hidden booking')
  assert.deepEqual(ok(sqlAs(stack, user.cam, `UPDATE public.trip_documents SET expense_id = NULL WHERE id = ${quote(hotel.id)} RETURNING id;`), 'hidden document update'), [])
  assert.equal(stack.psql(`SELECT title FROM public.trip_events WHERE id = ${quote(villa)};`), 'Villa Lumbung')

  // 5. Someone on it can add people, and can even take themselves off; whoever added it still sees it.
  ok(setAudience(user.ben, villa, [m.ben, m.cam]), 'add Cam')
  assert.equal(sees(user.cam, villa), true)
  assert.equal(seesFile(user.cam, hotel.path), true)
  ok(setAudience(user.ben, villa, [m.cam]), 'Ben takes himself off')
  assert.equal(sees(user.ben, villa), false)
  assert.equal(sees(user.cam, villa), true)
  assert.equal(sees(user.ana, villa), true, 'creator keeps it')
  // An empty list makes it everyone's again.
  ok(setAudience(user.ana, villa, []), 'back to everyone')
  for (const who of everyone) assert.equal(sees(who, villa), true)
  for (const who of everyone) assert.equal(seesFile(who, hotel.path), true)
  ok(setAudience(user.ana, villa, [m.ben]), 'private again')

  // 6. A scanned bill is shared with the Trip straight away (bills are split by everyone).
  const bill = scanned(user.ben, { kind: 'bill', title: 'Warung dinner' })
  for (const who of everyone) {
    assert.equal(seesDocument(who, bill.id), true, 'bill visible to every member')
    assert.equal(seesFile(who, bill.path), true, 'bill file visible to every member')
  }
  assert.equal(seesDocument(user.stranger, bill.id), false)

  // 7. The private booking's cost, once in Split, is visible to the whole Trip like every expense.
  const shares = quote(JSON.stringify([{ member_id: m.ana, amount: '4500.00' }, { member_id: m.ben, amount: '4500.00' }]))
  const cost = ok(sqlAs(stack, user.ana, `SELECT public.commit_expense(p_group_id => ${quote(tripA)}, p_description => 'Villa Lumbung',
    p_original_amount => '9000.00', p_original_currency => 'INR', p_split_method => 'exact',
    p_payers => ${quote(JSON.stringify([{ member_id: m.ana, amount: '9000.00' }]))}::jsonb, p_shares => ${shares}::jsonb,
    p_category => 'stay', p_request_id => ${quote(hotel.id)}::uuid, p_spent_at => '2026-11-20T10:00:00Z'::timestamptz);`), 'split the booking')[0][0]
  assert.equal(ok(sqlAs(stack, user.ana, `UPDATE public.trip_documents SET expense_id = ${quote(cost)} WHERE id = ${quote(hotel.id)} RETURNING id;`), 'link cost')[0][0], hotel.id)
  for (const who of everyone) {
    const ledger = JSON.parse(ok(sqlAs(stack, who, `SELECT public.get_split_ledger(${quote(tripA)})::text;`), 'ledger')[0][0])
    assert.equal(ledger.expenses.some((expense) => expense.id === cost), true, 'every member sees every expense')
  }

  // 8. Leaving the Trip ends access, even for whoever added it.
  stack.psql(`UPDATE public.group_members SET status = 'inactive' WHERE id = ${quote(m.ana)};`)
  assert.equal(sees(user.ana, villa), false)
  assert.equal(seesFile(user.ana, hotel.path), false)

  stack.stop()
  console.log(JSON.stringify({ publicEntries: 'passed', unreviewedPrivate: 'passed', privateBooking: 'passed', hiddenWritesRefused: 'passed', audienceChanges: 'passed', billsShared: 'passed', expensesVisible: 'passed', leavingEndsAccess: 'passed', cleanup: 'passed' }))
} catch (error) {
  try { stack.stop() } catch { /* keep the primary failure */ }
  console.error(error instanceof Error && /^[a-z0-9-]+$/u.test(error.message) ? error.message : 'private-bookings-db-verification-failed')
  if (process.env.TRIP_DEBUG === '1') console.error(error)
  process.exitCode = 1
}
