import { useEffect, useRef, useState } from 'react'
import { countdown, formatCountdown, type TripEvent } from './itinerary'
import { dualTime } from './tripTime'
import { legLabel } from '../split/travelRules'

/** "3" reads "Terminal 3"; a value already written as "Terminal 3" or "T3" stays as typed. */
export function terminalLabel(terminal: string) {
  const value = terminal.trim()
  return /^terminal/i.test(value) || /^T\d/i.test(value) ? value : `Terminal ${value}`
}

/**
 * The countdown text with each digit that just changed rolling up into place (180ms,
 * `.m-digit`). Digits are keyed by place (from the right) and value, so only a changed
 * digit remounts; the first render and unchanged digits stay still. The text content
 * is exactly `text`, for screen readers and tests.
 */
function RollingDigits({ text }: { text: string }) {
  const previous = useRef<string | null>(null)
  useEffect(() => { previous.current = text })
  const before = previous.current
  const chars = [...text]
  return <>{chars.map((char, index) => {
    if (!/\d/.test(char)) return char
    const place = chars.length - index
    const changed = before !== null && before.length === text.length && before[index] !== char
    return <span key={`${place}:${char}`} className={changed ? 'm-digit' : undefined}>{char}</span>
  })}</>
}

/** The next journey (flight, train, ferry, bus) with a ticking countdown; nothing when none is ahead. */
export function NextFlight({ flight, tripTimeZone, localTimeZone }: { flight: TripEvent | null; tripTimeZone: string; localTimeZone: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!flight) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [flight])

  // Nothing booked ahead: no card at all, rather than an empty "No upcoming flight".
  if (!flight) return null
  const isFlight = flight.event_type === 'flight'
  const kind = isFlight ? 'flight' : legLabel({ eventType: flight.event_type, title: flight.title }).replace(/^(the|a) /u, '').replace('separate journey', 'journey')
  const from = isFlight ? flight.dep_code : flight.location
  const to = isFlight ? flight.arr_code : flight.location_to
  const glyph = isFlight ? '✈' : kind === 'train' ? '🚆' : kind === 'ferry' ? '⛴' : kind === 'bus' ? '🚌' : '→'

  const parts = countdown(Date.parse(flight.starts_at), now)
  const time = dualTime(flight.starts_at, tripTimeZone, localTimeZone)
  const details = [flight.airline, flight.flight_no, flight.terminal && terminalLabel(flight.terminal)].filter(Boolean).join(' · ')

  return (
    <section aria-label={`Next ${kind}`} data-testid="next-flight" className="surface px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <p className="t-eyebrow min-w-0 truncate" style={{ color: 'var(--accent)' }}>next {kind}</p>
        {flight.flight_no && <span className="pill t-code shrink-0" style={{ fontSize: 'var(--type-caption)' }}>{flight.flight_no}</span>}
      </div>
      <p className="t-title3 mt-1 truncate" style={{ color: 'var(--text-primary)' }}>{flight.title}</p>
      {(from || to) && (
        <p className={`${isFlight ? 't-title1' : 't-title2'} mt-2 truncate`} style={{ color: 'var(--text-primary)' }}>
          {from ?? '—'} <span aria-hidden="true" style={{ color: 'var(--text-tertiary)', fontSize: '0.6em' }}>{glyph}</span><span className="sr-only">to</span> {to ?? '—'}
        </p>
      )}
      <p className="t-headline t-num mt-3" data-testid="next-flight-countdown"
        style={{ color: 'var(--text-primary)', fontSize: 'var(--type-title2)', lineHeight: 'var(--lh-title2)' }}>
        <span className="sr-only">Departs in </span><RollingDigits text={formatCountdown(parts)} />
      </p>
      <p className="t-footnote t-num mt-2" style={{ color: 'var(--text-tertiary)' }}>
        {time.tripDay} {time.trip} trip time{time.local ? ` · ${time.local.day} ${time.local.time} your time` : ''}
      </p>
      {details && <p className="mt-1 t-footnote" style={{ color: 'var(--text-tertiary)' }}>{details}</p>}
    </section>
  )
}
