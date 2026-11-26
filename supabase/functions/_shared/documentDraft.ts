// Pure rules shared by the parse-document Edge Function (Deno) and the Scan tab
// (browser). No runtime-specific APIs: only Intl and Date.

export const EVENT_TYPES = ['flight', 'hotel', 'ferry', 'activity', 'food', 'transport', 'other'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const DOCUMENT_BUCKET = 'trip-documents'
/** Types the bucket accepts. HEIC/HEIF can be stored but not read automatically. */
export const STORABLE_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const
export const PARSEABLE_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
/** The vision API accepts images up to 5 MB. */
export const MAX_PARSE_IMAGE_BYTES = 5 * 1024 * 1024

export type DraftWarning =
  | 'start_missing'
  | 'time_missing'
  | 'timezone_assumed'
  | 'end_before_start'
  | 'end_implausible'
  | 'outside_trip_dates'

export interface EventDraft {
  eventType: EventType
  title: string
  /** UTC instant (ISO 8601) or null when the document gave no usable start. */
  startsAt: string | null
  endsAt: string | null
  /** IANA zones the times were printed in; the review form edits times in these zones. */
  startTimezone: string
  endTimezone: string
  location: string | null
  locationTo: string | null
  depCode: string | null
  arrCode: string | null
  flightNo: string | null
  airline: string | null
  terminal: string | null
  bookingRef: string | null
  notes: string | null
  warnings: DraftWarning[]
}

export interface TripContext {
  timezone: string
  startDate: string
  endDate: string
  destination?: string
}

export function isStorableMimeType(value: string): boolean {
  return (STORABLE_MIME_TYPES as readonly string[]).includes(value)
}

export function isParseableMimeType(value: string): boolean {
  return (PARSEABLE_MIME_TYPES as readonly string[]).includes(value)
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$|^UTC$/u.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function wallClock(utcMs: number, timeZone: string) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]))
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  }
}

function offsetMs(utcMs: number, timeZone: string): number {
  const wall = wallClock(utcMs, timeZone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/u
const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u

interface WallTime { year: number; month: number; day: number; hour: number; minute: number; second: number; hasTime: boolean }

export function parseWallTime(value: string): WallTime | null {
  const match = WALL_TIME.exec(value.trim())
  if (!match) return null
  const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1, 7).map((part) => (part === undefined ? undefined : Number(part))) as number[]
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (day < 1 || day > daysInMonth) return null
  return { year, month, day, hour, minute, second, hasTime: match[4] !== undefined }
}

/** Interpret a wall-clock time (`YYYY-MM-DDTHH:mm[:ss]`) in an IANA zone; returns a UTC ISO string. */
export function zonedWallTimeToUtc(value: string, timeZone: string): string | null {
  const wall = parseWallTime(value)
  if (!wall || !isValidTimeZone(timeZone)) return null
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  const firstOffset = offsetMs(guess, timeZone)
  let instant = guess - firstOffset
  const secondOffset = offsetMs(instant, timeZone)
  if (secondOffset !== firstOffset) instant = guess - secondOffset
  return new Date(instant).toISOString()
}

/** Format a UTC instant as `YYYY-MM-DDTHH:mm` in an IANA zone (the value of a datetime-local input). */
export function utcToZonedWallTime(iso: string, timeZone: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms) || !isValidTimeZone(timeZone)) return ''
  const wall = wallClock(ms, timeZone)
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`
}

const TYPE_SYNONYMS: Record<string, EventType> = {
  flight: 'flight', plane: 'flight', airline: 'flight', boarding_pass: 'flight',
  hotel: 'hotel', accommodation: 'hotel', stay: 'hotel', villa: 'hotel', hostel: 'hotel', lodging: 'hotel',
  ferry: 'ferry', boat: 'ferry', fast_boat: 'ferry', cruise: 'ferry',
  activity: 'activity', tour: 'activity', ticket: 'activity', event: 'activity', excursion: 'activity',
  food: 'food', restaurant: 'food', dinner: 'food', lunch: 'food', meal: 'food',
  transport: 'transport', train: 'transport', bus: 'transport', taxi: 'transport', car: 'transport',
  car_rental: 'transport', transfer: 'transport', shuttle: 'transport',
  other: 'other',
}

export function normaliseEventType(value: unknown): EventType {
  if (typeof value !== 'string') return 'other'
  return TYPE_SYNONYMS[value.trim().toLowerCase().replace(/[\s-]+/gu, '_')] ?? 'other'
}

export function cleanText(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).replace(/\s+/gu, ' ').trim()
  if (!text || /^(null|none|n\/a|unknown|-)$/iu.test(text)) return null
  return text.slice(0, maxLength)
}

export function normaliseAirportCode(value: unknown): string | null {
  const text = cleanText(value, 10)?.toUpperCase() ?? null
  return text && /^[A-Z]{3}$/u.test(text) ? text : null
}

/** `6e 123`, `6E123`, `6E-123` -> `6E-123`. Unrecognised shapes are kept, upper-cased. */
export function normaliseFlightNumber(value: unknown): string | null {
  const text = cleanText(value, 20)?.toUpperCase() ?? null
  if (!text) return null
  const match = /^([A-Z]{2,3}|[A-Z][0-9]|[0-9][A-Z])\s*-?\s*(\d{1,4}[A-Z]?)$/u.exec(text)
  return match ? `${match[1]}-${match[2]}` : text.slice(0, 12)
}

export function normaliseBookingRef(value: unknown): string | null {
  const text = cleanText(value, 40)
  return text ? text.toUpperCase() : null
}

interface ResolvedTime { iso: string | null; timeZone: string; assumedZone: boolean; missingTime: boolean }

function resolveTime(value: unknown, zone: unknown, fallbackZone: string): ResolvedTime {
  const validZone = isValidTimeZone(zone) ? zone : null
  const timeZone = validZone ?? fallbackZone
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return { iso: null, timeZone, assumedZone: false, missingTime: false }
  if (OFFSET_TIME.test(text)) {
    const ms = Date.parse(text.replace(' ', 'T'))
    return { iso: Number.isNaN(ms) ? null : new Date(ms).toISOString(), timeZone, assumedZone: false, missingTime: false }
  }
  const wall = parseWallTime(text)
  if (!wall) return { iso: null, timeZone, assumedZone: false, missingTime: false }
  return { iso: zonedWallTimeToUtc(text, timeZone), timeZone, assumedZone: !validZone, missingTime: !wall.hasTime }
}

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

function defaultTitle(type: EventType, fields: Pick<EventDraft, 'airline' | 'flightNo' | 'depCode' | 'arrCode' | 'location'>): string {
  const route = fields.depCode && fields.arrCode ? `${fields.depCode} → ${fields.arrCode}` : null
  if (type === 'flight') {
    const carrier = [fields.airline, fields.flightNo].filter(Boolean).join(' ')
    return [carrier || 'Flight', route].filter(Boolean).join(' · ')
  }
  const label = { hotel: 'Hotel stay', ferry: 'Ferry', activity: 'Activity', food: 'Meal', transport: 'Transport', other: 'Booking' }[type]
  return fields.location ? `${label} · ${fields.location}` : label
}

/**
 * Turn raw extraction output (model JSON, or anything else) into a safe draft.
 * Never throws: unusable values become null and are reported as warnings.
 */
export function normaliseExtraction(raw: unknown, trip: TripContext): EventDraft {
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const tripZone = isValidTimeZone(trip.timezone) ? trip.timezone : 'UTC'
  const eventType = normaliseEventType(input.event_type ?? input.type)
  const warnings = new Set<DraftWarning>()

  const start = resolveTime(input.start_local ?? input.starts_at, input.start_timezone, tripZone)
  const end = resolveTime(input.end_local ?? input.ends_at, input.end_timezone, start.timeZone)
  if (!start.iso) warnings.add('start_missing')
  if (start.missingTime || end.missingTime) warnings.add('time_missing')
  // The end falls back to the start's zone; that is only a guess worth flagging for journeys.
  const journey = eventType === 'flight' || eventType === 'ferry' || eventType === 'transport'
  if ((start.iso && start.assumedZone) || (end.iso && journey && !isValidTimeZone(input.end_timezone))) warnings.add('timezone_assumed')

  let endsAt = end.iso
  if (start.iso && endsAt) {
    const span = Date.parse(endsAt) - Date.parse(start.iso)
    const limit = eventType === 'hotel' ? 60 * DAY : eventType === 'activity' || eventType === 'other' ? 14 * DAY : 48 * HOUR
    if (span < 0) { endsAt = null; warnings.add('end_before_start') }
    else if (span > limit) { endsAt = null; warnings.add('end_implausible') }
  }
  if (start.iso && trip.startDate && trip.endDate) {
    const from = Date.parse(`${trip.startDate}T00:00:00Z`) - 2 * DAY
    const to = Date.parse(`${trip.endDate}T23:59:59Z`) + 2 * DAY
    const at = Date.parse(start.iso)
    if (!Number.isNaN(from) && !Number.isNaN(to) && (at < from || at > to)) warnings.add('outside_trip_dates')
  }

  const fields = {
    location: cleanText(input.location),
    locationTo: cleanText(input.location_to),
    depCode: normaliseAirportCode(input.dep_code),
    arrCode: normaliseAirportCode(input.arr_code),
    flightNo: normaliseFlightNumber(input.flight_no),
    airline: cleanText(input.airline, 80),
    terminal: cleanText(input.terminal, 40),
    bookingRef: normaliseBookingRef(input.booking_ref),
    notes: cleanText(input.notes, 1000),
  }
  return {
    eventType,
    title: cleanText(input.title) ?? defaultTitle(eventType, fields),
    startsAt: start.iso,
    endsAt,
    startTimezone: start.timeZone,
    endTimezone: end.timeZone,
    ...fields,
    warnings: [...warnings],
  }
}

// ─── Bills ────────────────────────────────────────────────────────────────────
// A bill or receipt becomes an expense draft instead of an itinerary entry. Its
// payers and split are chosen in Split, now or later; until then the document
// stays "ready to split".

/** Same ids as Split's expense categories. */
export const BILL_CATEGORIES = ['food', 'transport', 'stay', 'activity', 'shopping', 'other'] as const
export type BillCategory = (typeof BILL_CATEGORIES)[number]

export type BillWarning = 'amount_missing' | 'currency_missing' | 'date_missing' | 'time_missing' | 'timezone_assumed'

export interface BillDraft {
  kind: 'bill'
  /** Expense description, e.g. "Sky Garden: food and drinks". */
  title: string
  merchant: string | null
  /** Total paid as a plain decimal ("1461075", "7770.00"), or null if unreadable. */
  amount: string | null
  /** ISO 4217 code, or null when the bill did not make it clear. */
  currency: string | null
  /** UTC instant (ISO 8601) the bill was printed for, or null. */
  spentAt: string | null
  /** IANA zone the bill's time was printed in; the form edits the time in this zone. */
  spentTimezone: string
  category: BillCategory | null
  notes: string | null
  warnings: BillWarning[]
}

/** What one scanned document drafts: an itinerary entry or an expense. */
export type DocumentDraft = EventDraft | BillDraft

export function isBillDraft(draft: DocumentDraft): draft is BillDraft {
  return (draft as BillDraft).kind === 'bill'
}

const MAX_BILL_AMOUNT = 1_000_000_000_000

/**
 * A printed total as a plain decimal string. Accepts what bills print:
 * "₹7,770.00", "Rp 1.461.075", "1 461 075", "12,50". Thousands separators are
 * dropped; a single separator followed by one or two digits is the decimal point.
 */
export function normaliseAmount(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value : ''
  // Currency words around the number are fine ("Rp 12.500", "INR 845"); letters inside it ("1e9") are not.
  if (/\d\s*[A-Za-z]+\s*\d/u.test(text)) return null
  let digits = text.replace(/[^\d.,]/gu, '')
  if (!digits || !/\d/u.test(digits)) return null
  const lastDot = digits.lastIndexOf('.')
  const lastComma = digits.lastIndexOf(',')
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ','
    const thousands = decimal === '.' ? ',' : '.'
    digits = digits.split(thousands).join('').replace(decimal, '.')
  } else if (lastComma >= 0) {
    digits = /^\d+,\d{1,2}$/u.test(digits) ? digits.replace(',', '.') : digits.split(',').join('')
  } else if (lastDot >= 0) {
    const parts = digits.split('.')
    if (parts.length > 2 || parts[1].length === 3) digits = parts.join('')
  }
  if (!/^\d+(\.\d{1,3})?$/u.test(digits)) return null
  const [whole, fraction] = digits.split('.')
  const cleanWhole = whole.replace(/^0+(?=\d)/u, '')
  const amount = Number(`${cleanWhole}.${fraction ?? '0'}`)
  if (!(amount > 0) || amount >= MAX_BILL_AMOUNT) return null
  return fraction ? `${cleanWhole}.${fraction}` : cleanWhole
}

const CURRENCY_SYMBOLS: Record<string, string> = { '₹': 'INR', RS: 'INR', 'RS.': 'INR', RP: 'IDR', '€': 'EUR', '£': 'GBP', '฿': 'THB', '¥': 'JPY' }

export function normaliseCurrency(value: unknown): string | null {
  const text = cleanText(value, 10)?.toUpperCase().replace(/\s+/gu, '') ?? null
  if (!text) return null
  if (/^[A-Z]{3}$/u.test(text)) return text
  return CURRENCY_SYMBOLS[text] ?? null
}

const BILL_CATEGORY_SYNONYMS: Record<string, BillCategory> = {
  food: 'food', restaurant: 'food', bar: 'food', cafe: 'food', drinks: 'food', meal: 'food', dinner: 'food', lunch: 'food', groceries: 'food',
  transport: 'transport', taxi: 'transport', cab: 'transport', fuel: 'transport', petrol: 'transport', train: 'transport', bus: 'transport', flight: 'transport', ferry: 'transport',
  stay: 'stay', hotel: 'stay', villa: 'stay', accommodation: 'stay', hostel: 'stay',
  activity: 'activity', tour: 'activity', tickets: 'activity', entry: 'activity', spa: 'activity',
  shopping: 'shopping', shop: 'shopping', store: 'shopping', souvenir: 'shopping', clothes: 'shopping',
  other: 'other',
}

export function normaliseBillCategory(value: unknown): BillCategory | null {
  if (typeof value !== 'string') return null
  return BILL_CATEGORY_SYNONYMS[value.trim().toLowerCase().replace(/[\s-]+/gu, '_')] ?? null
}

/** Turn raw bill extraction (model JSON, or anything else) into a safe expense draft. Never throws. */
export function normaliseBill(raw: unknown, trip: TripContext): BillDraft {
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const tripZone = isValidTimeZone(trip.timezone) ? trip.timezone : 'UTC'
  const warnings = new Set<BillWarning>()
  const spent = resolveTime(input.spent_local ?? input.spent_at, input.spent_timezone, tripZone)
  if (!spent.iso) warnings.add('date_missing')
  else {
    if (spent.missingTime) warnings.add('time_missing')
    if (spent.assumedZone) warnings.add('timezone_assumed')
  }
  const amount = normaliseAmount(input.total_amount ?? input.amount)
  if (!amount) warnings.add('amount_missing')
  const currency = normaliseCurrency(input.currency)
  if (!currency) warnings.add('currency_missing')
  const merchant = cleanText(input.merchant, 80)
  return {
    kind: 'bill',
    title: cleanText(input.title, 120) ?? merchant ?? 'Bill',
    merchant,
    amount,
    currency,
    spentAt: spent.iso,
    spentTimezone: spent.timeZone,
    category: normaliseBillCategory(input.bill_category ?? input.category),
    notes: cleanText(input.notes, 300),
    warnings: [...warnings],
  }
}

/** The model labels each document; anything but an explicit bill is a booking. */
export function normaliseDocument(raw: unknown, trip: TripContext): DocumentDraft {
  const kind = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).document_kind : null
  return kind === 'bill' ? normaliseBill(raw, trip) : normaliseExtraction(raw, trip)
}

/** A booking draft looked at as a bill (when the reader guessed wrong). */
export function eventToBillDraft(draft: EventDraft): BillDraft {
  return {
    kind: 'bill', title: draft.title, merchant: draft.location, amount: null, currency: null,
    spentAt: draft.startsAt, spentTimezone: draft.startTimezone, category: normaliseBillCategory(draft.eventType),
    notes: draft.notes, warnings: draft.startsAt ? ['amount_missing'] : ['amount_missing', 'date_missing'],
  }
}

/** A bill draft looked at as a booking (when the reader guessed wrong). */
export function billToEventDraft(draft: BillDraft, trip: TripContext): EventDraft {
  const zone = isValidTimeZone(draft.spentTimezone) ? draft.spentTimezone : (isValidTimeZone(trip.timezone) ? trip.timezone : 'UTC')
  return {
    ...normaliseExtraction({}, trip),
    eventType: draft.category === 'stay' ? 'hotel' : draft.category === 'transport' ? 'transport' : draft.category === 'activity' ? 'activity' : draft.category === 'food' ? 'food' : 'other',
    title: draft.title,
    startsAt: draft.spentAt,
    startTimezone: zone,
    endTimezone: zone,
    location: draft.merchant,
    notes: draft.notes,
    warnings: draft.spentAt ? [] : ['start_missing'],
  }
}

/** Read any stored draft back (`trip_documents.extracted`): a bill, or a booking in any older shape. */
export function readStoredDocument(value: unknown, trip: TripContext): DocumentDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const stored = value as Partial<BillDraft>
  if (stored.kind !== 'bill') return readStoredDraft(value, trip)
  if (typeof stored.title !== 'string') return null
  const draft = normaliseBill({
    title: stored.title, merchant: stored.merchant, total_amount: stored.amount, currency: stored.currency,
    spent_at: stored.spentAt ?? undefined, spent_timezone: stored.spentTimezone, bill_category: stored.category, notes: stored.notes,
  }, trip)
  return { ...draft, title: stored.title.trim() || draft.title }
}

/** An empty draft for manual entry, dated at the start of the Trip. */
export function emptyDraft(trip: TripContext): EventDraft {
  const zone = isValidTimeZone(trip.timezone) ? trip.timezone : 'UTC'
  return { ...normaliseExtraction({}, trip), title: '', startTimezone: zone, endTimezone: zone, warnings: [] }
}

/** Read a stored draft back (e.g. `trip_documents.extracted`), tolerating older or partial shapes. */
export function readStoredDraft(value: unknown, trip: TripContext): EventDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const stored = value as Partial<EventDraft>
  if (typeof stored.title !== 'string') return null
  return normaliseExtraction({
    event_type: stored.eventType, title: stored.title,
    starts_at: stored.startsAt ?? undefined, start_timezone: stored.startTimezone,
    ends_at: stored.endsAt ?? undefined, end_timezone: stored.endTimezone,
    location: stored.location, location_to: stored.locationTo, dep_code: stored.depCode, arr_code: stored.arrCode,
    flight_no: stored.flightNo, airline: stored.airline, terminal: stored.terminal, booking_ref: stored.bookingRef,
    notes: stored.notes,
  }, trip)
}
