import assert from 'node:assert/strict'
import test from 'node:test'

import {
  billToEventDraft, eventToBillDraft, isBillDraft, normaliseAmount, normaliseBill, normaliseCurrency, normaliseDocument,
  normaliseExtraction, readStoredDocument, type BillDraft,
} from '../../supabase/functions/_shared/documentDraft.ts'
import { EXTRACTION_SCHEMA, buildExtractionPrompt, createStubExtractor } from '../../supabase/functions/parse-document/handler.ts'
import { billPrefill } from '../../src/features/scan/scanRules.ts'

const bali = { timezone: 'Asia/Makassar', startDate: '2026-12-12', endDate: '2026-12-18', destination: 'Bali' }

test('bill totals parse from what bills actually print', () => {
  assert.equal(normaliseAmount('7770.00'), '7770.00')
  assert.equal(normaliseAmount('₹7,770.00'), '7770.00')
  assert.equal(normaliseAmount('Rp 1.461.075'), '1461075')
  assert.equal(normaliseAmount('1 461 075'), '1461075')
  assert.equal(normaliseAmount('1461075'), '1461075')
  assert.equal(normaliseAmount('12,50'), '12.50')
  assert.equal(normaliseAmount('1.234,56'), '1234.56')
  assert.equal(normaliseAmount('12.500'), '12500')
  assert.equal(normaliseAmount(845), '845')
  assert.equal(normaliseAmount('007.5'), '7.5')
  for (const bad of ['', 'free', '0', '0.00', null, undefined, {}, '1e9', '9999999999999']) {
    assert.equal(normaliseAmount(bad), null, String(bad))
  }
})

test('currencies come back as ISO codes, from codes or common symbols', () => {
  assert.equal(normaliseCurrency('idr'), 'IDR')
  assert.equal(normaliseCurrency('₹'), 'INR')
  assert.equal(normaliseCurrency('Rs.'), 'INR')
  assert.equal(normaliseCurrency('Rp'), 'IDR')
  assert.equal(normaliseCurrency('$'), null)
  assert.equal(normaliseCurrency(null), null)
})

test('a bill becomes an expense draft with its time read in the place it was printed', () => {
  const draft = normaliseBill({
    document_kind: 'bill', title: 'Warung Pantai Batu: food and drinks', merchant: 'Warung Pantai Batu',
    total_amount: '1.461.075', currency: 'IDR', spent_local: '2026-12-14T20:15', spent_timezone: 'Asia/Makassar',
    bill_category: 'food', notes: '5 covers',
  }, bali)
  assert.deepEqual(draft, {
    kind: 'bill', title: 'Warung Pantai Batu: food and drinks', merchant: 'Warung Pantai Batu', amount: '1461075',
    currency: 'IDR', spentAt: '2026-12-14T12:15:00.000Z', spentTimezone: 'Asia/Makassar', category: 'food', notes: '5 covers',
    warnings: [],
  })
})

test('an unclear bill is still a draft, with warnings for what to check', () => {
  const draft = normaliseBill({ merchant: 'Corner shop', spent_local: '2026-12-01', bill_category: 'souvenir' }, bali)
  assert.equal(draft.title, 'Corner shop')
  assert.equal(draft.amount, null)
  assert.equal(draft.category, 'shopping')
  assert.equal(draft.spentTimezone, 'Asia/Makassar')
  assert.deepEqual([...draft.warnings].sort(), ['amount_missing', 'currency_missing', 'time_missing', 'timezone_assumed'])
  assert.deepEqual(normaliseBill('nonsense', bali).warnings.sort(), ['amount_missing', 'currency_missing', 'date_missing'])
  // A bill from before the Trip is normal: no "outside the Trip dates" warning exists for bills.
  assert.ok(!normaliseBill({ total_amount: '500', currency: 'INR', spent_local: '2026-11-20T11:00', spent_timezone: 'Asia/Kolkata' }, bali).warnings.length)
})

test('the reader labels each document; only an explicit bill becomes a bill', () => {
  assert.equal(isBillDraft(normaliseDocument({ document_kind: 'bill', total_amount: '10', currency: 'INR' }, bali)), true)
  assert.equal(isBillDraft(normaliseDocument({ document_kind: 'booking', event_type: 'hotel', title: 'Villa' }, bali)), false)
  assert.equal(isBillDraft(normaliseDocument({ event_type: 'flight', title: 'SK 482' }, bali)), false)
  assert.equal(isBillDraft(normaliseDocument(null, bali)), false)
})

test('stored bill drafts read back as bills; older booking drafts still read as bookings', () => {
  const bill = normaliseBill({ title: 'Sky Garden: drinks', total_amount: '850000', currency: 'IDR', spent_local: '2026-12-15T23:40', spent_timezone: 'Asia/Makassar', bill_category: 'food' }, bali)
  const stored = JSON.parse(JSON.stringify(bill))
  assert.deepEqual(readStoredDocument(stored, bali), bill)
  const booking = normaliseExtraction({ event_type: 'hotel', title: 'Villa Sawah', start_local: '2026-12-12T14:00', start_timezone: 'Asia/Makassar' }, bali)
  const back = readStoredDocument(JSON.parse(JSON.stringify(booking)), bali)
  assert.ok(back && !isBillDraft(back))
  assert.equal(back?.title, 'Villa Sawah')
  assert.equal(readStoredDocument({ kind: 'bill' }, bali), null)
})

test('a wrong guess can be switched between bill and booking, keeping title and time', () => {
  const bill = normaliseBill({ title: 'Villa Sawah', merchant: 'Villa Sawah, Ubud', total_amount: '9000000', currency: 'IDR', spent_local: '2026-12-12T14:00', spent_timezone: 'Asia/Makassar', bill_category: 'stay' }, bali)
  const booking = billToEventDraft(bill, bali)
  assert.equal(booking.eventType, 'hotel')
  assert.equal(booking.title, 'Villa Sawah')
  assert.equal(booking.startsAt, bill.spentAt)
  assert.equal(booking.location, 'Villa Sawah, Ubud')
  const again: BillDraft = eventToBillDraft(booking)
  assert.equal(again.kind, 'bill')
  assert.equal(again.spentAt, bill.spentAt)
  assert.equal(again.category, 'stay')
  assert.deepEqual(again.warnings, ['amount_missing'])
})

test('a bill fills Split’s form; a missing currency falls back to the Trip currency', () => {
  const bill = normaliseBill({ title: 'Curlies: food and drinks', total_amount: '7770', spent_local: '2026-12-12T21:48', spent_timezone: 'Asia/Kolkata', bill_category: 'food' }, bali)
  assert.deepEqual(billPrefill(bill, 'IDR'), {
    description: 'Curlies: food and drinks', amount: '7770', currency: 'IDR', category: 'food', spentAt: '2026-12-12T16:18:00.000Z',
  })
})

test('the reader’s schema asks for both kinds, and the prompt explains when a document is a bill', () => {
  const properties = EXTRACTION_SCHEMA.properties as Record<string, unknown>
  for (const field of ['document_kind', 'merchant', 'total_amount', 'currency', 'spent_local', 'spent_timezone', 'bill_category']) {
    assert.ok(field in properties, field)
    assert.ok((EXTRACTION_SCHEMA.required as readonly string[]).includes(field), field)
  }
  const prompt = buildExtractionPrompt(bali)
  assert.match(prompt, /document_kind/u)
  assert.match(prompt, /total_amount/u)
})

test('the local stub reads a file named like a bill as a bill', async () => {
  const stub = createStubExtractor()
  const file = { bytes: new Uint8Array([1]), mimeType: 'image/png' }
  const bill = normaliseDocument(await stub({ file, fileName: 'dinner-bill.png', trip: bali }), bali)
  assert.ok(isBillDraft(bill))
  assert.equal(bill.amount, '7770.00')
  assert.equal(bill.currency, 'INR')
  const ticket = normaliseDocument(await stub({ file, fileName: 'ticket.png', trip: bali }), bali)
  assert.ok(!isBillDraft(ticket))
})

test('the reader’s schema stays within structured outputs’ limit of 16 union-typed fields (it uses none)', () => {
  const unions = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0
    const own = 'anyOf' in node || Array.isArray((node as { type?: unknown }).type) ? 1 : 0
    return own + Object.values(node).reduce<number>((sum, child) => sum + unions(child), 0)
  }
  assert.equal(unions(EXTRACTION_SCHEMA), 0)
})

test('empty strings for "not shown" read as missing, for bills and bookings', () => {
  const bill = normaliseDocument({ document_kind: 'bill', title: 'Cafe', merchant: '', total_amount: '450', currency: '',
    spent_local: '', spent_timezone: '', bill_category: 'food', notes: '' }, bali)
  assert.ok(isBillDraft(bill))
  assert.equal(bill.merchant, null)
  assert.equal(bill.currency, null)
  assert.equal(bill.spentAt, null)
  assert.equal(bill.notes, null)
  const booking = normaliseDocument({ document_kind: 'booking', event_type: 'flight', title: 'SK 482', start_local: '2026-12-12T06:10',
    start_timezone: 'Asia/Kolkata', end_local: '', end_timezone: '', location: '', location_to: '', dep_code: '', arr_code: '',
    flight_no: '', airline: '', terminal: '', booking_ref: '', notes: '', merchant: '', total_amount: '', currency: '', spent_local: '',
    spent_timezone: '', bill_category: 'other' }, bali)
  assert.ok(!isBillDraft(booking))
  assert.equal(booking.endsAt, null)
  assert.equal(booking.depCode, null)
  assert.equal(booking.startsAt, '2026-12-12T00:40:00.000Z')
})
