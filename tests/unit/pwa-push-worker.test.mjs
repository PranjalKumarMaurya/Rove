import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// public/sw-push.js (the service worker's push handlers), run in a fake worker scope.
const source = readFileSync(new URL('../../public/sw-push.js', import.meta.url), 'utf8')
const origin = 'https://rove.example'

function worker({ windows = [], badging = true } = {}) {
  const handlers = {}
  const shown = []
  const badges = []
  const opened = []
  const navigator = badging ? {
    setAppBadge: async (count) => { badges.push(count) },
    clearAppBadge: async () => { badges.push(0) },
  } : {}
  const self = {
    location: { origin },
    navigator,
    addEventListener: (type, handler) => { handlers[type] = handler },
    registration: {
      showNotification: async (title, options) => { shown.push({ title, ...options }) },
      pushManager: { subscribe: async () => ({}) },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); return null },
    },
  }
  vm.runInNewContext(source, { self, URL, Number, Math, console })
  const fire = async (type, event) => {
    const waits = []
    handlers[type]({ ...event, waitUntil: (promise) => waits.push(promise) })
    await Promise.all(waits)
  }
  return { fire, shown, badges, opened, handlers }
}

const pushEvent = (payload) => ({ data: { json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload) } })
const groupId = 'e9800000-0000-4000-8000-00000000000a'

test('a push shows the notification the server sent and sets the Home Screen badge', async () => {
  const client = { url: `${origin}/`, messages: [], postMessage(message) { this.messages.push(message) } }
  const sw = worker({ windows: [client] })
  await sw.fire('push', pushEvent({ title: 'Rishikesh', body: 'Asha: Rafting at 9', tag: `rove-chat-${groupId}`, url: `/#chat=${groupId}`, groupId, badge: 4 }))
  assert.equal(sw.shown.length, 1)
  assert.equal(sw.shown[0].title, 'Rishikesh')
  assert.equal(sw.shown[0].body, 'Asha: Rafting at 9')
  assert.equal(sw.shown[0].tag, `rove-chat-${groupId}`)
  assert.equal(sw.shown[0].icon, '/pwa-192x192.png')
  assert.deepEqual({ ...sw.shown[0].data }, { url: `/#chat=${groupId}`, groupId })
  assert.deepEqual(sw.badges, [4])
  assert.deepEqual(client.messages.map((message) => message.type), ['rove:push'], 'an open app refreshes its counts')
})

test('a zero badge clears it; no Badging API is fine; a broken payload still shows something', async () => {
  const sw = worker()
  await sw.fire('push', pushEvent({ title: 'Goa', body: 'x', groupId, badge: 0 }))
  assert.deepEqual(sw.badges, [0])
  const plain = worker({ badging: false })
  await plain.fire('push', pushEvent({ title: 'Goa', body: 'x', groupId, badge: 3 }))
  assert.equal(plain.shown.length, 1)
  const broken = worker()
  await broken.fire('push', { data: { json: () => { throw new Error('not json') } } })
  assert.equal(broken.shown[0].title, 'Rove', 'iOS needs a notification for every push')
  assert.equal(broken.shown[0].data.url, '/')
})

test('tapping a notification focuses the open app and switches it to the Trip’s Chat', async () => {
  const client = { url: `${origin}/`, focused: false, messages: [], postMessage(message) { this.messages.push(message) }, focus() { this.focused = true; return this } }
  const sw = worker({ windows: [client] })
  let closed = false
  await sw.fire('notificationclick', { notification: { data: { url: `/#chat=${groupId}`, groupId }, close: () => { closed = true } } })
  assert.equal(closed, true)
  assert.equal(client.focused, true)
  assert.deepEqual({ ...client.messages[0] }, { type: 'rove:open-chat', groupId, url: `${origin}/#chat=${groupId}` })
  assert.deepEqual(sw.opened, [])
})

test('with no open app it opens one at the Chat; a foreign URL is never followed', async () => {
  const sw = worker()
  await sw.fire('notificationclick', { notification: { data: { url: `/#chat=${groupId}`, groupId }, close() {} } })
  assert.deepEqual(sw.opened, [`${origin}/#chat=${groupId}`])
  const evil = worker()
  await evil.fire('notificationclick', { notification: { data: { url: 'https://evil.example/phish', groupId }, close() {} } })
  assert.deepEqual(evil.opened, [`${origin}/`])
})

test('the push handler caches nothing and talks to no backend', () => {
  assert.doesNotMatch(source, /caches\.|fetch\(|supabase|indexedDB|localStorage/iu)
})
