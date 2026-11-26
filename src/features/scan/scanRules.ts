// Pure Scan-tab rules: local file checks, storage naming, and the review form.
// No Supabase imports, so these run under `node --test`.
import {
  EVENT_TYPES, MAX_DOCUMENT_BYTES, type BillDraft, type BillWarning, type DocumentDraft, type DraftWarning, type EventDraft, type EventType,
  isBillDraft, isStorableMimeType, isValidTimeZone, parseWallTime, utcToZonedWallTime, zonedWallTimeToUtc,
} from '../../../supabase/functions/_shared/documentDraft.ts'

export { EVENT_TYPES, isBillDraft, type BillDraft, type DocumentDraft, type EventDraft, type EventType }

export type FileProblem = 'empty' | 'unsupported' | 'too_large'

/** Photos this big are accepted at selection: they are shrunk on the device before upload. */
export const MAX_SELECTED_IMAGE_BYTES = 40 * 1024 * 1024

/** Checked on selection, before anything leaves the device. Uses the browser-reported type only. */
export function checkSelectedFile(file: { name: string; size: number; type: string }): FileProblem | null {
  if (!isStorableMimeType(file.type)) return 'unsupported'
  if (file.size <= 0) return 'empty'
  const limit = file.type.startsWith('image/') ? MAX_SELECTED_IMAGE_BYTES : MAX_DOCUMENT_BYTES
  if (file.size > limit) return 'too_large'
  return null
}

// ─── Shrinking photos before upload ──────────────────────────────────────────
// Phone photos are often 3–8 MB, more than the reader accepts (5 MB) and slow on
// mobile data. A photo is re-encoded as JPEG with its long side at most
// MAX_IMAGE_EDGE px, which keeps printed text sharp and lands well under 1 MB.

export const MAX_IMAGE_EDGE = 2000
/** Smaller photos already within MAX_IMAGE_EDGE are uploaded unchanged. */
export const SHRINK_ABOVE_BYTES = 1.5 * 1024 * 1024

export function shrinkTarget(width: number, height: number, bytes: number, type: string):
  { width: number; height: number } | null {
  if (!(width > 0 && height > 0)) return null
  const heic = type === 'image/heic' || type === 'image/heif'
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height))
  if (!heic && scale === 1 && bytes <= SHRINK_ABOVE_BYTES) return null
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** `IMG_4634.HEIC` -> `IMG_4634.jpg`. */
export function jpegFileName(name: string): string {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name || 'photo'}.jpg`
}

export const FILE_PROBLEM_MESSAGES: Record<FileProblem, string> = {
  unsupported: 'Choose a PDF, JPEG, PNG, WebP, or HEIC file.',
  too_large: 'This file is too large. Choose a PDF under 10 MB or a photo under 40 MB.',
  empty: 'This file is empty or could not be read. Choose it again.',
}

/** A storage-safe object name that keeps the extension; the original name is kept in metadata. */
export function storageFileName(name: string): string {
  const trimmed = (name.split(/[\\/]/u).pop() ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').trim()
  const dot = trimmed.lastIndexOf('.')
  const base = (dot > 0 ? trimmed.slice(0, dot) : trimmed).replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80)
  const extension = dot > 0 ? trimmed.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 5) : ''
  return `${base || 'document'}${extension ? `.${extension}` : ''}`
}

export function documentPath(groupId: string, objectId: string, fileName: string): string {
  return `${groupId}/${objectId}/${storageFileName(fileName)}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function fileKindLabel(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType === 'image/heic' || mimeType === 'image/heif') return 'HEIC'
  return mimeType.startsWith('image/') ? mimeType.slice(6).toUpperCase().replace('JPEG', 'JPG') : 'File'
}

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  flight: 'Flight', hotel: 'Hotel', ferry: 'Ferry', activity: 'Activity', food: 'Food', transport: 'Transport', other: 'Other',
}

export const WARNING_MESSAGES: Record<DraftWarning, string> = {
  start_missing: 'No start time was found. Enter it below.',
  time_missing: 'The document shows a date without a time. Check the time.',
  timezone_assumed: 'The timezone was not clear, so the Trip timezone was assumed. Check it.',
  end_before_start: 'The end time looked wrong, so it was left blank.',
  end_implausible: 'The end time looked wrong, so it was left blank.',
  outside_trip_dates: 'This booking falls outside the Trip dates. Check the date.',
}

export const BILL_WARNING_MESSAGES: Record<BillWarning, string> = {
  amount_missing: 'The total could not be read. Enter it.',
  currency_missing: 'The currency was not clear, so the Trip currency is filled in. Check it.',
  date_missing: 'No date was found on the bill. Check the date and time.',
  time_missing: 'The bill shows a date without a time. Check the time.',
  timezone_assumed: 'The time zone was not clear, so the Trip time zone was assumed.',
}

/** What a scanned bill fills into Split's expense form. */
export interface BillPrefill {
  description: string
  amount: string
  currency: string
  category: string
  spentAt: string | null
}

export function billPrefill(draft: BillDraft, accountingCurrency: string): BillPrefill {
  return {
    description: draft.title.slice(0, 120),
    amount: draft.amount ?? '',
    currency: draft.currency ?? accountingCurrency,
    category: draft.category ?? '',
    spentAt: draft.spentAt,
  }
}

export interface EventForm {
  eventType: EventType
  title: string
  startLocal: string
  startTimezone: string
  endLocal: string
  endTimezone: string
  location: string
  locationTo: string
  depCode: string
  arrCode: string
  flightNo: string
  airline: string
  terminal: string
  bookingRef: string
  notes: string
}

export type FormErrors = Partial<Record<keyof EventForm, string>>

/** What `create_event_from_document` receives. */
export interface EventInput {
  eventType: EventType
  title: string
  startsAt: string
  endsAt: string | null
  location: string | null
  locationTo: string | null
  depCode: string | null
  arrCode: string | null
  flightNo: string | null
  airline: string | null
  terminal: string | null
  bookingRef: string | null
  notes: string | null
}

export function draftToForm(draft: EventDraft): EventForm {
  return {
    eventType: draft.eventType,
    title: draft.title,
    startLocal: draft.startsAt ? utcToZonedWallTime(draft.startsAt, draft.startTimezone) : '',
    startTimezone: draft.startTimezone,
    endLocal: draft.endsAt ? utcToZonedWallTime(draft.endsAt, draft.endTimezone) : '',
    endTimezone: draft.endTimezone,
    location: draft.location ?? '',
    locationTo: draft.locationTo ?? '',
    depCode: draft.depCode ?? '',
    arrCode: draft.arrCode ?? '',
    flightNo: draft.flightNo ?? '',
    airline: draft.airline ?? '',
    terminal: draft.terminal ?? '',
    bookingRef: draft.bookingRef ?? '',
    notes: draft.notes ?? '',
  }
}

const optional = (value: string) => value.trim() || null

/** Validate the review form; returns either field errors or the Event to create. */
export function formToEventInput(form: EventForm): { errors: FormErrors; input: EventInput | null } {
  const errors: FormErrors = {}
  const title = form.title.trim()
  if (!title) errors.title = 'Enter a title.'
  else if (title.length > 200) errors.title = 'Keep the title under 200 characters.'
  if (!(EVENT_TYPES as readonly string[]).includes(form.eventType)) errors.eventType = 'Choose a type.'

  if (!isValidTimeZone(form.startTimezone.trim())) errors.startTimezone = 'Enter an IANA timezone, for example Asia/Kolkata.'
  if (!form.startLocal) errors.startLocal = 'Enter the start date and time.'
  else if (!parseWallTime(form.startLocal)) errors.startLocal = 'Enter a valid date and time.'
  const startsAt = errors.startLocal || errors.startTimezone ? null : zonedWallTimeToUtc(form.startLocal, form.startTimezone.trim())

  let endsAt: string | null = null
  if (form.endLocal) {
    if (!isValidTimeZone(form.endTimezone.trim())) errors.endTimezone = 'Enter an IANA timezone, for example Asia/Kolkata.'
    else if (!parseWallTime(form.endLocal)) errors.endLocal = 'Enter a valid date and time.'
    else {
      endsAt = zonedWallTimeToUtc(form.endLocal, form.endTimezone.trim())
      if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) errors.endLocal = 'The end must be after the start.'
    }
  }

  const code = (value: string) => value.trim().toUpperCase()
  const flight = form.eventType === 'flight'
  if (flight && form.depCode.trim() && !/^[A-Z]{3}$/u.test(code(form.depCode))) errors.depCode = 'Use a three-letter airport code.'
  if (flight && form.arrCode.trim() && !/^[A-Z]{3}$/u.test(code(form.arrCode))) errors.arrCode = 'Use a three-letter airport code.'

  if (Object.keys(errors).length || !startsAt) return { errors, input: null }
  return {
    errors,
    input: {
      eventType: form.eventType,
      title,
      startsAt,
      endsAt,
      location: optional(form.location),
      locationTo: optional(form.locationTo),
      depCode: flight ? optional(code(form.depCode)) : null,
      arrCode: flight ? optional(code(form.arrCode)) : null,
      flightNo: flight ? optional(form.flightNo.toUpperCase()) : null,
      airline: flight ? optional(form.airline) : null,
      terminal: flight ? optional(form.terminal) : null,
      bookingRef: optional(form.bookingRef),
      notes: optional(form.notes),
    },
  }
}

export type ParseFailure =
  | 'not_authenticated' | 'document_not_found' | 'unsupported_for_parsing' | 'too_large_to_parse'
  | 'document_unavailable' | 'parser_unavailable' | 'parse_failed' | 'network' | 'unknown'
  /** The daily automatic-reading limit: yours, or the whole Trip's. */
  | 'parse_limit_reached' | 'trip_parse_limit_reached'

export function parseFailureMessage(code: ParseFailure): string {
  switch (code) {
    case 'unsupported_for_parsing': return 'This file type cannot be read automatically. Enter the details yourself.'
    case 'too_large_to_parse': return 'This image is too large to read automatically. Enter the details yourself.'
    case 'parser_unavailable': return 'Automatic reading is not available right now. Enter the details yourself.'
    case 'parse_failed': return 'We could not read this document. Enter the details yourself.'
    case 'parse_limit_reached': return 'You’ve used today’s automatic reads. Enter the details yourself, or try again tomorrow. The document is saved.'
    case 'trip_parse_limit_reached': return 'This Trip has used today’s automatic reads. Enter the details yourself, or try again tomorrow. The document is saved.'
    case 'document_not_found':
    case 'document_unavailable': return 'This document is no longer available to you.'
    case 'not_authenticated': return 'Your session has ended. Sign in again to read documents.'
    case 'network': return 'The connection dropped while reading. The document is saved; enter the details or try again.'
    default: return 'We could not read this document. Enter the details yourself.'
  }
}

// ─── Who's on a booking, and its cost ────────────────────────────────────────

export interface AudienceMember {
  id: string
  name: string
}

const nameTokens = (name: string): string[] =>
  name.normalize('NFKD').replace(/[̀-ͯ]/gu, '').toLowerCase()
    // Titles printed on tickets and vouchers.
    .replace(/\b(mr|mrs|ms|miss|mstr|master|dr)\b\.?/gu, ' ')
    .split(/[^a-z0-9]+/u).filter((token) => token.length > 1)

/**
 * Members whose name matches a passenger or guest printed on the booking. A
 * match is a shared first name, or a member's single-word name equal to any
 * word of the printed name ("RAO/ASHA MS" matches "Asha"). Each printed name
 * picks at most one member, and only when exactly one member fits.
 */
export function matchTravellers(travellers: readonly string[], members: readonly AudienceMember[]): string[] {
  const picked = new Set<string>()
  for (const traveller of travellers) {
    const printed = nameTokens(traveller)
    if (!printed.length) continue
    const fits = members.filter((member) => {
      const own = nameTokens(member.name)
      if (!own.length) return false
      // Full name printed in any order.
      if (own.length > 1 && own.every((token) => printed.includes(token))) return true
      return printed.includes(own[0])
    })
    if (fits.length === 1) picked.add(fits[0].id)
  }
  return members.filter((member) => picked.has(member.id)).map((member) => member.id)
}

export interface AudienceChoice {
  everyone: boolean
  picked: string[]
}

/**
 * Where "Who's on this booking?" starts: the members named on it; otherwise
 * just me when it is for fewer people than the Trip; otherwise everyone.
 */
export function initialAudience(draft: Pick<EventDraft, 'partySize' | 'travellers'>, members: readonly AudienceMember[], me: string): AudienceChoice {
  const named = matchTravellers(draft.travellers ?? [], members)
  if (named.length && named.length < members.length) return { everyone: false, picked: named }
  if (draft.partySize && draft.partySize < members.length) {
    return { everyone: false, picked: members.some((member) => member.id === me) ? [me] : [] }
  }
  return { everyone: true, picked: [] }
}

/** The line under "Who's on this booking?". */
export function audienceHint(partySize: number | null, choice: AudienceChoice, memberCount: number): string {
  const count = choice.everyone ? memberCount : choice.picked.length
  const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`
  if (!partySize) return choice.everyone ? `Everyone · ${people(memberCount)}` : `${count} picked`
  return `For ${people(partySize)} · ${count} of ${partySize} picked`
}

/** A gentle note when the picked count doesn't match what the booking says. */
export function audienceMismatch(partySize: number | null, choice: AudienceChoice, memberCount: number): string | null {
  if (!partySize) return null
  const count = choice.everyone ? memberCount : choice.picked.length
  if (count === partySize || count === 0) return null
  return `The booking says ${partySize}, and ${count} ${count === 1 ? 'is' : 'are'} picked. That's fine if some people aren't in this Trip.`
}

/** "Also add to Split" starts on only for a booking that says it is paid. */
export function defaultAddToSplit(draft: Pick<EventDraft, 'price'>): boolean {
  return draft.price?.status === 'paid'
}

const COST_CATEGORY: Record<EventType, string> = {
  flight: 'transport', ferry: 'transport', transport: 'transport', hotel: 'stay', activity: 'activity', food: 'food', other: 'other',
}

/** What a booking's cost fills into Split's expense form. */
export function bookingCostPrefill(draft: Pick<EventDraft, 'price'>, input: { title: string; eventType: EventType }, accountingCurrency: string, included: string[]): BillPrefill & { included: string[] } {
  return {
    description: input.title.slice(0, 120),
    amount: draft.price?.amount ?? '',
    currency: draft.price?.currency ?? accountingCurrency,
    category: COST_CATEGORY[input.eventType],
    // Paid when booked; the booking doesn't say when, so the form starts at now.
    spentAt: null,
    included,
  }
}
