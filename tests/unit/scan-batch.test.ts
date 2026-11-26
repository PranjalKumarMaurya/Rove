import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_FILES_PER_PICK, batchSummary, planBatch, reviewQueue, splitReads } from '../../src/features/scan/scanRules.ts'

const photo = (name: string, extra: Partial<{ size: number; type: string; lastModified: number }> = {}) =>
  ({ name, size: 1000, type: 'image/jpeg', lastModified: 1, ...extra })

test('several files: each is checked, repeats are kept once, and the pick is capped', () => {
  const plan = planBatch([photo('a.jpg'), photo('a.jpg'), photo('b.jpg', { lastModified: 2 }), photo('notes.txt', { type: 'text/plain' }), photo('empty.jpg', { size: 0 })])
  assert.deepEqual(plan.accepted.map((file) => file.name), ['a.jpg', 'b.jpg'])
  assert.deepEqual(plan.duplicates, ['a.jpg'])
  assert.deepEqual(plan.rejected, [{ name: 'notes.txt', problem: 'unsupported' }, { name: 'empty.jpg', problem: 'empty' }])
  const many = planBatch(Array.from({ length: MAX_FILES_PER_PICK + 3 }, (_, index) => photo(`p${index}.jpg`)))
  assert.equal(many.accepted.length, MAX_FILES_PER_PICK)
  assert.equal(many.overflow, 3)
})

test('reads that fit today are done now; the rest wait', () => {
  assert.deepEqual(splitReads(19, 0, 20), { readNow: 19, later: 0 })
  assert.deepEqual(splitReads(19, 8, 20), { readNow: 12, later: 7 })
  assert.deepEqual(splitReads(5, 25, 20), { readNow: 0, later: 5 })
  // Unknown usage: try them all; the server still enforces the limit.
  assert.deepEqual(splitReads(5, null, 20), { readNow: 5, later: 0 })
})

test('the summary says what will happen before anything uploads', () => {
  const plan = planBatch([photo('a.jpg'), photo('a.jpg'), photo('notes.txt', { type: 'text/plain' }), photo('b.jpg', { lastModified: 2 })])
  assert.equal(batchSummary(plan, { readNow: 2, later: 0 }), '2 files ready. Picked twice, added once: a.jpg. Left out: notes.txt (not a PDF or photo).')
  assert.match(batchSummary(plan, { readNow: 1, later: 1 }), /1 will be read now; the other 1 are saved/u)
  assert.match(batchSummary(plan, { readNow: 0, later: 2 }), /used today’s automatic reads/u)
})

test('Review next goes oldest first: read ones, then unreadable, then not read yet', () => {
  const doc = (id: string, parseStatus: 'pending' | 'parsed' | 'failed', createdAt: string, done: Partial<{ eventId: string; expenseId: string }> = {}) =>
    ({ id, parseStatus, createdAt, eventId: done.eventId ?? null, expenseId: done.expenseId ?? null })
  const documents = [
    doc('new-bill', 'parsed', '2026-11-27T10:05:00Z'),
    doc('pending', 'pending', '2026-11-27T09:00:00Z'),
    doc('old-booking', 'parsed', '2026-11-27T10:00:00Z'),
    doc('unreadable', 'failed', '2026-11-27T08:00:00Z'),
    doc('done', 'parsed', '2026-11-27T07:00:00Z', { eventId: 'e1' }),
    doc('split', 'parsed', '2026-11-27T07:00:00Z', { expenseId: 'x1' }),
    doc('reading', 'pending', '2026-11-27T06:00:00Z'),
  ]
  assert.deepEqual(reviewQueue(documents, new Set(), new Set(['reading'])).map((entry) => entry.id), ['old-booking', 'new-bill', 'unreadable', 'pending'])
  // Skipped or finished in this walk-through: left out.
  assert.deepEqual(reviewQueue(documents, new Set(['old-booking', 'unreadable']), new Set(['reading'])).map((entry) => entry.id), ['new-bill', 'pending'])
})
