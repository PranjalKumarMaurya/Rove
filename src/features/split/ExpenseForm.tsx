import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { NeonBtn } from '../../components/ui/NeonBtn'
import { AsyncButton, useAsyncStatus } from '../../components/ui/AsyncButton'
import { Checkbox } from '../../components/ui/Checkbox'
import { Collapse } from '../../components/ui/Collapse'
import {
  CATEGORIES, draftFromExpense, emptyDraft, evaluateDraft, spentLocalFor, switchSplitMode, type DraftField, type ExpenseDraft, type TotalCheck,
} from './expenseDraft'
import { fetchLiveRate } from './fxRate'
import type { LedgerExpense } from './ledger'
import { equalSplit, formatMoney, type MoneyLine } from './money'
import { findSimilarExpenses } from './similarExpense'
import { awayMembers, type TravelLeg } from './travelRules'
import { zonedWallTimeToUtc } from '../../../supabase/functions/_shared/documentDraft.ts'
import { commitExpense, SplitRequestError, updateExpense } from './splitApi'
import { Field, SplitDialog, inputClass, inputStyle } from './SplitDialog'
import { splitErrorMessage } from './splitErrors'
import { SPLIT_OPTIONS, WeightFields } from './SplitWeights'

const COMMON_CURRENCIES = ['INR', 'IDR', 'USD', 'EUR', 'GBP', 'SGD', 'THB', 'AED', 'JPY', 'AUD', 'MYR', 'VND', 'LKR', 'NPR']

export interface SplitMember {
  id: string
  name: string
}

type RateState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'live'; asOf: string | null } | { kind: 'error' }

/** Values a scanned bill fills in before the form opens. */
export interface ExpensePrefill {
  description: string
  amount: string
  currency: string
  category: string
  /** UTC instant from the bill, or null to use now. */
  spentAt: string | null
  /** Who shares it (e.g. the people on a booking); empty or missing means everyone. */
  included?: string[]
}

export function ExpenseForm({
  groupId, accountingCurrency, timezone, me, members, expense, onClose, onSaved, international = true, prefill, requestId: fixedRequestId, notice, heading,
  existing = [], legs = [],
}: {
  groupId: string
  accountingCurrency: string
  timezone: string
  /** Domestic Trips record everything in the Trip currency: no currency field or conversion. */
  international?: boolean
  me: string
  /** Active members, in roster order. */
  members: SplitMember[]
  /** The Expense being edited, or null to add one. */
  expense: LedgerExpense | null
  onClose: () => void
  /** Called with the saved Expense's id. */
  onSaved: (expenseId: string) => void
  /** A new expense started from a scanned bill. */
  prefill?: ExpensePrefill
  /** Reuse one request id (e.g. the scanned document's) so saving twice returns the same Expense. */
  requestId?: string
  /** Shown above the form, e.g. what to check on a scanned bill. */
  notice?: ReactNode
  heading?: string
  /** Expenses already in Split, to warn about adding the same cost twice. */
  existing?: readonly LedgerExpense[]
  /** Journeys on the itinerary: people travelling separately at the time are left out by default. */
  legs?: readonly TravelLeg[]
}) {
  const context = useMemo(() => ({ accountingCurrency, memberIds: members.map((member) => member.id), timezone }), [accountingCurrency, members, timezone])
  const [initial] = useState<ExpenseDraft>(() => {
    if (expense) return draftFromExpense(expense, context)
    const empty = emptyDraft(context, me)
    if (!prefill) return empty
    const included = (prefill.included ?? []).filter((id) => context.memberIds.includes(id))
    return {
      ...empty,
      included: included.length ? included : empty.included,
      description: prefill.description,
      amount: prefill.amount,
      currency: international ? prefill.currency : accountingCurrency,
      category: prefill.category,
      spentLocal: prefill.spentAt ? spentLocalFor(prefill.spentAt, context) : empty.spentLocal,
    }
  })
  const [draft, setDraft] = useState<ExpenseDraft>(initial)
  const [touched, setTouched] = useState<ReadonlySet<DraftField>>(new Set())
  const [attempted, setAttempted] = useState(false)
  const [saving, setSaving] = useState(false)
  const action = useAsyncStatus()
  const [serverError, setServerError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [rateState, setRateState] = useState<RateState>({ kind: 'idle' })
  // One request id per form: a retry after a lost response returns the same Expense.
  const requestId = useRef(fixedRequestId ?? crypto.randomUUID())
  const seenMembers = useRef(new Set(context.memberIds))

  // People who appear while a new expense is open (the roster refreshes when it
  // opens) are included in an equal split, and the payer defaults to me.
  useEffect(() => {
    const joined = context.memberIds.filter((id) => !seenMembers.current.has(id))
    joined.forEach((id) => seenMembers.current.add(id))
    if (expense || !joined.length) return
    setDraft((current) => ({
      ...current,
      included: [...current.included, ...joined],
      payerId: context.memberIds.includes(current.payerId) ? current.payerId : (context.memberIds.includes(me) ? me : context.memberIds[0]),
    }))
  }, [context.memberIds, expense, me])

  const evaluation = evaluateDraft(draft, context)
  const currency = evaluation.currency
  const converts = !evaluation.errors.currency && currency !== accountingCurrency
  // Domestic: the currency is always the Trip currency. An older expense in another
  // currency (from when the Trip was international) still shows its conversion.
  const showCurrency = international || initial.currency !== accountingCurrency
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const show = (field: DraftField) => (attempted || touched.has(field) ? evaluation.errors[field] : undefined)
  const touch = (field: DraftField) => () => setTouched((current) => new Set(current).add(field))
  const update = (changes: Partial<ExpenseDraft>) => {
    if (saving) return
    setServerError(null)
    setDraft((current) => ({ ...current, ...changes }))
  }
  const money = (minor: bigint, code = currency) => formatMoney(minor, code)

  // People elsewhere when this was spent (e.g. on the train while this was the car's petrol).
  const spentInstant = useMemo(() => {
    const iso = draft.spentLocal.trim() ? zonedWallTimeToUtc(draft.spentLocal.trim(), timezone) : null
    return iso ? Date.parse(iso) : null
  }, [draft.spentLocal, timezone])
  const away = useMemo(() => awayMembers(legs, spentInstant, context.memberIds, draft.payerId),
    [legs, spentInstant, context.memberIds, draft.payerId])
  const awayKey = [...away.keys()].sort().join(',')
  // Applied until the person changes who shares it themselves; never on edits or a
  // booking's own people.
  const autoAway = useRef(!expense && !(prefill?.included?.length))
  useEffect(() => {
    if (!autoAway.current) return
    setDraft((current) => {
      const included = context.memberIds.filter((id) => !away.has(id))
      return included.join(',') === current.included.join(',') ? current : { ...current, included }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awayKey, context.memberIds])
  const chooseIncluded = (included: string[]) => { autoAway.current = false; update({ included }) }
  const similar = useMemo(() => findSimilarExpenses(existing, draft.amount, currency, expense?.id)[0] ?? null,
    [existing, draft.amount, currency, expense?.id])
  const memberName = (id: string) => members.find((member) => member.id === id)?.name ?? 'Someone'

  const requestClose = () => {
    if (saving) return
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }

  // Returning to an edited expense's own currency restores its stored snapshot.
  const changeCurrency = (code: string) => {
    setRateState({ kind: 'idle' })
    const original = expense && code === expense.originalCurrency
    update({ currency: code, rate: original ? (expense.fxRate ?? '') : '', rateSource: original ? (expense.fxSource ?? 'manual') : 'manual' })
  }

  const fetchRate = async () => {
    setRateState({ kind: 'loading' })
    try {
      const live = await fetchLiveRate(currency, accountingCurrency)
      setDraft((current) => ({ ...current, rate: live.rate, rateSource: 'open.er-api.com' }))
      setRateState({ kind: 'live', asOf: live.asOf })
    } catch {
      setRateState({ kind: 'error' })
    }
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    setAttempted(true)
    setServerError(null)
    const request = evaluation.request
    if (!request) return
    setSaving(true)
    action.busy()
    try {
      let savedId: string
      if (expense) {
        await updateExpense(expense.id, expense.version, request)
        savedId = expense.id
      } else {
        savedId = await commitExpense(groupId, request, requestId.current)
      }
      // The button's tick is the confirmation; the form closes once it has been seen.
      await action.done()
      onSaved(savedId)
    } catch (error) {
      setServerError(splitErrorMessage(error instanceof SplitRequestError ? error.code : null))
      setSaving(false)
      action.fail()
    }
  }

  const keepsSnapshot = expense?.fxRate && expense.fxCapturedAt && converts
    && currency === expense.originalCurrency && draft.rate === expense.fxRate && draft.rateSource === expense.fxSource
  const perHead = draft.splitMode === 'equal' && evaluation.shares.length ? range(evaluation.shares) : null
  const originalPerHead = converts && perHead && evaluation.originalMinor !== null
    ? range(equalSplit(evaluation.originalMinor, evaluation.shares.map((line) => line.memberId)))
    : null

  return (
    <SplitDialog title={heading ?? (expense ? 'Edit expense' : 'Add expense')} onClose={requestClose} locked={saving} testId="expense-form">
      {confirmDiscard ? (
        <section aria-label="Discard changes" className="flex flex-col gap-4">
          <p style={{ color: 'var(--text-secondary)' }}>Discard what you’ve entered? Nothing has been saved.</p>
          <div className="flex gap-2">
            <NeonBtn type="button" onClick={onClose} className="flex-1">Discard</NeonBtn>
            <NeonBtn type="button" variant="ghost" onClick={() => setConfirmDiscard(false)} className="flex-1">Keep editing</NeonBtn>
          </div>
        </section>
      ) : (
        <form onSubmit={(event) => void save(event)} aria-label={expense ? 'Edit expense' : 'Add expense'} aria-busy={saving}
          noValidate className="flex flex-col gap-4">
          {notice}
          <fieldset disabled={saving} className="flex flex-col gap-4">
            <Field label="Description" error={show('description')}>
              {(control) => <input {...control} className={inputClass} style={inputStyle} value={draft.description}
                maxLength={120} placeholder="Dinner, ferry, villa…" onChange={(event) => update({ description: event.target.value })}
                onBlur={touch('description')} />}
            </Field>
            <div className={showCurrency ? 'grid grid-cols-[1fr_96px] gap-3' : 'grid grid-cols-1 gap-3'}>
              <Field label="Total amount" error={show('amount')}>
                {(control) => <input {...control} className={inputClass} style={inputStyle} value={draft.amount} inputMode="decimal"
                  autoComplete="off" placeholder="0.00" onChange={(event) => update({ amount: event.target.value })} onBlur={touch('amount')} />}
              </Field>
              {showCurrency && <Field label="Currency" error={show('currency')}>
                {(control) => <input {...control} className={inputClass} style={inputStyle} value={draft.currency} maxLength={3}
                  list="split-currencies" autoComplete="off"
                  onChange={(event) => changeCurrency(event.target.value.toUpperCase())}
                  onBlur={touch('currency')} />}
              </Field>}
              {showCurrency && <datalist id="split-currencies">{COMMON_CURRENCIES.map((code) => <option key={code} value={code} />)}</datalist>}
            </div>

            <Collapse open={showCurrency && converts} gap={4}>
              <div className="surface card--nested card flex flex-col gap-2" data-layout="card">
                <Field label={`Exchange rate: ${accountingCurrency} for 1 ${currency}`} error={show('rate')}
                  hint={rateHint(rateState, keepsSnapshot ? expense : null, timezone)}>
                  {(control) => <input {...control} className={inputClass} style={inputStyle} value={draft.rate} inputMode="decimal"
                    autoComplete="off" placeholder="e.g. 83.12"
                    onChange={(event) => { setRateState({ kind: 'idle' }); update({ rate: event.target.value, rateSource: 'manual' }) }}
                    onBlur={touch('rate')} />}
                </Field>
                <div className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => void fetchRate()} disabled={rateState.kind === 'loading'}
                    className="t-callout t-medium min-h-tap text-left" style={{ color: 'var(--accent)' }}>
                    {rateState.kind === 'loading' ? 'Fetching rate…' : 'Use live rate'}
                  </button>
                  {evaluation.accountingMinor !== null && (
                    <p className="t-footnote t-num whitespace-nowrap" style={{ color: 'var(--text-secondary)' }} data-testid="converted-amount">
                      = {money(evaluation.accountingMinor, accountingCurrency)}
                    </p>
                  )}
                </div>
              </div>
            </Collapse>

            <Field label="Category">
              {(control) => (
                <select {...control} className={inputClass} style={inputStyle} value={draft.category}
                  onChange={(event) => update({ category: event.target.value })}>
                  <option value="">No category</option>
                  {CATEGORIES.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}
                </select>
              )}
            </Field>

            <Field label="When" error={show('spentAt')} hint={`In Trip time (${timezone}). Bills from before the Trip are fine.`}>
              {(control) => <input {...control} type="datetime-local" className={inputClass} style={{ ...inputStyle, colorScheme: 'dark' }}
                value={draft.spentLocal} onChange={(event) => update({ spentLocal: event.target.value })} onBlur={touch('spentAt')} />}
            </Field>

            <Choice legend="Paid by" name="payer-mode" value={draft.payerMode}
              options={[{ value: 'single', label: 'One person' }, { value: 'multiple', label: 'Several people' }]}
              onChange={(payerMode) => update({ payerMode })}>
              <Collapse open={draft.payerMode === 'single'} gap={4}>
                <Field label="Who paid" error={show('payers')}>
                  {(control) => (
                    <select {...control} className={inputClass} style={inputStyle} value={draft.payerId}
                      onChange={(event) => update({ payerId: event.target.value })}>
                      {members.map((member) => <option key={member.id} value={member.id}>{member.name}{member.id === me ? ' (you)' : ''}</option>)}
                    </select>
                  )}
                </Field>
              </Collapse>
              <Collapse open={draft.payerMode === 'multiple'} gap={4}>
                <div className="flex flex-col gap-3">
                  <AmountList label="Paid by" members={members} currency={currency} values={draft.payerAmounts}
                    onChange={(payerAmounts) => update({ payerAmounts })} />
                  <TotalStrip check={evaluation.payerCheck} what="Paid" matchText="Payer amounts match the total." money={money}
                    error={show('payers')} />
                </div>
              </Collapse>
            </Choice>

            <Choice legend="Split" name="split-mode" value={draft.splitMode} options={SPLIT_OPTIONS}
              onChange={(splitMode) => update(switchSplitMode(draft, splitMode))}>
              <Collapse open={draft.splitMode === 'percent' || draft.splitMode === 'shares'} gap={4}>
                <div className="flex flex-col gap-3">
                <WeightFields mode={draft.splitMode === 'shares' ? 'shares' : 'percent'} members={members} evaluation={evaluation} currency={currency}
                  accountingCurrency={accountingCurrency} money={money} error={evaluation.errors.shares}
                  values={draft.splitMode === 'percent' ? draft.sharePercents : draft.shareWeights}
                  onChange={(values) => update(draft.splitMode === 'percent' ? { sharePercents: values } : { shareWeights: values })} />
                </div>
              </Collapse>
              <Collapse open={draft.splitMode === 'equal'} gap={4}>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="t-footnote" style={{ color: 'var(--text-tertiary)' }}>Split between</span>
                    <span className="flex gap-3 t-callout">
                      <button type="button" className="min-h-tap" style={{ color: 'var(--accent)' }}
                        onClick={() => chooseIncluded(members.map((member) => member.id))}>Everyone</button>
                      <button type="button" className="min-h-tap" style={{ color: 'var(--text-secondary)' }}
                        onClick={() => chooseIncluded([])}>No one</button>
                    </span>
                  </div>
                  <ul className="flex flex-col gap-1" aria-label="People sharing this expense">
                    {members.map((member) => {
                      const checked = draft.included.includes(member.id)
                      const reason = away.get(member.id)
                      return (
                        <li key={member.id}>
                          <label className="m-toggle flex min-h-tap cursor-pointer items-center gap-3" data-away={reason && !checked ? 'true' : undefined}
                            style={{ color: reason && !checked ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
                            <Checkbox checked={checked}
                              onChange={(event) => chooseIncluded(event.target.checked
                                ? [...draft.included, member.id]
                                : draft.included.filter((id) => id !== member.id))} />
                            <span className="min-w-0 flex-1 truncate">{member.name}</span>
                            {reason && <span className="shrink-0 t-footnote" data-testid="split-away-reason" style={{ color: 'var(--text-tertiary)' }}>{reason}</span>}
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                  <Collapse open={Boolean(show('shares'))} gap={3}>
                    <p role="alert" className="t-footnote" style={{ color: 'var(--accent)' }}>{show('shares')}</p>
                  </Collapse>
                  {perHead && (
                    <p role="status" className="t-footnote t-num" style={{ color: 'var(--text-secondary)' }}>
                      {rangeText(perHead, (minor) => money(minor, accountingCurrency))} each
                      {originalPerHead ? ` (${rangeText(originalPerHead, money)})` : ''}
                    </p>
                  )}
                </div>
              </Collapse>
              <Collapse open={draft.splitMode === 'exact'} gap={4}>
                <div className="flex flex-col gap-3">
                  <AmountList label="Share for" members={members} currency={currency} values={draft.shareAmounts}
                    onChange={(shareAmounts) => update({ shareAmounts })} />
                  <TotalStrip check={evaluation.shareCheck} what="Shared" matchText="Shares match the total." money={money}
                    error={show('shares')} />
                </div>
              </Collapse>
            </Choice>
          </fieldset>

          <Collapse open={Boolean(similar)} gap={4}>
            {similar && <p role="status" data-testid="similar-expense" className="card--nested card--row t-footnote"
              style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-strong)' }}>
              {similar.createdBy === me ? 'You' : memberName(similar.createdBy)} already added {money(similar.originalAmount, similar.originalCurrency)} for
              “{similar.description}” on {formatDay(similar.spentAt ?? similar.createdAt, timezone)}. Check it isn’t the same cost before saving.
            </p>}
          </Collapse>
          <Collapse open={Boolean(serverError)} gap={4}>
            <p role="alert" className="surface card--nested card--row t-callout" style={{ color: 'var(--text-primary)' }}>{serverError}</p>
          </Collapse>
          <Collapse open={attempted && !evaluation.request && !serverError} gap={4}>
            <p role="alert" className="t-callout" style={{ color: 'var(--accent)' }}>Check the highlighted fields.</p>
          </Collapse>
          <div className="flex gap-2">
            <AsyncButton type="submit" status={action.status} busyLabel="Saving…" doneLabel="Saved" className="flex-1">
              {expense ? 'Save changes' : 'Save expense'}
            </AsyncButton>
            <NeonBtn type="button" variant="ghost" disabled={saving} onClick={requestClose} >Cancel</NeonBtn>
          </div>
        </form>
      )}
    </SplitDialog>
  )
}

function range(lines: MoneyLine[]): { min: bigint; max: bigint } {
  return lines.reduce((acc, line) => ({
    min: line.amount < acc.min ? line.amount : acc.min,
    max: line.amount > acc.max ? line.amount : acc.max,
  }), { min: lines[0].amount, max: lines[0].amount })
}

function rangeText({ min, max }: { min: bigint; max: bigint }, money: (minor: bigint) => string): string {
  return min === max ? money(min) : `${money(min)}–${money(max)}`
}

function rateHint(state: RateState, kept: LedgerExpense | null, timezone: string): string | undefined {
  if (state.kind === 'live') return `Live reference rate from open.er-api.com${state.asOf ? `, updated ${state.asOf}` : ''}. It is saved with this expense and never changes later.`
  if (state.kind === 'error') return 'Could not fetch a live rate. Enter the rate you were charged.'
  if (kept?.fxCapturedAt) return `Rate captured ${formatWhen(kept.fxCapturedAt, timezone)}. Keeping it leaves the recorded conversion unchanged.`
  return 'Use the rate you were charged, or fetch a live reference rate.'
}

function formatDay(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, day: 'numeric', month: 'short' }).format(new Date(iso))
  } catch {
    return iso.slice(0, 10)
  }
}

export function formatWhen(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
      .format(new Date(iso))
  } catch {
    return iso
  }
}

function Choice<T extends string>({ legend, name, value, options, onChange, children }: {
  legend: string
  name: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  children: ReactNode
}) {
  return (
    <fieldset className="surface card--nested card flex flex-col gap-4" data-layout="card">
      <legend className="sr-only">{legend}</legend>
      <span aria-hidden="true" className="t-callout" style={{ color: 'var(--text-secondary)' }}>{legend}</span>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => {
          const checked = value === option.value
          return (
            <label key={option.value} className="m-toggle flex min-h-tap cursor-pointer items-center justify-center gap-1 rounded-full border px-2 text-center t-footnote"
              style={{
                borderColor: checked ? 'var(--accent)' : 'var(--border)',
                background: checked ? 'var(--accent-soft)' : 'transparent',
                color: checked ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}>
              <input type="radio" name={name} value={option.value} checked={checked}
                onChange={() => onChange(option.value)} style={{ accentColor: 'var(--accent)' }} />
              {option.label}
            </label>
          )
        })}
      </div>
      {children}
    </fieldset>
  )
}

function AmountList({ label, members, currency, values, onChange }: {
  label: string
  members: SplitMember[]
  currency: string
  values: Record<string, string>
  onChange: (values: Record<string, string>) => void
}) {
  return (
    <ul className="flex flex-col gap-2">
      {members.map((member) => (
        <li key={member.id} className="grid grid-cols-[minmax(0,1fr)_120px_auto] items-center gap-2">
          <span aria-hidden="true" className="min-w-0 truncate t-callout" style={{ color: 'var(--text-primary)' }}>{member.name}</span>
          <input aria-label={`${label} ${member.name}`} className={inputClass} style={inputStyle}
            inputMode="decimal" autoComplete="off" placeholder="0" value={values[member.id] ?? ''}
            onChange={(event) => onChange({ ...values, [member.id]: event.target.value })} />
          <span className="t-caption" style={{ color: 'var(--text-tertiary)' }}>{currency}</span>
        </li>
      ))}
    </ul>
  )
}

function TotalStrip({ check, what, matchText, money, error }: {
  check: TotalCheck | null
  what: string
  matchText: string
  money: (minor: bigint) => string
  error?: string
}) {
  const matches = check?.matches ?? false
  const text = !check
    ? error
    : matches
      ? matchText
      : `${what} ${money(check.entered)} of ${money(check.required)} · ${check.entered < check.required
        ? `${money(check.required - check.entered)} left`
        : `${money(check.entered - check.required)} too much`}`
  if (!text) return null
  return (
    <p role="status" className="m-toggle rounded-sm px-3 py-2 t-footnote"
      style={{
        color: matches ? 'var(--text-primary)' : 'var(--accent)',
        border: `1px solid ${matches ? 'var(--border-strong)' : 'rgba(255,139,77,0.4)'}`,
        background: matches ? 'transparent' : 'var(--accent-soft)',
      }}>
      {text}
    </p>
  )
}
