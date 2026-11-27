import { useEffect, useMemo, useState } from 'react'
import type { MyGroupAccess } from '../groups/myGroupAccess'
import type { RosterMember } from '../groups/useGroupRoster'
import { useTripMemberProfiles } from '../groups/useTripMemberProfiles'
import { type CrewPhase, crewStatuses } from './crewStatus'
import type { TripEvent } from './itinerary'

const MOVING: ReadonlySet<CrewPhase> = new Set(['in-air', 'on-the-way', 'heading-home'])
const RESTING: ReadonlySet<CrewPhase> = new Set(['back-home', 'trip-over'])

/** Compact "who's where" strip for the top of the Trip tab; refreshes every minute. */
export function CrewStatusStrip({ trip, roster, events, audience, tripTimeZone }: {
  trip: MyGroupAccess
  roster: RosterMember[]
  events: TripEvent[]
  audience: Map<string, string[]>
  tripTimeZone: string
}) {
  const { profiles } = useTripMemberProfiles(trip.groupId)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // The viewer first, then everyone else in roster order.
  const members = useMemo(() => {
    const active = roster.filter((member) => member.status === 'active')
    return [...active.filter((member) => member.groupMemberId === trip.groupMemberId),
      ...active.filter((member) => member.groupMemberId !== trip.groupMemberId)]
  }, [roster, trip.groupMemberId])
  const emoji = useMemo(() => new Map(profiles.map((profile) => [profile.groupMemberId, profile.avatarEmoji])), [profiles])
  const statuses = useMemo(() => crewStatuses(members, events, audience, {
    startDate: trip.startDate, endDate: trip.endDate, timeZone: tripTimeZone, destination: trip.destination,
  }, now), [members, events, audience, trip.startDate, trip.endDate, trip.destination, tripTimeZone, now])

  if (!members.length) return null

  return (
    <section aria-labelledby="crew-status-heading" data-testid="crew-status" data-layout="section">
      <p id="crew-status-heading" className="t-callout t-voice" style={{ color: 'var(--text-secondary)' }}>the crew, right now</p>
      {/* Bleeds to the screen edges; the first tile starts on the gutter (scroll-px-5). */}
      <ul className="-mx-5 mt-3 flex scroll-px-5 gap-2 overflow-x-auto px-5" style={{ scrollSnapType: 'x proximity' }}>
        {members.map((member) => {
          const status = statuses.get(member.groupMemberId)
          if (!status) return null
          const isMe = member.groupMemberId === trip.groupMemberId
          const firstName = member.displayName.trim().split(/\s+/u)[0] || member.displayName
          return (
            <li key={member.groupMemberId} data-testid="crew-status-member" data-phase={status.phase}
              className="surface relative flex shrink-0 flex-col items-center gap-1 p-3 text-center"
              // At least 120px; a little wider with larger text. Status wraps to two lines, then truncates.
              style={{ minWidth: 120, width: 'clamp(120px, calc(120px * var(--text-scale)), 150px)', scrollSnapAlign: 'start', borderColor: isMe ? 'rgba(255,139,77,0.4)' : undefined, opacity: RESTING.has(status.phase) ? 0.6 : 1 }}>
              {MOVING.has(status.phase) && <span aria-hidden="true" className="animate-pulse-soft absolute right-2 top-2 rounded-full"
                style={{ width: 6, height: 6, background: 'var(--accent)' }} />}
              <span aria-hidden="true" className="flex size-avatar-md items-center justify-center rounded-full" style={{
                background: 'var(--accent-soft)', border: '1px solid var(--border-strong)',
                color: 'var(--text-primary)', fontSize: emoji.get(member.groupMemberId) ? 18 : 14, fontWeight: 'var(--w-semibold)',
              }}>
                {emoji.get(member.groupMemberId) || firstName.charAt(0).toUpperCase()}
              </span>
              <span className="t-caption w-full truncate" style={{ color: 'var(--text-secondary)' }} title={member.displayName}>
                {firstName}{isMe ? ' (you)' : ''}
              </span>
              <span className="sr-only">: </span>
              <span className="t-footnote t-medium line-clamp-2 w-full" style={{ color: 'var(--text-primary)' }} title={status.label}>{status.label}</span>
              {status.detail && <>
                <span className="sr-only">, </span>
                <span className="t-caption t-num line-clamp-2 w-full" style={{ color: 'var(--text-tertiary)', fontWeight: 'var(--w-regular)' }}>{status.detail}</span>
              </>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
