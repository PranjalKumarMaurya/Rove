// Migration 092, applied as the non-superuser `postgres`, checked as real users:
// - commit_expense / update_expense store when an expense was spent (p_spent_at);
//   an older client that sends no date stores NULL on create and keeps the date on edit.
// - A date from before the Trip is fine; one days in the future is refused.
// - get_split_ledger returns spent_at and lists expenses by when they were spent.
// - A scanned bill's document records the expense made from it (expense_id): any
//   active member of the Trip may set it, nobody else, and only to an expense of
//   the same Trip; deleting the expense clears it.
import assert from 'node:assert/strict'
import { createLocalStack } from '../../support/local-stack.mjs'
import { createTrip, createUsers, quote, sqlAs } from '../../support/db-fixtures.mjs'

const stack = createLocalStack({ projectId: 'bill-expenses-db', basePort: 59050 })
const tripA = 'e9000000-0000-4000-8000-00000000000a'
const tripB = 'e9000000-0000-4000-8000-00000000000b'

const lines = (entries) => quote(JSON.stringify(entries.map(([memberId, amount]) => ({ member_id: memberId, amount }))))
const commit = (groupId, payer, shares, { amount = '300.00', spentAt, requestId } = {}) =>
  `SELECT public.commit_expense(p_group_id => ${quote(groupId)}, p_description => 'Dinner', p_original_amount => ${quote(amount)},
    p_original_currency => 'INR', p_split_method => 'exact', p_payers => ${lines([[payer, amount]])}::jsonb,
    p_shares => ${lines(shares)}::jsonb, p_category => 'food'${spentAt === undefined ? '' : `, p_spent_at => ${spentAt === null ? 'NULL' : `${quote(spentAt)}::timestamptz`}`}
    ${requestId ? `, p_request_id => ${quote(requestId)}::uuid` : ''});`
const update = (expenseId, version, payer, shares, { amount = '300.00', spentAt } = {}) =>
  `SELECT public.update_expense(p_expense_id => ${quote(expenseId)}, p_expected_version => ${version}, p_description => 'Dinner',
    p_original_amount => ${quote(amount)}, p_original_currency => 'INR', p_split_method => 'exact',
    p_payers => ${lines([[payer, amount]])}::jsonb, p_shares => ${lines(shares)}::jsonb, p_category => 'food'
    ${spentAt === undefined ? '' : `, p_spent_at => ${quote(spentAt)}::timestamptz`});`
const spentAt = (expenseId) => stack.psql(`SELECT coalesce(to_char(spent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI'), 'none') FROM public.trip_expenses WHERE id = ${quote(expenseId)};`)

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
  const user = createUsers(stack, ['owner', 'ana', 'ben', 'stranger'])
  const a = createTrip(stack, { groupId: tripA, name: 'Bali', members: { [user.owner]: 'owner', [user.ana]: 'member', [user.ben]: 'member' } })
  const b = createTrip(stack, { groupId: tripB, name: 'Goa', members: { [user.stranger]: 'owner' } })
  const m = { owner: a.memberIds[user.owner], ana: a.memberIds[user.ana], ben: a.memberIds[user.ben] }
  const split3 = [[m.owner, '100.00'], [m.ana, '100.00'], [m.ben, '100.00']]

  // A pre-trip shopping bill, dated, and an undated one from an older client.
  const preTrip = ok(sqlAs(stack, user.ana, commit(tripA, m.ana, split3, { spentAt: '2026-11-20T05:30:00Z' })), 'dated create')[0][0]
  assert.equal(spentAt(preTrip), '2026-11-20T05:30')
  const undated = ok(sqlAs(stack, user.ben, commit(tripA, m.ben, split3)), 'create without a date')[0][0]
  assert.equal(spentAt(undated), 'none')
  const dinner = ok(sqlAs(stack, user.owner, commit(tripA, m.owner, split3, { spentAt: '2026-11-25T12:15:00Z' })), 'trip dinner')[0][0]

  // Days in the future is refused; nothing is written.
  const before = stack.psql(`SELECT count(*) FROM public.trip_expenses WHERE group_id = ${quote(tripA)};`)
  const future = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString()
  assert.match(refused(sqlAs(stack, user.ana, commit(tripA, m.ana, split3, { spentAt: future })), 'future date'), /trip_expenses_spent_at_plausible/u)
  assert.equal(stack.psql(`SELECT count(*) FROM public.trip_expenses WHERE group_id = ${quote(tripA)};`), before)

  // Editing changes the date; an edit without one keeps it.
  ok(sqlAs(stack, user.ana, update(preTrip, 1, m.ana, split3, { spentAt: '2026-11-21T08:00:00Z' })), 'edit date')
  assert.equal(spentAt(preTrip), '2026-11-21T08:00')
  ok(sqlAs(stack, user.ana, update(preTrip, 2, m.ana, split3)), 'edit without a date')
  assert.equal(spentAt(preTrip), '2026-11-21T08:00')
  // Only the creator or an Owner may edit, as before.
  refused(sqlAs(stack, user.ben, update(preTrip, 3, m.ana, split3, { spentAt: '2026-11-22T08:00:00Z' })), 'someone else edits')

  // The ledger returns spent_at and lists by when it was spent (undated: by entry time, i.e. now).
  const ledger = JSON.parse(ok(sqlAs(stack, user.ben, `SELECT public.get_split_ledger(${quote(tripA)})::text;`), 'ledger')[0][0])
  const order = ledger.expenses.map((expense) => expense.id)
  assert.deepEqual(order, [undated, dinner, preTrip])
  assert.equal(ledger.expenses.find((expense) => expense.id === dinner).spent_at.slice(0, 16), '2026-11-25T12:15')
  assert.equal(ledger.expenses.find((expense) => expense.id === undated).spent_at, null)

  // Scanned bill documents record the expense made from them.
  const doc = 'e9100000-0000-4000-8000-000000000001'
  stack.psql(`INSERT INTO public.trip_documents (id, group_id, storage_path, file_name, mime_type, size_bytes, uploaded_by, parse_status, extracted)
    VALUES (${quote(doc)}, ${quote(tripA)}, ${quote(`${tripA}/${doc}/bill.png`)}, 'bill.png', 'image/png', 100, ${quote(m.ana)}, 'parsed', '{"kind":"bill","title":"Dinner"}');`)
  const link = (who, expenseId) => sqlAs(stack, who, `UPDATE public.trip_documents SET expense_id = ${quote(expenseId)} WHERE id = ${quote(doc)} RETURNING id;`)
  // Someone outside the Trip sees nothing to update.
  assert.deepEqual(ok(link(user.stranger, dinner), 'stranger links'), [])
  // An expense from another Trip is refused by the same-Trip key.
  const other = ok(sqlAs(stack, user.stranger, commit(tripB, b.memberIds[user.stranger], [[b.memberIds[user.stranger], '300.00']])), 'other trip expense')[0][0]
  stack.psql(`INSERT INTO public.group_members (group_id, profile_id, role, status)
    SELECT ${quote(tripB)}, profile.id, 'member', 'active' FROM public.profiles AS profile WHERE profile.auth_user_id = ${quote(user.ana)};`)
  assert.match(refused(link(user.ana, other), 'cross-trip link'), /trip_documents_expense_same_group/u)
  // Any active member of the Trip may record it (a scanned bill can be split by whoever is free).
  assert.equal(ok(link(user.ben, dinner), 'member links')[0][0], doc)
  assert.equal(stack.psql(`SELECT expense_id FROM public.trip_documents WHERE id = ${quote(doc)};`), dinner)
  // Other columns stay out of reach.
  refused(sqlAs(stack, user.ben, `UPDATE public.trip_documents SET uploaded_by = ${quote(m.ben)} WHERE id = ${quote(doc)};`), 'other columns')
  // Deleting the expense leaves the document, unlinked, so it can be split again.
  ok(sqlAs(stack, user.owner, `SELECT public.delete_expense(${quote(dinner)}, NULL);`), 'delete expense')
  assert.equal(stack.psql(`SELECT coalesce(expense_id::text, 'none') FROM public.trip_documents WHERE id = ${quote(doc)};`), 'none')

  // Saving the same scanned bill twice (same request id) returns one expense.
  const once = ok(sqlAs(stack, user.ana, commit(tripA, m.ana, split3, { spentAt: '2026-11-26T10:00:00Z', requestId: doc })), 'scan save')[0][0]
  const twice = ok(sqlAs(stack, user.ana, commit(tripA, m.ana, split3, { spentAt: '2026-11-26T10:00:00Z', requestId: doc })), 'scan save again')[0][0]
  assert.equal(once, twice)

  stack.stop()
  console.log(JSON.stringify({ spentAtStored: 'passed', futureRefused: 'passed', editKeepsDate: 'passed', ledgerOrder: 'passed', documentExpenseLink: 'passed', idempotentScanSave: 'passed', cleanup: 'passed' }))
} catch (error) {
  try { stack.stop() } catch { /* keep the primary failure */ }
  console.error(error instanceof Error && /^[a-z0-9-]+$/u.test(error.message) ? error.message : 'bill-expenses-db-verification-failed')
  if (process.env.TRIP_DEBUG === '1') console.error(error)
  process.exitCode = 1
}
