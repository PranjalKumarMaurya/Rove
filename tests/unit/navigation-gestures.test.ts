import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adjacentTab, entryDepthOf, navDirection, planHistory, previousView, readRoveState, roveState, tripOf, viewDepth, viewKey, withRoveState,
  type View,
} from '../../src/features/auth/navigationHistory.ts'
import {
  classifySwipe, completionDuration, isStandaloneDisplay, shouldCompleteSwipe, startsAtEdge, swipeProgress,
  swipeVelocity, underlayDim, underlayShift,
} from '../../src/lib/edgeSwipe.ts'
import {
  TAB_RESISTANCE_MAX, classifyTabSwipe, shouldSwitchTab, tabDragDxForOffset, tabDragOffset, tabNeighborOffset,
  tabProgress, tabSwitchDuration, tabSwitchTarget,
} from '../../src/lib/tabSwipe.ts'
import { celebrate, onCelebrate, shouldCoalesce } from '../../src/lib/celebrate.ts'

const home: View = { kind: 'home' }
const trip: View = { kind: 'trip', groupId: 'g1' }
const create: View = { kind: 'create' }
const profileFromHome: View = { kind: 'profile', from: { kind: 'home' } }
const profileFromTrip: View = { kind: 'profile', from: { kind: 'trip', groupId: 'g1' } }
const todos: View = { kind: 'todos', groupId: 'g1' }
const settings: View = { kind: 'settings', groupId: 'g1' }

test('screens have depths: home 0, Trip/Create/Profile 1, Profile from a Trip 2', () => {
  assert.equal(viewDepth(home), 0)
  assert.equal(viewDepth(trip), 1)
  assert.equal(viewDepth(create), 1)
  assert.equal(viewDepth(profileFromHome), 1)
  assert.equal(viewDepth(profileFromTrip), 2)
  assert.notEqual(viewKey(trip), viewKey({ kind: 'trip', groupId: 'g2' }))
  assert.notEqual(viewKey(profileFromHome), viewKey(profileFromTrip))
})

test('going deeper pushes, going back pops, moving sideways replaces', () => {
  assert.deepEqual(planHistory(viewDepth(home), viewDepth(trip)), { kind: 'push', count: 1 })
  assert.deepEqual(planHistory(viewDepth(trip), viewDepth(profileFromTrip)), { kind: 'push', count: 1 })
  assert.deepEqual(planHistory(viewDepth(profileFromTrip), viewDepth(trip)), { kind: 'back', count: 1 })
  assert.deepEqual(planHistory(viewDepth(trip), viewDepth(home)), { kind: 'back', count: 1 })
  assert.deepEqual(planHistory(viewDepth(profileFromTrip), viewDepth(home)), { kind: 'back', count: 2 })
  // Create → the new Trip: back from the Trip returns home, not to the form.
  assert.deepEqual(planHistory(viewDepth(create), viewDepth(trip)), { kind: 'replace' })
  assert.deepEqual(planHistory(0, 0), { kind: 'replace' })
  // A reload restored a deeper entry: the restored Trip reuses it.
  assert.deepEqual(planHistory(1, viewDepth(trip)), { kind: 'replace' })
})

test('history state round-trips, and anything foreign reads as the Trips home', () => {
  assert.deepEqual(readRoveState(roveState(profileFromTrip)), { rove: profileFromTrip, roveDepth: 2 })
  assert.deepEqual(readRoveState(roveState(trip, 3)), { rove: trip, roveDepth: 3 })
  for (const foreign of [null, undefined, 'x', {}, { rove: { kind: 'trip' } }, { rove: { kind: 'nope' } },
    { rove: { kind: 'profile', from: { kind: 'trip', groupId: '' } } }]) {
    assert.deepEqual(readRoveState(foreign), { rove: home, roveDepth: 0 })
  }
  assert.equal(readRoveState({ rove: trip, roveDepth: -1 }).roveDepth, 1, 'a bad depth falls back to the view’s depth')
  assert.equal(entryDepthOf(null), 0)
  assert.equal(entryDepthOf(roveState(trip)), 1)
  assert.deepEqual(withRoveState({ other: 1 }, create), { other: 1, rove: create, roveDepth: 1 })
})

test('an edge swipe starts only at the left edge and commits only when mostly horizontal', () => {
  assert.equal(startsAtEdge(0), true)
  assert.equal(startsAtEdge(24), true)
  assert.equal(startsAtEdge(25), false)
  assert.equal(classifySwipe(3, 2), 'pending')
  assert.equal(classifySwipe(20, 4), 'horizontal')
  assert.equal(classifySwipe(20, 18), 'cancel', 'diagonal is a scroll')
  assert.equal(classifySwipe(-20, 0), 'cancel', 'leftward is not back')
  assert.equal(classifySwipe(2, 30), 'cancel', 'vertical is a scroll')
})

test('release goes back past 35% of the width or on a fast flick', () => {
  assert.equal(shouldCompleteSwipe(140, 400, 0), true)
  assert.equal(shouldCompleteSwipe(139, 400, 0.2), false)
  assert.equal(shouldCompleteSwipe(60, 400, 0.8), true)
  assert.equal(shouldCompleteSwipe(4, 400, 2), false, 'a twitch is not a flick')
  assert.equal(shouldCompleteSwipe(0, 400, 2), false)
  assert.equal(swipeVelocity([{ x: 0, t: 0 }, { x: 50, t: 100 }]), 0.5)
  assert.equal(swipeVelocity([{ x: 0, t: 0 }, { x: 10, t: 300 }, { x: 70, t: 400 }]), 0.6, 'only recent samples count')
  assert.equal(swipeVelocity([{ x: 0, t: 0 }]), 0)
})

test('the screen under a swipe is the one a level back in the history stack', () => {
  assert.equal(previousView(home), null, 'nothing below the Trips home')
  assert.deepEqual(previousView(trip), home)
  assert.deepEqual(previousView(create), home)
  assert.deepEqual(previousView(profileFromHome), home)
  assert.deepEqual(previousView(profileFromTrip), trip, 'Profile from a Trip sits on that Trip')
  // It is always exactly one depth level up.
  for (const view of [trip, create, profileFromHome, profileFromTrip]) {
    assert.equal(viewDepth(previousView(view)!), viewDepth(view) - 1)
  }
})

test('button navigation pushes deeper, pops shallower, and moves sideways forward', () => {
  assert.equal(navDirection(home, trip), 'push')
  assert.equal(navDirection(trip, profileFromTrip), 'push')
  assert.equal(navDirection(profileFromTrip, trip), 'pop')
  assert.equal(navDirection(trip, home), 'pop')
  assert.equal(navDirection(profileFromTrip, home), 'pop')
  assert.equal(navDirection(create, trip), 'push', 'Create → the new Trip reads as forward')
  assert.equal(navDirection(trip, { kind: 'trip', groupId: 'g1' }), 'none')
  assert.equal(navDirection(home, home), 'none')
})

test('Trips and Profile-from-home are side-by-side tabs; taps between them slide sideways', () => {
  assert.deepEqual(adjacentTab(home), { view: profileFromHome, side: 'right' }, 'Profile is to the right of Trips')
  assert.deepEqual(adjacentTab(profileFromHome), { view: home, side: 'left' }, 'Trips is to the left of Profile')
  for (const view of [trip, create, profileFromTrip]) assert.equal(adjacentTab(view), null)
  assert.equal(navDirection(home, profileFromHome), 'tab-left')
  assert.equal(navDirection(profileFromHome, home), 'tab-right')
  // Other moves keep the push/pop.
  assert.equal(navDirection(profileFromHome, create), 'push')
  assert.equal(navDirection(profileFromTrip, home), 'pop')
  // The history still treats Profile-from-home as one level above the Trips home.
  assert.deepEqual(planHistory(viewDepth(home), viewDepth(adjacentTab(home)!.view)), { kind: 'push', count: 1 })
  assert.deepEqual(planHistory(viewDepth(profileFromHome), viewDepth(adjacentTab(profileFromHome)!.view)), { kind: 'back', count: 1 })
})

test('a Trip’s To-dos and Settings are full screens one level above that Trip', () => {
  assert.equal(viewDepth(todos), 2)
  assert.equal(viewDepth(settings), 2)
  assert.notEqual(viewKey(todos), viewKey(settings))
  assert.notEqual(viewKey(todos), viewKey(trip))
  assert.notEqual(viewKey(settings), viewKey({ kind: 'settings', groupId: 'g2' }))
  // Opening from the Trip header pushes one entry; back (button, system gesture or edge swipe) pops it.
  assert.deepEqual(planHistory(viewDepth(trip), viewDepth(todos)), { kind: 'push', count: 1 })
  assert.deepEqual(planHistory(viewDepth(settings), viewDepth(trip)), { kind: 'back', count: 1 })
  // Losing the Trip from Settings (leave, archive) returns straight to the Trips home.
  assert.deepEqual(planHistory(viewDepth(settings), viewDepth(home)), { kind: 'back', count: 2 })
  assert.equal(navDirection(trip, todos), 'push')
  assert.equal(navDirection(trip, settings), 'push')
  assert.equal(navDirection(todos, trip), 'pop')
  assert.equal(navDirection(settings, home), 'pop')
  // The edge swipe shows the Trip underneath.
  assert.deepEqual(previousView(todos), trip)
  assert.deepEqual(previousView(settings), trip)
  for (const view of [todos, settings]) {
    assert.equal(viewDepth(previousView(view)!), viewDepth(view) - 1)
    assert.equal(adjacentTab(view), null, 'no tab swipe from a pushed screen')
    assert.deepEqual(readRoveState(roveState(view)), { rove: view, roveDepth: 2 })
  }
  for (const foreign of [{ rove: { kind: 'todos' } }, { rove: { kind: 'settings', groupId: '' } }, { rove: { kind: 'todos', groupId: 3 } }]) {
    assert.deepEqual(readRoveState(foreign), { rove: home, roveDepth: 0 })
  }
  assert.equal(tripOf(todos), 'g1')
  assert.equal(tripOf(settings), 'g1')
  assert.equal(tripOf(trip), 'g1')
  assert.equal(tripOf(profileFromTrip), 'g1')
  assert.equal(tripOf(home), null)
  assert.equal(tripOf(create), null)
  assert.equal(tripOf(profileFromHome), null)
})

test('a tab swipe commits after 10px only when clearly sideways, either way', () => {
  assert.equal(classifyTabSwipe(9, 0), 'pending')
  assert.equal(classifyTabSwipe(-9, 9), 'pending')
  assert.equal(classifyTabSwipe(-12, 4), 'horizontal')
  assert.equal(classifyTabSwipe(12, 4), 'horizontal')
  assert.equal(classifyTabSwipe(15, 10), 'cancel', 'exactly 1.5× is not enough')
  assert.equal(classifyTabSwipe(16, 10), 'horizontal')
  assert.equal(classifyTabSwipe(3, 14), 'cancel', 'vertical is a scroll')
})

test('dragging towards the other tab is 1:1; the wrong way rubber-bands, capped at 48px', () => {
  // On Trips (Profile on the right) the finger drags left.
  assert.equal(tabDragOffset(-120, 'right', 400), -120)
  assert.equal(tabDragOffset(-500, 'right', 400), -400, 'never past a full width')
  assert.equal(tabDragOffset(100, 'right', 400), 25)
  assert.equal(tabDragOffset(1000, 'right', 400), TAB_RESISTANCE_MAX)
  // On Profile (Trips on the left) the finger drags right.
  assert.equal(tabDragOffset(120, 'left', 400), 120)
  assert.equal(tabDragOffset(-100, 'left', 400), -25)
  assert.equal(tabDragOffset(-1000, 'left', 400), -TAB_RESISTANCE_MAX)
  assert.equal(tabDragOffset(0, 'left', 400), 0)
  // Catching a moving screen continues from where it is.
  for (const [offset, side] of [[-80, 'right'], [20, 'right'], [80, 'left'], [-20, 'left']] as const) {
    assert.equal(tabDragOffset(tabDragDxForOffset(offset, side), side, 400), offset)
  }
  assert.equal(tabProgress(-100, 'right'), 100)
  assert.equal(tabProgress(100, 'right'), -100)
})

test('the other tab stays edge to edge with the current screen', () => {
  assert.equal(tabNeighborOffset(0, 'right', 400), 400, 'Profile waits just off the right edge')
  assert.equal(tabNeighborOffset(-150, 'right', 400), 250)
  assert.equal(tabNeighborOffset(0, 'left', 400), -400, 'Trips waits just off the left edge')
  assert.equal(tabNeighborOffset(150, 'left', 400), -250)
  assert.equal(tabNeighborOffset(tabSwitchTarget('right', 400), 'right', 400), 0, 'a switch ends with it in place')
  assert.equal(tabNeighborOffset(tabSwitchTarget('left', 400), 'left', 400), 0)
})

test('release switches past 30% or on a flick towards the other tab, never the wrong way', () => {
  assert.equal(shouldSwitchTab(-120, 400, 0, 'right'), true)
  assert.equal(shouldSwitchTab(-119, 400, 0.1, 'right'), false)
  assert.equal(shouldSwitchTab(-40, 400, -0.6, 'right'), true, 'a leftward flick on Trips')
  assert.equal(shouldSwitchTab(-40, 400, 0.6, 'right'), false, 'flicking back towards rest')
  assert.equal(shouldSwitchTab(40, 400, 0.6, 'left'), true, 'a rightward flick on Profile')
  assert.equal(shouldSwitchTab(120, 400, 0, 'left'), true)
  assert.equal(shouldSwitchTab(25, 400, 2, 'right'), false, 'rubber-banded the wrong way')
  assert.equal(shouldSwitchTab(-25, 400, -2, 'left'), false)
  assert.equal(shouldSwitchTab(0, 400, -2, 'right'), false)
  assert.equal(shouldSwitchTab(-200, 0, 0, 'right'), false)
})

test('a switch finishes at the finger’s speed, within 180–300ms', () => {
  assert.equal(tabSwitchDuration(-150, 400, -1, 'right'), 250, '250px left at 1px/ms')
  assert.equal(tabSwitchDuration(150, 400, 1, 'left'), 250)
  assert.equal(tabSwitchDuration(-100, 400, -5, 'right'), 180, 'a hard flick is never a jump')
  assert.equal(tabSwitchDuration(-150, 400, -0.1, 'right'), 300, 'a slow release still finishes briskly')
  assert.equal(tabSwitchDuration(-150, 400, 1, 'right'), 300, 'moving the other way: the longest')
  assert.equal(tabSwitchDuration(-400, 400, -1, 'right'), 180, 'nothing left to travel')
})

test('during a swipe the screen underneath slides in from -30% and its dim fades', () => {
  assert.equal(swipeProgress(0, 400), 0)
  assert.equal(swipeProgress(200, 400), 0.5)
  assert.equal(swipeProgress(500, 400), 1)
  assert.equal(swipeProgress(-10, 400), 0)
  assert.equal(swipeProgress(10, 0), 0)
  assert.equal(underlayShift(0, 400), -120)
  assert.equal(underlayShift(0.5, 400), -60)
  assert.equal(underlayShift(1, 400) === 0, true)
  assert.equal(underlayDim(0), 0.35)
  assert.ok(Math.abs(underlayDim(0.5) - 0.175) < 1e-9)
  assert.equal(underlayDim(1), 0)
  assert.equal(underlayDim(2), 0, 'clamped')
})

test('a completed swipe finishes at the finger’s speed, within 180–320ms', () => {
  assert.equal(completionDuration(250, 1), 250, 'remaining distance at the release speed')
  assert.equal(completionDuration(300, 3), 180, 'a hard flick is never a jump')
  assert.equal(completionDuration(300, 0.2), 320, 'a slow release still finishes briskly')
  assert.equal(completionDuration(300, 0), 320, 'no speed: the longest')
  assert.equal(completionDuration(300, -1), 320, 'moving back left: the longest')
  assert.equal(completionDuration(0, 1), 180)
})

test('standalone detection accepts iOS navigator.standalone or display-mode', () => {
  assert.equal(isStandaloneDisplay(true, false), true)
  assert.equal(isStandaloneDisplay(undefined, true), true)
  assert.equal(isStandaloneDisplay(false, false), false)
  assert.equal(isStandaloneDisplay('true', false), false)
})

test('celebrations close together are one tick; later ones are new', () => {
  assert.equal(shouldCoalesce(1000, null), false)
  assert.equal(shouldCoalesce(1300, 1000), true)
  assert.equal(shouldCoalesce(1700, 1000), false)
  const seen: { id: number; label: string }[] = []
  const stop = onCelebrate((celebration) => seen.push(celebration))
  celebrate('Expense added')
  celebrate('Added to Split')
  celebrate('   ')
  stop()
  celebrate('ignored after unsubscribe')
  assert.equal(seen.length, 3)
  assert.equal(seen[0].id, seen[1].id, 'a second report of the same action relabels, not replays')
  assert.equal(seen[1].label, 'Added to Split')
  assert.equal(seen[2].label, 'Saved')
})

test('a follow-up only relabels a tick still showing and never starts one', async () => {
  const seen: { id: number; label: string }[] = []
  const stop = onCelebrate((celebration) => seen.push(celebration))
  await new Promise((resolve) => setTimeout(resolve, 1300))
  celebrate('Added to Split', { followUp: true })
  assert.equal(seen.length, 0, 'nothing showing, so nothing to relabel')
  celebrate('Expense added')
  celebrate('Added to Split', { followUp: true })
  stop()
  assert.equal(seen.length, 2)
  assert.equal(seen[0].id, seen[1].id)
  assert.equal(seen[1].label, 'Added to Split')
})
