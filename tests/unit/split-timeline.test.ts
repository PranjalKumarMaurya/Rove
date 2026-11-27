import assert from 'node:assert/strict'
import test from 'node:test'

import type { LedgerExpense } from '../../src/features/split/ledger.ts'
import {
  buildTimeline, dateLabel, dayHeading, dayNumber, headerAmount, involvesMe, isTripOngoing, phaseOf, tripToday,
} from '../../src/features/split/timeline.ts'

const [pranjal, kshitij, ana] = ['m-pranjal', 'm-kshitij', 'm-ana']
const trip = { timezone: 'Asia/Kolkata', startDate: '2026-11-15', endDate: '2026-11-18', me: pranjal }

function expense(id: string, when: { spentAt?: string | null; createdAt?: string }, total: bigint, payer: string,
  shares: [string, bigint][]): LedgerExpense {
  return {
    id, description: id, category: null, originalAmount: total, originalCurrency: 'INR', accountingAmount: total,
    accountingCurrency: 'INR', fxRate: null, fxSource: null, fxCapturedAt: null, splitMethod: 'exact', createdBy: payer,
    version: 1, createdAt: when.createdAt ?? '2026-11-01T00:00:00Z', updatedAt: '', spentAt: when.spentAt ?? null,
    payers: [{ memberId: payer, amount: total }],
    shares: shares.map(([memberId, amount]) => ({ memberId, amount })),
  }
}

const ids = (days: { entries: { expense: LedgerExpense }[] }[]) => days.map((day) => day.entries.map((entry) => entry.expense.id))

test('expenses group into numbered Trip days, Day 1 first, empty days left out', () => {
  const timeline = buildTimeline([
    // 16 Nov 10:00 IST, then 15 Nov 09:00 IST, then 18 Nov 20:00 IST.
    expense('lunch', { spentAt: '2026-11-16T04:30:00Z' }, 1000n, kshitij, [[kshitij, 1000n]]),
    expense('breakfast', { spentAt: '2026-11-15T03:30:00Z' }, 500n, pranjal, [[pranjal, 500n]]),
    expense('dinner', { spentAt: '2026-11-18T14:30:00Z' }, 900n, pranjal, [[pranjal, 900n]]),
  ], trip)
  assert.deepEqual(timeline.during.map((day) => [day.date, day.dayNumber]), [['2026-11-15', 1], ['2026-11-16', 2], ['2026-11-18', 4]])
  assert.deepEqual(ids(timeline.during), [['breakfast'], ['lunch'], ['dinner']])
  assert.deepEqual(timeline.before, [])
  assert.deepEqual(timeline.after, [])
  assert.equal(dayHeading(timeline.during[0]), 'Day 1 · Sun 15 Nov')
  assert.equal(dayHeading(timeline.during[1]), 'Day 2 · Mon 16 Nov')
})

test('days before the start and after the end are kept apart, unnumbered and in date order', () => {
  const timeline = buildTimeline([
    expense('souvenirs', { spentAt: '2026-11-20T06:00:00Z' }, 300n, ana, [[ana, 300n]]),
    expense('flights', { spentAt: '2026-11-02T06:00:00Z' }, 9000n, pranjal, [[pranjal, 4500n], [kshitij, 4500n]]),
    expense('visa', { spentAt: '2026-10-30T06:00:00Z' }, 2000n, pranjal, [[pranjal, 2000n]]),
    expense('cab home', { spentAt: '2026-11-19T06:00:00Z' }, 400n, kshitij, [[kshitij, 400n]]),
    expense('beach', { spentAt: '2026-11-17T06:00:00Z' }, 100n, kshitij, [[kshitij, 100n]]),
  ], trip)
  assert.deepEqual(timeline.before.map((day) => day.date), ['2026-10-30', '2026-11-02'])
  assert.deepEqual(timeline.during.map((day) => day.date), ['2026-11-17'])
  assert.deepEqual(timeline.after.map((day) => day.date), ['2026-11-19', '2026-11-20'])
  assert.ok([...timeline.before, ...timeline.after].every((day) => day.dayNumber === null))
  assert.equal(dayHeading(timeline.before[0]), 'Fri 30 Oct')
  assert.equal(phaseOf('2026-11-14', trip.startDate, trip.endDate), 'before')
  assert.equal(phaseOf('2026-11-18', trip.startDate, trip.endDate), 'during')
  assert.equal(phaseOf('2026-11-19', trip.startDate, trip.endDate), 'after')
  // No end date: nothing is "after".
  assert.equal(phaseOf('2027-01-01', trip.startDate, ''), 'during')
})

test('within a day, expenses run morning to night with Trip-time times', () => {
  const timeline = buildTimeline([
    expense('dinner', { spentAt: '2026-11-15T15:00:00Z' }, 900n, ana, [[ana, 900n]]), // 20:30 IST
    expense('kshitij coffee', { spentAt: '2026-11-15T04:15:00Z' }, 200n, kshitij, [[kshitij, 200n]]), // 09:45 IST
    expense('pranjal breakfast', { spentAt: '2026-11-15T02:15:00Z' }, 500n, pranjal, [[pranjal, 500n]]), // 07:45 IST
  ], trip)
  assert.deepEqual(ids(timeline.during), [['pranjal breakfast', 'kshitij coffee', 'dinner']])
  assert.deepEqual(timeline.during[0].entries.map((entry) => entry.time), ['07:45', '09:45', '20:30'])
})

test('a 23:30 Trip-time expense stays on its Trip day even when UTC is already the next day', () => {
  // America/Los_Angeles is UTC-8 in November: 23:30 on 15 Nov there is 07:30 on 16 Nov UTC.
  const timeline = buildTimeline([
    expense('late snack', { spentAt: '2026-11-16T07:30:00Z' }, 300n, pranjal, [[pranjal, 300n]]),
  ], { ...trip, timezone: 'America/Los_Angeles' })
  assert.equal(timeline.during[0].date, '2026-11-15')
  assert.equal(timeline.during[0].dayNumber, 1)
  assert.equal(timeline.during[0].entries[0].time, '23:30')
  // And the other way: 00:30 IST on 16 Nov is still 15 Nov in UTC, but is Day 2.
  const ist = buildTimeline([expense('midnight', { spentAt: '2026-11-15T19:00:00Z' }, 1n, pranjal, [[pranjal, 1n]])], trip)
  assert.equal(ist.during[0].date, '2026-11-16')
})

test('day totals, and my share under "Only mine"', () => {
  const timeline = buildTimeline([
    expense('villa', { spentAt: '2026-11-15T08:00:00Z' }, 600000n, kshitij, [[pranjal, 300000n], [kshitij, 300000n]]),
    expense('scooter', { spentAt: '2026-11-15T10:00:00Z' }, 80000n, ana, [[ana, 40000n], [kshitij, 40000n]]),
    expense('dinner', { spentAt: '2026-11-15T14:00:00Z' }, 144000n, pranjal, [[pranjal, 48000n], [kshitij, 48000n], [ana, 48000n]]),
  ], trip)
  const day = timeline.during[0]
  assert.equal(day.total, 824000n)
  assert.equal(day.myShare, 348000n)
  assert.deepEqual(headerAmount(day, 'all'), { amount: 824000n, yourShare: false })
  assert.deepEqual(headerAmount(day, 'mine'), { amount: 348000n, yourShare: true })
  // Expenses folding away after a delete are listed but not counted.
  const folding = buildTimeline([
    expense('a', { spentAt: '2026-11-15T08:00:00Z' }, 100n, pranjal, [[pranjal, 100n]]),
    expense('b', { spentAt: '2026-11-15T09:00:00Z' }, 50n, pranjal, [[pranjal, 50n]]),
  ], { ...trip, uncounted: new Set(['a']) })
  assert.equal(folding.during[0].entries.length, 2)
  assert.equal(folding.during[0].total, 50n)
  assert.equal(folding.during[0].myShare, 50n)
  assert.equal(involvesMe(expense('paid only', {}, 1n, pranjal, [[ana, 1n]]), pranjal), true)
  assert.equal(involvesMe(expense('not mine', {}, 1n, ana, [[ana, 1n]]), pranjal), false)
})

test('expenses without a date spent use when they were entered', () => {
  const timeline = buildTimeline([
    expense('entered later', { spentAt: null, createdAt: '2026-11-16T12:00:00Z' }, 100n, pranjal, [[pranjal, 100n]]), // 17:30 IST
    expense('spent earlier', { spentAt: '2026-11-16T03:00:00Z', createdAt: '2026-11-20T00:00:00Z' }, 100n, pranjal, [[pranjal, 100n]]),
  ], trip)
  assert.deepEqual(timeline.during.map((day) => day.date), ['2026-11-16'])
  assert.deepEqual(ids(timeline.during), [['spent earlier', 'entered later']])
  assert.equal(timeline.during[0].entries[1].time, '17:30')
})

test('labels, day numbers and today in Trip time', () => {
  assert.equal(dateLabel('2026-11-15'), 'Sun 15 Nov')
  assert.equal(dateLabel('2027-01-01'), 'Fri 1 Jan')
  assert.equal(dayNumber('2026-12-01', '2026-11-15'), 17)
  assert.equal(tripToday(Date.parse('2026-11-15T19:00:00Z'), 'Asia/Kolkata'), '2026-11-16')
  assert.equal(tripToday(Date.parse('2026-11-15T19:00:00Z'), 'Not/AZone'), '2026-11-15')
  assert.equal(isTripOngoing('2026-11-16', trip.startDate, trip.endDate), true)
  assert.equal(isTripOngoing('2026-11-19', trip.startDate, trip.endDate), false)
})
