// Who was elsewhere when money was spent. When part of the group travels
// separately (three by train, four by car), a bill from one side shouldn't be
// split with the other. Pure, so it runs under `node --test`.

/** A journey on the itinerary and who is on it (empty audience: everyone). */
export interface TravelLeg {
  eventType: string
  title: string
  startsAt: string
  endsAt: string | null
  audience: readonly string[]
}

const JOURNEYS = new Set(['flight', 'ferry', 'transport'])
/** A journey with no arrival time counts as under way for this long. */
const DEFAULT_LEG_MS = 3 * 3600 * 1000

/** "On the train", "On a flight": a few words for the greyed-out row. */
export function legLabel(leg: Pick<TravelLeg, 'eventType' | 'title'>): string {
  if (leg.eventType === 'flight') return 'a flight'
  if (leg.eventType === 'ferry') return 'the ferry'
  if (/\b(train|express|rail|shatabdi|rajdhani|vande|mail|superfast|irctc)\b/iu.test(leg.title)) return 'the train'
  if (/\b(bus|volvo|coach)\b/iu.test(leg.title)) return 'the bus'
  return 'a separate journey'
}

/**
 * Members to leave out of a bill spent at `at`, with why. A journey with a
 * "Who's on this" list that is under way then splits the group in two: if the
 * payer is on it, the bill is that side's and everyone else is left out ("Not
 * on the train"); otherwise its travellers are ("On the train"). Journeys for
 * everyone, or with no list, change nothing.
 */
export function awayMembers(legs: readonly TravelLeg[], at: number | null, memberIds: readonly string[], payerId: string): Map<string, string> {
  const away = new Map<string, string>()
  if (at === null || Number.isNaN(at)) return away
  const all = new Set(memberIds)
  for (const leg of legs) {
    if (!JOURNEYS.has(leg.eventType)) continue
    const start = Date.parse(leg.startsAt)
    const end = leg.endsAt ? Date.parse(leg.endsAt) : start + DEFAULT_LEG_MS
    if (Number.isNaN(start) || at < start || at > end) continue
    const on = new Set(leg.audience.filter((id) => all.has(id)))
    if (!on.size || on.size === all.size) continue
    const label = legLabel(leg)
    if (on.has(payerId)) {
      for (const id of memberIds) if (!on.has(id) && !away.has(id)) away.set(id, `Not on ${label}`)
    } else {
      for (const id of on) if (!away.has(id)) away.set(id, `On ${label}`)
    }
  }
  return away
}
