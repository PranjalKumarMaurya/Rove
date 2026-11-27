import { type CSSProperties, useEffect, useMemo, useState } from 'react'
import { space } from '../../components/ui/space'
import { NeonBtn } from '../../components/ui/NeonBtn'
import { Collapse } from '../../components/ui/Collapse'
import { useExitList } from '../../components/ui/motion'
import { Swap } from '../../components/ui/Swap'
import type { TripTabProps } from '../workspace/tripTab'
import { CrewStatusStrip } from './CrewStatusStrip'
import { EventCard } from './EventCard'
import { EventDialog, type SaveEvent } from './EventDialog'
import { NextFlight } from './NextFlight'
import { eventStatuses, nextJourney, type TripEvent } from './itinerary'
import { createTripEvent, deleteTripEvent, updateTripEvent, useItinerary } from './tripEventsApi'
import { clocksDiffer, dayKey, formatDay, resolveTripTimeZone, timeZoneCity, viewerTimeZone } from './tripTime'
import { LiveBadge } from './useLiveRefetch'

type Editing = { mode: 'add' } | { mode: 'edit'; event: TripEvent }

export function TripTab({ trip, roster }: TripTabProps) {
  const { events, audience, loading, error, live, reload } = useItinerary(trip.groupId)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [localTimeZone] = useState(viewerTimeZone)
  const [notice, setNotice] = useState<string | null>(null)
  const tripZone = resolveTripTimeZone(trip.timezone)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const statuses = useMemo(() => eventStatuses(events, now), [events, now])
  const flight = useMemo(() => nextJourney(events, now), [events, now])
  const names = useMemo(() => new Map(roster.map((member) => [member.groupMemberId, member.displayName])), [roster])
  // An event someone deletes here folds away; one deleted elsewhere just goes.
  const { entries, exit } = useExitList(events, (event) => event.id)
  const days = (() => {
    const groups: { key: string; label: string; events: { event: TripEvent; leaving: boolean }[]; leaving: boolean }[] = []
    for (const { item: event, leaving } of entries) {
      const key = dayKey(event.starts_at, tripZone)
      const last = groups[groups.length - 1]
      if (last?.key === key) { last.events.push({ event, leaving }); last.leaving &&= leaving }
      else groups.push({ key, label: formatDay(event.starts_at, tripZone), events: [{ event, leaving }], leaving })
    }
    return groups
  })()
  // Position in the whole itinerary, so the entrance stagger runs across days, not per day.
  const order = useMemo(() => new Map(events.map((event, index) => [event.id, index])), [events])

  const save: SaveEvent = async (payload, people, overwrite) => {
    const saved = editing?.mode === 'edit'
      ? await updateTripEvent(trip.groupId, editing.event.id, overwrite ? null : editing.event.updated_at, payload, people)
      : await createTripEvent(trip.groupId, trip.groupMemberId, payload, people)
    // The event is saved either way; never leave the dialog open to be saved twice.
    setNotice(saved.audienceSaved ? null : `“${payload.title}” was saved, but who’s on it was not. Edit it to try again.`)
    // The dialog shows "Saved ✓" on its button, then closes itself (it stays locked meanwhile).
    void reload()
  }

  const remove = async (event: TripEvent) => {
    await deleteTripEvent(trip.groupId, event.id)
    exit(event.id)
    void reload()
  }

  // Compare clock offsets, not names: browsers may report an old alias (Asia/Calcutta for Asia/Kolkata).
  const showsLocal = clocksDiffer([new Date().toISOString()], tripZone, localTimeZone)

  return (
    <section data-testid="trip-tab" className="flex flex-col gap-6">
      {/* Statuses come from the itinerary, so wait for it rather than guess. */}
      {!loading && !error && <CrewStatusStrip trip={trip} roster={roster} events={events} audience={audience} tripTimeZone={tripZone} />}
      <NextFlight flight={flight} tripTimeZone={tripZone} localTimeZone={localTimeZone} />

      <div className="section" data-layout="section">
        <div>
          <div className="section-head">
            <h2 className="t-title2" style={{ color: 'var(--text-primary)' }}>Itinerary</h2>
            <NeonBtn type="button" variant="outline" color="#FF8B4D" onClick={() => setEditing({ mode: 'add' })}>
              Add event
            </NeonBtn>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 t-footnote" style={{ color: 'var(--text-tertiary)' }}>
            <span>Times in {timeZoneCity(tripZone)} time{showsLocal ? ` · yours shown below each` : ''}</span>
            <LiveBadge status={live} />
          </div>
        </div>

        <Collapse open={Boolean(notice)} gap={3}>
          <p role="status" className="surface card--row t-callout" style={{ color: 'var(--text-secondary)' }}>
            {notice} <button type="button" data-layout-exempt="inline" onClick={() => setNotice(null)} style={{ color: 'var(--accent)' }}>Dismiss</button>
          </p>
        </Collapse>
        <Collapse open={Boolean(error)} gap={3}>
          <p role="alert" className="surface card--row t-callout" style={{ color: 'var(--text-secondary)' }}>
            Could not load the itinerary. <button type="button" data-layout-exempt="inline" onClick={() => void reload()} style={{ color: 'var(--accent)' }}>Try again</button>
          </p>
        </Collapse>
        <Swap id={loading ? 'loading' : !error && entries.length === 0 ? 'empty' : 'list'}>
        {loading ? (
          <p role="status" className="t-callout" style={{ color: 'var(--text-tertiary)' }}>Loading itinerary…</p>
        ) : !error && events.length === 0 ? (
          <div className="surface card m-appear" data-testid="itinerary-empty" data-layout="card">
            <p className="t-title3 t-voice" style={{ color: 'var(--text-secondary)' }}>Nothing planned yet.</p>
            <p className="mt-1 t-callout" style={{ color: 'var(--text-tertiary)' }}>Add flights, stays and plans. Everyone in the Trip sees them.</p>
          </div>
        ) : (
          <div className="relative flex flex-col gap-6" data-testid="itinerary">
            {days.map((day) => (
              <section key={day.key} aria-label={day.label} className={day.leaving ? 'm-fold is-leaving' : 'm-fold'}
                style={{ '--fold-gap': space(6) } as CSSProperties} aria-hidden={day.leaving || undefined}>
                <div>
                <p className="t-headline t-num mb-3" style={{ color: 'var(--text-primary)' }}>{day.label}</p>
                <ol className="flex flex-col gap-3" style={{ '--fold-gap': space(3) } as CSSProperties}>
                  {day.events.map(({ event, leaving }) => (
                    <EventCard key={event.id} leaving={leaving && !day.leaving} index={order.get(event.id) ?? 0} event={event} status={statuses.get(event.id) ?? 'upcoming'}
                      tripTimeZone={tripZone} localTimeZone={localTimeZone}
                      audienceNames={(audience.get(event.id) ?? []).map((id) => names.get(id) ?? 'a former member')}
                      onEdit={() => setEditing({ mode: 'edit', event })} onDelete={() => remove(event)} />
                  ))}
                </ol>
                </div>
              </section>
            ))}
          </div>
        )}
        </Swap>
      </div>

      {editing && (
        <EventDialog
          key={editing.mode === 'edit' ? editing.event.id : 'add'}
          event={editing.mode === 'edit' ? editing.event : null}
          initialAudience={editing.mode === 'edit' ? audience.get(editing.event.id) ?? [] : []}
          tripTimeZone={tripZone}
          roster={roster}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}
