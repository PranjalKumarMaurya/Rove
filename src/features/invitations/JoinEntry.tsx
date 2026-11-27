import { type ReactNode, useEffect, useRef, useState } from 'react'
import { AsyncButton, useAsyncStatus } from '../../components/ui/AsyncButton'
import { NeonBtn } from '../../components/ui/NeonBtn'
import { ScreenFrame } from '../../components/ui/ScreenFrame'
import { AuthEntry } from '../auth/AuthEntry'
import type { AuthSessionState } from '../auth/authSession'
import { formatTripDates } from '../onboarding/tripSettings'
import { type JoinLinkInspection, inspectJoinLink, joinWithLink } from './joinLinkApi'

type ViewState =
  | { kind: 'loading' }
  | { kind: 'inspection-error' }
  | { kind: 'inspected'; value: JoinLinkInspection }
  | { kind: 'joining' }
  /** The join call refused or failed; `code` is the thrown `Error(code)` (joinLinkApi.ts). */
  | { kind: 'join-error'; code: string }

type TripSummary = { name: string; destination: string; startDate?: string; endDate?: string }

/** Copy for a link that cannot be used, by inspection outcome or join error code. */
const CLOSED = { title: 'This invite link is off', body: 'This invite link is off. Ask the Trip Owner for a new one.' }
const REMOVED = { title: 'You can’t rejoin with this link', body: 'You were removed from this Trip. Ask the Owner to invite you again.' }
const ARCHIVED = { title: 'This Trip is archived', body: 'Nobody can join or change it while it’s archived. Ask the Trip Owner to restore it.' }

/**
 * Opening a Trip's join link (`#join=<proof>`, "anyone with the link can join").
 * Mirrors InvitationEntry: a preview works signed out; sign-in and sign-up keep the
 * pending link (joinLink.ts), and the person then confirms "Join trip". Someone
 * already in the Trip goes straight to it.
 */
export function JoinEntry({ proof, auth, onClose, onOpenTrip }: {
  proof: string
  auth: AuthSessionState
  /** Leave without joining (the pending link is forgotten). */
  onClose: () => void
  /** Joined, or already a member: open that Trip. */
  onOpenTrip: (groupId: string) => void
}) {
  const [view, setView] = useState<ViewState>({ kind: 'loading' })
  const [trip, setTrip] = useState<TripSummary | null>(null)
  const [showAuth, setShowAuth] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const requestId = useRef<string | null>(null)
  const joinAction = useAsyncStatus()
  const signedIn = auth.status === 'authenticated-linked' || auth.status === 'authenticated-unlinked'
  const userId = signedIn ? auth.session.user.id : null
  const opened = useRef(false)
  const open = (groupId: string) => {
    if (opened.current) return
    opened.current = true
    onOpenTrip(groupId)
  }

  useEffect(() => {
    let current = true
    setView({ kind: 'loading' })
    void inspectJoinLink(proof).then(
      (value) => {
        if (!current) return
        if (value.tripName && value.destination) {
          setTrip({ name: value.tripName, destination: value.destination, startDate: value.startDate, endDate: value.endDate })
        }
        setView({ kind: 'inspected', value })
      },
      () => { if (current) setView({ kind: 'inspection-error' }) },
    )
    return () => { current = false }
  }, [proof, userId, attempt])

  // Already in this Trip: nothing to confirm.
  const alreadyIn = view.kind === 'inspected' && view.value.outcome === 'already_member' ? view.value.groupId : undefined
  const linked = auth.status === 'authenticated-linked'
  useEffect(() => {
    if (alreadyIn && linked) open(alreadyIn)
    // `open` is stable in effect (guarded by a ref).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alreadyIn, linked])

  const join = async () => {
    if (view.kind === 'joining') return
    requestId.current ??= crypto.randomUUID()
    setView({ kind: 'joining' })
    joinAction.busy()
    try {
      const result = await joinWithLink(proof, requestId.current)
      await joinAction.done()
      open(result.groupId)
    } catch (error) {
      joinAction.fail()
      const code = error instanceof Error ? error.message : 'join_link_unavailable'
      // Signed out meanwhile: sign in again, then confirm.
      if (code === 'not_authorized' && !signedIn) setShowAuth(true)
      setView({ kind: 'join-error', code })
    }
  }

  if (showAuth && auth.status === 'signed-out') {
    return <AuthEntry mode="sign-in" onBack={() => setShowAuth(false)}
      contextMessage={trip
        ? `Sign in or create an account to join ${trip.name}. We’ll bring you back here to confirm.`
        : 'Sign in or create an account to join this Trip. We’ll bring you back here to confirm.'} />
  }

  const outcome = view.kind === 'inspected' ? view.value.outcome : null
  const dates = trip?.startDate && trip.endDate ? formatTripDates(trip.startDate, trip.endDate) : null
  const summary = trip ? [trip.destination, dates].filter(Boolean).join(' · ') : undefined
  const joinTitle = trip ? `Join ${trip.name}?` : 'Join a Trip'
  const exitLabel = auth.status === 'authenticated-linked' ? 'Go to my Trips' : signedIn ? 'Continue' : 'Go to sign in'
  const leave = (label: string) => <NeonBtn type="button" variant="ghost" size="lg" className="w-full" onClick={onClose}>{label}</NeonBtn>
  const done = <NeonBtn type="button" size="lg" className="w-full" onClick={onClose}>{exitLabel}</NeonBtn>

  let title: ReactNode = joinTitle
  let lede: ReactNode = summary
  let body: ReactNode = null
  let actions: ReactNode = null
  const dead = (copy: { title: string; body: string }) => {
    title = copy.title
    lede = undefined
    body = copy.body
    actions = done
  }

  if (view.kind === 'loading') {
    title = trip ? joinTitle : 'Checking the link'
    body = <span className="flex items-center gap-3"><span className="spinner" aria-hidden="true" />Checking this link…</span>
  } else if (view.kind === 'inspection-error') {
    title = 'Trip link'
    lede = undefined
    body = 'We couldn’t check this link right now. Check your connection and try again.'
    actions = <><NeonBtn type="button" size="lg" className="w-full" onClick={() => setAttempt((value) => value + 1)}>Try again</NeonBtn>{leave('Not now')}</>
  } else if (outcome === 'closed') {
    dead(CLOSED)
  } else if (outcome === 'removed') {
    dead(REMOVED)
  } else if (outcome === 'archived') {
    dead(ARCHIVED)
  } else if (outcome === 'continue') {
    body = 'Sign in or create an account to join. You join only after you confirm.'
    actions = <><NeonBtn type="button" size="lg" className="w-full" onClick={() => setShowAuth(true)}>Continue</NeonBtn>{leave('Not now')}</>
  } else if (outcome === 'verification_required') {
    body = 'Confirm your email address first: open the link we emailed you, then come back here and check again.'
    actions = <><NeonBtn type="button" size="lg" className="w-full" onClick={() => setAttempt((value) => value + 1)}>Check again</NeonBtn>{leave('Not now')}</>
  } else if (outcome === 'already_member') {
    title = trip ? `You’re already in ${trip.name}` : 'You’re already in this Trip'
    body = 'Opening the Trip…'
    actions = alreadyIn && auth.status === 'authenticated-linked'
      ? <NeonBtn type="button" size="lg" className="w-full" onClick={() => { opened.current = false; open(alreadyIn) }}>Open Trip</NeonBtn>
      : done
  } else if (outcome === 'ready' || view.kind === 'joining') {
    body = 'You’ll join as a Member. Everyone in the Trip will see you in its People list.'
    actions = <>
      <AsyncButton type="button" size="lg" className="w-full" status={view.kind === 'joining' ? joinAction.status : 'idle'}
        busyLabel="Joining…" doneLabel="Joined" onClick={() => void join()}>Join trip</AsyncButton>
      {view.kind !== 'joining' && leave('Not now')}
    </>
  } else if (view.kind === 'join-error') {
    if (view.code === 'link_closed') dead(CLOSED)
    else if (view.code === 'membership_removed') dead(REMOVED)
    else if (view.code === 'trip_archived') dead(ARCHIVED)
    else if (view.code === 'verification_required') {
      body = 'Confirm your email address first: open the link we emailed you, then come back here and check again.'
      actions = <><NeonBtn type="button" size="lg" className="w-full" onClick={() => setAttempt((value) => value + 1)}>Check again</NeonBtn>{leave('Not now')}</>
    } else {
      body = <span role="alert">We couldn’t confirm whether you joined. It’s safe to try again; you won’t be added twice.</span>
      actions = <><AsyncButton type="button" size="lg" className="w-full" status={joinAction.status} onClick={() => void join()}>Try again</AsyncButton>{leave('Not now')}</>
    }
  }

  return (
    <ScreenFrame testId="join-entry" title={title} eyebrow={<p className="t-eyebrow">Trip invite link</p>} lede={lede}>
      <div aria-live="polite" className="flex flex-col gap-6">
        {body && <p key={`${view.kind}:${outcome ?? ''}`} className="t-callout m-text-swap" style={{ color: 'var(--text-secondary)' }}>{body}</p>}
        {actions && <div className="flex flex-col gap-3">{actions}</div>}
      </div>
    </ScreenFrame>
  )
}
