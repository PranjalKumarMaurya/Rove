import assert from 'node:assert/strict'
import test from 'node:test'
import {
  entryDepthOf, planHistory, readRoveState, roveState, viewDepth, viewKey, withRoveState, type View,
} from '../../src/features/auth/navigationHistory.ts'
import {
  classifySwipe, isStandaloneDisplay, shouldCompleteSwipe, startsAtEdge, swipeVelocity,
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
