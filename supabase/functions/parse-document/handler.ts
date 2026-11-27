// Request handling for parse-document, free of Deno and npm imports so it can be
// unit-tested in Node. index.ts wires in the user-scoped Supabase store and the
// Anthropic extractor.
import {
  DEFAULT_MEMBER_PARSE_LIMIT,
  BILL_CATEGORIES, EVENT_TYPES, MAX_PARSE_IMAGE_BYTES, type DocumentDraft, type TripContext,
  isParseableMimeType, normaliseDocument,
} from '../_shared/documentDraft.ts'
import { costMicroUsd, type TokenUsage } from '../_shared/aiPricing.ts'

export type ParseErrorCode =
  | 'method_not_allowed'
  | 'not_authenticated'
  | 'invalid_request'
  | 'document_not_found'
  | 'unsupported_for_parsing'
  | 'too_large_to_parse'
  | 'document_unavailable'
  | 'parser_unavailable'
  | 'parse_failed'
  | 'parse_limit_reached'

export interface StoredDocument { id: string; groupId: string; storagePath: string; fileName: string; mimeType: string }
export interface DocumentFile { bytes: Uint8Array; mimeType: string }
export type ParseResult = { status: 'parsed'; draft: DocumentDraft } | { status: 'failed'; error: ParseErrorCode }

/** Model calls allowed per person and per Trip in any 24 hours. */
export interface ParseLimits { member: number; trip: number }
export type ParseClaim = 'claimed' | 'member_limit' | 'trip_limit'

export const DEFAULT_PARSE_LIMITS: ParseLimits = { member: DEFAULT_MEMBER_PARSE_LIMIT, trip: 100 }

/** Limits from SCAN_PARSE_DAILY_LIMIT_MEMBER / _TRIP; anything but a whole number ≥ 0 uses the default. */
export function parseLimitsFromEnv(get: (name: string) => string | undefined): ParseLimits {
  const read = (name: string, fallback: number) => {
    const raw = get(name)?.trim()
    return raw && /^\d{1,9}$/u.test(raw) ? Number(raw) : fallback
  }
  return {
    member: read('SCAN_PARSE_DAILY_LIMIT_MEMBER', DEFAULT_PARSE_LIMITS.member),
    trip: read('SCAN_PARSE_DAILY_LIMIT_TRIP', DEFAULT_PARSE_LIMITS.trip),
  }
}

/** Every method runs as the caller, so Row Level Security decides what exists. */
export interface ParseStore {
  currentUserId(): Promise<string | null>
  findDocument(id: string): Promise<StoredDocument | null>
  tripContext(groupId: string): Promise<TripContext | null>
  download(path: string): Promise<DocumentFile | null>
  saveResult(documentId: string, result: ParseResult): Promise<void>
  /**
   * Count this parse against the daily limits (claim_document_parse, as the
   * caller). Throws when the count cannot be checked; the model is then not called.
   */
  claimParse(documentId: string, limits: ParseLimits): Promise<ParseClaim>
  /**
   * Record what a model call cost, for the caller's AI usage. Written with the
   * service role (only the server may write usage), never from the client.
   */
  recordUsage(entry: { userId: string; groupId: string; documentId: string; usage: ModelUsage; costMicroUsd: number }): Promise<void>
}

/** Tokens one model call used, reported by the extractor as soon as the model answers. */
export interface ModelUsage extends TokenUsage { model: string }

export type Extractor = (input: {
  file: DocumentFile; fileName: string; trip: TripContext
  /** Called once the model has answered (even if the answer is then unusable): those tokens were spent. */
  onUsage?: (usage: ModelUsage) => void
}) => Promise<unknown>

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })
}

export function createParseHandler({ openStore, extractor, limits = DEFAULT_PARSE_LIMITS, log = () => {} }: {
  openStore: (authorization: string) => ParseStore
  extractor: Extractor | null
  limits?: ParseLimits
  log?: (event: string) => void
}) {
  return async function handle(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' })

    const authorization = request.headers.get('Authorization') ?? ''
    if (!/^Bearer \S+$/u.test(authorization)) return json(401, { error: 'not_authenticated' })

    let documentId: unknown
    try {
      documentId = ((await request.json()) as { documentId?: unknown })?.documentId
    } catch {
      return json(400, { error: 'invalid_request' })
    }
    if (typeof documentId !== 'string' || !UUID.test(documentId)) return json(400, { error: 'invalid_request' })

    const store = openStore(authorization)
    const userId = await store.currentUserId()
    if (!userId) return json(401, { error: 'not_authenticated' })

    // Visible only to an active member of the document's Trip (RLS); anything
    // else, including another Trip's document, is indistinguishable from missing.
    const document = await store.findDocument(documentId)
    if (!document || !document.storagePath.startsWith(`${document.groupId}/`)) return json(404, { error: 'document_not_found' })
    const trip = await store.tripContext(document.groupId)
    if (!trip) return json(404, { error: 'document_not_found' })

    const fail = async (status: number, error: ParseErrorCode, extra: Record<string, string> = {}) => {
      try { await store.saveResult(document.id, { status: 'failed', error }) } catch { log('save_failed') }
      log(error)
      return json(status, { error, ...extra })
    }

    if (!isParseableMimeType(document.mimeType)) return fail(422, 'unsupported_for_parsing')
    const file = await store.download(document.storagePath)
    if (!file) return fail(422, 'document_unavailable')
    if (!isParseableMimeType(file.mimeType)) return fail(422, 'unsupported_for_parsing')
    if (file.mimeType !== 'application/pdf' && file.bytes.byteLength > MAX_PARSE_IMAGE_BYTES) return fail(422, 'too_large_to_parse')
    if (!extractor) return fail(503, 'parser_unavailable')

    // Cost cap: counted (and checked) before the model is called. If the count
    // cannot be checked, do not call the model.
    let claim: ParseClaim
    try {
      claim = await store.claimParse(document.id, limits)
    } catch {
      log('claim_failed')
      return fail(503, 'parser_unavailable')
    }
    if (claim === 'member_limit' || claim === 'trip_limit') {
      return fail(429, 'parse_limit_reached', { scope: claim === 'member_limit' ? 'member' : 'trip' })
    }
    if (claim !== 'claimed') return fail(503, 'parser_unavailable')

    let raw: unknown
    let usage: ModelUsage | null = null
    const record = async () => {
      if (!usage) return
      try {
        await store.recordUsage({ userId, groupId: document.groupId, documentId: document.id, usage, costMicroUsd: costMicroUsd(usage.model, usage) })
      } catch { log('usage_failed') }
    }
    try {
      raw = await extractor({ file, fileName: document.fileName, trip, onUsage: (reported) => { usage = reported } })
    } catch (error) {
      await record()
      // Only the HTTP status and error type, never document content or keys.
      const detail = error && typeof error === 'object' ? error as { status?: unknown; name?: unknown } : {}
      log(`extractor_error status=${typeof detail.status === 'number' ? detail.status : 'none'} type=${typeof detail.name === 'string' ? detail.name.replace(/[^A-Za-z]/gu, '').slice(0, 40) : 'unknown'}`)
      return fail(502, 'parse_failed')
    }
    await record()
    // The draft is returned for review; no Event or expense is created here.
    const draft = normaliseDocument(raw, trip)
    try { await store.saveResult(document.id, { status: 'parsed', draft }) } catch { log('save_failed') }
    return json(200, { draft })
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

// Plain strings, never `anyOf`/null: structured outputs allow at most 16 union-typed
// fields per schema, so "not shown" is an empty string (normalisation treats it as missing).
const text = { type: 'string' }
const EXTRACTED_FIELDS = ['start_local', 'start_timezone', 'end_local', 'end_timezone', 'location', 'location_to',
  'dep_code', 'arr_code', 'flight_no', 'airline', 'terminal', 'booking_ref', 'notes'] as const
const BILL_FIELDS = ['merchant', 'total_amount', 'currency', 'spent_local', 'spent_timezone'] as const
const PARTY_FIELDS = ['party_size', 'price_total', 'price_currency'] as const

/** JSON schema for the model's answer (structured outputs). */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    document_kind: { type: 'string', enum: ['booking', 'bill'] },
    event_type: { type: 'string', enum: [...EVENT_TYPES] },
    title: { type: 'string' },
    ...Object.fromEntries(EXTRACTED_FIELDS.map((field) => [field, text])),
    ...Object.fromEntries(BILL_FIELDS.map((field) => [field, text])),
    bill_category: { type: 'string', enum: [...BILL_CATEGORIES] },
    ...Object.fromEntries(PARTY_FIELDS.map((field) => [field, text])),
    travellers: { type: 'array', items: text },
    payment_status: { type: 'string', enum: ['paid', 'pay_later', 'unknown'] },
  },
  required: ['document_kind', 'event_type', 'title', ...EXTRACTED_FIELDS, ...BILL_FIELDS, 'bill_category',
    ...PARTY_FIELDS, 'travellers', 'payment_status'],
}

export const EXTRACTION_SYSTEM_PROMPT = 'You read one document a friend uploaded to a group trip. It is either a booking '
  + '(boarding pass, e-ticket, hotel voucher, ferry, train or activity booking) that belongs on the itinerary, or a bill '
  + '(restaurant or bar bill, shop receipt, taxi receipt, any paid or payable total) that the group will split. '
  + 'Report only what the document shows; use an empty string for anything it does not show.'

export function buildExtractionPrompt(trip: TripContext): string {
  return [
    'Which document: photos often catch other papers or screen text at the edges. Read only the main document, the one most completely visible and central in the image. Ignore anything cut off at the edges or only partly shown. Only if one complete document lists several bookings (for example a multi-leg itinerary), use the earliest.',
    '',
    'First decide document_kind:',
    '- "bill" when its main point is money spent: a restaurant, bar, cafe or shop bill, a receipt, a taxi or fuel receipt, an invoice for something already used.',
    '- "booking" when it confirms a future journey, stay or activity, even if it shows a price.',
    '',
    `Trip: ${trip.destination || 'unknown destination'}, ${trip.startDate} to ${trip.endDate}. Trip timezone: ${trip.timezone}.`,
    '',
    'For a bill:',
    '- title: the place and what it was for, for example "Sky Garden: food and drinks" or "Big Bazaar: groceries".',
    '- merchant: the business name as printed.',
    '- total_amount: the final total actually charged, after tax, service and discounts. Digits only, with "." for decimals and no thousands separators, for example 1461075 or 7770.00.',
    '- currency: the ISO 4217 code, for example INR for ₹ or Rs, IDR for Rp. Use an empty string if the bill does not make it clear.',
    '- spent_local: the date and time printed on the bill, as YYYY-MM-DDTHH:mm in local time. spent_timezone: the IANA timezone of the place, or an empty string.',
    '- bill_category: food, transport, stay, activity, shopping or other.',
    '- notes: a short summary such as "5 covers, 6 drinks". Set event_type to the closest type (food for a meal) and every booking field to an empty string.',
    '',
    'For a booking: set every bill field to an empty string, bill_category to other, and extract the primary booking.',
    '- party_size: how many people the booking is for, as digits, for example 5 for "5 adults" or 2 for "2 tickets" (count adults and children together). Empty string if it does not say.',
    '- travellers: every passenger or guest name printed on it, as printed, for example ["Rahul Sharma", "Priya Mehta"]. An empty list if no names are shown.',
    '- price_total: the total price of the whole booking, digits only like total_amount. price_currency: its ISO 4217 code. Empty strings if no price is shown.',
    '- payment_status: "paid" if it says paid, prepaid, charged or confirmed with payment; "pay_later" if it is to be paid at the property, on arrival or later; otherwise "unknown".',
    'For a bill: set party_size, price_total and price_currency to empty strings, travellers to an empty list and payment_status to unknown.',
    '',
    'Times:',
    '- start_local is the departure, check-in, or start clock time; end_local is the arrival, check-out, or end time.',
    '- Write them as YYYY-MM-DDTHH:mm exactly as printed on the document, in local time. Do not convert between timezones.',
    '- start_timezone and end_timezone are the IANA timezones of the places those times apply to (for a flight: departure airport, then arrival airport), for example Asia/Kolkata or Asia/Makassar. Use an empty string if you cannot tell.',
    '- A duration such as "2h 30m" is never a clock time.',
    '- If no year is printed, use the year that puts the date within or nearest the trip dates.',
    '',
    'Other fields:',
    '- title: short, for example "IndiGo 6E-123 · DEL → GOI" or "Hotel · Taj Fort Aguada".',
    '- dep_code and arr_code: three-letter IATA airport codes. flight_no: carrier code and number, for example 6E-123.',
    '- booking_ref: the PNR or confirmation number. terminal: as printed.',
    '- notes: brief useful details such as seat, baggage, or check-in instructions.',
  ].join('\n')
}

/** Parse the model's text answer; tolerates a stray code fence. */
export function parseModelText(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  return JSON.parse(clean)
}

/**
 * Deterministic extractor for local stacks and tests (SCAN_PARSE_STUB=1). A file
 * whose name contains "unreadable" simulates a document the parser cannot read.
 */
export function createStubExtractor(): Extractor {
  return async ({ fileName, trip, onUsage }) => {
    if (/unreadable/iu.test(fileName)) throw new Error('stub_unreadable')
    // A fixed, realistic-looking usage so the AI usage records can be tested locally.
    onUsage?.({ model: 'claude-haiku-5-5', inputTokens: 1800, outputTokens: 400 })
    if (/bill|receipt/iu.test(fileName)) {
      return {
        document_kind: 'bill', event_type: 'food', title: 'Curlies by the Sea: food and drinks',
        merchant: 'Curlies by the Sea', total_amount: '7,770.00', currency: 'INR',
        spent_local: `${trip.startDate}T21:48`, spent_timezone: 'Asia/Kolkata', bill_category: 'food', notes: '5 covers',
      }
    }
    return {
      document_kind: 'booking',
      event_type: 'flight', title: 'IndiGo 6E-123 · DEL → GOI',
      start_local: `${trip.startDate}T06:15`, start_timezone: 'Asia/Kolkata',
      end_local: `${trip.startDate}T08:45`, end_timezone: 'Asia/Kolkata',
      location: 'Delhi (DEL)', location_to: 'Goa (GOI)', dep_code: 'del', arr_code: 'goi',
      flight_no: '6e 123', airline: 'IndiGo', terminal: 'T1', booking_ref: 'stub42', notes: 'Seat 12A',
      party_size: '2 adults', travellers: ['Asha Rao', 'Ravi Kumar'], price_total: '12,480', price_currency: 'INR', payment_status: 'paid',
    }
  }
}
