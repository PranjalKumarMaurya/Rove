// Web Push for the installed app, loaded into the app-shell service worker with
// importScripts (vite.config.ts). It caches nothing and reads no data: it shows
// what the server sent (send-chat-push), sets the Home Screen badge, and opens
// the Trip's Chat when a notification is tapped.
/* eslint-env serviceworker */
'use strict'

const ROVE_ICON = '/pwa-192x192.png'

/** The push's JSON, or a plain fallback (iOS requires every push to show a notification). */
function rovePayload(data) {
  let value = null
  try { value = data ? data.json() : null } catch { value = null }
  const text = (key, fallback) => value && typeof value[key] === 'string' && value[key] ? value[key] : fallback
  const groupId = text('groupId', '')
  return {
    title: text('title', 'Rove'),
    body: text('body', 'New messages'),
    tag: text('tag', groupId ? `rove-chat-${groupId}` : 'rove'),
    url: text('url', groupId ? `/#chat=${groupId}` : '/'),
    groupId,
    badge: value && Number.isFinite(value.badge) && value.badge >= 0 ? Math.floor(value.badge) : null,
  }
}

/** A same-origin URL only: a notification can never send the app elsewhere. */
function roveTarget(url) {
  try {
    const target = new URL(url, self.location.origin)
    return target.origin === self.location.origin ? target.href : `${self.location.origin}/`
  } catch {
    return `${self.location.origin}/`
  }
}

async function roveShow(event) {
  const payload = rovePayload(event.data)
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    // A summary replacing the Trip's notification should still alert.
    renotify: true,
    icon: ROVE_ICON,
    badge: ROVE_ICON,
    data: { url: payload.url, groupId: payload.groupId },
  })
  if (payload.badge !== null && self.navigator && 'setAppBadge' in self.navigator) {
    try {
      if (payload.badge > 0) await self.navigator.setAppBadge(payload.badge)
      else await self.navigator.clearAppBadge()
    } catch { /* badging is best effort */ }
  }
  // An open app refreshes its unread counts.
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of windows) client.postMessage({ type: 'rove:push', groupId: payload.groupId })
}

async function roveOpen(notification) {
  const data = notification.data || {}
  const url = roveTarget(typeof data.url === 'string' ? data.url : '/')
  const groupId = typeof data.groupId === 'string' ? data.groupId : ''
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const open = windows.find((client) => client.url.startsWith(self.location.origin))
  if (open) {
    // The app switches to the Trip's Chat itself (no reload), then comes to the front.
    open.postMessage({ type: 'rove:open-chat', groupId, url })
    if ('focus' in open) return open.focus()
    return open
  }
  return self.clients.openWindow(url)
}

self.addEventListener('push', (event) => {
  event.waitUntil(roveShow(event))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(roveOpen(event.notification))
})

// The push service replaced the subscription: subscribe again with the same key, and let
// an open app save it (the app also re-checks its subscription every time it starts).
self.addEventListener('pushsubscriptionchange', (event) => {
  const options = event.oldSubscription && event.oldSubscription.options
  if (!options) return
  event.waitUntil(self.registration.pushManager.subscribe(options).then(async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) client.postMessage({ type: 'rove:push-subscription-changed' })
  }).catch(() => {}))
})
