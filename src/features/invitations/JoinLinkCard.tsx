import { useEffect, useRef, useState } from 'react'
import { Collapse } from '../../components/ui/Collapse'
import { NeonBtn } from '../../components/ui/NeonBtn'
import { Switch } from '../../components/ui/Switch'
import { ActionSheet } from '../crew/ActionSheet'
import { type JoinLinkState, getJoinLink, setJoinLink } from './joinLinkApi'
import { joinShareUrl } from './joinLink'
import { canNativeShare } from './inviteShare'

type LoadState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; link: JoinLinkState }

/** What a failed load or change says (joinLinkApi.ts throws `Error(code)`). */
function joinLinkErrorMessage(code: string): string {
  if (code === 'trip_archived') return 'This Trip is archived, so its invite link can’t change.'
  if (code === 'not_authorized') return 'Only the Trip Owner can change the invite link.'
  return 'We couldn’t update the invite link. Check your connection and try again.'
}

const codeOf = (error: unknown) => (error instanceof Error ? error.message : 'join_link_unavailable')

/** The share URL for a proof, on this app's origin. */
function shareUrl(proof: string): string {
  return joinShareUrl(new URL(import.meta.env.BASE_URL, window.location.origin).toString(), proof)
}

/**
 * Settings → Invite: the Trip's one open link ("anyone with the link can join",
 * migration 096). The Owner turns it on or off and can reset it (the old link stops
 * working); every member can copy and share it while it is on.
 */
export function JoinLinkCard({ groupId, tripName, isOwner }: { groupId: string; tripName: string; isOwner: boolean }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const copiedTimer = useRef(0)
  // The reset sheet maps errors through Crew codes; keep the join-link code for its message.
  const resetError = useRef('join_link_unavailable')

  useEffect(() => {
    let active = true
    void getJoinLink(groupId).then(
      (link) => { if (active) setState({ kind: 'ready', link }) },
      () => { if (active) setState({ kind: 'error' }) },
    )
    return () => { active = false }
  }, [groupId, attempt])
  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])

  const link = state.kind === 'ready' ? state.link : null
  const url = link?.active ? shareUrl(link.proof) : null
  const share = url ? { title: `Join ${tripName} on Rove`, text: `Join ${tripName} on Rove`, url } : null

  const toggle = async (enabled: boolean) => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    setMessage(null)
    try {
      const result = await setJoinLink(groupId, enabled)
      setState({ kind: 'ready', link: result.active ? { active: true, proof: result.proof } : { active: false } })
    } catch (error) {
      setFailure(joinLinkErrorMessage(codeOf(error)))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!url) return
    setMessage(null)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setMessage('Copy didn’t work here. Press and hold the link to copy it.')
    }
  }

  const shareLink = async () => {
    if (!share) return
    setMessage(null)
    if (!canNativeShare(typeof navigator === 'undefined' ? undefined : navigator, share)) {
      await copy()
      return
    }
    try {
      await navigator.share(share)
    } catch (error) {
      // Closing the share sheet is not a failure.
      if (!(error instanceof DOMException && error.name === 'AbortError')) await copy()
    }
  }

  return (
    <section data-testid="join-link-card" aria-labelledby="join-link-heading" className="surface settings-card" data-layout="card">
      <h3 id="join-link-heading" className="t-headline" style={{ color: 'var(--text-primary)' }}>Invite link</h3>
      {state.kind === 'loading' && <p role="status" className="t-callout" style={{ color: 'var(--text-secondary)' }}>Loading the invite link…</p>}
      {state.kind === 'error' && <div className="flex flex-col items-start gap-3">
        <p role="alert" className="t-callout" style={{ color: 'var(--text-secondary)' }}>We couldn’t load the invite link.</p>
        <NeonBtn type="button" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>Try again</NeonBtn>
      </div>}
      {link && <>
        {isOwner && <Switch label="Anyone with the link can join" checked={link.active} disabled={busy} testId="join-link-switch"
          onChange={(enabled) => void toggle(enabled)} />}
        {link.active && url
          ? <>
            <p className="t-callout" style={{ color: 'var(--text-secondary)' }}>
              {isOwner ? 'Anyone who opens this link can join as a Member.' : 'Share this link and anyone who opens it can join as a Member.'}
            </p>
            <p data-testid="join-link-url" className="settings-link t-footnote t-code" title={url}>{url}</p>
            <div className="settings-actions">
              <NeonBtn type="button" onClick={() => void copy()} aria-live="polite">{copied ? 'Copied' : 'Copy'}</NeonBtn>
              <NeonBtn type="button" variant="outline" onClick={() => void shareLink()}>Share</NeonBtn>
              {isOwner && <NeonBtn type="button" variant="ghost" disabled={busy} onClick={() => setConfirmReset(true)}>Reset link</NeonBtn>}
            </div>
          </>
          : <p className="t-callout" style={{ color: 'var(--text-secondary)' }}>
            {isOwner ? 'Turn on to share one link anyone can use. Turn it off once everyone’s in.' : 'The Owner has turned off the invite link.'}
          </p>}
      </>}
      <Collapse open={Boolean(failure || message)}>
        <p role={failure ? 'alert' : 'status'} className="t-footnote" style={{ color: failure ? 'var(--accent)' : 'var(--text-secondary)' }}>{failure ?? message}</p>
      </Collapse>
      {confirmReset && <ActionSheet title="Reset the invite link" testId="reset-join-link-sheet" onClose={() => setConfirmReset(false)} actions={[{
        id: 'reset-join-link',
        menuLabel: 'Reset link',
        title: 'Reset the invite link?',
        body: 'The current link stops working straight away. Share the new one with anyone who still needs to join.',
        confirmLabel: 'Reset link',
        busyLabel: 'Resetting…',
        tone: 'danger',
        run: async () => {
          const result = await setJoinLink(groupId, true, true).catch((error: unknown) => {
            resetError.current = codeOf(error)
            throw error
          })
          setState({ kind: 'ready', link: result.active ? { active: true, proof: result.proof } : { active: false } })
          return 'Done. The old link no longer works; share the new one.'
        },
        describeError: () => ({
          message: joinLinkErrorMessage(resetError.current),
          retryable: resetError.current === 'join_link_unavailable',
        }),
      }]} />}
    </section>
  )
}
