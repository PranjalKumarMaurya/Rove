import { supabase } from '../../lib/supabase'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { NeonBtn } from '../../components/ui/NeonBtn'
import { ScreenFrame } from '../../components/ui/ScreenFrame'
import { AuthEntry } from './AuthEntry'
import { useAuthSession } from './authSession'
import { BootstrapOnboarding } from '../onboarding/BootstrapOnboarding'
import { InvitationEntry } from '../invitations/InvitationEntry'
import { clearPendingInvitation, pendingInvitationFromBrowser } from '../invitations/invitationLink'
import { JoinEntry } from '../invitations/JoinEntry'
import { clearPendingJoin, pendingJoinFromBrowser } from '../invitations/joinLink'
import { GroupWorkspace, type TripSectionId } from '../groups/GroupWorkspace'
import { loadMyGroupAccess, type MyGroupAccess } from '../groups/myGroupAccess'
import { HomeNav } from '../home/HomeNav'
import { TripsHome } from '../home/TripsHome'
import { useMyProfile } from '../profile/profileApi'
import { ProfileScreen } from '../profile/ProfileScreen'
import { TripSettingsScreen } from '../settings/TripSettingsScreen'
import { TripTodosScreen } from '../todos/TripTodosScreen'
import {
  adjacentTab, entryDepthOf, navDirection, planHistory, previousView, readRoveState, roveState, tripOf, viewDepth, viewKey,
  withRoveState, type View,
} from './navigationHistory'
import {
  clearLayerStyles, setLayerScroll, notifySwipeSettled, registerSwipeHost, runNavTransition, systemAnimatedBack, takeSwipeNavigation,
  type SwipeMode,
} from '../../lib/screenTransition'

/** The screen shown beside the current one during a swipe: beneath it (edge swipe back) or next to it (tab swipe). */
type SwipeLayer = { view: View; mode: SwipeMode; side?: 'left' | 'right' }

/**
 * Signed-in screens (`View`, see navigationHistory.ts). After sign-in the Trips home
 * always comes first; from there the person opens a Trip, creates one, or opens Profile.
 * An invite link (`#invite=`, one person by email) or a Trip's join link (`#join=`,
 * anyone with the link) opens its screen first, and joining opens that Trip. A Trip's
 * To-dos and Settings are full screens pushed above it (depth 2), so back, the system
 * gesture and the edge swipe return to the Trip, on the tab it was showing.
 * Screens are mirrored into the browser history so the system back gesture (and the
 * iOS edge swipe, EdgeSwipeBack) steps back through them.
 *
 * Motion (src/lib/screenTransition.ts): button navigation and the system back gesture
 * slide screens with a view transition. During an edge swipe the previous screen is
 * rendered beneath the current one (`underlay`), each in its own layer keyed by the
 * screen, so when the swipe completes the screen underneath simply becomes the current
 * one (same component instance, no remount, no flash). The tab swipe between the Trips
 * home and Profile-from-home (TabSwipe) uses the same layers, with the other tab beside
 * the current one instead of beneath it. Each screen's scroll position is remembered,
 * so going back returns to where the person was (the Trips home and a Trip).
 */

// The Trip open in this browser tab, so a reload returns to it (cleared on sign-out).
const openTripKey = 'trip:open-trip:v1'
function readOpenTrip(): string | null {
  try { return window.sessionStorage.getItem(openTripKey) } catch { return null }
}
function writeOpenTrip(groupId: string | null) {
  try {
    if (groupId) window.sessionStorage.setItem(openTripKey, groupId)
    else window.sessionStorage.removeItem(openTripKey)
  } catch { /* storage may be unavailable; a reload then shows the Trips home */ }
}

export function AuthBoundary() {
  const auth = useAuthSession()
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [groupAccess, setGroupAccess] = useState<'idle' | 'checking' | 'ready' | 'error'>('idle')
  const [groups, setGroups] = useState<MyGroupAccess[]>([])
  const [view, setView] = useState<View>({ kind: 'home' })
  const [groupReload, setGroupReload] = useState(0)
  // The tab each open Trip shows, so returning from its To-dos or Settings (or seeing it
  // beneath an edge swipe) shows the same tab. Opening a Trip afresh starts on its first.
  const [openTabs, setOpenTabs] = useState<Record<string, TripSectionId>>({})
  // A refresh (Crew changes, settings, focus, back to the Trips home) re-reads Trips in
  // the background so the open screen stays mounted.
  const backgroundReload = useRef(false)
  // A Trip to open once the next load lists it (just created, joined, or restored).
  const pendingOpen = useRef<string | null>(null)
  // The Trip this tab had open before a reload; restored once, on the first load.
  const restoreTrip = useRef<string | null>(readOpenTrip())
  const refreshTrips = () => {
    backgroundReload.current = true
    setGroupReload((value) => value + 1)
  }

  // History sync. `syncedKey` is the screen the current history entry describes,
  // `entryDepth` that entry's depth; `awaitingPop` is set while our own history.go(-n)
  // (a UI back button) is travelling, so its popstate does not change the screen again.
  const syncedKey = useRef(viewKey({ kind: 'home' }))
  const entryDepth = useRef(typeof window === 'undefined' ? 0 : entryDepthOf(window.history.state))
  const awaitingPop = useRef(false)
  const viewRef = useRef(view)
  viewRef.current = view

  /** Changes screen with the push/pop slide (see screenTransition.ts). */
  const navigate = (next: View) => {
    runNavTransition(navDirection(viewRef.current, next), () => setView(next))
  }

  // The other screen of a live swipe: the previous one beneath (edge swipe), or the
  // other home tab beside (tab swipe).
  const [underlay, setUnderlayState] = useState<SwipeLayer | null>(null)
  const underlayRef = useRef<SwipeLayer | null>(null)
  const setUnderlay = (next: SwipeLayer | null) => {
    underlayRef.current = next
    setUnderlayState(next)
  }
  const stackRef = useRef<HTMLDivElement>(null)
  // Where the swipe started: the screen, its scroll offset and the page height then.
  const swipeStart = useRef<{ fromKey: string; scrollY: number; pageHeight: number } | null>(null)
  // Scroll offset per screen (viewKey), so going back lands where the person left off.
  // Only the Trips home is recorded (see the scroll listener).
  const scrollMemory = useRef(new Map<string, number>())
  const shownView = useRef(view)

  useEffect(() => {
    const key = viewKey(view)
    if (key === syncedKey.current) return
    syncedKey.current = key
    const target = viewDepth(view)
    const plan = planHistory(entryDepth.current, target)
    try {
      if (plan.kind === 'push') {
        // One entry per depth level, so going back always lands on the right level.
        for (let step = 1; step <= plan.count; step += 1) {
          window.history.pushState(roveState(view, entryDepth.current + step), '')
        }
      } else if (plan.kind === 'back') {
        awaitingPop.current = true
        window.history.go(-plan.count)
      } else {
        window.history.replaceState(withRoveState(window.history.state, view, target), '')
      }
    } catch { /* history may be unavailable (sandboxed frames); the screens still work */ }
    entryDepth.current = target
  }, [view])

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const entry = readRoveState(event.state)
      if (awaitingPop.current) {
        // Our own back step landed: record the screen now showing on this entry.
        awaitingPop.current = false
        const current = viewRef.current
        try { window.history.replaceState(withRoveState(event.state, current), '') } catch { /* see above */ }
        entryDepth.current = viewDepth(current)
        syncedKey.current = viewKey(current)
        return
      }
      // Following an invite link inside the app is handled by the hashchange listener.
      const ours = !!event.state && typeof event.state === 'object' && 'rove' in event.state
      if (!ours && /^#(invite|join)=/u.test(window.location.hash)) return
      entryDepth.current = entry.roveDepth
      syncedKey.current = viewKey(entry.rove)
      // The edge swipe (or the browser) already animated this step back.
      if (takeSwipeNavigation() || systemAnimatedBack(event)) setView(entry.rove)
      else runNavTransition(navDirection(viewRef.current, entry.rove), () => setView(entry.rove))
      // As goHome does; a Trip that is no longer listed falls back to the Trips home on reload.
      refreshTrips()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Scroll positions are ours to restore (the screens are React state, not pages).
  useEffect(() => {
    try { if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual' } catch { /* see above */ }
    // The Trips home, and a Trip when coming back from its To-dos or Settings, return where
    // they were. A Trip opened afresh starts on its first tab, at the top (a push).
    const onScroll = () => {
      const current = viewRef.current
      if (!swipeStart.current && (current.kind === 'home' || current.kind === 'trip')) scrollMemory.current.set(viewKey(current), window.scrollY)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // The edge swipe asks for the previous screen underneath (EdgeSwipeBack), the tab
  // swipe for the other home tab beside the current screen (TabSwipe).
  useEffect(() => registerSwipeHost({
    begin: (mode) => {
      const current = viewRef.current
      const tab = mode === 'tab' ? adjacentTab(current) : null
      const other = mode === 'tab' ? tab?.view ?? null : previousView(current)
      if (!other || !stackRef.current || underlayRef.current) return false
      // Read before the layers change, while the page still has its normal layout.
      swipeStart.current = {
        fromKey: viewKey(current), scrollY: window.scrollY, pageHeight: document.documentElement.scrollHeight,
      }
      flushSync(() => setUnderlay({ view: other, mode, side: tab?.side }))
      if (stackRef.current?.querySelector('[data-screen-layer="underlay"]')) return true
      flushSync(() => setUnderlay(null))
      return false
    },
    cancel: () => flushSync(() => setUnderlay(null)),
    tabSide: () => adjacentTab(viewRef.current)?.side ?? null,
    switchTab: () => {
      const tab = adjacentTab(viewRef.current)
      if (!tab) return
      // As goHome does.
      if (tab.view.kind === 'home') refreshTrips()
      const layer = underlayRef.current
      // The tab layer is already where the screen belongs: it simply becomes the screen
      // (the history follows as for the HomeNav buttons: Profile pushes, Trips goes back).
      if (layer?.mode === 'tab' && viewKey(layer.view) === viewKey(tab.view)) flushSync(() => setView(tab.view))
      else navigate(tab.view)
    },
  }), [])

  // Swipe layers: lift both screens into viewport-sized layers, each showing its page
  // where it was scrolled to, and put them back when a cancelled swipe has settled.
  useLayoutEffect(() => {
    const stack = stackRef.current
    const start = swipeStart.current
    if (!stack || !start || viewKey(viewRef.current) !== start.fromKey) return
    const current = stack.querySelector<HTMLElement>('[data-screen-layer="current"]')
    if (underlay) {
      // Keep the page height so the window keeps its scroll offset meanwhile.
      stack.style.minHeight = `${start.pageHeight}px`
      if (current) setLayerScroll(current, start.scrollY)
      const under = stack.querySelector<HTMLElement>('[data-screen-layer="underlay"]')
      if (under) {
        under.setAttribute('inert', '')
        setLayerScroll(under, scrollMemory.current.get(viewKey(underlay.view)) ?? 0)
      }
    } else {
      swipeStart.current = null
      stack.style.minHeight = ''
      if (current) clearLayerStyles(current)
      window.scrollTo(0, start.scrollY)
    }
  }, [underlay])

  // A new screen: restore its scroll offset when going back, start at the top otherwise.
  // When a swipe brought it here, the layer it was shown in becomes the plain screen in
  // this same frame.
  useLayoutEffect(() => {
    const previous = shownView.current
    shownView.current = view
    if (viewKey(previous) === viewKey(view)) return
    const swiped = swipeStart.current
    if (swiped) {
      swipeStart.current = null
      const stack = stackRef.current
      if (stack) {
        stack.style.minHeight = ''
        stack.querySelectorAll<HTMLElement>('[data-screen-layer]').forEach(clearLayerStyles)
      }
      setUnderlay(null)
    }
    const back = viewDepth(view) < viewDepth(previous)
    window.scrollTo(0, back ? scrollMemory.current.get(viewKey(view)) ?? 0 : 0)
    if (swiped) notifySwipeSettled()
  }, [view])

  const [inviteProof, setInviteProof] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    let storage: Storage | null = null
    try { storage = window.localStorage } catch { /* private browsing may deny storage */ }
    return pendingInvitationFromBrowser(window.location.hash, storage).proof
  })

  // A Trip join link ("anyone with the link can join"), kept through sign-in and sign-up.
  const [joinProof, setJoinProof] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    let storage: Storage | null = null
    try { storage = window.localStorage } catch { /* private browsing may deny storage */ }
    return pendingJoinFromBrowser(window.location.hash, storage).proof
  })

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash
      if (!hash.startsWith('#invite=') && !hash.startsWith('#join=')) return
      let storage: Storage | null = null
      try { storage = window.localStorage } catch { /* private browsing may deny storage */ }
      if (hash.startsWith('#join=')) setJoinProof(pendingJoinFromBrowser(hash, storage).proof)
      else setInviteProof(pendingInvitationFromBrowser(hash, storage).proof)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    // A reload on a Trip's To-dos or Settings returns to that Trip.
    const open = view.kind === 'trip' || view.kind === 'todos' || view.kind === 'settings' ? tripOf(view) : null
    if (open) writeOpenTrip(open)
    else if (view.kind === 'home') writeOpenTrip(null)
  }, [view])

  const clearSavedInvitation = () => {
    try { clearPendingInvitation(window.localStorage) } catch { /* storage may be unavailable */ }
    if (window.location.hash.startsWith('#invite=')) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    }
  }

  const closeInvitation = () => {
    clearSavedInvitation()
    setInviteProof(null)
  }

  const closeJoin = () => {
    try { clearPendingJoin(window.localStorage) } catch { /* storage may be unavailable */ }
    if (window.location.hash.startsWith('#join=')) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    }
    setJoinProof(null)
  }

  const goHome = () => {
    navigate({ kind: 'home' })
    refreshTrips()
  }

  /** Open a Trip; one not listed yet (or `reload`) opens after the Trip list is re-read. */
  const openTrip = (groupId: string, { reload = false, animate = true }: { reload?: boolean; animate?: boolean } = {}) => {
    // Opened afresh: its first tab.
    setOpenTabs((current) => {
      if (!(groupId in current)) return current
      const next = { ...current }
      delete next[groupId]
      return next
    })
    if (reload || !groups.some((group) => group.groupId === groupId)) {
      pendingOpen.current = groupId
      refreshTrips()
    }
    if (animate) navigate({ kind: 'trip', groupId })
    else setView({ kind: 'trip', groupId })
  }

  const resetSignedIn = () => {
    restoreTrip.current = null
    pendingOpen.current = null
    writeOpenTrip(null)
    scrollMemory.current.clear()
    // Signing out starts again at the Trips home without stepping back through history.
    awaitingPop.current = false
    entryDepth.current = 0
    syncedKey.current = viewKey({ kind: 'home' })
    try { window.history.replaceState(withRoveState(window.history.state, { kind: 'home' }, 0), '') } catch { /* see above */ }
    setView({ kind: 'home' })
  }

  const signOut = async () => {
    setSignOutError(null)
    const { error } = await supabase.auth.signOut()
    if (error) {
      setSignOutError('We could not sign you out. Check your connection and try again.')
      return
    }
    resetSignedIn()
    auth.markSignedOut()
  }

  const accountDeleted = () => {
    resetSignedIn()
    auth.markSignedOut('deleted')
    // The account no longer exists on the server, so only the local session is cleared.
    void supabase.auth.signOut({ scope: 'local' })
  }

  const profileId = auth.status === 'authenticated-linked' ? auth.profileId : null
  const userId = auth.status === 'authenticated-linked' ? auth.session.user.id : null
  const myProfile = useMyProfile(userId)

  useEffect(() => {
    if (!profileId) return
    window.addEventListener('focus', refreshTrips)
    return () => window.removeEventListener('focus', refreshTrips)
  }, [profileId])

  useEffect(() => {
    if (!profileId) {
      setGroupAccess('idle')
      setGroups([])
      return
    }
    let active = true
    const background = backgroundReload.current && groupAccess === 'ready'
    backgroundReload.current = false
    // This load was started for the Trip waiting to open (if any), so it settles that Trip.
    const pendingAtStart = pendingOpen.current
    if (!background) setGroupAccess('checking')
    const timeout = background ? undefined : window.setTimeout(() => {
      if (active) setGroupAccess('error')
    }, 1500)
    void (async () => {
      try {
        const data = await loadMyGroupAccess()
        window.clearTimeout(timeout)
        if (!active) return
        const listed = (groupId: string) => data.some((group) => group.groupId === groupId)
        if (pendingAtStart && pendingOpen.current === pendingAtStart) pendingOpen.current = null
        const stillPending = pendingOpen.current
        const restore = restoreTrip.current
        restoreTrip.current = null
        setGroups(data)
        setGroupAccess('ready')
        setView((current) => {
          if (restore && current.kind === 'home' && listed(restore)) return { kind: 'trip', groupId: restore }
          // An open Trip the person lost (left, removed, archived), or its To-dos or
          // Settings, returns to the Trips home.
          const open = current.kind === 'trip' || current.kind === 'todos' || current.kind === 'settings' ? current.groupId : null
          if (open && !listed(open) && open !== stillPending) return { kind: 'home' }
          return current
        })
      } catch {
        window.clearTimeout(timeout)
        // A failed background refresh keeps the Trips already shown.
        if (active && !background) setGroupAccess('error')
      }
    })()
    return () => {
      active = false
      window.clearTimeout(timeout)
    }
  }, [profileId, groupReload])

  if (auth.status === 'loading') return <AuthEntry mode="restoring" />
  if (auth.status === 'error') return <AuthEntry mode="error" onRetry={auth.retry} />
  if (auth.status === 'signed-out' && auth.reason === 'recovery') return <AuthEntry mode="reset" />
  if (inviteProof) {
    return <InvitationEntry proof={inviteProof} auth={auth} onSignOut={() => void signOut()} onClose={closeInvitation}
      onAccepted={() => {
        clearSavedInvitation()
        refreshTrips()
      }}
      onOpenTrip={(groupId) => {
        closeInvitation()
        // The invitation screen is leaving too, so this is a plain switch.
        openTrip(groupId, { reload: true, animate: false })
      }} signOutError={signOutError} />
  }
  if (joinProof) {
    return <JoinEntry proof={joinProof} auth={auth} onClose={closeJoin}
      onOpenTrip={(groupId) => {
        closeJoin()
        // The join screen is leaving too, so this is a plain switch.
        openTrip(groupId, { reload: true, animate: false })
      }} />
  }
  if (auth.status === 'signed-out') {
    return <AuthEntry mode={auth.reason === 'expired' ? 'expired' : 'sign-in'}
      contextMessage={auth.reason === 'deleted' ? 'Your account was deleted. Thanks for travelling with us.' : undefined} />
  }

  if (auth.status === 'authenticated-unlinked') {
    return (
      <ScreenFrame testId="workspace-unavailable" title="Your account isn’t ready yet"
        lede="We couldn’t finish setting up your account, so no Trips were opened. Sign out, then sign in again.">
        {signOutError && <p role="status" className="notice notice--error mb-4">{signOutError}</p>}
        <NeonBtn type="button" size="lg" className="w-full" onClick={() => void signOut()}>Sign out</NeonBtn>
      </ScreenFrame>
    )
  }

  if (groupAccess === 'checking' || groupAccess === 'idle') {
    return <AuthEntry mode="restoring" />
  }

  if (groupAccess === 'error') {
    return (
      <ScreenFrame testId="workspace-unavailable" title="We couldn’t load your Trips"
        lede={<>Signed in as {auth.displayName}. Check your connection and try again.</>}>
        {signOutError && <p role="status" className="notice notice--error mb-4">{signOutError}</p>}
        <div className="flex flex-col gap-3">
          <NeonBtn type="button" size="lg" className="w-full" onClick={() => setGroupReload((value) => value + 1)}>Try again</NeonBtn>
          <NeonBtn type="button" variant="ghost" size="lg" className="w-full" onClick={() => void signOut()}>Sign out</NeonBtn>
        </div>
      </ScreenFrame>
    )
  }

  const accountName = myProfile.profile?.displayName || auth.displayName

  /** One signed-in screen. The swipe underlay renders through here too (inert, never interacted with). */
  const renderScreen = (screen: View) => {
    if (screen.kind === 'profile') {
      const from = screen.from
      const back = from.kind === 'trip' ? groups.find((group) => group.groupId === from.groupId) : undefined
      return <ProfileScreen userId={auth.session.user.id} email={auth.session.user.email} profile={myProfile.profile}
        profileStatus={myProfile.status} onProfileChanged={myProfile.patch} onReload={myProfile.reload}
        onBack={back ? () => navigate({ kind: 'trip', groupId: back.groupId }) : undefined} backLabel={back?.tripName}
        bottomNav={back ? undefined : <HomeNav active="profile" onTrips={goHome} onCreate={() => navigate({ kind: 'create' })}
          onProfile={() => window.scrollTo({ top: 0, behavior: 'smooth' })} profile={myProfile.profile} accountName={accountName} />}
        onSignOut={() => void signOut()} signOutError={signOutError} onAccountDeleted={accountDeleted} />
    }

    if (screen.kind === 'create') {
      // The new Trip may still be loading, so it appears without a slide.
      return <BootstrapOnboarding onBack={goHome} homeCurrency={myProfile.profile?.homeCurrency}
        onContinue={(groupId) => openTrip(groupId, { reload: true, animate: false })} />
    }

    if (screen.kind === 'trip') {
      const trip = groups.find((group) => group.groupId === screen.groupId)
      // Waiting for the Trip list that includes a just-created or just-joined Trip.
      if (!trip) return <AuthEntry mode="restoring" />
      // Profile lives on the home screen (bottom nav, swipe); a Trip shows only its own settings.
      const groupId = trip.groupId
      return <GroupWorkspace trip={trip} onBack={goHome} onRefresh={refreshTrips}
        tab={openTabs[groupId] ?? 'trip'} onTabChange={(tab) => setOpenTabs((current) => ({ ...current, [groupId]: tab }))}
        onOpenTodos={() => navigate({ kind: 'todos', groupId })} onOpenSettings={() => navigate({ kind: 'settings', groupId })} />
    }

    if (screen.kind === 'todos' || screen.kind === 'settings') {
      const trip = groups.find((group) => group.groupId === screen.groupId)
      if (!trip) return <AuthEntry mode="restoring" />
      const back = () => navigate({ kind: 'trip', groupId: trip.groupId })
      return screen.kind === 'todos'
        ? <TripTodosScreen trip={trip} onBack={back} />
        : <TripSettingsScreen trip={trip} onBack={back} onTripsChanged={refreshTrips} />
    }

    return <TripsHome trips={groups} profile={myProfile.profile} accountName={accountName}
      onCreate={() => navigate({ kind: 'create' })} onOpenTrip={openTrip}
      onOpenProfile={() => navigate({ kind: 'profile', from: { kind: 'home' } })}
      onInvite={(link) => {
        let storage: Storage | null = null
        try { storage = window.localStorage } catch { /* private browsing may deny storage */ }
        if (link.kind === 'join') setJoinProof(pendingJoinFromBrowser(`#join=${link.proof}`, storage).proof)
        else setInviteProof(pendingInvitationFromBrowser(`#invite=${link.proof}`, storage).proof)
      }} />
  }

  // Each screen sits in a layer keyed by the screen, so the one shown underneath (edge
  // swipe) or beside (tab swipe) keeps its component instance when it becomes the
  // current screen.
  const swiping = underlay !== null && viewKey(underlay.view) !== viewKey(view)
  const paging = swiping && underlay.mode === 'tab'
  const currentClass = !swiping ? 'rove-layer' : paging ? 'rove-layer rove-layer--lifted rove-layer--paging' : 'rove-layer rove-layer--lifted'
  return (
    <div ref={stackRef} className="rove-stack">
      {swiping && (
        <div key={viewKey(underlay.view)} data-screen-layer="underlay" data-side={underlay.side}
          className={paging ? 'rove-layer rove-layer--under rove-layer--beside' : 'rove-layer rove-layer--under'} aria-hidden="true">
          {renderScreen(underlay.view)}
        </div>
      )}
      {swiping && !paging && <div key="rove-dim" data-screen-dim="" className="rove-dim" aria-hidden="true" />}
      <div key={viewKey(view)} data-screen-layer="current" className={currentClass}>
        {renderScreen(view)}
      </div>
    </div>
  )
}
