import { type CSSProperties, type KeyboardEvent, useRef } from 'react'
import { ScreenHeader } from '../../components/ui/ScreenHeader'
import { IconChat, IconChecklist, IconExchange, IconMap, IconReceipt, IconScan, IconSettings } from '../../components/ui/icons'
import { ChatTab } from '../chat/ChatTab'
import { FxTab } from '../fx/FxTab'
import { ScanTab } from '../scan/ScanTab'
import { SplitTab } from '../split/SplitTab'
import { useOpenTodoCount } from '../todos/tripTodosApi'
import { TripTab } from '../trip/TripTab'
import type { MyGroupAccess } from './myGroupAccess'
import { useGroupRoster } from './useGroupRoster'

const ALL_TABS = [
  { id: 'trip', label: 'Trip', Icon: IconMap, Component: TripTab },
  { id: 'split', label: 'Split', Icon: IconReceipt, Component: SplitTab },
  { id: 'scan', label: 'Scan', Icon: IconScan, Component: ScanTab },
  { id: 'chat', label: 'Chat', Icon: IconChat, Component: ChatTab },
  { id: 'fx', label: 'FX', Icon: IconExchange, Component: FxTab },
] as const

export type TripSectionId = (typeof ALL_TABS)[number]['id']

/** Domestic Trips have no currency features, so no FX tab. */
const tabsFor = (trip: MyGroupAccess) => ALL_TABS.filter((entry) => entry.id !== 'fx' || trip.isInternational)

/**
 * One Trip: a header with the way back to the Trips home and two round buttons on
 * the right, To-dos and Settings (each opens a full screen pushed above the Trip,
 * see navigationHistory.ts), then the selected tab and the bottom tab bar
 * (Trip · Split · Scan · Chat · FX). The chosen tab is held by the caller, so coming
 * back from To-dos or Settings (or seeing the Trip beneath an edge swipe) shows the
 * same tab.
 */
export function GroupWorkspace({ trip, tab, onTabChange, onBack, onRefresh, onOpenTodos, onOpenSettings }: {
  trip: MyGroupAccess
  /** The selected tab (falls back to the first when it isn't offered). */
  tab: string
  onTabChange: (tab: TripSectionId) => void
  /** Back to the Trips home. */
  onBack: () => void
  /** Re-read the Trip list in the background (role, settings, membership, archive state). */
  onRefresh: () => void
  onOpenTodos: () => void
  onOpenSettings: () => void
}) {
  const owner = trip.role === 'owner'
  const openTodos = useOpenTodoCount(trip.groupId)

  return (
    <main data-testid="group-workspace" className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col">
      {/* The same header as every pushed screen; the back button is icon only. */}
      <ScreenHeader title={trip.tripName} subtitle={`${trip.destination} · ${owner ? 'Owner' : 'Member'}`}
        onBack={onBack} backLabel="Back to Trips" actions={<>
          <button type="button" className="round-btn" onClick={onOpenTodos}
            aria-label={openTodos ? `To-dos, ${openTodos} open` : 'To-dos'}>
            <IconChecklist size="md" />
            {openTodos ? <span className="round-btn__badge" aria-hidden="true">{openTodos > 99 ? '99+' : openTodos}</span> : null}
          </button>
          <button type="button" className="round-btn" aria-label="Trip settings" onClick={onOpenSettings}>
            <IconSettings size="md" />
          </button>
        </>} />

      {/* Keyed by Trip so opening another Trip remounts every tab with fresh state. */}
      <TripSections key={trip.groupId} trip={trip} tab={tab} onTabChange={onTabChange} onTripsChanged={onRefresh} />
    </main>
  )
}

function TripSections({ trip, tab, onTabChange, onTripsChanged }: {
  trip: MyGroupAccess
  tab: string
  onTabChange: (tab: TripSectionId) => void
  onTripsChanged: () => void
}) {
  const tabRefs = useRef<Partial<Record<TripSectionId, HTMLButtonElement | null>>>({})
  const { roster, reload } = useGroupRoster(trip.groupId)
  const TABS = tabsFor(trip)
  // A tab that disappears (e.g. FX after a Trip becomes domestic) falls back to the first.
  const current = TABS.find((entry) => entry.id === tab) ?? TABS[0]
  const currentIndex = TABS.findIndex((entry) => entry.id === current.id)

  const choose = (id: TripSectionId, focus = false) => {
    onTabChange(id)
    if (focus) tabRefs.current[id]?.focus()
    // A new section starts at its top, like a native tab bar.
    window.scrollTo({ top: 0 })
  }

  // Arrow keys move between tabs (WAI-ARIA tabs pattern, automatic activation).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((entry) => entry.id === current.id)
    const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length
      : event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    choose(TABS[next].id, true)
  }

  return (
    <>
      {/* Keyed by tab so each section settles in once when chosen (m-tab-enter); no exit. */}
      <div key={current.id} role="tabpanel" id="trip-tab-panel" aria-labelledby={`trip-tab-${current.id}`}
        className={`app-content trip-panel--${current.id} m-tab-enter flex-1`}>
        <current.Component trip={trip} roster={roster} reloadRoster={reload} onTripsChanged={onTripsChanged} />
      </div>
      <div className="tab-bar">
        {/* One accent line that slides to the active tab (motion.css). */}
        <span className="tab-bar__indicator" aria-hidden="true"
          style={{ '--tab-index': currentIndex, '--tab-count': TABS.length } as CSSProperties} />
        <div role="tablist" aria-label="Trip sections" className="tab-bar__inner" onKeyDown={onKeyDown}>
          {TABS.map((entry) => {
            const active = entry.id === current.id
            return (
              <button key={entry.id} ref={(node) => { tabRefs.current[entry.id] = node }} type="button" role="tab"
                id={`trip-tab-${entry.id}`} aria-selected={active} aria-controls="trip-tab-panel" tabIndex={active ? 0 : -1}
                onClick={() => choose(entry.id)} className={`nav-tab${active ? ' active' : ''}`}>
                <entry.Icon size="lg" />
                <span>{entry.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}
