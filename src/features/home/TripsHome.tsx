import { useCallback, useEffect, useRef, useState } from 'react'
import { IconChevronRight, IconLinkPlus, IconPlus } from '../../components/ui/icons'
import { enterIndex } from '../../components/ui/motion'
import { NeonBtn } from '../../components/ui/NeonBtn'
import { BrandMark } from '../../components/ui/ScreenFrame'
import { supabase } from '../../lib/supabase'
import { ArchivedTrips } from '../crew/ArchivedTrips'
import type { MyGroupAccess } from '../groups/myGroupAccess'
import { formatTripDates } from '../onboarding/tripSettings'
import type { MyProfile } from '../profile/profileApi'
import { HomeNav } from './HomeNav'
import { InviteDialog } from './InviteDialog'
import { type TripPhase, groupTrips, relativeTripLine } from './tripGrouping'
import './home.css'

const sectionTitles: Record<TripPhase, string> = { ongoing: 'Ongoing', upcoming: 'Upcoming', past: 'Past' }

/** Active member count per Trip; empty (no counts shown) if it cannot be read. */
function useTripMemberCounts(refreshKey: string): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    let active = true
    void supabase.rpc('get_my_trip_member_counts').then(({ data, error }) => {
      if (active && !error && Array.isArray(data)) {
        setCounts(Object.fromEntries(data.map((row) => [row.group_id, row.member_count])))
      }
    })
    return () => { active = false }
  }, [refreshKey])
  return counts
}

/**
 * Trips whose card has already been shown this session. Home remounts every time the
 * person comes back from a Trip; cards rise in only on their first appearance (first
 * load, or a Trip just created or joined), never on each return.
 */
const shownTrips = new Set<string>()

/** Ids of this mount's cards that are new this session; grows only, so a class never drops mid-animation. */
function useFreshTrips(trips: MyGroupAccess[]): ReadonlySet<string> {
  const fresh = useRef(new Set<string>())
  for (const trip of trips) if (!shownTrips.has(trip.groupId)) fresh.current.add(trip.groupId)
  useEffect(() => { for (const trip of trips) shownTrips.add(trip.groupId) }, [trips])
  return fresh.current
}

/** The current time, refreshed every minute so "Day 3 of 7" rolls over at midnight. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/**
 * The screen after sign-in: every Trip grouped Ongoing / Upcoming / Past, a link
 * button beside the title that opens a popup for joining with a pasted invite
 * link, archived Trips an Owner can restore, and the bottom nav (Trips, ＋ Create
 * Trip, Profile).
 */
export function TripsHome({ trips, profile, accountName, onCreate, onOpenTrip, onOpenProfile, onInvite }: {
  trips: MyGroupAccess[]
  profile: MyProfile | null
  accountName: string
  onCreate: () => void
  onOpenTrip: (groupId: string, options?: { reload?: boolean }) => void
  onOpenProfile: () => void
  /** A pasted invite link: open the invitation screen for it. */
  onInvite: (proof: string) => void
}) {
  const now = useNow()
  const refreshKey = trips.map((trip) => `${trip.groupId}:${trip.role}`).join(',')
  const counts = useTripMemberCounts(refreshKey)
  const grouped = groupTrips(trips, now)
  const fresh = useFreshTrips(trips)
  let entering = 0
  const name = (profile?.displayName || accountName).trim()
  const [inviteOpen, setInviteOpen] = useState(false)
  const inviteButton = useRef<HTMLButtonElement>(null)
  const closeInvite = useCallback(() => {
    setInviteOpen(false)
    inviteButton.current?.focus({ preventScroll: true })
  }, [])

  return (
    <main data-testid="trips-home" className="screen home-nav-space home-top">
      <div className="flex min-h-7 items-center justify-center">
        <BrandMark />
      </div>

      <div className="pb-2 pt-5">
        <div className="flex items-center justify-between gap-3">
          <h1 className="screen-title">Your Trips</h1>
          <button ref={inviteButton} type="button" className="round-btn" aria-label="Join with an invite link"
            aria-haspopup="dialog" aria-expanded={inviteOpen} onClick={() => setInviteOpen(true)}>
            <IconLinkPlus size={22} />
          </button>
        </div>
        <p className="screen-lede mt-2">{name ? `Hi ${name}. ` : ''}{trips.length ? 'Where to next?' : 'Plan, split and share a group trip.'}</p>
      </div>

      {trips.length === 0 ? (
        <section data-testid="trips-empty" aria-label="No Trips yet" className="surface m-appear mt-6 px-5 py-7 text-center">
          <p className="serif-display" style={{ fontSize: 24, color: 'var(--text-primary)' }}>No Trips yet</p>
          <p className="mx-auto mt-2 max-w-[300px]" style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5 }}>
            Create a Trip and invite your friends, or join one with the link a friend sent you.
          </p>
          <NeonBtn type="button" size="lg" className="mt-6 w-full" onClick={onCreate}><IconPlus size={18} />Create your first Trip</NeonBtn>
        </section>
      ) : (
        <div className="mt-4 flex flex-col gap-7">
          {(['ongoing', 'upcoming', 'past'] as const).filter((phase) => grouped[phase].length > 0).map((phase) => (
            <section key={phase} aria-labelledby={`trips-${phase}`}>
              <h2 id={`trips-${phase}`} className="section-title mb-3">{sectionTitles[phase]}</h2>
              <ul className="flex flex-col gap-3">
                {grouped[phase].map((trip) => (
                  <li key={trip.groupId} className={fresh.has(trip.groupId) ? 'm-enter' : undefined}
                    style={fresh.has(trip.groupId) ? enterIndex(entering++) : undefined}>
                    <TripCard trip={trip} phase={phase} now={now} members={counts[trip.groupId]} onOpen={() => onOpenTrip(trip.groupId)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <ArchivedTrips className="mt-8" refreshKey={refreshKey} onRestored={(groupId) => onOpenTrip(groupId, { reload: true })} />

      <HomeNav active="trips" onTrips={() => window.scrollTo({ top: 0, behavior: 'smooth' })} onCreate={onCreate}
        onProfile={onOpenProfile} profile={profile} accountName={accountName} />
      <InviteDialog open={inviteOpen} triggerRef={inviteButton} onClose={closeInvite} onInvite={(proof) => { setInviteOpen(false); onInvite(proof) }} />
    </main>
  )
}

function TripCard({ trip, phase, now, members, onOpen }: {
  trip: MyGroupAccess
  phase: TripPhase
  now: Date
  members?: number
  onOpen: () => void
}) {
  const detailsId = `trip-card-${trip.groupId}`
  const people = members === undefined ? null : members === 1 ? '1 person' : `${members} people`
  return (
    <button type="button" className={`trip-card${phase === 'ongoing' ? ' trip-card--ongoing' : ''}`} data-testid="trip-card"
      aria-label={trip.tripName} aria-describedby={detailsId} onClick={onOpen}>
      <span className="min-w-0 flex-1">
        <span className="block truncate" style={{ fontSize: 17, fontWeight: 500 }}>{trip.tripName}</span>
        <span id={detailsId} className="mt-1 block" style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.45 }}>
          <span className="block truncate">{trip.destination} · {formatTripDates(trip.startDate, trip.endDate)}</span>
          <span className="block truncate">
            <span className="trip-card__when">{relativeTripLine(trip, now)}</span>
            {' · '}{trip.role === 'owner' ? 'Owner' : 'Member'}{people ? ` · ${people}` : ''}
          </span>
        </span>
      </span>
      <span aria-hidden="true" style={{ color: 'var(--text-tertiary)' }}><IconChevronRight size={20} /></span>
    </button>
  )
}
