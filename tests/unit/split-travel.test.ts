import assert from 'node:assert/strict'
import test from 'node:test'

import { awayMembers, legLabel, type TravelLeg } from '../../src/features/split/travelRules.ts'

const crew = ['me', 'kittu', 'bittu', 'harshit', 'priyanshu', 'dhruv', 'cheeku']
const train: TravelLeg = {
  eventType: 'transport', title: 'Train 14609 Hemkunt Express · Delhi → Yog Nagari Rishikesh',
  startsAt: '2026-11-15T00:20:00Z', endsAt: '2026-11-15T06:05:00Z', audience: ['priyanshu', 'dhruv', 'cheeku'],
}
const at = (iso: string) => Date.parse(iso)

test('a car bill while three are on the train leaves the three out, with why', () => {
  const away = awayMembers([train], at('2026-11-15T00:50:00Z'), crew, 'me')
  assert.deepEqual([...away.keys()].sort(), ['cheeku', 'dhruv', 'priyanshu'])
  assert.equal(away.get('dhruv'), 'On the train')
})

test('a bill paid by someone on the train is the train side’s', () => {
  const away = awayMembers([train], at('2026-11-15T03:00:00Z'), crew, 'dhruv')
  assert.deepEqual([...away.keys()].sort(), ['bittu', 'harshit', 'kittu', 'me'])
  assert.equal(away.get('me'), 'Not on the train')
})

test('outside the journey, for everyone, or not a journey: nobody is left out', () => {
  assert.equal(awayMembers([train], at('2026-11-15T07:00:00Z'), crew, 'me').size, 0)
  assert.equal(awayMembers([{ ...train, audience: [] }], at('2026-11-15T01:00:00Z'), crew, 'me').size, 0)
  assert.equal(awayMembers([{ ...train, audience: crew }], at('2026-11-15T01:00:00Z'), crew, 'me').size, 0)
  assert.equal(awayMembers([{ ...train, eventType: 'activity' }], at('2026-11-15T01:00:00Z'), crew, 'me').size, 0)
  assert.equal(awayMembers([train], null, crew, 'me').size, 0)
  // No arrival time: under way for three hours.
  assert.equal(awayMembers([{ ...train, endsAt: null }], at('2026-11-15T02:00:00Z'), crew, 'me').size, 3)
  assert.equal(awayMembers([{ ...train, endsAt: null }], at('2026-11-15T04:00:00Z'), crew, 'me').size, 0)
})

test('labels', () => {
  assert.equal(legLabel({ eventType: 'flight', title: 'IndiGo 6E-123' }), 'a flight')
  assert.equal(legLabel({ eventType: 'ferry', title: 'Fast boat' }), 'the ferry')
  assert.equal(legLabel({ eventType: 'transport', title: 'Volvo bus to Manali' }), 'the bus')
  assert.equal(legLabel({ eventType: 'transport', title: 'Cab to airport' }), 'a separate journey')
})
