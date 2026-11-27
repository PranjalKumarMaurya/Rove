import assert from 'node:assert/strict'
import test from 'node:test'
import {
  entryDepthOf, navDirection, planHistory, previousView, readRoveState, roveState, viewDepth, viewKey, withRoveState,
  type View,
} from '../../src/features/auth/navigationHistory.ts'
import {
  classifySwipe, completionDuration, isStandaloneDisplay, shouldCompleteSwipe, startsAtEdge, swipeProgress,
  swipeVelocity, underlayDim, underlayShift,
} from '../../src/lib/edgeSwipe.ts'
import { celebrate, onCelebrate, shouldCoalesce } from '../../src/lib/celebrate.ts'

const home: View = { kind: 'home' }
const trip: View = { kind: 'trip', groupId: 'g1' }
const create: View = { kind: 'create' }
const profileFromHome: View = { kind: 'profile', from: { kind: 'home' } }
const profileFromTrip: View = { kind: 'profile', from: { kind: 'trip', groupId: 'g1' } }

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
