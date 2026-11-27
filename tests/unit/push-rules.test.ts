import assert from 'node:assert/strict'
import test from 'node:test'

import { base64Url, isAppleMobile, mutedLabel, pushAvailability, sameKey, vapidKeyBytes, type PushEnvironment } from '../../src/features/notifications/pushRules.ts'

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1'
const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15'
const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36'
// A real P-256 public key (65 bytes, uncompressed), base64url.
const key = 'BI72tgSZ3DL4hnstxG70xqMDfey3wsCZK33p7H8Ugf_TqX3nkhmCRVWZBelhRM4DUUt0RjhyDeryTndSFR9ZBow'

const env = (overrides: Partial<PushEnvironment> = {}): PushEnvironment => ({
  vapidKey: key, hasServiceWorker: true, hasPushManager: true, hasNotification: true, standalone: true,
  userAgent: iphone, maxTouchPoints: 5, permission: 'default', ...overrides,
})

test('asks only in the installed app; iPhone Safari is told to install first', () => {
  assert.equal(pushAvailability(env()), 'ask')
  // iOS hides Web Push from Safari tabs entirely.
  assert.equal(pushAvailability(env({ standalone: false, hasPushManager: false, hasNotification: false })), 'needs-install')
  assert.equal(pushAvailability(env({ standalone: false, userAgent: ipad })), 'needs-install', 'iPadOS reports a Mac with touch')
  assert.equal(pushAvailability(env({ standalone: false, userAgent: android, maxTouchPoints: 5 })), 'not-installed', 'Android in a tab: no prompt')
  assert.equal(pushAvailability(env({ userAgent: android, maxTouchPoints: 5 })), 'ask', 'installed on Android')
})

test('answers already given, missing support and a missing key', () => {
  assert.equal(pushAvailability(env({ permission: 'granted' })), 'granted')
  assert.equal(pushAvailability(env({ permission: 'denied' })), 'denied')
  assert.equal(pushAvailability(env({ hasPushManager: false, userAgent: android })), 'unsupported')
  assert.equal(pushAvailability(env({ vapidKey: '' })), 'not-configured', 'no key: push is off, quietly')
  assert.equal(isAppleMobile(ipad, 0), false, 'a real Mac has no touch points')
})

test('the VAPID key becomes the 65 bytes subscribe() wants; anything else is refused', () => {
  const bytes = vapidKeyBytes(key)
  assert.equal(bytes?.length, 65)
  assert.equal(bytes?.[0], 4)
  assert.equal(vapidKeyBytes('not a key!'), null)
  assert.equal(vapidKeyBytes('AAAA'), null, 'too short')
  assert.equal(base64Url(bytes?.buffer ?? null), key, 'round trip to the base64url the database stores')
  assert.equal(base64Url(null), '')
  assert.equal(sameKey(bytes, bytes as Uint8Array), true)
  assert.equal(sameKey(new Uint8Array(65), bytes as Uint8Array), false)
  assert.equal(sameKey(null, bytes as Uint8Array), false)
})

test('the mute line names when it ends; nothing once it has', () => {
  const now = new Date(2026, 10, 27, 9, 0).getTime()
  assert.equal(mutedLabel(new Date(2026, 10, 27, 17, 0).toISOString(), now), 'Muted until 17:00')
  assert.equal(mutedLabel(new Date(2026, 10, 28, 1, 30).toISOString(), now), 'Muted until tomorrow 01:30')
  assert.equal(mutedLabel(new Date(2026, 10, 27, 8, 0).toISOString(), now), null)
  assert.equal(mutedLabel(null, now), null)
})
