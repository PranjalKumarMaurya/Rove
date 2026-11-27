import { useId, useRef, useState } from 'react'
import { AsyncLabel, useErrorNudge } from '../../components/ui/AsyncButton'
import { Collapse } from '../../components/ui/Collapse'
import { enterIndex, foldProps } from '../../components/ui/motion'
import { Swap } from '../../components/ui/Swap'
import { eventTypeMeta, safeMapUrl, type EventStatus, type TripEvent } from './itinerary'
import { clocksDiffer, formatSpan } from './tripTime'
import { terminalLabel } from './NextFlight'

const STATUS_LABEL: Record<EventStatus, string> = { past: 'Past', live: 'Live now', next: 'Next', upcoming: 'Upcoming' }

export function EventCard({ event, index = 0, status, tripTimeZone, localTimeZone, audienceNames, onEdit, onDelete, leaving = false }: {
  /** Deleted here: folding away (useExitList). */
  leaving?: boolean
  event: TripEvent
  /** Position in the itinerary, for the entrance stagger. */
  index?: number
  status: EventStatus
  tripTimeZone: string
  localTimeZone: string
  /** Names of the people this is for; empty means everyone. */
  audienceNames: string[]
  onEdit: () => void
  onDelete: () => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(false)
  const notesId = useId()
  const deleteButton = useRef<HTMLButtonElement>(null)
  const deleteStatus = deleting ? 'busy' : deleteError ? 'error' : 'idle'
  useErrorNudge(deleteButton, deleteStatus)
  const meta = eventTypeMeta(event.event_type)
  const showLocal = clocksDiffer([event.starts_at, event.ends_at], tripTimeZone, localTimeZone)
  const mapUrl = safeMapUrl(event.map_url)
  const highlighted = status === 'live' || status === 'next'
  const isFlight = event.event_type === 'flight'
  // Flight numbers and airport codes are codes (JetBrains Mono); the airline and terminal are text.
  const flightParts = [
    event.airline && { key: 'airline', text: event.airline, code: false },
    event.flight_no && { key: 'flight', text: event.flight_no, code: true },
    event.terminal && { key: 'terminal', text: terminalLabel(event.terminal), code: false },
  ].filter((part): part is { key: string; text: string; code: boolean } => Boolean(part))
  const flightLine = flightParts.length > 0

  const confirmDelete = async () => {
    setDeleting(true)
    setDeleteError(false)
    try {
      await onDelete()
    } catch {
      setDeleteError(true)
      setDeleting(false)
    }
  }

  return (
    <li data-testid="trip-event" data-status={status} aria-label={event.title} style={enterIndex(index)} {...foldProps(leaving, 'm-enter')}>
      <div className="flex items-start gap-3">
      <span aria-hidden="true" className="relative flex size-avatar-md shrink-0 items-center justify-center rounded-full" style={{
        background: 'var(--bg-base)', fontSize: 16,
        border: `1px solid ${highlighted ? 'var(--accent)' : 'var(--border-strong)'}`,
      }}>
        {meta.icon}
      </span>
      <article className="surface card min-w-0 flex-1" data-layout="card" style={{
        borderColor: status === 'live' ? 'var(--accent)' : status === 'next' ? 'rgba(255,139,77,0.35)' : undefined,
        opacity: status === 'past' ? 0.55 : 1,
      }}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="t-title3 min-w-0" style={{ color: 'var(--text-primary)', overflowWrap: 'break-word' }}>
            {event.notes
              ? <button type="button" aria-expanded={expanded} aria-controls={notesId} onClick={() => setExpanded((value) => !value)} className="text-left">{event.title}</button>
              : event.title}
          </h3>
          <span className="pill shrink-0" style={{ color: highlighted ? 'var(--accent)' : 'var(--text-tertiary)', borderColor: highlighted ? 'rgba(255,139,77,0.45)' : undefined }}>
            {STATUS_LABEL[status]}
          </span>
        </div>

        <p className="t-callout t-num mt-1" data-testid="event-trip-time" style={{ color: 'var(--text-secondary)' }}>
          {formatSpan(event.starts_at, event.ends_at, tripTimeZone)}
          <span style={{ color: 'var(--text-tertiary)' }}> trip time</span>
        </p>
        {showLocal && (
          <p className="t-footnote t-num" data-testid="event-local-time" style={{ color: 'var(--text-tertiary)' }}>
            {formatSpan(event.starts_at, event.ends_at, localTimeZone)} your time
          </p>
        )}

        {(event.location || event.location_to) && (
          <p className="mt-2 t-callout" style={{ color: 'var(--text-secondary)' }}>
            {event.location}
            {event.location_to && <><span aria-hidden="true" className="mx-1" style={{ color: 'var(--text-quaternary)' }}>→</span><span className="sr-only"> to </span>{event.location_to}</>}
          </p>
        )}
        {isFlight && (event.dep_code || event.arr_code || flightLine) && (
          <p className="t-footnote mt-2" data-testid="event-flight" style={{ color: 'var(--text-secondary)' }}>
            {(event.dep_code || event.arr_code) && <span><span className="t-code">{event.dep_code ?? '—'}</span> → <span className="t-code">{event.arr_code ?? '—'}</span></span>}
            {flightLine && <span>{event.dep_code || event.arr_code ? ' · ' : ''}{flightParts.map((part, index) => (
              <span key={part.key}>{index > 0 ? ' · ' : ''}{part.code ? <span className="t-code">{part.text}</span> : part.text}</span>
            ))}</span>}
          </p>
        )}
        {event.booking_ref && <p className="t-footnote mt-1" style={{ color: 'var(--text-tertiary)' }}>Booking <span className="t-code" style={{ color: 'var(--text-secondary)' }}>{event.booking_ref}</span></p>}
        <p className="mt-2 t-footnote" data-testid="event-audience" style={{ color: 'var(--text-tertiary)' }}>
          {audienceNames.length ? `For ${audienceNames.join(', ')}` : 'For everyone'}
        </p>

        <Collapse open={expanded && Boolean(event.notes)}>
          <p id={notesId} className="t-callout mt-4 whitespace-pre-wrap pt-4" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
            {event.notes}
          </p>
        </Collapse>

        <Swap id={confirming ? 'confirm' : 'actions'}>
        {confirming ? (
          <div role="group" aria-label={`Confirm deleting ${event.title}`} className="mt-4 flex flex-wrap items-center gap-2">
            <span className="t-callout" style={{ color: 'var(--text-primary)' }}>Delete this for everyone?</span>
            <button ref={deleteButton} type="button" disabled={deleting} aria-busy={deleting || undefined} onClick={() => void confirmDelete()} className="btn-quiet m-press" style={{ color: '#1A0A03', background: 'var(--accent)', border: '1px solid var(--accent)' }}>
              <AsyncLabel status={deleteStatus} busyLabel="Deleting…">Yes, delete</AsyncLabel>
            </button>
            <button type="button" disabled={deleting} onClick={() => setConfirming(false)} className="btn-quiet m-press">Keep it</button>
            {deleteError && <p role="alert" className="m-field-error w-full t-footnote" style={{ color: 'var(--accent)' }}>Could not delete. Try again.</p>}
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {mapUrl && <a href={mapUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open map for ${event.title}`} className="btn-quiet m-press">↗ Map</a>}
            <button type="button" aria-label={`Edit ${event.title}`} onClick={onEdit} className="btn-quiet m-press">Edit</button>
            <button type="button" aria-label={`Delete ${event.title}`} onClick={() => setConfirming(true)} className="btn-quiet m-press">Delete</button>
          </div>
        )}
        </Swap>
      </article>
      </div>
    </li>
  )
}
