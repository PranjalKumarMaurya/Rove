import { useCallback, useEffect, useState } from 'react'
import { IconClose } from '../../components/ui/icons'
import { Switch } from '../../components/ui/Switch'
import { supabase } from '../../lib/supabase'
import { usePush } from './pushApi'
import { MUTE_HOURS, mutedLabel, type NotifyLevel, type PushAvailability } from './pushRules'
import './notifications.css'

const LEVELS: { value: NotifyLevel; label: string; hint: string }[] = [
  { value: 'all', label: 'All', hint: 'Every message, with bursts grouped into one notification. Quiet from 23:00 to 07:00 Trip time, except mentions.' },
  { value: 'mentions', label: 'Mentions only', hint: 'Only when someone mentions you or @everyone.' },
  { value: 'none', label: 'Off', hint: 'No notifications from this Trip, not even mentions.' },
]

/** Why this device gets no notifications, if it doesn't (shown under the Trip's choice). */
function deviceNote(availability: PushAvailability, subscribed: boolean | null): string | null {
  if (availability === 'not-configured') return 'Notifications aren’t set up for Rove yet.'
  if (availability === 'unsupported') return 'This browser can’t show notifications.'
  if (availability === 'needs-install') return 'On iPhone, notifications need Rove on your Home Screen: tap Share, then Add to Home Screen, and open Rove from there.'
  if (availability === 'not-installed') return 'Install Rove (Add to Home Screen) to get notifications.'
  if (availability === 'denied') return 'Notifications are blocked for Rove in this device’s settings.'
  if (availability === 'ask' || subscribed === false) return 'Notifications are off on this device. Turn them on in Profile or from Chat.'
  return null
}

/** This Trip's notification choice for the signed-in Member (their own row; nobody else's is readable). */
function useTripNotificationPrefs(groupId: string, memberId: string) {
  const [level, setLevel] = useState<NotifyLevel>('all')
  const [mutedUntil, setMutedUntil] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'error' | 'load-error'>('loading')
  useEffect(() => {
    let active = true
    void supabase.from('trip_notification_prefs').select('level, muted_until').eq('group_id', groupId).eq('member_id', memberId).maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        // Still usable: the defaults show, and a choice saves as usual.
        if (error) { setStatus('load-error'); return }
        if (data?.level === 'mentions' || data?.level === 'none' || data?.level === 'all') setLevel(data.level)
        setMutedUntil(typeof data?.muted_until === 'string' ? data.muted_until : null)
        setStatus('ready')
      })
    return () => { active = false }
  }, [groupId, memberId])

  const save = useCallback(async (next: { level: NotifyLevel; mutedUntil: string | null }) => {
    const before = { level, mutedUntil }
    setLevel(next.level)
    setMutedUntil(next.mutedUntil)
    setStatus('saving')
    const { error } = await supabase.from('trip_notification_prefs').upsert(
      { group_id: groupId, member_id: memberId, level: next.level, muted_until: next.mutedUntil },
      { onConflict: 'group_id,member_id' },
    )
    if (error) {
      setLevel(before.level)
      setMutedUntil(before.mutedUntil)
      setStatus('error')
    } else {
      setStatus('ready')
    }
  }, [groupId, level, memberId, mutedUntil])

  return { level, mutedUntil, status, save }
}

/** Trip Settings → Notifications: All / Mentions only / Off, and "Mute for 8 hours". */
export function TripNotificationsSection({ groupId, memberId }: { groupId: string; memberId: string }) {
  const prefs = useTripNotificationPrefs(groupId, memberId)
  const push = usePush()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const muted = mutedLabel(prefs.mutedUntil, now)
  const selected = LEVELS.find((entry) => entry.value === prefs.level) ?? LEVELS[0]
  const note = deviceNote(push.availability, push.subscribed)
  const disabled = prefs.status === 'loading'
  return (
    <section data-testid="trip-notifications" aria-labelledby="settings-notifications-heading" className="settings-section" data-layout="section">
      <h2 id="settings-notifications-heading" className="t-title2" style={{ color: 'var(--text-primary)' }}>Notifications</h2>
      <div className="surface settings-card" data-layout="card">
        <div className="segmented notify-levels" role="group" aria-label="Notify me about">
          {LEVELS.map((entry) => (
            <button key={entry.value} type="button" className="segmented__item m-toggle t-callout" aria-pressed={prefs.level === entry.value}
              disabled={disabled} onClick={() => { if (prefs.level !== entry.value) void prefs.save({ level: entry.value, mutedUntil: prefs.mutedUntil }) }}>
              {entry.label}
            </button>
          ))}
        </div>
        <p className="t-footnote" style={{ color: 'var(--text-secondary)' }}>{selected.hint}</p>
        {prefs.level !== 'none' && (
          <div className="notify-mute">
            <p className="t-callout min-w-0 flex-1" style={{ color: muted ? 'var(--text-primary)' : 'var(--text-secondary)' }} data-testid="notify-mute-state">
              {muted ?? 'Need a break?'}
            </p>
            <button type="button" className="btn-quiet t-footnote" disabled={disabled}
              onClick={() => void prefs.save({ level: prefs.level, mutedUntil: muted ? null : new Date(Date.now() + MUTE_HOURS * 3600_000).toISOString() })}>
              {muted ? 'Unmute' : `Mute for ${MUTE_HOURS} hours`}
            </button>
          </div>
        )}
        {muted && <p className="t-footnote" style={{ color: 'var(--text-tertiary)' }}>Mentions still come through while muted.</p>}
        {prefs.status === 'error' && <p role="alert" className="t-footnote field-error">Couldn’t save that. Check your connection and try again.</p>}
        {prefs.status === 'load-error' && <p className="t-footnote" style={{ color: 'var(--text-tertiary)' }}>Couldn’t load your choice for this Trip; showing the default.</p>}
        {note && <p className="t-footnote" style={{ color: 'var(--text-tertiary)' }} data-testid="notify-device-note">{note}</p>}
      </div>
    </section>
  )
}

/** Profile → Notifications: this device on or off (every Trip's own choice still applies). */
export function DeviceNotificationsSection() {
  const push = usePush()
  const available = push.availability === 'ask' || push.availability === 'granted'
  const hint = push.failed
    ? 'Couldn’t turn on notifications. Check your connection and try again.'
    : available
      ? 'Messages from your Trips, as each Trip’s Settings allow.'
      : deviceNote(push.availability, push.subscribed) ?? undefined
  return (
    <section aria-labelledby="profile-notifications" className="section" data-testid="profile-notifications" data-layout="section">
      <h2 id="profile-notifications" className="t-eyebrow">Notifications</h2>
      <Switch label="Notifications on this device" hint={hint} checked={push.subscribed === true} testId="push-switch"
        disabled={!available || push.busy || push.subscribed === null}
        onChange={(on) => { if (on) void push.turnOn(); else void push.turnOff() }} />
    </section>
  )
}

/**
 * The friendly ask in Chat. Only in the installed app (iOS allows Web Push nowhere
 * else), only until it is answered or closed; in iPhone Safari it explains how to
 * install instead. The permission prompt itself comes only from the Turn on tap.
 */
export function NotificationPrompt() {
  const push = usePush()
  if (push.promptDismissed) return null
  if (push.availability === 'needs-install') {
    return (
      <div className="notify-prompt" role="note" data-testid="notify-prompt" data-kind="install">
        <p className="t-footnote notify-prompt__text">
          <span className="t-medium" style={{ color: 'var(--text-primary)' }}>Get notified when the crew messages.</span>{' '}
          Add Rove to your Home Screen first: tap Share, then Add to Home Screen.
        </p>
        <button type="button" className="close-x notify-prompt__close" aria-label="Close" onClick={push.dismissPrompt}><IconClose size="sm" /></button>
      </div>
    )
  }
  if (push.availability !== 'ask') return null
  return (
    <div className="notify-prompt" role="note" data-testid="notify-prompt" data-kind="ask">
      <p className="t-footnote notify-prompt__text">
        <span className="t-medium" style={{ color: 'var(--text-primary)' }}>Get notified when the crew messages</span>
        {push.failed && <span className="block">That didn’t work. Try again?</span>}
      </p>
      <button type="button" className="notify-prompt__on t-footnote" disabled={push.busy} onClick={() => void push.turnOn()}>
        {push.busy ? 'Turning on…' : 'Turn on'}
      </button>
      <button type="button" className="close-x notify-prompt__close" aria-label="Not now" onClick={push.dismissPrompt}><IconClose size="sm" /></button>
    </div>
  )
}
