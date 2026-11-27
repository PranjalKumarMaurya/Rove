import { type ChangeEvent, type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Field } from '../../components/ui/Field'
import { IconBack, IconCamera, IconChevronRight, IconSignOut } from '../../components/ui/icons'
import { NeonBtn } from '../../components/ui/NeonBtn'
import { AsyncButton, useAsyncStatus } from '../../components/ui/AsyncButton'
import { Collapse } from '../../components/ui/Collapse'
import { Swap } from '../../components/ui/Swap'
import { NeonInput } from '../../components/ui/NeonInput'
import { NeonSelect } from '../../components/ui/NeonSelect'
import { ScreenFrame } from '../../components/ui/ScreenFrame'
import { Sheet } from '../../components/ui/Sheet'
import { UserAvatar } from '../../components/ui/UserAvatar'
import { TRIP_CURRENCIES, currencyName } from '../onboarding/tripSettings'
import { formatUsd } from '../../../supabase/functions/_shared/aiPricing.ts'
import { type AiUsageTotals, loadMyAiUsage } from './aiUsageApi'
import {
  AccountRequestError, accountErrorMessage, changeEmail, changePassword, deleteMyAccount, loadDeletionBlockers,
} from './accountApi'
import { APP_VERSION, SUPPORT_EMAIL, supportMailto } from './appInfo'
import { AVATAR_ACCEPT, AvatarError, prepareAvatar, removeAvatars, uploadAvatar, useAvatarUrl } from './avatarStorage'
import { LegalPage } from './LegalPage'
import { DeviceNotificationsSection } from '../notifications/NotificationSettings'
import { TextSizeSettings } from './TextSizeSettings'
import { type MyProfile, ProfileRequestError, updateMyProfile } from './profileApi'
import {
  AVATAR_EMOJI, DIETARY_NOTES_MAX, EMERGENCY_CONTACT_MAX, type ProfileField, type ProfileFormValues, emailError,
  newPasswordError, profileChanges, validateProfileForm,
} from './profileRules'

const inputStyle = { fontSize: 'var(--type-field)', minHeight: 44 } as const

type Page = 'main' | 'privacy' | 'terms'
type SheetKind = 'email' | 'password' | 'delete' | null

/**
 * The person's own profile: avatar, name, home currency, UPI ID and crew info,
 * sign-in details, help, legal pages, sign out and account deletion.
 */
export function ProfileScreen({ userId, email, profile, profileStatus, onProfileChanged, onReload, onBack, backLabel = 'Trips', bottomNav, onSignOut, signOutError, onAccountDeleted }: {
  userId: string
  email: string | undefined
  profile: MyProfile | null
  profileStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Apply a saved change to the shared profile state. */
  onProfileChanged: (changes: Partial<MyProfile>) => void
  onReload: () => void
  /** Back to the open Trip; absent when Profile is a home tab (with `bottomNav`). */
  onBack?: () => void
  /** Where Back goes: the open Trip's name. */
  backLabel?: string
  /** The home bottom nav, when Profile was opened from it. */
  bottomNav?: ReactNode
  onSignOut: () => void
  signOutError: string | null
  onAccountDeleted: () => void
}) {
  const [page, setPage] = useState<Page>('main')
  const [sheet, setSheet] = useState<SheetKind>(null)
  // Icon only, like the Trip top bar; the destination shows as a hover hint.
  const top = onBack ? <button type="button" className="round-btn" aria-label="Back" title={`Back to ${backLabel}`} onClick={onBack}><IconBack size="md" /></button> : undefined
  const navClass = bottomNav ? 'home-nav-space' : undefined

  if (page !== 'main') return <LegalPage kind={page} onBack={() => setPage('main')} />

  if (!profile) {
    return (
      <>
      <ScreenFrame testId="profile-screen" title="Profile" top={top} busy={profileStatus !== 'error'} className={navClass}
        lede={profileStatus === 'error' ? 'We couldn’t load your profile. Check your connection and try again.' : 'Loading your profile…'}>
        {profileStatus === 'error'
          ? <NeonBtn type="button" size="lg" className="w-full" onClick={onReload}>Try again</NeonBtn>
          : <span className="spinner" aria-hidden="true" />}
      </ScreenFrame>
      {bottomNav}
      </>
    )
  }

  return (
    <>
    <ScreenFrame testId="profile-screen" centered={false} eyebrow={<p className="t-eyebrow">Profile</p>}
      title={profile.displayName} lede={email} top={top} className={navClass}>
      <div className="flex flex-col gap-6">
        <AvatarEditor userId={userId} profile={profile} onChanged={onProfileChanged} />
        <DetailsForm profile={profile} onChanged={onProfileChanged} />
        <TextSizeSettings />
        <DeviceNotificationsSection />
        <AiUsage />

        <section aria-labelledby="profile-sign-in" className="section" data-layout="section">
          <h2 id="profile-sign-in" className="t-eyebrow">Sign-in</h2>
          <div className="surface card" data-layout="card">
            <p className="field-label t-footnote t-medium">Email</p>
            <p className="t-callout mt-1 truncate" style={{ color: 'var(--text-primary)' }} data-testid="profile-email">{email}</p>
          </div>
          <NeonBtn type="button" variant="outline" size="lg" className="w-full" onClick={() => setSheet('email')}>Change email</NeonBtn>
          <NeonBtn type="button" variant="outline" size="lg" className="w-full" onClick={() => setSheet('password')}>Change password</NeonBtn>
        </section>

        <section aria-labelledby="profile-help" className="section" data-layout="section">
          <h2 id="profile-help" className="t-eyebrow">Help & legal</h2>
          {SUPPORT_EMAIL && <a className="row-btn" href={supportMailto(SUPPORT_EMAIL)}>
            <span className="flex-1">Help & feedback</span><IconChevronRight size="md" />
          </a>}
          <button type="button" className="row-btn" onClick={() => setPage('privacy')}><span className="flex-1">Privacy policy</span><IconChevronRight size="md" /></button>
          <button type="button" className="row-btn" onClick={() => setPage('terms')}><span className="flex-1">Terms of use</span><IconChevronRight size="md" /></button>
        </section>

        <section aria-label="Account" className="section" data-layout="section">
          {signOutError && <p role="alert" className="notice notice--error">{signOutError}</p>}
          <NeonBtn type="button" variant="outline" size="lg" className="w-full" onClick={onSignOut}><IconSignOut size="md" />Sign out</NeonBtn>
          <button type="button" className="row-btn row-btn--danger justify-center" onClick={() => setSheet('delete')}>Delete account</button>
          <p className="t-footnote text-center" style={{ color: 'var(--text-tertiary)' }} data-testid="app-version">Version {APP_VERSION}</p>
        </section>
      </div>

      {sheet === 'email' && <ChangeEmailSheet currentEmail={email} onClose={() => setSheet(null)} />}
      {sheet === 'password' && email && <ChangePasswordSheet email={email} onClose={() => setSheet(null)} />}
      {sheet === 'delete' && <DeleteAccountSheet userId={userId} onClose={() => setSheet(null)} onDeleted={onAccountDeleted} />}
    </ScreenFrame>
    {bottomNav}
    </>
  )
}

function avatarErrorMessage(code: string): string {
  if (code === 'unsupported_type') return 'Choose a JPEG, PNG or WebP photo.'
  if (code === 'too_large') return 'That photo is too large. Choose one under 15 MB.'
  if (code === 'unreadable') return 'We couldn’t read that photo. Try another one.'
  return 'We couldn’t save your photo. Check your connection and try again.'
}

function AvatarEditor({ userId, profile, onChanged }: { userId: string; profile: MyProfile; onChanged: (changes: Partial<MyProfile>) => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const photo = useAvatarUrl(profile.avatarPath)
  const [busy, setBusy] = useState<'photo' | 'emoji' | null>(null)
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)

  const choosePhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy('photo')
    setMessage(null)
    let uploaded: string | null = null
    try {
      uploaded = await uploadAvatar(userId, await prepareAvatar(file))
      await updateMyProfile(profile.id, { avatar_path: uploaded })
      const previous = profile.avatarPath
      onChanged({ avatarPath: uploaded })
      if (previous) await removeAvatars([previous]).catch(() => undefined)
      setMessage({ tone: 'info', text: 'Photo updated.' })
    } catch (error) {
      if (uploaded) await removeAvatars([uploaded]).catch(() => undefined)
      setMessage({ tone: 'error', text: avatarErrorMessage(error instanceof AvatarError ? error.code : 'upload_failed') })
    } finally {
      setBusy(null)
    }
  }

  const removePhoto = async () => {
    if (!profile.avatarPath) return
    setBusy('photo')
    setMessage(null)
    try {
      await updateMyProfile(profile.id, { avatar_path: null })
      const previous = profile.avatarPath
      onChanged({ avatarPath: null })
      await removeAvatars([previous]).catch(() => undefined)
      setMessage({ tone: 'info', text: 'Photo removed.' })
    } catch {
      setMessage({ tone: 'error', text: avatarErrorMessage('remove_failed') })
    } finally {
      setBusy(null)
    }
  }

  // Picking an emoji replaces the photo, so what friends see matches what you picked.
  const chooseEmoji = async (emoji: string) => {
    setBusy('emoji')
    setMessage(null)
    try {
      const previous = profile.avatarPath
      await updateMyProfile(profile.id, { avatar_emoji: emoji, avatar_path: null })
      onChanged({ avatarEmoji: emoji, avatarPath: null })
      if (previous) await removeAvatars([previous]).catch(() => undefined)
    } catch {
      setMessage({ tone: 'error', text: 'We couldn’t save that. Check your connection and try again.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="profile-avatar" className="surface card" data-testid="avatar-editor" data-layout="section card">
      <h2 id="profile-avatar" className="t-eyebrow">Avatar</h2>
      <div className="mt-4 flex items-center gap-4">
        <UserAvatar size={76} name={profile.displayName} emoji={profile.avatarEmoji} imageUrl={photo} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} className="sr-only" aria-label="Profile photo file"
            tabIndex={-1} onChange={(event) => void choosePhoto(event)} />
          <AsyncButton type="button" variant="outline" size="lg" disabled={busy !== null} status={busy === 'photo' ? 'busy' : 'idle'}
            busyLabel="Saving…" onClick={() => fileRef.current?.click()}>
            <IconCamera size="md" />{profile.avatarPath ? 'Change photo' : 'Add photo'}
          </AsyncButton>
          {profile.avatarPath && <NeonBtn type="button" variant="ghost" size="lg" disabled={busy !== null} onClick={() => void removePhoto()}>Remove photo</NeonBtn>}
        </div>
      </div>
      <p className="mt-4 field-label t-footnote t-medium">Or pick an emoji</p>
      <div className="emoji-grid mt-2" role="group" aria-label="Avatar emoji">
        {AVATAR_EMOJI.map((emoji) => {
          const chosen = !profile.avatarPath && profile.avatarEmoji === emoji
          return (
            <button key={emoji} type="button" className="emoji-option" aria-pressed={chosen} aria-label={`Use ${emoji} as your avatar`}
              disabled={busy !== null} onClick={() => void chooseEmoji(emoji)}>{emoji}</button>
          )
        })}
      </div>
      <Collapse open={Boolean(message)}>
        {message && <p role={message.tone === 'error' ? 'alert' : 'status'} className={`notice mt-4${message.tone === 'error' ? ' notice--error' : ''}`}>{message.text}</p>}
      </Collapse>
    </section>
  )
}

const formFrom = (profile: MyProfile): ProfileFormValues => ({
  displayName: profile.displayName,
  homeCurrency: profile.homeCurrency ?? '',
  upiId: profile.upiId ?? '',
  phone: profile.phone ?? '',
  emergencyContact: profile.emergencyContact ?? '',
  dietaryNotes: profile.dietaryNotes ?? '',
})

function DetailsForm({ profile, onChanged }: { profile: MyProfile; onChanged: (changes: Partial<MyProfile>) => void }) {
  const [form, setForm] = useState<ProfileFormValues>(() => formFrom(profile))
  const [attempted, setAttempted] = useState(false)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const action = useAsyncStatus()
  const errors = validateProfileForm(form)
  const show = (field: ProfileField) => (attempted ? errors[field] : undefined)
  const dirty = JSON.stringify(form) !== JSON.stringify(formFrom(profile))
  const set = (field: ProfileField) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm((current) => ({ ...current, [field]: event.target.value }))
    if (state !== 'saving') setState('idle')
  }
  const currencies = profile.homeCurrency && !TRIP_CURRENCIES.includes(profile.homeCurrency)
    ? [profile.homeCurrency, ...TRIP_CURRENCIES] : TRIP_CURRENCIES

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (state === 'saving') return
    setAttempted(true)
    if (Object.keys(errors).length) return
    setState('saving')
    action.busy()
    const changes = profileChanges(form)
    try {
      await updateMyProfile(profile.id, changes)
      await action.done()
      action.reset()
      onChanged({
        displayName: changes.display_name, homeCurrency: changes.home_currency, upiId: changes.upi_id, phone: changes.phone,
        emergencyContact: changes.emergency_contact, dietaryNotes: changes.dietary_notes,
      })
      setState('saved')
    } catch (error) {
      setState('failed')
      action.fail()
      if (error instanceof ProfileRequestError && error.code === 'invalid_value') setAttempted(true)
    }
  }

  return (
    <form aria-label="Your details" noValidate onSubmit={(event) => void save(event)} className="flex flex-col gap-4" aria-busy={state === 'saving'} data-layout="section">
      <h2 className="t-eyebrow">Your details</h2>
      <Field id="profile-name" label="Display name" hint="How you appear to everyone in your Trips." error={show('displayName')}>
        <NeonInput value={form.displayName} onChange={set('displayName')} autoComplete="name" maxLength={80} style={inputStyle} />
      </Field>
      <Field id="profile-currency" label="Home currency" optional hint="New domestic Trips use it as their currency." error={show('homeCurrency')}>
        <NeonSelect value={form.homeCurrency} onChange={set('homeCurrency')}>
          <option value="">Not set</option>
          {currencies.map((code) => <option key={code} value={code}>{code} · {currencyName(code)}</option>)}
        </NeonSelect>
      </Field>
      <Field id="profile-upi" label="UPI ID" optional hint="Friends can pay you from Split" error={show('upiId')}>
        <NeonInput value={form.upiId} onChange={set('upiId')} placeholder="name@okbank" autoComplete="off" autoCapitalize="off" spellCheck={false} style={inputStyle} />
      </Field>

      <fieldset className="surface card flex flex-col gap-4" data-layout="card">
        <legend className="sr-only">Crew info</legend>
        <div>
          <p aria-hidden="true" className="t-callout t-medium" style={{ color: 'var(--text-primary)' }}>Crew info</p>
          <p className="field-hint t-footnote mt-1">Visible only to people in your Trips</p>
        </div>
        <Field id="profile-phone" label="Phone" optional error={show('phone')}>
          <NeonInput type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" placeholder="e.g. +91 98765 43210" style={inputStyle} />
        </Field>
        <Field id="profile-emergency" label="Emergency contact" optional error={show('emergencyContact')}>
          <NeonInput value={form.emergencyContact} onChange={set('emergencyContact')} maxLength={EMERGENCY_CONTACT_MAX} placeholder="Name and phone number" autoComplete="off" style={inputStyle} />
        </Field>
        <Field id="profile-dietary" label="Dietary needs or allergies" optional error={show('dietaryNotes')}>
          <textarea className="field-textarea" value={form.dietaryNotes} onChange={set('dietaryNotes')} maxLength={DIETARY_NOTES_MAX} placeholder="e.g. Vegetarian, nut allergy" />
        </Field>
      </fieldset>

      <Collapse open={attempted && Object.keys(errors).length > 0} gap={5}>
        <p role="alert" className="notice notice--error">Check the highlighted fields.</p>
      </Collapse>
      <Collapse open={state === 'failed'} gap={5}>
        <p role="alert" className="notice notice--error">We couldn’t save your details. Check your connection and try again.</p>
      </Collapse>
      <Collapse open={state === 'saved' && !dirty} gap={5}>
        <p role="status" className="notice">Saved.</p>
      </Collapse>
      <AsyncButton type="submit" size="lg" className="w-full" status={action.status} busyLabel="Saving…" doneLabel="Saved"
        disabled={!dirty && state !== 'failed' && action.status === 'idle'}>
        Save details
      </AsyncButton>
    </form>
  )
}

function ChangeEmailSheet({ currentEmail, onClose }: { currentEmail: string | undefined; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'sending' | 'pending' | 'changed'>('idle')
  const action = useAsyncStatus()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const problem = emailError(email, currentEmail)
    setError(problem)
    if (problem || state === 'sending') return
    setState('sending')
    action.busy()
    try {
      const outcome = await changeEmail(email)
      await action.done()
      setState(outcome)
    } catch (failure) {
      setState('idle')
      action.fail()
      setError(failure instanceof AccountRequestError && failure.code === 'email_unavailable'
        ? 'That email address can’t be used. Try another one.'
        : 'We couldn’t start the change. Check your connection and try again.')
    }
  }

  return (
    <Sheet title="Change email" testId="change-email-sheet" onClose={onClose}>
      <Swap id={state === 'pending' || state === 'changed' ? 'sent' : 'form'}>
      {state === 'pending' || state === 'changed' ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="notice">{state === 'changed'
            ? `Your sign-in email is now ${email.trim()}.`
            : `We sent a confirmation link to ${email.trim()}. Your sign-in email changes only after you open it. If an email also arrives at ${currentEmail ?? 'your current address'}, confirm that one too. Until then, keep signing in with ${currentEmail ?? 'your current email'}.`}</p>
          <NeonBtn type="button" size="lg" className="w-full" onClick={onClose}>Done</NeonBtn>
        </div>
      ) : (
        <form aria-label="Change email" noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <p className="t-callout" style={{ color: 'var(--text-secondary)' }}>
            We’ll email a confirmation link to the new address. Nothing changes until you open it.
          </p>
          <Field id="new-email" label="New email" error={error ?? undefined}>
            <NeonInput type="email" value={email} onChange={(event) => { setEmail(event.target.value); setError(null) }}
              autoComplete="email" inputMode="email" placeholder="you@example.com" style={inputStyle} />
          </Field>
          <AsyncButton type="submit" size="lg" className="w-full" status={action.status} busyLabel="Sending…" doneLabel="Sent">Send confirmation link</AsyncButton>
        </form>
      )}
      </Swap>
    </Sheet>
  )
}

function ChangePasswordSheet({ email, onClose }: { email: string; onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<{ field: 'current' | 'next' | 'form'; text: string } | null>(null)
  const [state, setState] = useState<'idle' | 'saving' | 'done'>('idle')
  const action = useAsyncStatus()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (state === 'saving') return
    if (!current) return setError({ field: 'current', text: 'Enter your current password.' })
    const problem = newPasswordError(next, confirmation)
    if (problem) return setError({ field: 'next', text: problem })
    setError(null)
    setState('saving')
    action.busy()
    try {
      await changePassword(email, current, next)
      await action.done()
      setState('done')
    } catch (failure) {
      setState('idle')
      action.fail()
      const code = failure instanceof AccountRequestError ? failure.code : 'password_failed'
      setError(code === 'wrong_password' ? { field: 'current', text: 'That’s not your current password.' }
        : code === 'same_password' ? { field: 'next', text: 'Choose a password different from your current one.' }
          : code === 'weak_password' ? { field: 'next', text: 'Choose a stronger password.' }
            : { field: 'form', text: 'We couldn’t change your password. Check your connection and try again.' })
    }
  }

  return (
    <Sheet title="Change password" testId="change-password-sheet" onClose={onClose}>
      <Swap id={state === 'done' ? 'done' : 'form'}>
      {state === 'done' ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="notice">Password changed. Use it the next time you sign in.</p>
          <NeonBtn type="button" size="lg" className="w-full" onClick={onClose}>Done</NeonBtn>
        </div>
      ) : (
        <form aria-label="Change password" noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <Field id="current-password" label="Current password" error={error?.field === 'current' ? error.text : undefined}>
            <NeonInput type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" style={inputStyle} />
          </Field>
          <Field id="new-password" label="New password" hint="At least 8 characters." error={error?.field === 'next' ? error.text : undefined}>
            <NeonInput type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" style={inputStyle} />
          </Field>
          <Field id="confirm-new-password" label="Confirm new password">
            <NeonInput type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" style={inputStyle} />
          </Field>
          <Collapse open={error?.field === 'form'} gap={4}>
            <p role="alert" className="notice notice--error">{error?.text}</p>
          </Collapse>
          <AsyncButton type="submit" size="lg" className="w-full" status={action.status} busyLabel="Checking…" doneLabel="Changed">Change password</AsyncButton>
        </form>
      )}
      </Swap>
    </Sheet>
  )
}

function DeleteAccountSheet({ userId, onClose, onDeleted }: { userId: string; onClose: () => void; onDeleted: () => void }) {
  const [blockers, setBlockers] = useState<{ groupId: string; tripName: string }[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [typed, setTyped] = useState('')
  const [state, setState] = useState<'idle' | 'deleting'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setLoadFailed(false)
    void loadDeletionBlockers().then((rows) => { if (active) setBlockers(rows) }, () => { if (active) setLoadFailed(true) })
    return () => { active = false }
  }, [attempt])

  const confirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (typed !== 'DELETE' || state === 'deleting') return
    setState('deleting')
    setError(null)
    try {
      await deleteMyAccount(userId)
      onDeleted()
    } catch (failure) {
      const code = failure instanceof AccountRequestError ? failure.code : 'operation_failed'
      setState('idle')
      if (code === 'last_owner') setAttempt((value) => value + 1)
      setError(accountErrorMessage(code))
    }
  }

  return (
    <Sheet title="Delete account" testId="delete-account-sheet" onClose={() => { if (state !== 'deleting') onClose() }}>
      {loadFailed ? (
        <div className="flex flex-col gap-4">
          <p role="alert" className="notice notice--error">We couldn’t check your Trips. Check your connection and try again.</p>
          <NeonBtn type="button" size="lg" className="w-full" onClick={() => setAttempt((value) => value + 1)}>Try again</NeonBtn>
        </div>
      ) : blockers === null ? (
        <p role="status" className="t-callout flex items-center gap-3 py-4" style={{ color: 'var(--text-secondary)' }}><span className="spinner" aria-hidden="true" />Checking your Trips…</p>
      ) : blockers.length > 0 ? (
        <div className="flex flex-col gap-4" data-testid="delete-account-blocked">
          <p className="t-callout" style={{ color: 'var(--text-primary)' }}>
            You’re the only Owner of {blockers.length === 1 ? 'this Trip' : 'these Trips'}. Make someone else an Owner in the Trip’s Settings, under People, or archive the Trip, before you delete your account.
          </p>
          <ul className="flex flex-col gap-2" aria-label="Trips that need another Owner">
            {blockers.map((trip) => <li key={trip.groupId} className="t-callout surface card--nested card--row">{trip.tripName}</li>)}
          </ul>
          <NeonBtn type="button" size="lg" className="w-full" onClick={onClose}>OK</NeonBtn>
        </div>
      ) : (
        <form aria-label="Delete account" noValidate onSubmit={(event) => void confirm(event)} className="flex flex-col gap-4">
          <p className="t-callout" style={{ color: 'var(--text-primary)' }}>
            This permanently deletes your account, profile and photo, and you leave every Trip. Plans, expenses and payments you added stay for the others and show as “a former member”. This can’t be undone.
          </p>
          <Field id="delete-confirm" label="Type DELETE to confirm">
            <NeonInput value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} style={inputStyle} />
          </Field>
          <Collapse open={Boolean(error)} gap={4}>
            <p role="alert" className="notice notice--error">{error}</p>
          </Collapse>
          <AsyncButton type="submit" size="lg" className="w-full" color="var(--neon-pink)" disabled={typed !== 'DELETE'}
            status={state === 'deleting' ? 'busy' : error ? 'error' : 'idle'} busyLabel="Deleting…">
            Delete my account
          </AsyncButton>
          <NeonBtn type="button" variant="ghost" size="lg" className="w-full" disabled={state === 'deleting'} onClick={onClose}>Keep my account</NeonBtn>
        </form>
      )}
    </Sheet>
  )
}

/**
 * What the AI features have used for me so far (today: reading scanned
 * documents), across every Trip: total tokens and what they cost in dollars.
 * Re-read each time Profile opens, so it grows as I use them.
 */
function AiUsage() {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; totals: AiUsageTotals }>({ kind: 'loading' })
  useEffect(() => {
    let active = true
    loadMyAiUsage()
      .then((totals) => { if (active) setState({ kind: 'ready', totals }) })
      .catch(() => { if (active) setState({ kind: 'error' }) })
    return () => { active = false }
  }, [])
  const tokens = state.kind === 'ready' ? state.totals.totalTokens.toLocaleString('en-US') : '—'
  const cost = state.kind === 'ready' ? formatUsd(state.totals.costMicroUsd) : '—'
  return (
    <section aria-labelledby="profile-ai-usage" className="section" data-testid="profile-ai-usage" data-layout="section">
      <h2 id="profile-ai-usage" className="t-eyebrow">AI usage</h2>
      <div className="surface card grid grid-cols-2" data-layout="card" aria-busy={state.kind === 'loading'}>
        <div className="min-w-0">
          <p className="field-label t-footnote t-medium">Tokens used</p>
          <p className="t-headline t-num mt-1 truncate" style={{ color: 'var(--text-primary)' }} data-testid="ai-usage-tokens">{tokens}</p>
        </div>
        <div className="min-w-0 border-l pl-4" style={{ borderColor: 'var(--border)' }}>
          <p className="field-label t-footnote t-medium">Cost</p>
          <p className="t-headline t-num mt-1 truncate" style={{ color: 'var(--text-primary)' }} data-testid="ai-usage-cost">{cost}</p>
        </div>
      </div>
      <p className="t-footnote" style={{ color: 'var(--text-tertiary)' }}>
        {state.kind === 'error' ? 'Couldn’t load your AI usage just now.' : 'Everything AI has done for you so far, like reading scanned tickets and bills, across all your Trips.'}
      </p>
    </section>
  )
}
