import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { NeonBtn } from '../../components/ui/NeonBtn'
import { NeonInput } from '../../components/ui/NeonInput'
import { formatMoney, minorUnits, parseAmount } from '../split/money'
import { KindRow } from './KindRow'
import {
  EVENT_TYPES, EVENT_TYPE_LABELS, WARNING_MESSAGES, type AudienceChoice, type EventDraft, type EventForm, type EventInput, type FormErrors,
  audienceHint, audienceMismatch, defaultAddToSplit, draftToForm, formToEventInput, initialAudience,
} from './scanRules'

const COMMON_ZONES = ['Asia/Kolkata', 'Asia/Makassar', 'Asia/Jakarta', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Dubai',
  'Asia/Tokyo', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC']

const fieldStyle = { color: 'var(--text-secondary)' }
const selectStyle = {
  background: 'rgba(245,241,235,0.035)', border: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: 14, colorScheme: 'dark',
} as const
const dateStyle = { colorScheme: 'dark' } as const

export function DraftReviewForm({ draft, fileName, notice, tripTimezone, saving, saveError, onSubmit, onCancel, onRetryRead, members = [], me = '', onSwitchToBill, cancelLabel = 'Not now' }: {
  /** "Skip" while walking through several documents. */
  cancelLabel?: string
  draft: EventDraft
  /** Active members, for "Who's on this". */
  members?: { id: string; name: string }[]
  /** My member id: whoever adds a booking always sees it. */
  me?: string
  /** The reader guessed wrong: treat this document as a bill. */
  onSwitchToBill?: () => void
  fileName: string
  notice: string | null
  tripTimezone: string
  saving: boolean
  saveError: string | null
  /** `audience` lists who it is for (empty means everyone); `addToSplit` opens Split next. */
  onSubmit: (input: EventInput, audience: string[], addToSplit: boolean) => void
  onCancel: () => void
  onRetryRead?: () => void
}) {
  const [form, setForm] = useState<EventForm>(() => draftToForm(draft))
  const [errors, setErrors] = useState<FormErrors>({})
  const [choice, setChoice] = useState<AudienceChoice>(() => initialAudience(draft, members, me))
  const [addToSplit, setAddToSplit] = useState(() => defaultAddToSplit(draft))
  const [audienceError, setAudienceError] = useState<string | null>(null)
  const toggle = (id: string) => {
    setAudienceError(null)
    setChoice((current) => {
      const picked = current.everyone ? members.map((member) => member.id) : current.picked
      const next = picked.includes(id) ? picked.filter((member) => member !== id) : [...picked, id]
      return { everyone: false, picked: next }
    })
  }
  const pickEveryone = () => { setAudienceError(null); setChoice({ everyone: true, picked: [] }) }
  const isOn = (id: string) => choice.everyone || choice.picked.includes(id)
  const price = draft.price
  const priceText = price && price.currency ? (() => {
    const minor = parseAmount(price.amount, minorUnits(price.currency))
    return minor === null ? `${price.amount} ${price.currency}` : formatMoney(minor, price.currency)
  })() : price ? price.amount : null
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Move focus (and the viewport on phones) to the form when it opens.
  useEffect(() => { headingRef.current?.focus() }, [])
  const set = (field: keyof EventForm) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((current) => ({ ...current, [field]: event.target.value }))

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    const result = formToEventInput(form)
    setErrors(result.errors)
    const chosen = choice.everyone ? [] : choice.picked
    if (members.length > 1 && !choice.everyone && !chosen.length) {
      setAudienceError('Pick who’s on this booking, or choose Everyone in the Trip.')
      return
    }
    if (result.input) onSubmit(result.input, chosen.length >= members.length ? [] : chosen, addToSplit)
  }

  const flight = form.eventType === 'flight'
  const journey = flight || form.eventType === 'ferry' || form.eventType === 'transport'
  const zones = [...new Set([tripTimezone, draft.startTimezone, draft.endTimezone, ...COMMON_ZONES])]

  return (
    <section data-testid="scan-review" aria-label="Review booking" className="surface px-4 py-5">
      <h2 ref={headingRef} tabIndex={-1} className="serif-display outline-none" style={{ color: 'var(--text-primary)', fontSize: 25 }}>Review booking</h2>
      <p className="mt-1 truncate" style={{ color: 'var(--text-secondary)', fontSize: 13 }}>From {fileName}</p>
      {onSwitchToBill && <div className="mt-3"><KindRow kind="booking" onChange={onSwitchToBill} disabled={saving} /></div>}
      {notice && <p role="status" className="mt-3 rounded-md border px-3 py-2 text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}>{notice}</p>}
      {draft.warnings.length > 0 && (
        <ul aria-label="Check these details" className="mt-3 flex list-disc flex-col gap-1 pl-5 text-sm" style={{ color: 'var(--accent)' }}>
          {[...new Set(draft.warnings.map((warning) => WARNING_MESSAGES[warning]))].map((message) => <li key={message}>{message}</li>)}
        </ul>
      )}
      <form onSubmit={submit} aria-busy={saving} className="mt-4 flex flex-col gap-4" noValidate>
        {Object.keys(errors).length > 0 && <p role="alert" className="text-sm" style={{ color: 'var(--accent)' }}>Fix the highlighted fields before adding this to the itinerary.</p>}
        <Field label="Type" error={errors.eventType}>
          <select aria-label="Type" value={form.eventType} onChange={set('eventType')} disabled={saving} className="w-full rounded-md px-3 py-2.5" style={selectStyle}>
            {EVENT_TYPES.map((type) => <option key={type} value={type}>{EVENT_TYPE_LABELS[type]}</option>)}
          </select>
        </Field>
        <Field label="Title" error={errors.title}>
          <NeonInput aria-label="Title" value={form.title} onChange={set('title')} disabled={saving} maxLength={200} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Starts" error={errors.startLocal}>
            <NeonInput aria-label="Starts" type="datetime-local" value={form.startLocal} onChange={set('startLocal')} disabled={saving} style={dateStyle} />
          </Field>
          <Field label="Start timezone" error={errors.startTimezone}>
            <NeonInput aria-label="Start timezone" list="scan-timezones" value={form.startTimezone} onChange={set('startTimezone')} disabled={saving} />
          </Field>
          <Field label="Ends (optional)" error={errors.endLocal}>
            <NeonInput aria-label="Ends" type="datetime-local" value={form.endLocal} onChange={set('endLocal')} disabled={saving} style={dateStyle} />
          </Field>
          <Field label="End timezone" error={errors.endTimezone}>
            <NeonInput aria-label="End timezone" list="scan-timezones" value={form.endTimezone} onChange={set('endTimezone')} disabled={saving} />
          </Field>
        </div>
        <datalist id="scan-timezones">{zones.map((zone) => <option key={zone} value={zone} />)}</datalist>
        <Field label={journey ? 'From' : 'Location'}>
          <NeonInput aria-label={journey ? 'From' : 'Location'} value={form.location} onChange={set('location')} disabled={saving} />
        </Field>
        {journey && (
          <Field label="To">
            <NeonInput aria-label="To" value={form.locationTo} onChange={set('locationTo')} disabled={saving} />
          </Field>
        )}
        {flight && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Departure airport" error={errors.depCode}>
              <NeonInput aria-label="Departure airport" value={form.depCode} onChange={set('depCode')} disabled={saving} maxLength={3} autoCapitalize="characters" />
            </Field>
            <Field label="Arrival airport" error={errors.arrCode}>
              <NeonInput aria-label="Arrival airport" value={form.arrCode} onChange={set('arrCode')} disabled={saving} maxLength={3} autoCapitalize="characters" />
            </Field>
            <Field label="Flight number">
              <NeonInput aria-label="Flight number" value={form.flightNo} onChange={set('flightNo')} disabled={saving} maxLength={20} />
            </Field>
            <Field label="Airline">
              <NeonInput aria-label="Airline" value={form.airline} onChange={set('airline')} disabled={saving} maxLength={80} />
            </Field>
            <Field label="Terminal">
              <NeonInput aria-label="Terminal" value={form.terminal} onChange={set('terminal')} disabled={saving} maxLength={40} />
            </Field>
          </div>
        )}
        <Field label="Booking reference">
          <NeonInput aria-label="Booking reference" value={form.bookingRef} onChange={set('bookingRef')} disabled={saving} maxLength={40} />
        </Field>
        {members.length > 1 && (
          <fieldset className="flex flex-col gap-2" disabled={saving}>
            <legend className="text-sm" style={{ color: 'var(--text-secondary)' }}>Who&rsquo;s on this booking?</legend>
            <p data-testid="scan-audience-hint" className="font-mono" style={{ color: 'var(--text-tertiary)', fontSize: 11, letterSpacing: '0.04em' }}>
              {audienceHint(draft.partySize, choice, members.length)}
            </p>
            <div className="flex flex-wrap gap-2" data-testid="scan-audience">
              <label className="pill cursor-pointer" style={{ color: choice.everyone ? 'var(--accent)' : 'var(--text-secondary)' }}>
                <input type="checkbox" checked={choice.everyone} onChange={() => (choice.everyone ? setChoice({ everyone: false, picked: [] }) : pickEveryone())}
                  style={{ accentColor: 'var(--accent)' }} className="mr-1.5" />
                Everyone in the Trip
              </label>
              {members.map((member) => (
                <label key={member.id} className="pill cursor-pointer" style={{ color: isOn(member.id) ? 'var(--accent)' : 'var(--text-secondary)' }}>
                  <input type="checkbox" checked={isOn(member.id)} onChange={() => toggle(member.id)}
                    style={{ accentColor: 'var(--accent)' }} className="mr-1.5" />
                  {member.name}{member.id === me ? ' (you)' : ''}
                </label>
              ))}
            </div>
            {audienceMismatch(draft.partySize, choice, members.length) && (
              <p data-testid="scan-audience-mismatch" style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{audienceMismatch(draft.partySize, choice, members.length)}</p>
            )}
            {audienceError && <p role="alert" style={{ color: 'var(--accent)', fontSize: 12 }}>{audienceError}</p>}
            <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
              {choice.everyone
                ? 'Everyone in the Trip will see this booking and its document.'
                : 'Only the people picked, and you, will see this booking and its document.'}
            </p>
          </fieldset>
        )}
        <fieldset className="surface flex flex-col gap-2 px-3.5 py-3" disabled={saving} data-testid="scan-cost">
          <legend className="sr-only">Cost</legend>
          {priceText && (
            <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
              Cost {priceText}
              <span style={{ color: 'var(--text-tertiary)' }}>
                {price?.status === 'paid' ? ' · paid' : price?.status === 'pay_later' ? ' · to pay at the property or later' : ''}
              </span>
            </p>
          )}
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm" style={{ color: 'var(--text-primary)' }}>
            <input type="checkbox" checked={addToSplit} onChange={(event) => setAddToSplit(event.target.checked)}
              style={{ accentColor: 'var(--accent)', width: 18, height: 18 }} />
            Also add the cost to Split
          </label>
          <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
            {addToSplit
              ? 'Next you pick who paid and check the split, shared between the people on this booking.'
              : price?.status === 'pay_later' ? 'Not paid yet, so it isn’t split now. You can split it later from Trip documents.' : 'You can split it later from Trip documents.'}
          </p>
        </fieldset>
        <Field label="Notes">
          <textarea aria-label="Notes" value={form.notes} onChange={set('notes')} disabled={saving} rows={3} maxLength={1000}
            className="w-full rounded-md px-3.5 py-2.5" style={selectStyle} />
        </Field>
        {saveError && <p role="alert" className="text-sm" style={{ color: 'var(--accent)' }}>{saveError}</p>}
        <NeonBtn type="submit" disabled={saving} className="w-full">{saving ? 'Adding…' : addToSplit ? 'Add to itinerary and split' : 'Add to itinerary'}</NeonBtn>
        <div className="flex flex-wrap justify-between gap-3">
          <button type="button" onClick={onCancel} disabled={saving} style={{ color: 'var(--text-secondary)' }}>{cancelLabel}</button>
          {onRetryRead && <button type="button" onClick={onRetryRead} disabled={saving} style={{ color: 'var(--text-secondary)' }}>Try reading again</button>}
        </div>
      </form>
    </section>
  )
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm" style={fieldStyle}>
      <span>{label}</span>
      {children}
      {error && <span role="alert" style={{ color: 'var(--accent)', fontSize: 12 }}>{error}</span>}
    </label>
  )
}
