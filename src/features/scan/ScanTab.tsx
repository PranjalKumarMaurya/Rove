import { type CSSProperties, type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NeonBtn } from '../../components/ui/NeonBtn'
import { AsyncButton, AsyncLabel, useAsyncStatus } from '../../components/ui/AsyncButton'
import { Collapse } from '../../components/ui/Collapse'
import { foldProps, useExitList } from '../../components/ui/motion'
import { Swap } from '../../components/ui/Swap'
import type { TripTabProps } from '../workspace/tripTab'
import { DEFAULT_MEMBER_PARSE_LIMIT, MAX_DOCUMENT_BYTES, billToEventDraft, emptyDraft, eventToBillDraft, type TripContext } from '../../../supabase/functions/_shared/documentDraft.ts'
import { ExpenseForm, type ExpensePrefill } from '../split/ExpenseForm'
import type { LedgerExpense } from '../split/ledger'
import { loadLedger } from '../split/splitApi'
import { useTravelLegs } from '../trip/tripEventsApi'
import { DraftReviewForm } from './DraftReviewForm'
import { KindRow } from './KindRow'
import { prepareForUpload } from './prepareImage'
import {
  ScanError, type TripDocument, addDocumentEvent, deleteTripDocument, eventAudience, isUnsplitBill, linkDocumentExpense, listTripDocuments, myReadsToday,
  parseTripDocument, signedDocumentUrl, storedDraft, uploadTripDocument,
} from './documentsApi'
import {
  BILL_WARNING_MESSAGES, FILE_PROBLEM_MESSAGES, type BillDraft, type DocumentDraft, type EventInput, batchSummary, billPrefill, bookingCostPrefill,
  checkSelectedFile, fileKindLabel, formatBytes, isBillDraft, parseFailureMessage, planBatch, reviewQueue, splitReads,
} from './scanRules'

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif'

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; done?: number; total?: number }
  | { kind: 'parsing'; document: TripDocument }
  | { kind: 'review'; document: TripDocument; draft: DocumentDraft; notice: string | null; canRetry: boolean }
  /** A booking in the itinerary whose cost is being split. `justAdded`: straight after adding it. */
  | { kind: 'cost'; document: TripDocument; title: string; prefill: ExpensePrefill; justAdded: boolean }

type ListState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; documents: TripDocument[] }

const UPLOAD_MESSAGES: Record<string, string> = {
  too_large: FILE_PROBLEM_MESSAGES.too_large,
  unsupported: FILE_PROBLEM_MESSAGES.unsupported,
  upload_failed: 'The upload did not finish. Nothing was saved. Check your connection and try again.',
}

const DELETE_MESSAGES: Record<string, string> = {
  delete_denied: 'Only the person who uploaded this document or a Trip Owner can delete it.',
  delete_partial: 'The file was deleted, but its entry could not be removed. Try again.',
  delete_failed: 'The document could not be deleted. Try again.',
}

export function ScanTab({ trip, roster }: TripTabProps) {
  const tripContext = useMemo<TripContext>(() => ({
    timezone: trip.timezone, startDate: trip.startDate, endDate: trip.endDate, destination: trip.destination,
  }), [trip.timezone, trip.startDate, trip.endDate, trip.destination])
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const file = files.length === 1 ? files[0] : null
  // Several files: what will happen, shown before uploading.
  const [batchNote, setBatchNote] = useState<string | null>(null)
  const [readNowCount, setReadNowCount] = useState(0)
  // Documents being read in the background after a multi-file upload.
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set())
  // "Review next": documents finished or skipped in this walk-through.
  const [walk, setWalk] = useState<{ handled: ReadonlySet<string> } | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)
  // "Add to itinerary" on the review form: Adding… → Added ✓.
  const addAction = useAsyncStatus()
  const [uploadFailed, setUploadFailed] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [reloadCount, setReloadCount] = useState(0)
  const reload = useCallback(() => setReloadCount((value) => value + 1), [])
  // Expenses already in Split, to warn before the same cost is added twice.
  const [existing, setExisting] = useState<LedgerExpense[]>([])
  const legs = useTravelLegs(trip.groupId, reloadCount)
  const splitting = phase.kind === 'cost' || (phase.kind === 'review' && isBillDraft(phase.draft))
  useEffect(() => {
    if (!splitting) return
    let active = true
    loadLedger(trip.groupId).then((ledger) => { if (active) setExisting(ledger.expenses) }).catch(() => { /* the warning is optional */ })
    return () => { active = false }
  }, [splitting, trip.groupId])

  useEffect(() => {
    let active = true
    listTripDocuments(trip.groupId)
      .then((documents) => { if (active) setList({ kind: 'ready', documents }) })
      .catch(() => { if (active) setList((current) => current.kind === 'ready' ? current : { kind: 'error' }) })
    return () => { active = false }
  }, [trip.groupId, reloadCount])

  const names = useMemo(() => new Map(roster.map((member) => [member.groupMemberId, member.displayName])), [roster])
  const members = useMemo(() => roster.filter((member) => member.status === 'active')
    .map((member) => ({ id: member.groupMemberId, name: member.displayName })), [roster])
  const busy = phase.kind === 'uploading' || phase.kind === 'parsing'

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = [...(event.target.files ?? [])]
    // A cancelled chooser keeps the previous selection.
    if (!picked.length) return
    setUploadFailed(false)
    setMessage(null)
    setBatchNote(null)
    if (picked.length === 1) {
      const problem = checkSelectedFile(picked[0])
      setFileError(problem ? FILE_PROBLEM_MESSAGES[problem] : null)
      setFiles(problem ? [] : picked)
      if (problem && inputRef.current) inputRef.current.value = ''
      return
    }
    const plan = planBatch(picked)
    setFileError(plan.accepted.length ? null : 'None of these files can be added. Choose PDFs or photos under the size limit.')
    setFiles(plan.accepted)
    if (!plan.accepted.length) return
    const show = (used: number | null) => {
      const reads = splitReads(plan.accepted.length, used, DEFAULT_MEMBER_PARSE_LIMIT)
      setReadNowCount(reads.readNow)
      setBatchNote(batchSummary(plan, reads))
    }
    show(null)
    void myReadsToday().then(show).catch(() => { /* keep the estimate */ })
  }

  const clearFile = () => {
    setFiles([])
    setFileError(null)
    setBatchNote(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const read = async (document: TripDocument) => {
    setPhase({ kind: 'parsing', document })
    const outcome = await parseTripDocument(document.id, tripContext)
    if (outcome.ok) {
      setPhase({ kind: 'review', document, draft: outcome.draft, notice: null, canRetry: false })
    } else {
      setPhase({ kind: 'review', document, draft: emptyDraft(tripContext), notice: parseFailureMessage(outcome.code), canRetry: outcome.code === 'network' || outcome.code === 'parse_failed' || outcome.code === 'unknown' })
    }
    reload()
  }

  // Several files: upload them all, then read them one after another in the
  // background. Nothing opens; each shows its status in Trip documents and
  // "Review next" walks through them.
  const uploadMany = async () => {
    const batch = files
    const readNow = readNowCount
    setMessage(null)
    setSaveError(null)
    setUploadFailed(false)
    setPhase({ kind: 'uploading', done: 0, total: batch.length })
    const uploaded: TripDocument[] = []
    const failed: string[] = []
    for (const [index, picked] of batch.entries()) {
      try {
        const prepared = await prepareForUpload(picked)
        if (prepared.size > MAX_DOCUMENT_BYTES) throw new ScanError('too_large')
        uploaded.push(await uploadTripDocument(trip.groupId, trip.groupMemberId, prepared))
      } catch {
        failed.push(picked.name)
      }
      setPhase({ kind: 'uploading', done: index + 1, total: batch.length })
    }
    clearFile()
    setPhase({ kind: 'idle' })
    if (failed.length) setUploadFailed(true)
    if (failed.length) setFileError(`These didn’t upload, so nothing was saved for them: ${failed.join(', ')}. Try them again.`)
    reload()
    const toRead = uploaded.slice(0, readNow)
    setReading(new Set(toRead.map((document) => document.id)))
    setMessage(`Uploaded ${uploaded.length}. Reading ${toRead.length}…`)
    let stopped = false
    for (const document of toRead) {
      if (!stopped) {
        const outcome = await parseTripDocument(document.id, tripContext)
        // Out of reads (another device used some): the rest wait as "Not read yet".
        if (!outcome.ok && (outcome.code === 'parse_limit_reached' || outcome.code === 'trip_parse_limit_reached')) stopped = true
      }
      setReading((current) => { const next = new Set(current); next.delete(document.id); return next })
      reload()
    }
    setMessage(`${uploaded.length} added to Trip documents. Tap “Review next” to go through them.`)
  }

  const uploadAndRead = async () => {
    if (files.length > 1 && !busy) { await uploadMany(); return }
    if (!file || busy) return
    setMessage(null)
    setSaveError(null)
    setUploadFailed(false)
    setPhase({ kind: 'uploading' })
    let document: TripDocument
    try {
      // Photos are shrunk first so they upload quickly and stay within what the reader accepts.
      const prepared = await prepareForUpload(file)
      if (prepared.size > MAX_DOCUMENT_BYTES) throw new ScanError('too_large')
      document = await uploadTripDocument(trip.groupId, trip.groupMemberId, prepared)
    } catch (error) {
      setFileError(UPLOAD_MESSAGES[error instanceof ScanError ? error.message : ''] ?? UPLOAD_MESSAGES.upload_failed)
      setUploadFailed(true)
      setPhase({ kind: 'idle' })
      return
    }
    clearFile()
    reload()
    await read(document)
  }

  // Latest values for the walk-through, which continues after async saves.
  const latest = useRef({ list, reading, walk })
  latest.current = { list, reading, walk }
  const queue = useMemo(() => (list.kind === 'ready' ? reviewQueue(list.documents, walk?.handled ?? new Set(), reading) : []),
    [list, walk, reading])

  const reviewNext = (handled: ReadonlySet<string>) => {
    const current = latest.current
    const next = current.list.kind === 'ready' ? reviewQueue(current.list.documents, handled, current.reading)[0] : undefined
    if (!next) {
      setWalk(null)
      setPhase({ kind: 'idle' })
      if (handled.size) setMessage(current.reading.size ? 'That’s all for now. More are still being read.' : 'All caught up: nothing left to review.')
      return
    }
    setWalk({ handled: new Set([...handled, next.id]) })
    review(next)
  }

  const startWalk = () => { setMessage(null); reviewNext(new Set()) }
  const stopWalk = () => { setWalk(null); setPhase({ kind: 'idle' }) }

  /** One document is done, skipped or put off: go to the next one while walking, otherwise close. */
  const finish = () => {
    const current = latest.current.walk
    if (current) reviewNext(current.handled)
    else setPhase({ kind: 'idle' })
  }

  const review = (document: TripDocument) => {
    setMessage(null)
    setSaveError(null)
    const draft = storedDraft(document, tripContext)
    if (draft) setPhase({ kind: 'review', document, draft, notice: null, canRetry: true })
    else void read(document)
  }

  const addToItinerary = async (input: EventInput, audience: string[], addToSplit: boolean) => {
    if (phase.kind !== 'review' || isBillDraft(phase.draft)) return
    const { document, draft } = phase
    setSaving(true)
    addAction.busy()
    setSaveError(null)
    try {
      await addDocumentEvent(document.id, input, audience)
      // The button's tick confirms it; then on to Split, or back to Scan.
      await addAction.done()
      addAction.reset()
      if (addToSplit) {
        const included = audience.length ? audience : members.map((member) => member.id)
        setPhase({ kind: 'cost', document, title: input.title, justAdded: true,
          prefill: bookingCostPrefill(draft, input, trip.accountingCurrency, included) })
      } else {
        setMessage(`Added to the itinerary: ${input.title}`)
        finish()
      }
      reload()
    } catch (error) {
      setSaveError(error instanceof ScanError && error.message === 'document_unavailable'
        ? 'This document is already in the itinerary or is no longer available to you.'
        : 'We could not add this to the itinerary. Your details are still here; try again.')
      addAction.fail()
    } finally {
      setSaving(false)
    }
  }

  // A bill was split: record it on the document so it leaves the "ready to split" list.
  const billSplit = async (document: TripDocument, draft: BillDraft, expenseId: string) => {
    try {
      await linkDocumentExpense(document.id, expenseId)
      setMessage(`Added to Split: ${draft.title}`)
    } catch {
      setMessage(`Added to Split: ${draft.title}. This bill still shows as ready to split; don’t split it again.`)
    }
    reload()
    finish()
  }

  // Split a booking that is already in the itinerary (from Trip documents).
  const splitCost = async (document: TripDocument) => {
    setMessage(null)
    let audience: string[] = []
    try { audience = document.eventId ? await eventAudience(document.eventId) : [] } catch { /* fall back to everyone */ }
    const draft = storedDraft(document, tripContext)
    const booking = draft && !isBillDraft(draft) ? draft : null
    const title = document.eventTitle ?? booking?.title ?? document.fileName
    const active = new Set(members.map((member) => member.id))
    const included = audience.filter((id) => active.has(id))
    setPhase({ kind: 'cost', document, title, justAdded: false, prefill: bookingCostPrefill(
      { price: booking?.price ?? null }, { title, eventType: booking?.eventType ?? 'other', startsAt: booking?.startsAt ?? null }, trip.accountingCurrency,
      included.length ? included : [...active]) })
  }

  const costSplit = async (document: TripDocument, title: string, expenseId: string) => {
    try {
      await linkDocumentExpense(document.id, expenseId)
      setMessage(`In the itinerary and in Split: ${title}`)
    } catch {
      setMessage(`Added to Split: ${title}. The document doesn’t show it yet; don’t split it again.`)
    }
    reload()
    finish()
  }

  const switchKind = () => {
    if (phase.kind !== 'review') return
    setSaveError(null)
    setPhase({ ...phase, draft: isBillDraft(phase.draft) ? billToEventDraft(phase.draft, tripContext) : eventToBillDraft(phase.draft), notice: null })
  }

  return (
    <section data-testid="scan-tab" className="flex flex-col gap-6">
      <div className="surface px-4 py-5">
        <h2 className="t-title2" style={{ color: 'var(--text-primary)' }}>Scan</h2>
        <p className="t-callout mt-2" style={{ color: 'var(--text-secondary)' }}>
          Add a ticket, hotel voucher, or booking for the itinerary, or a bill to split. You review the details before anything is saved. A booking stays private to you until you pick who’s on it; bills are shared with the Trip.
        </p>
        <label className="mt-5 flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-7 text-center focus-within:ring-2 focus-within:ring-[#FF8B4D]"
          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-secondary)', opacity: busy ? 0.5 : 1 }}>
          <span className="t-body t-medium" style={{ color: 'var(--text-primary)' }}>{files.length ? 'Choose different files' : 'Choose tickets, bookings, or bills'}</span>
          <span className="t-eyebrow" style={{ color: 'var(--text-tertiary)' }}>ONE OR MANY · PDF · JPG · PNG · WEBP · HEIC</span>
          <input ref={inputRef} type="file" accept={ACCEPT} multiple onChange={choose} disabled={busy} className="sr-only" aria-label="Ticket, booking, or bill file" />
        </label>
        <Collapse open={Boolean(file)}>
          {file && <div data-testid="scan-selected-file" className="mt-3 flex items-center justify-between gap-3 t-callout" style={{ color: 'var(--text-primary)' }}>
            <span className="min-w-0 truncate">{file.name}</span>
            <span className="t-num flex shrink-0 items-center gap-3" style={{ color: 'var(--text-secondary)' }}>
              <span className="whitespace-nowrap">{fileKindLabel(file.type)} · {formatBytes(file.size)}</span>
              <button type="button" onClick={clearFile} disabled={busy} style={{ color: 'var(--text-secondary)' }}>Remove</button>
            </span>
          </div>}
        </Collapse>
        <Collapse open={files.length > 1}>
          <div data-testid="scan-selected-files" className="mt-3 flex flex-col gap-1 t-callout" style={{ color: 'var(--text-primary)' }}>
            <ul className="flex flex-col gap-0.5">
              {files.map((picked) => <li key={`${picked.name}-${picked.size}`} className="truncate" style={{ color: 'var(--text-secondary)' }}>{picked.name}</li>)}
            </ul>
            <Collapse open={Boolean(batchNote)}>
              <p data-testid="scan-batch-note" className="t-footnote" style={{ color: 'var(--text-tertiary)' }}>{batchNote}</p>
            </Collapse>
            <button type="button" onClick={clearFile} disabled={busy} className="self-start" style={{ color: 'var(--text-secondary)' }}>Clear</button>
          </div>
        </Collapse>
        <Collapse open={Boolean(fileError)}>
          <p role="alert" className="mt-3 t-callout" style={{ color: 'var(--accent)' }}>{fileError}</p>
        </Collapse>
        <AsyncButton type="button" onClick={() => void uploadAndRead()} disabled={!files.length} className="mt-4 w-full"
          status={busy ? 'busy' : uploadFailed ? 'error' : 'idle'}
          busyKey={phase.kind === 'parsing' ? 'reading' : 'uploading'}
          busyLabel={phase.kind === 'uploading'
            ? (phase.total && phase.total > 1 ? `Uploading ${phase.done ?? 0} of ${phase.total}…` : 'Uploading…')
            : 'Reading…'}>
          {files.length > 1 ? `Upload ${files.length} files` : 'Upload and read'}
        </AsyncButton>
        <Collapse open={busy}>
          <p role="status" className="t-eyebrow mt-3 text-center" style={{ color: 'var(--text-tertiary)' }}>
            <span key={phase.kind} className="m-text-swap inline-block">{phase.kind === 'uploading' ? 'UPLOADING PRIVATELY' : 'READING THE DOCUMENT'}</span>
          </p>
        </Collapse>
        <Collapse open={Boolean(message)}>
          <p role="status" className="mt-3 t-callout" style={{ color: 'var(--accent)' }}>{message}</p>
        </Collapse>
        <Collapse open={!walk && phase.kind === 'idle' && queue.length > 0}>
          <NeonBtn type="button" variant="outline" color="#FF8B4D" onClick={startWalk} className="mt-4 w-full" data-testid="scan-review-next">
            Review next · {queue.length} waiting{reading.size ? ` · ${reading.size} reading` : ''}
          </NeonBtn>
        </Collapse>
      </div>

      {walk && phase.kind !== 'idle' && (
        <div data-testid="scan-walk" className="-mb-3 flex items-center justify-between gap-3 px-1 t-callout" style={{ color: 'var(--text-secondary)' }}>
          <span className="t-eyebrow t-num min-w-0">
            REVIEWING {walk.handled.size} OF {walk.handled.size + queue.length}
          </span>
          <button type="button" onClick={stopWalk} disabled={saving} className="min-h-11 shrink-0" style={{ color: 'var(--text-secondary)' }}>Stop reviewing</button>
        </div>
      )}

      <Collapse open={phase.kind === 'review' && !isBillDraft(phase.draft)} gap={24}>
      {phase.kind === 'review' && !isBillDraft(phase.draft) && (
        <Swap id={phase.document.id}>
        <DraftReviewForm key={`${phase.document.id}-${phase.draft.startsAt ?? ''}-${phase.notice ?? ''}`} draft={phase.draft}
          fileName={phase.document.fileName} notice={phase.notice} tripTimezone={trip.timezone} saving={saving} saveStatus={addAction.status} saveError={saveError}
          members={members} me={trip.groupMemberId} onSwitchToBill={switchKind}
          onSubmit={(input, audience, addToSplit) => void addToItinerary(input, audience, addToSplit)} onCancel={finish} cancelLabel={walk ? 'Skip' : undefined}
          onRetryRead={phase.canRetry ? () => void read(phase.document) : undefined} />
        </Swap>
      )}
      </Collapse>
      {phase.kind === 'review' && isBillDraft(phase.draft) && (
        <ExpenseForm key={`bill-${phase.document.id}`} groupId={trip.groupId} accountingCurrency={trip.accountingCurrency}
          timezone={trip.timezone} international={trip.isInternational} me={trip.groupMemberId} members={members} expense={null}
          prefill={billPrefill(phase.draft, trip.accountingCurrency)} requestId={phase.document.id} heading="Split this bill" existing={existing} legs={legs}
          notice={<BillNotice fileName={phase.document.fileName} draft={phase.draft} onSwitchToBooking={switchKind} />}
          onClose={finish}
          onSaved={(expenseId) => { if (phase.kind === 'review' && isBillDraft(phase.draft)) void billSplit(phase.document, phase.draft, expenseId) }} />
      )}
      {phase.kind === 'cost' && (
        <ExpenseForm key={`cost-${phase.document.id}`} groupId={trip.groupId} accountingCurrency={trip.accountingCurrency}
          timezone={trip.timezone} international={trip.isInternational} me={trip.groupMemberId} members={members} expense={null}
          prefill={phase.prefill} requestId={phase.document.id} heading="Split this booking" existing={existing}
          notice={<p className="t-callout" data-testid="scan-cost-notice" style={{ color: 'var(--text-secondary)' }}>
            {phase.justAdded ? `${phase.title} is in the itinerary. ` : ''}Split the cost between the people on this booking, or change who shares it.
          </p>}
          onClose={() => {
            if (phase.justAdded) setMessage(`Added to the itinerary: ${phase.title}. Split the cost any time from Trip documents.`)
            finish()
          }}
          onSaved={(expenseId) => { if (phase.kind === 'cost') void costSplit(phase.document, phase.title, expenseId) }} />
      )}

      <DocumentList state={list} names={names} trip={trip} tripContext={tripContext} disabled={busy || saving} reading={reading}
        onRetry={reload} onReview={review} onSplitCost={(document) => void splitCost(document)} onDeleted={(document, exit) => {
          exit()
          if (phase.kind === 'review' && phase.document.id === document.id) setPhase({ kind: 'idle' })
          setMessage(`Deleted ${document.fileName}`)
          reload()
        }} />
    </section>
  )
}

function BillNotice({ fileName, draft, onSwitchToBooking }: { fileName: string; draft: BillDraft; onSwitchToBooking: () => void }) {
  return (
    <div className="flex flex-col gap-2 t-callout" data-testid="scan-bill-notice">
      <p className="truncate" style={{ color: 'var(--text-secondary)' }}>From {fileName}</p>
      <KindRow kind="bill" onChange={onSwitchToBooking} />
      <p style={{ color: 'var(--text-secondary)' }}>Pick who paid and how to split it.</p>
      {draft.warnings.length > 0 && (
        <ul aria-label="Check these details" className="flex list-disc flex-col gap-1 pl-5" style={{ color: 'var(--accent)' }}>
          {draft.warnings.map((warning) => <li key={warning}>{BILL_WARNING_MESSAGES[warning]}</li>)}
        </ul>
      )}
      <p className="t-footnote" style={{ color: 'var(--text-tertiary)' }}>Not ready? Cancel, and the bill waits in Trip documents until you split it.</p>
    </div>
  )
}

function DocumentList({ state, names, trip, tripContext, disabled, reading, onRetry, onReview, onSplitCost, onDeleted }: {
  reading: ReadonlySet<string>
  state: ListState
  names: Map<string, string>
  trip: TripTabProps['trip']
  tripContext: TripContext
  disabled: boolean
  onRetry: () => void
  onReview: (document: TripDocument) => void
  onSplitCost: (document: TripDocument) => void
  /** `exit`: let its row fold away as the list refreshes. */
  onDeleted: (document: TripDocument, exit: () => void) => void
}) {
  const documents = state.kind === 'ready' ? state.documents : []
  const rows = useExitList(documents, (document) => document.id)
  const dateFormat = useMemo(() => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: trip.timezone }), [trip.timezone])
  return (
    <section aria-labelledby="scan-documents-heading" className="surface px-4 py-5">
      <h2 id="scan-documents-heading" className="t-title3" style={{ color: 'var(--text-primary)' }}>Trip documents</h2>
      <Swap id={state.kind === 'ready' ? (rows.entries.length ? 'list' : 'empty') : state.kind}>
      {state.kind === 'loading' && <p role="status" className="mt-3 t-callout" style={{ color: 'var(--text-tertiary)' }}>Loading documents…</p>}
      {state.kind === 'error' && (
        <div className="mt-3 flex items-center justify-between gap-3 t-callout">
          <p role="alert" style={{ color: 'var(--text-secondary)' }}>We could not load this Trip’s documents.</p>
          <button type="button" onClick={onRetry} className="min-h-11 shrink-0" style={{ color: 'var(--accent)' }}>Retry</button>
        </div>
      )}
      {state.kind === 'ready' && rows.entries.length === 0 && (
        <p className="mt-3 t-callout" style={{ color: 'var(--text-secondary)' }}>No documents yet. Bills you add show to the whole Trip; a booking shows only to the people on it.</p>
      )}
      {state.kind === 'ready' && rows.entries.length > 0 && (
        <ul aria-label="Trip documents" className="m-list mt-3 flex flex-col gap-2" style={{ '--fold-gap': '8px' } as CSSProperties}>
          {rows.entries.map(({ item: document, leaving }) => (
            <DocumentRow key={document.id} leaving={leaving} document={document} disabled={disabled || reading.has(document.id)} reading={reading.has(document.id)} unsplitBill={isUnsplitBill(document, tripContext)}
              uploader={names.get(document.uploadedBy) ?? 'Former member'} date={dateFormat.format(new Date(document.createdAt))}
              canDelete={document.uploadedBy === trip.groupMemberId || trip.role === 'owner'}
              onReview={() => onReview(document)} onSplitCost={() => onSplitCost(document)} onDeleted={() => onDeleted(document, () => rows.exit(document.id))} />
          ))}
        </ul>
      )}
      </Swap>
    </section>
  )
}

function DocumentRow({ document, uploader, date, canDelete, disabled, reading, unsplitBill, onReview, onSplitCost, onDeleted, leaving }: {
  leaving: boolean
  reading: boolean
  document: TripDocument
  unsplitBill: boolean
  uploader: string
  date: string
  canDelete: boolean
  disabled: boolean
  onReview: () => void
  onSplitCost: () => void
  onDeleted: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [working, setWorking] = useState<'view' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null)
  // A failed delete closes the confirmation and shows why, so the label only goes idle → busy.
  const deleteStatus = working === 'delete' ? 'busy' : 'idle'

  const view = async () => {
    setError(null)
    setFallbackUrl(null)
    // Open the tab inside the click so pop-up blockers allow it, then point it at the short-lived link.
    const opened = window.open('', '_blank')
    if (opened) opened.opener = null
    setWorking('view')
    try {
      const url = await signedDocumentUrl(document.storagePath)
      if (opened) opened.location.href = url
      else setFallbackUrl(url)
    } catch {
      opened?.close()
      setError('This document could not be opened. It may have been removed.')
    } finally {
      setWorking(null)
    }
  }

  const remove = async () => {
    setWorking('delete')
    setError(null)
    try {
      await deleteTripDocument(document)
      onDeleted()
    } catch (failure) {
      setError(DELETE_MESSAGES[failure instanceof ScanError ? failure.message : ''] ?? DELETE_MESSAGES.delete_failed)
      setConfirming(false)
    } finally {
      setWorking(null)
    }
  }

  const done = Boolean(document.eventId || document.expenseId)
  const status = document.eventId && document.expenseId
    ? `In itinerary · In Split${document.eventTitle ? `: ${document.eventTitle}` : ''}`
    : document.eventId
    ? `In itinerary${document.eventTitle ? `: ${document.eventTitle}` : ''}`
    : document.expenseId
      ? `In Split${document.expenseTitle ? `: ${document.expenseTitle}` : ''}`
      : reading ? 'Reading…'
      : unsplitBill ? 'Bill ready to split'
        : document.parseStatus === 'parsed' ? 'Booking ready to review' : document.parseStatus === 'failed' ? 'Needs details' : 'Not read yet'

  return (
    <li data-testid="scan-document" {...foldProps(leaving)}>
    <div><div className="rounded-md border px-3 py-3" style={{ borderColor: 'var(--border)' }}>
      <p className="t-headline truncate" style={{ color: 'var(--text-primary)' }} title={document.fileName}>{document.fileName}</p>
      <p className="mt-0.5 t-footnote t-num" style={{ color: 'var(--text-tertiary)' }}>{fileKindLabel(document.mimeType)} · {formatBytes(document.sizeBytes)} · {uploader} · {date}</p>
      <p className="mt-1 t-footnote" style={{ color: done || unsplitBill ? 'var(--accent)' : 'var(--text-secondary)' }}>{status}</p>
      <Swap id={confirming ? 'confirm' : 'actions'}>
      {confirming ? (
        <div role="group" aria-label={`Delete ${document.fileName}?`} className="mt-3 flex flex-col gap-2 t-callout">
          <p style={{ color: 'var(--text-secondary)' }}>Delete this document for everyone in the Trip? Itinerary entries and expenses made from it stay.</p>
          <div className="flex gap-4">
            <button type="button" onClick={() => void remove()} disabled={working !== null} aria-busy={working === 'delete' || undefined} style={{ color: 'var(--accent)' }}>
              <AsyncLabel status={deleteStatus} busyLabel="Deleting…">Delete document</AsyncLabel>
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={working !== null} style={{ color: 'var(--text-secondary)' }}>Keep</button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-4 t-callout">
          <button type="button" onClick={() => void view()} disabled={working !== null} aria-label={`View ${document.fileName}`} style={{ color: 'var(--accent)' }}>{working === 'view' ? 'Opening…' : 'View'}</button>
          {!done && <button type="button" onClick={onReview} disabled={disabled} aria-label={`${unsplitBill ? 'Split' : 'Review'} ${document.fileName}`} style={{ color: 'var(--text-primary)' }}>{unsplitBill ? 'Split bill' : 'Review'}</button>}
          {document.eventId && !document.expenseId && <button type="button" onClick={onSplitCost} disabled={disabled} aria-label={`Split cost of ${document.fileName}`} style={{ color: 'var(--text-primary)' }}>Split cost</button>}
          {canDelete && <button type="button" onClick={() => setConfirming(true)} disabled={disabled} aria-label={`Delete ${document.fileName}`} style={{ color: 'var(--text-secondary)' }}>Delete</button>}
        </div>
      )}
      </Swap>
      {fallbackUrl && <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block t-callout" style={{ color: 'var(--accent)', overflowWrap: 'anywhere' }}>Open {document.fileName} (link expires in a minute)</a>}
      <Collapse open={Boolean(error)}>
        <p role="alert" className="mt-2 t-callout" style={{ color: 'var(--accent)' }}>{error}</p>
      </Collapse>
    </div></div>
    </li>
  )
}
