// When and how the app may ask for notifications. Pure, so it runs under `node --test`.
//
// Web Push on iPhone works only in the app installed to the Home Screen (iOS 16.4+),
// and the permission prompt must come from a tap (docs/CHAT-PLAN.md §4). So Rove
// asks only in the installed app, only from a button, and in Safari explains how
// to install instead.

export type PushAvailability =
  /** Push is not set up for this build (no VAPID public key). */
  | 'not-configured'
  /** This browser has no Web Push. */
  | 'unsupported'
  /** iPhone/iPad Safari in a tab: notifications need the app on the Home Screen. */
  | 'needs-install'
  /** Supported, but Rove asks only in the installed app (other browsers in a tab). */
  | 'not-installed'
  /** Ready to ask (after a tap). */
  | 'ask'
  | 'denied'
  | 'granted'

export interface PushEnvironment {
  vapidKey: string
  hasServiceWorker: boolean
  hasPushManager: boolean
  hasNotification: boolean
  /** display-mode: standalone, or iOS's navigator.standalone. */
  standalone: boolean
  userAgent: string
  maxTouchPoints: number
  permission: 'default' | 'granted' | 'denied' | null
}

/** iPhone, iPod or iPad (iPadOS reports itself as a Mac with touch). */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/u.test(userAgent) || (/Macintosh/u.test(userAgent) && maxTouchPoints > 1)
}

export function pushAvailability(env: PushEnvironment): PushAvailability {
  if (!env.vapidKey) return 'not-configured'
  const apple = isAppleMobile(env.userAgent, env.maxTouchPoints)
  const supported = env.hasServiceWorker && env.hasPushManager && env.hasNotification
  // iOS only exposes Web Push to the Home Screen app, so in Safari it looks unsupported.
  if (apple && !env.standalone) return 'needs-install'
  if (!supported) return 'unsupported'
  if (env.permission === 'denied') return 'denied'
  if (env.permission === 'granted') return 'granted'
  return env.standalone ? 'ask' : 'not-installed'
}

/** The VAPID public key (base64url) as the bytes pushManager.subscribe wants; null if malformed. */
export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> | null {
  const clean = key.trim()
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(clean)) return null
  const base64 = clean.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(clean.length / 4) * 4, '=')
  let binary: string
  try { binary = atob(base64) } catch { return null }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  // An uncompressed P-256 point: 65 bytes starting with 0x04.
  return bytes.length === 65 && bytes[0] === 4 ? bytes : null
}

/** A PushSubscription's key (ArrayBuffer) as base64url, as the database stores it. */
export function base64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return ''
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

/** The same key (as subscribe options keep it) or not: a different key means subscribing again. */
export function sameKey(a: ArrayBuffer | Uint8Array | null | undefined, b: Uint8Array): boolean {
  if (!a) return false
  const left = a instanceof Uint8Array ? a : new Uint8Array(a)
  return left.length === b.length && left.every((byte, index) => byte === b[index])
}

export type NotifyLevel = 'all' | 'mentions' | 'none'

/** "Muted until 14:05" or "Muted until tomorrow 09:00", in the device's own time. */
export function mutedLabel(until: string | null, nowMs: number, locale?: string): string | null {
  const ms = until ? Date.parse(until) : Number.NaN
  if (!Number.isFinite(ms) || ms <= nowMs) return null
  const time = new Intl.DateTimeFormat(locale ?? 'en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
  const sameDay = new Date(ms).toDateString() === new Date(nowMs).toDateString()
  return `Muted until ${sameDay ? '' : 'tomorrow '}${time}`
}

export const MUTE_HOURS = 8
