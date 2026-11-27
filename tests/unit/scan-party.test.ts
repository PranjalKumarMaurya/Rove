import assert from 'node:assert/strict'
import test from 'node:test'

import { eventToBillDraft, normaliseExtraction, normalisePartySize, normaliseTravellers, readStoredDraft } from '../../supabase/functions/_shared/documentDraft.ts'
import { EXTRACTION_SCHEMA, buildExtractionPrompt, createStubExtractor } from '../../supabase/functions/parse-document/handler.ts'
import {
  audienceHint, audienceMismatch, bookingCostPrefill, defaultAddToSplit, initialAudience, matchTravellers,
} from '../../src/features/scan/scanRules.ts'
import { findSimilarExpenses } from '../../src/features/split/similarExpense.ts'
import type { LedgerExpense } from '../../src/features/split/ledger.ts'

const bali = { timezone: 'Asia/Makassar', startDate: '2026-12-12', endDate: '2026-12-18', destination: 'Bali' }
const crew = [
  { id: 'm-asha', name: 'Asha' }, { id: 'm-ravi', name: 'Ravi Kumar' }, { id: 'm-rahul1', name: 'Rahul S' },
  { id: 'm-rahul2', name: 'Rahul M' }, { id: 'm-me', name: 'Pranav' }, { id: 'm-dev', name: 'Dev' },
]

test('party size, travellers and price come through from the reader', () => {
  const draft = normaliseExtraction({
    event_type: 'hotel', title: 'Villa Lumbung', start_local: '2026-12-12T14:00', start_timezone: 'Asia/Makassar',
    party_size: '5 adults', travellers: ['MS ASHA RAO', ' Ravi Kumar ', '', 'Ravi Kumar'],
    price_total: 'Rp 9.000.000', price_currency: 'IDR', payment_status: 'paid',
  }, bali)
  assert.equal(draft.partySize, 5)
  assert.deepEqual(draft.travellers, ['MS ASHA RAO', 'Ravi Kumar'])
  assert.deepEqual(draft.price, { amount: '9000000', currency: 'IDR', status: 'paid' })
})

test('missing or odd party details are left unknown, never guessed', () => {
  const draft = normaliseExtraction({ event_type: 'flight', title: 'x', party_size: '', travellers: 'Asha', price_total: '', payment_status: 'maybe' }, bali)
  assert.equal(draft.partySize, null)
  assert.deepEqual(draft.travellers, [])
  assert.equal(draft.price, null)
  for (const bad of ['0', 'two', '120', null, -1]) assert.equal(normalisePartySize(bad), null, String(bad))
  assert.equal(normalisePartySize(2), 2)
  assert.equal(normaliseTravellers(Array.from({ length: 30 }, (_, index) => `P${index}`)).length, 20)
  // A price whose status is unclear is kept, as unknown.
  assert.equal(normaliseExtraction({ price_total: '4500', payment_status: 'maybe' }, bali).price?.status, 'unknown')
})

test('stored drafts keep party details, and a booking switched to a bill keeps its price', () => {
  const draft = normaliseExtraction({ event_type: 'activity', title: 'Show', start_local: '2026-12-14T19:00', party_size: '2',
    travellers: ['Asha'], price_total: '3,000', price_currency: 'INR', payment_status: 'pay_later' }, bali)
  const again = readStoredDraft(JSON.parse(JSON.stringify(draft)), bali)
  assert.equal(again?.partySize, 2)
  assert.deepEqual(again?.travellers, ['Asha'])
  assert.deepEqual(again?.price, { amount: '3000', currency: 'INR', status: 'pay_later' })
  // Older stored drafts without these fields still read.
  assert.equal(readStoredDraft({ title: 'Old', eventType: 'flight' }, bali)?.partySize, null)
  const bill = eventToBillDraft(draft)
  assert.equal(bill.amount, '3000')
  assert.equal(bill.currency, 'INR')
  assert.deepEqual(bill.warnings, [])
})

test('the reader is asked for party details and the stub returns them', async () => {
  const properties = EXTRACTION_SCHEMA.properties as Record<string, { type: string; enum?: string[] }>
  for (const field of ['party_size', 'travellers', 'price_total', 'price_currency', 'payment_status']) {
    assert.ok(properties[field], field)
    assert.ok(EXTRACTION_SCHEMA.required.includes(field as never), `${field} required`)
  }
  assert.equal(properties.travellers.type, 'array')
  assert.deepEqual(properties.payment_status.enum, ['paid', 'pay_later', 'unknown'])
  assert.match(buildExtractionPrompt(bali), /party_size/u)
  const stub = await createStubExtractor()({ fileName: 'ticket.pdf', trip: bali } as never)
  assert.equal(normaliseExtraction(stub, bali).partySize, 2)
})

test('names on a booking pick the matching members, and never guess between two', () => {
  assert.deepEqual(matchTravellers(['MS ASHA RAO', 'KUMAR/RAVI MR'], crew), ['m-asha', 'm-ravi'])
  // Two Rahuls: a first name alone can't tell them apart.
  assert.deepEqual(matchTravellers(['Rahul Verma'], crew), [])
  assert.deepEqual(matchTravellers(['Mr. Dev Patel', 'Unknown Person'], crew), ['m-dev'])
  assert.deepEqual(matchTravellers([], crew), [])
})

test('who is on a booking starts from its names, then from its size', () => {
  assert.deepEqual(initialAudience({ partySize: 2, travellers: ['Asha Rao', 'Dev P'] }, crew, 'm-me'), { everyone: false, picked: ['m-asha', 'm-dev'] })
  // No names, but for fewer people than the Trip: start with me and let me pick the rest.
  assert.deepEqual(initialAudience({ partySize: 3, travellers: [] }, crew, 'm-me'), { everyone: false, picked: ['m-me'] })
  // Nothing to go on, or for the whole group: everyone.
  assert.deepEqual(initialAudience({ partySize: null, travellers: [] }, crew, 'm-me'), { everyone: true, picked: [] })
  assert.deepEqual(initialAudience({ partySize: 6, travellers: [] }, crew, 'm-me'), { everyone: true, picked: [] })
})

test('the count hint and the gentle mismatch note', () => {
  assert.equal(audienceHint(5, { everyone: false, picked: ['a', 'b', 'c'] }, 10), 'For 5 people · 3 of 5 picked')
  assert.equal(audienceHint(null, { everyone: true, picked: [] }, 10), 'Everyone · 10 people')
  assert.equal(audienceHint(null, { everyone: false, picked: ['a'] }, 10), '1 picked')
  assert.match(audienceMismatch(5, { everyone: false, picked: ['a', 'b', 'c'] }, 10) ?? '', /says 5, and 3 are picked/u)
  assert.equal(audienceMismatch(5, { everyone: false, picked: ['a', 'b', 'c', 'd', 'e'] }, 10), null)
  assert.equal(audienceMismatch(null, { everyone: true, picked: [] }, 10), null)
  assert.match(audienceMismatch(2, { everyone: true, picked: [] }, 10) ?? '', /10 are picked/u)
})

test('the cost goes to Split by default only when the booking says it is paid', () => {
  assert.equal(defaultAddToSplit({ price: { amount: '9000', currency: 'INR', status: 'paid' } }), true)
  assert.equal(defaultAddToSplit({ price: { amount: '9000', currency: 'INR', status: 'pay_later' } }), false)
  assert.equal(defaultAddToSplit({ price: { amount: '9000', currency: 'INR', status: 'unknown' } }), false)
  assert.equal(defaultAddToSplit({ price: null }), false)
  assert.deepEqual(bookingCostPrefill({ price: { amount: '9000000', currency: 'IDR', status: 'paid' } }, { title: 'Villa Lumbung', eventType: 'hotel' }, 'INR', ['m-asha', 'm-ravi']), {
    description: 'Villa Lumbung', amount: '9000000', currency: 'IDR', category: 'stay', spentAt: null, included: ['m-asha', 'm-ravi'],
  })
  assert.equal(bookingCostPrefill({ price: null }, { title: 'Flight', eventType: 'flight' }, 'INR', []).currency, 'INR')
  // Dated by the journey when it has happened; a future one starts at now (null).
  const now = Date.parse('2026-11-27T00:00:00Z')
  assert.equal(bookingCostPrefill({ price: null }, { title: 'Train', eventType: 'transport', startsAt: '2026-11-15T00:20:00Z' }, 'INR', [], now).spentAt, '2026-11-15T00:20:00.000Z')
  assert.equal(bookingCostPrefill({ price: null }, { title: 'Villa', eventType: 'hotel', startsAt: '2026-12-12T08:00:00Z' }, 'INR', [], now).spentAt, null)
  assert.equal(bookingCostPrefill({ price: null }, { title: 'Flight', eventType: 'flight' }, 'INR', []).category, 'transport')
})

test('a cost already in Split is spotted: same currency, within 1%', () => {
  const expense = (id: string, amount: bigint, currency: string, spentAt: string): LedgerExpense => ({
    id, description: id, category: null, originalAmount: amount, originalCurrency: currency, accountingAmount: amount,
    accountingCurrency: 'INR', fxRate: null, fxSource: null, fxCapturedAt: null, splitMethod: 'equal', createdBy: 'm-asha',
    version: 1, createdAt: spentAt, updatedAt: spentAt, spentAt, payers: [], shares: [],
  })
  const ledger = [
    expense('villa-old', 900000n, 'INR', '2026-11-01T00:00:00Z'),
    expense('villa-new', 905000n, 'INR', '2026-11-20T00:00:00Z'),
    expense('idr', 900000n, 'IDR', '2026-11-21T00:00:00Z'),
    expense('far', 950000n, 'INR', '2026-11-22T00:00:00Z'),
  ]
  assert.deepEqual(findSimilarExpenses(ledger, '9000.00', 'inr').map((found) => found.id), ['villa-new', 'villa-old'])
  assert.deepEqual(findSimilarExpenses(ledger, '9000', 'INR', 'villa-new').map((found) => found.id), ['villa-old'])
  assert.deepEqual(findSimilarExpenses(ledger, '', 'INR'), [])
  assert.deepEqual(findSimilarExpenses(ledger, '9000', 'RUPEES'), [])
})
