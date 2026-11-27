import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { supabase } from '../../lib/supabase'
import { base64Url, pushAvailability, sameKey, vapidKeyBytes, type PushAvailability, type PushEnvironment } from './pushRules'

/**
 * The VAPID public key for Web Push. Set VITE_VAPID_PUBLIC_KEY at build time, or
 * paste the key printed by `node scripts/generate-vapid.mjs` here. While neither
 * is set, push is off: no prompt, and Settings say notifications aren't set up.
 */
export const VAPID_PUBLIC_KEY_FALLBACK = 'BJhlvevXqK-Miktz18KJJ1DKILgSj-9pSnf607zbd93WU2xV8kn03028eZbW98O5tWPjnyLLBZz5YALxv4nz0Z0'

export function vapidPublicKey(): string {
  return (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined)?.trim() || VAPID_PUBLIC_KEY_FALLBACK
}

/** Turned off on this device in Profile: the app then never subscribes it again by itself. */
const OPT_OUT_KEY = 'rove.push.off'
const PROMPT_DISMISSED_KEY = 'rove.push.prompt-dismissed'

function readFlag(key: string): boolean {
  try { return window.localStorage.getItem(key) === '1' } catch { return false }
}
function writeFlag(key: string, on: boolean) {
  try {
    if (on) window.localStorage.setItem(key, '1')
    else window.localStorage.removeItem(key)
  } catch { /* storage may be unavailable */ }
}

function standalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  } catch {
    return false
  }
}

function environment(): PushEnvironment {
  const hasNotification = typeof Notification !== 'undefined'
  return {
    vapidKey: vapidPublicKey(),
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    hasNotification,
    standalone: standalone(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    maxTouchPoints: typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints ?? 0,
    permission: hasNotification ? Notification.permission : null,
  }
}

// ─── One shared state for the prompt card, Settings and Profile ─────────

export interface PushState {
  availability: PushAvailability
  /** This device has a saved subscription (null while checking). */
  subscribed: boolean | null
  busy: boolean
  /** The last attempt to turn on failed for a reason other than the person saying no. */
  failed: boolean
  promptDismissed: boolean
}

let state: PushState = { availability: 'unsupported', subscribed: null, busy: false, failed: false, promptDismissed: false }
const listeners = new Set<() => void>()
function update(change: Partial<PushState>) {
  state = { ...state, ...change }
  for (const listener of listeners) listener()
}

/** The app-shell worker's registration. `wait`: give one that is still starting time to activate. */
async function registration(timeoutMs = 4000, wait = true): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    const existing = await navigator.serviceWorker.getRegistration()
    if (existing?.active) return existing
    // No worker at all (development, automation): nothing can be subscribed.
    if (!existing && !wait) return null
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => { window.setTimeout(() => resolve(null), timeoutMs) }),
    ])
  } catch {
    return null
  }
}

async function save(subscription: PushSubscription): Promise<boolean> {
  const p256dh = base64Url(subscription.getKey('p256dh'))
  const auth = base64Url(subscription.getKey('auth'))
  if (!p256dh || !auth) return false
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: subscription.endpoint, p_p256dh: p256dh, p_auth: auth, p_user_agent: navigator.userAgent.slice(0, 300),
  })
  return !error
}

/** Subscribe this device with the current key (again if the key changed) and save it for the signed-in person. */
async function subscribeAndSave(): Promise<boolean> {
  const key = vapidKeyBytes(vapidPublicKey())
  if (!key) return false
  const reg = await registration()
  if (!reg) return false
  try {
    let subscription = await reg.pushManager.getSubscription()
    if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
      await subscription.unsubscribe().catch(() => false)
      subscription = null
    }
    subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as Uint8Array<ArrayBuffer> })
    return await save(subscription)
  } catch {
    return false
  }
}

/** Re-read what this device can do and whether it is subscribed. */
export async function checkPush(): Promise<void> {
  const availability = pushAvailability(environment())
  update({ availability, promptDismissed: readFlag(PROMPT_DISMISSED_KEY) })
  if (availability !== 'granted') {
    update({ subscribed: false })
    return
  }
  const reg = await registration(1500, false)
  const subscription = reg ? await reg.pushManager.getSubscription().catch(() => null) : null
  update({ subscribed: Boolean(subscription) && !readFlag(OPT_OUT_KEY) })
}

/**
 * At sign-in and each start: if notifications are allowed (and not turned off
 * here), make sure this device's subscription exists and is saved for whoever
 * is signed in now. Push services rotate subscriptions; this picks that up.
 */
export async function syncPushSubscription(): Promise<void> {
  await checkPush()
  if (state.availability !== 'granted' || readFlag(OPT_OUT_KEY)) return
  if (await subscribeAndSave()) update({ subscribed: true })
}

/**
 * Turn notifications on. Call straight from a tap: iOS shows its permission
 * prompt only in response to one, so nothing may be awaited before asking.
 */
export function turnOnPush(): Promise<boolean> {
  if (typeof Notification === 'undefined') return Promise.resolve(false)
  update({ busy: true, failed: false })
  const asked = Notification.permission === 'granted' ? Promise.resolve<NotificationPermission>('granted') : Notification.requestPermission()
  return asked.then(async (permission) => {
    if (permission !== 'granted') {
      update({ busy: false })
      await checkPush()
      return false
    }
    writeFlag(OPT_OUT_KEY, false)
    const saved = await subscribeAndSave()
    update({ busy: false, failed: !saved, subscribed: saved, availability: 'granted' })
    return saved
  }).catch(() => {
    update({ busy: false, failed: true })
    return false
  })
}

/** Turn notifications off on this device: forget the subscription here and on the server. */
export async function turnOffPush({ remember = true }: { remember?: boolean } = {}): Promise<void> {
  update({ busy: true })
  if (remember) writeFlag(OPT_OUT_KEY, true)
  try {
    const reg = await registration(1500, false)
    const subscription = reg ? await reg.pushManager.getSubscription() : null
    if (subscription) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint)
      await subscription.unsubscribe().catch(() => false)
    }
  } catch { /* best effort: a dead subscription is removed on the next push anyway */ }
  update({ busy: false, subscribed: false })
}

/** Signing out: this device stops notifying the person who is leaving. */
export async function forgetPushOnSignOut(): Promise<void> {
  await Promise.race([turnOffPush({ remember: false }), new Promise((resolve) => { window.setTimeout(resolve, 2500) })])
}

export function dismissPushPrompt() {
  writeFlag(PROMPT_DISMISSED_KEY, true)
  update({ promptDismissed: true })
}

/** The shared push state, checked when first used and when the app comes back to the front. */
export function usePush() {
  const current = useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => state, () => state)
  useEffect(() => {
    void checkPush()
    const onVisible = () => { if (document.visibilityState === 'visible') void checkPush() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
  const on = useCallback(() => turnOnPush(), [])
  const off = useCallback(() => turnOffPush(), [])
  return { ...current, turnOn: on, turnOff: off, dismissPrompt: dismissPushPrompt }
}

/** Keep this device's subscription saved while someone is signed in (see syncPushSubscription). */
export function usePushSync(profileId: string | null) {
  useEffect(() => {
    if (!profileId) return
    void syncPushSubscription()
    const worker = 'serviceWorker' in navigator ? navigator.serviceWorker : null
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'rove:push-subscription-changed') void syncPushSubscription()
    }
    worker?.addEventListener('message', onMessage)
    return () => worker?.removeEventListener('message', onMessage)
  }, [profileId])
}
