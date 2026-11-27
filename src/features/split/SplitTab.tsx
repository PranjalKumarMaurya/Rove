import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { listExpenseSources, type ExpenseSource } from '../scan/documentsApi'
import { useTravelLegs } from '../trip/tripEventsApi'
import { NeonBtn } from '../../components/ui/NeonBtn'
import { enterIndex } from '../../components/ui/motion'
import { useTripMemberProfiles } from '../groups/useTripMemberProfiles'
import type { TripTabProps } from '../workspace/tripTab'
import { ExpenseForm, formatWhen, type SplitMember } from './ExpenseForm'
import { CATEGORIES, expenseMemberIds } from './expenseDraft'
import {
  computeBalances, computeGroupTotals, suggestSettlements, type Ledger, type LedgerExpense, type LedgerSettlement,
  type ShareLine, type SplitMethod,
} from './ledger'
import { formatMoney, formatPercent } from './money'
import { SettleUpDialog } from './SettleUpDialog'
import { deleteExpense, deleteSettlement, SplitRequestError } from './splitApi'
import { splitErrorMessage } from './splitErrors'
import {
  buildTimeline, dateLabel, dayHeading, expenseMoment, headerAmount, involvesMe, isTripOngoing, tripToday, type TimelineDay,
  type TimelineFilter,
} from './timeline'
import { useSplitLedger } from './useSplitLedger'
import './splitTimeline.css'

// The edit dialog keeps the Expense as it was when opened, so a concurrent edit is detected as stale.
type Dialog = { kind: 'add' } | { kind: 'edit'; expense: LedgerExpense } | { kind: 'settle' } | null

const eyebrow = { color: 'var(--text-tertiary)', fontSize: 10, letterSpacing: '0.22em' } as const

const METHOD_TEXT: Record<SplitMethod, string> = {
  equal: 'split equally',
  exact: 'exact amounts',
  percent: 'split by percent',
  shares: 'split by shares',
}

/** The input behind a percent or shares line, e.g. " (70%)" or " (2 shares)". */
function weightText(method: SplitMethod, share: ShareLine): string {
  if (share.weight === undefined) return ''
  if (method === 'percent') return ` (${formatPercent(share.weight)}%)`
  if (method === 'shares') return ` (${share.weight} share${share.weight === 1n ? '' : 's'})`
  return ''
}

export function SplitTab({ trip, roster, reloadRoster }: TripTabProps) {
  const { state, reload } = useSplitLedger(trip.groupId)
  // Co-members' UPI IDs for "Pay via UPI"; re-read whenever Settle up opens.
  const { profiles, loading: profilesLoading, error: profilesError, reload: reloadProfiles } = useTripMemberProfiles(trip.groupId)
  const upiIds = useMemo(() => (profilesLoading || profilesError ? null
    : new Map(profiles.map((profile) => [profile.groupMemberId, profile.upiId]))), [profiles, profilesLoading, profilesError])
  const [dialog, setDialog] = useState<Dialog>(null)
  const legs = useTravelLegs(trip.groupId, dialog?.kind)
  const me = trip.groupMemberId
  const isOwner = trip.role === 'owner'
  const ledger: Ledger | null = state.status === 'loading' ? null : state.ledger
  const currency = ledger?.accountingCurrency ?? trip.accountingCurrency

  // The roster is loaded once per Trip; refresh it so people who joined since appear.
  useEffect(() => { reloadRoster() }, [reloadRoster])
  const names = useMemo(() => new Map(roster.map((member) => [member.groupMemberId, member.displayName])), [roster])
  const unknownKey = useMemo(() => {
    if (!ledger) return ''
    const ids = new Set<string>()
    for (const expense of ledger.expenses) for (const id of [expense.createdBy, ...expenseMemberIds(expense)]) ids.add(id)
    for (const settlement of ledger.settlements) [settlement.fromMember, settlement.toMember, settlement.recordedBy].forEach((id) => ids.add(id))
    return [...ids].filter((id) => !names.has(id)).sort().join(',')
  }, [ledger, names])
  const askedFor = useRef('')
  useEffect(() => {
    if (unknownKey && askedFor.current !== unknownKey) {
      askedFor.current = unknownKey
      reloadRoster()
    }
  }, [unknownKey, reloadRoster])

  const active: SplitMember[] = useMemo(() => roster.filter((member) => member.status === 'active')
    .map((member) => ({ id: member.groupMemberId, name: member.displayName })), [roster])
  const activeIds = useMemo(() => new Set(active.map((member) => member.id)), [active])
  const nameOf = (id: string) => {
    const name = names.get(id)
    if (!name) return 'Former member'
    return activeIds.has(id) ? name : `${name} (left)`
  }

  const balances = useMemo(() => (ledger ? computeBalances(ledger.expenses, ledger.settlements, active.map((member) => member.id)) : new Map<string, bigint>()), [ledger, active])
  const suggestions = useMemo(() => suggestSettlements(balances), [balances])
  const totals = useMemo(() => computeGroupTotals(ledger?.expenses ?? [], active.map((member) => member.id)), [ledger, active])
  const money = (minor: bigint) => formatMoney(minor, currency)

  // "From booking" labels: which expenses came from scanned documents I can see.
  const [sources, setSources] = useState<Map<string, ExpenseSource>>(new Map())
  const expenseKey = ledger?.expenses.map((expense) => expense.id).join(',') ?? ''
  useEffect(() => {
    let active = true
    if (expenseKey) void listExpenseSources(trip.groupId).then((found) => { if (active) setSources(found) })
    return () => { active = false }
  }, [trip.groupId, expenseKey])

  const closeDialog = () => setDialog(null)
  const saved = () => { setDialog(null); void reload() }

  return (
    <section data-testid="split-tab" className="flex flex-col gap-6" aria-labelledby="split-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="split-heading" className="serif-display" style={{ color: 'var(--text-primary)', fontSize: 25 }}>Split</h2>
        <p className="font-mono" style={eyebrow} data-testid="split-currency">AMOUNTS IN {currency}</p>
      </div>

      {state.status === 'error' && (
        <div role="alert" className="surface flex items-center justify-between gap-3 px-4 py-3 text-sm" style={{ color: 'var(--text-primary)' }}>
          <span>
            {state.code === 'split_not_a_member'
              ? 'You no longer have access to this Trip’s expenses.'
              : ledger ? 'Couldn’t refresh. Showing the last figures loaded.' : 'We couldn’t load this Trip’s expenses.'}
          </span>
          {state.code !== 'split_not_a_member' && <button type="button" className="min-h-11 shrink-0" style={{ color: 'var(--accent)' }} onClick={() => void reload()}>Retry</button>}
        </div>
      )}

      {!ledger ? (
        state.status === 'loading' && (
          <div role="status" aria-label="Loading expenses" className="flex flex-col gap-2">
            {[0, 1, 2].map((index) => <div key={index} className="animate-pulse-soft" style={{ height: 78, background: 'var(--bg-card)', borderRadius: 12 }} />)}
          </div>
        )
      ) : (
        <>
          <BalanceSummary me={me} balances={balances} activeIds={activeIds} nameOf={nameOf} money={money} />

          <div className="flex gap-2">
            <NeonBtn type="button" className="min-h-11 flex-1" onClick={() => { reloadRoster(); setDialog({ kind: 'add' }) }}>Add expense</NeonBtn>
            <NeonBtn type="button" variant="outline" color="#FF8B4D" className="min-h-11 flex-1" onClick={() => { reloadProfiles(); setDialog({ kind: 'settle' }) }}>Settle up</NeonBtn>
          </div>

          {ledger.heldOut.length > 0 && (
            <p role="alert" className="surface px-4 py-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {ledger.heldOut.length} record{ledger.heldOut.length === 1 ? ' doesn’t' : 's don’t'} add up in {currency} and
              {ledger.heldOut.length === 1 ? ' is' : ' are'} left out of every balance. A Trip Owner should review
              {ledger.heldOut.length === 1 ? ' it' : ' them'}.
            </p>
          )}

          {ledger.expenses.length > 0 && <GroupTotals totals={totals} nameOf={nameOf} money={money} me={me} />}

          <ExpenseLog expenses={ledger.expenses} me={me} isOwner={isOwner} activeIds={activeIds} nameOf={nameOf}
            groupId={trip.groupId} sources={sources} money={money} timezone={trip.timezone} tripStartDate={trip.startDate} tripEndDate={trip.endDate} onEdit={(expense) => setDialog({ kind: 'edit', expense })} onChanged={() => void reload()} />

          {ledger.settlements.length > 0 && (
            <PaymentHistory settlements={ledger.settlements} me={me} isOwner={isOwner} nameOf={nameOf} money={money}
              timezone={trip.timezone} onChanged={() => void reload()} />
          )}
        </>
      )}

      {(dialog?.kind === 'add' || dialog?.kind === 'edit') && (
        <ExpenseForm key={dialog.kind === 'edit' ? dialog.expense.id : 'add'} groupId={trip.groupId} accountingCurrency={currency}
          timezone={trip.timezone} international={trip.isInternational} me={me} members={active} expense={dialog.kind === 'edit' ? dialog.expense : null}
          existing={ledger?.expenses ?? []} legs={legs} onClose={closeDialog} onSaved={saved} />
      )}
      {dialog?.kind === 'settle' && (
        <SettleUpDialog groupId={trip.groupId} tripName={trip.tripName} currency={currency} me={me} isOwner={isOwner} members={active}
          nameOf={nameOf} upiIds={upiIds} suggestions={suggestions} onClose={closeDialog} onRecorded={() => void reload()} />
      )}
    </section>
  )
}

function BalanceSummary({ me, balances, activeIds, nameOf, money }: {
  me: string
  balances: ReadonlyMap<string, bigint>
  activeIds: ReadonlySet<string>
  nameOf: (id: string) => string
  money: (minor: bigint) => string
}) {
  const mine = balances.get(me) ?? 0n
  const abs = (value: bigint) => (value < 0n ? -value : value)
  const others = [...balances].filter(([id, value]) => id !== me && (value !== 0n || activeIds.has(id)))
  return (
    <section aria-labelledby="split-balance-heading" className="surface m-appear px-4 py-5" data-testid="split-balance">
      <h3 id="split-balance-heading" className="serif-eyebrow" style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
        {mine > 0n ? 'You’re owed' : mine < 0n ? 'You owe' : 'All settled up'}
      </h3>
      <p className="serif-display mt-1 whitespace-nowrap" data-testid="split-my-balance"
        style={{ color: 'var(--text-primary)', fontSize: 38, fontWeight: 300, lineHeight: 1.1 }}>
        {/* Keyed by the amount: a new balance fades in over the old (no count-up). */}
        <span key={money(abs(mine))} className="m-swap">{money(abs(mine))}</span>
      </p>
      {others.length > 0 && (
        <ul aria-label="Balances" className="mt-4 flex flex-col gap-1.5">
          {others.map(([id, value]) => {
            const name = nameOf(id)
            return (
              <li key={id} className="flex justify-between gap-3 text-sm">
                <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{name}</span>
                <span className="font-mono whitespace-nowrap" style={{ color: value === 0n ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
                  {value > 0n ? `is owed ${money(value)}` : value < 0n ? `owes ${money(-value)}` : 'settled up'}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function GroupTotals({ totals, nameOf, money, me }: {
  totals: ReturnType<typeof computeGroupTotals>
  nameOf: (id: string) => string
  money: (minor: bigint) => string
  me: string
}) {
  const rows = [...totals.members]
  return (
    <section className="surface m-appear overflow-x-auto" aria-labelledby="split-totals-heading">
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <h3 id="split-totals-heading" className="serif-eyebrow" style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Group totals</h3>
        <p className="font-mono" style={{ color: 'var(--text-tertiary)', fontSize: 11 }} data-testid="split-total-spend"><span key={money(totals.total)} className="m-swap">{money(totals.total)}</span> spent</p>
      </div>
      <table className="w-full text-xs" aria-labelledby="split-totals-heading">
        <thead>
          <tr style={{ color: 'var(--text-tertiary)' }}>
            <th scope="col" className="px-4 py-1.5 text-left font-normal">Person</th>
            <th scope="col" className="px-2 py-1.5 text-right font-normal">Paid</th>
            <th scope="col" className="px-2 py-1.5 text-right font-normal">Share</th>
            <th scope="col" className="px-4 py-1.5 text-right font-normal">Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, entry]) => (
            <tr key={id} style={{ borderTop: '1px solid var(--border)' }}>
              <th scope="row" className="px-4 py-2 text-left font-normal" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
                {nameOf(id)}{id === me ? ' (you)' : ''}
              </th>
              <td className="font-mono whitespace-nowrap px-2 py-2 text-right" style={{ color: 'var(--text-secondary)' }}>{money(entry.paid)}</td>
              <td className="font-mono whitespace-nowrap px-2 py-2 text-right" style={{ color: 'var(--text-tertiary)' }}>{money(entry.share)}</td>
              <td className="font-mono whitespace-nowrap px-4 py-2 text-right" style={{ color: entry.net === 0n ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
                {entry.net > 0n ? '+' : entry.net < 0n ? '−' : ''}{money(entry.net < 0n ? -entry.net : entry.net)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function listNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

const filterKey = (groupId: string) => `rove:split-filter:${groupId}`

function readFilter(groupId: string): TimelineFilter {
  try { return window.localStorage.getItem(filterKey(groupId)) === 'mine' ? 'mine' : 'all' } catch { return 'all' }
}

/** How long a deleted expense takes to fold away (splitTimeline.css: --dur-base). */
const FOLD_MS = 240

type Leaving = ReadonlyMap<string, { expense: LedgerExpense; folded: boolean }>

const countText = (count: number) => (count === 1 ? '1 expense' : `${count} expenses`)

function ExpenseLog({ expenses: allExpenses, me, isOwner, activeIds, nameOf, money, timezone, tripStartDate, tripEndDate, onEdit, onChanged, groupId, sources }: {
  expenses: LedgerExpense[]
  groupId: string
  sources: ReadonlyMap<string, ExpenseSource>
  /** YYYY-MM-DD; Trip days are numbered from here, and earlier days (Trip time) are "Before the trip". */
  tripStartDate: string
  /** YYYY-MM-DD; later days (Trip time) are "After the trip". */
  tripEndDate: string
  me: string
  isOwner: boolean
  activeIds: ReadonlySet<string>
  nameOf: (id: string) => string
  money: (minor: bigint) => string
  timezone: string
  onEdit: (expense: LedgerExpense) => void
  onChanged: () => void
}) {
  // Everyone sees every expense; "Only mine" is a per-Trip view choice kept on this device.
  const [filter, setFilterState] = useState<TimelineFilter>(() => readFilter(groupId))
  const setFilter = (next: TimelineFilter) => {
    setFilterState(next)
    try { window.localStorage.setItem(filterKey(groupId), next) } catch { /* storage may be unavailable */ }
  }

  // Expenses I just deleted stay in place while they fold away, even if the refreshed
  // ledger drops them first; they leave once both the fold and the refresh are done.
  const [leaving, setLeaving] = useState<Leaving>(new Map())
  const liveIds = useMemo(() => new Set(allExpenses.map((expense) => expense.id)), [allExpenses])
  useEffect(() => {
    if ([...leaving].some(([id, ghost]) => ghost.folded && !liveIds.has(id))) {
      setLeaving((prev) => new Map([...prev].filter(([id, ghost]) => !(ghost.folded && !liveIds.has(id)))))
    }
  }, [leaving, liveIds])
  const foldAway = (expense: LedgerExpense) => {
    setLeaving((prev) => new Map(prev).set(expense.id, { expense, folded: false }))
    onChanged()
    window.setTimeout(() => setLeaving((prev) => {
      const ghost = prev.get(expense.id)
      return ghost ? new Map(prev).set(expense.id, { ...ghost, folded: true }) : prev
    }), FOLD_MS)
  }

  const counted = allExpenses.filter((expense) => !leaving.has(expense.id))
  const mineCount = counted.filter((expense) => involvesMe(expense, me)).length
  const withGhosts = [...allExpenses, ...[...leaving.values()].filter((ghost) => !liveIds.has(ghost.expense.id)).map((ghost) => ghost.expense)]
  const shown = filter === 'mine' ? withGhosts.filter((expense) => involvesMe(expense, me)) : withGhosts
  const leavingIds = useMemo(() => new Set(leaving.keys()), [leaving])
  const timeline = buildTimeline(shown, { timezone, startDate: tripStartDate, endDate: tripEndDate, me, uncounted: leavingIds })

  const today = tripToday(Date.now(), timezone)
  const todayShown = isTripOngoing(today, tripStartDate, tripEndDate) && timeline.during.some((day) => day.date === today)
  const logRef = useRef<HTMLElement>(null)
  const jumpToToday = () => {
    const target = logRef.current?.querySelector(`[data-day="${today}"]`)
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    target?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
  }

  let enterAt = 0
  const day = (entry: TimelineDay, level: 'h4' | 'h5') => (
    <DayGroup key={entry.date || 'undated'} day={entry} level={level} index={enterAt++} filter={filter} today={entry.date === today}
      leaving={leaving} money={money}>
      {entry.entries.map(({ expense, time }) => (
        <ExpenseCard key={expense.id} expense={expense} time={time} me={me} mine={involvesMe(expense, me)} source={sources.get(expense.id) ?? null}
          canChange={expense.createdBy === me || isOwner} involvesFormer={expenseMemberIds(expense).some((id) => !activeIds.has(id))}
          leaving={leaving.has(expense.id)} nameOf={nameOf} money={money} timezone={timezone}
          onEdit={() => onEdit(expense)} onDeleted={() => foldAway(expense)} />
      ))}
    </DayGroup>
  )
  const beforeCount = timeline.before.reduce((sum, entry) => sum + entry.entries.length, 0)
  const afterCount = timeline.after.reduce((sum, entry) => sum + entry.entries.length, 0)
  const beforeDays = timeline.before.map((entry) => day(entry, 'h5'))
  const duringDays = timeline.during.map((entry) => day(entry, 'h4'))
  const afterDays = timeline.after.map((entry) => day(entry, 'h5'))

  return (
    <section ref={logRef} aria-labelledby="split-log-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id="split-log-heading" className="serif-eyebrow" style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Expenses</h3>
        {allExpenses.length > 0 && (
          <div role="group" aria-label="Show expenses" className="flex rounded-full border p-0.5 text-xs" style={{ borderColor: 'var(--border)' }}>
            {([['all', 'All'], ['mine', `Only mine · ${mineCount}`]] as const).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}
                className="m-press min-h-9 rounded-full px-3"
                style={{ background: filter === value ? 'var(--accent-soft)' : 'transparent', color: filter === value ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {todayShown && (
        <button type="button" onClick={jumpToToday} data-testid="expenses-jump-today"
          className="m-press m-appear min-h-9 self-start rounded-full border px-3 text-xs"
          style={{ borderColor: 'rgba(255,139,77,0.38)', color: 'var(--accent)' }}>
          Jump to today
        </button>
      )}
      <div className="flex flex-col">
        {beforeDays.length > 0 && (
          <section aria-labelledby="split-before-heading" className="flex flex-col" data-testid="expenses-before-trip">
            <h4 id="split-before-heading" className="pb-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Before the trip · {countText(beforeCount)}
            </h4>
            <ul aria-label="Expenses before the trip" className="flex flex-col">{beforeDays}</ul>
          </section>
        )}
        {(duringDays.length > 0 || afterDays.length > 0) && (
          <ul aria-label="Expenses" className="flex flex-col">
            {duringDays}
            {afterDays.length > 0 && (
              <li data-testid="expenses-after-trip" aria-labelledby="split-after-heading" className="flex flex-col">
                <h4 id="split-after-heading" className="pb-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  After the trip · {countText(afterCount)}
                </h4>
                <ul aria-label="After the trip" className="flex flex-col">{afterDays}</ul>
              </li>
            )}
          </ul>
        )}
      </div>
      {withGhosts.length === 0 ? (
        <p className="m-appear py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }} data-testid="expenses-empty">
          No expenses yet. Tap “Add expense” to log the first one.
        </p>
      ) : shown.length === 0 ? (
        <p className="py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }} data-testid="expenses-mine-empty">
          You’re not on any expenses yet. Switch to All to see the whole Trip’s.
        </p>
      ) : null}
    </section>
  )
}

/** One Trip-time day: a sticky header (label and the day's total, or my share) over its expenses, earliest first. */
function DayGroup({ day, level: Heading, index, filter, today, leaving, money, children }: {
  day: TimelineDay
  level: 'h4' | 'h5'
  index: number
  filter: TimelineFilter
  today: boolean
  leaving: Leaving
  money: (minor: bigint) => string
  children: ReactNode
}) {
  const id = `split-day-${day.date || 'undated'}`
  const { amount, yourShare } = headerAmount(day, filter)
  const allLeaving = day.entries.every((entry) => leaving.has(entry.expense.id))
  const label = dayHeading(day)
  return (
    <li className="split-fold" data-leaving={allLeaving ? 'true' : undefined}>
      <div>
        <section aria-labelledby={id} data-testid="expense-day" data-day={day.date} className="split-day split-day--enter flex flex-col pb-4"
          style={enterIndex(index)}>
          <div className="split-day__header flex items-baseline justify-between gap-3 py-2">
            <Heading id={id} className="flex min-w-0 items-baseline gap-1.5 truncate">
              {day.dayNumber !== null ? (
                <>
                  <span className="serif-display" style={{ color: 'var(--text-primary)', fontSize: 17 }}>Day {day.dayNumber}</span>
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>· {dateLabel(day.date)}</span>
                </>
              ) : (
                <span className="serif-display" style={{ color: 'var(--text-primary)', fontSize: 15 }}>{label}</span>
              )}
              {today && <span className="font-mono" style={{ color: 'var(--accent)', fontSize: 10, letterSpacing: '0.16em' }}>TODAY</span>}
            </Heading>
            <p className="font-mono shrink-0 whitespace-nowrap text-xs" data-testid="expense-day-total" style={{ color: 'var(--text-primary)' }}>
              <span key={money(amount)} className="m-swap">{money(amount)}</span>
              {yourShare && <span style={{ color: 'var(--text-tertiary)' }}> your share</span>}
            </p>
          </div>
          <ul aria-label={label} className="m-list flex flex-col">{children}</ul>
        </section>
      </div>
    </li>
  )
}

function ExpenseCard({ expense, time, me, mine, source, canChange, involvesFormer, leaving, nameOf, money, timezone, onEdit, onDeleted }: {
  expense: LedgerExpense
  /** "07:45" in Trip time. */
  time: string
  /** I paid or share in it: a quiet accent border. */
  mine: boolean
  source: ExpenseSource | null
  me: string
  canChange: boolean
  involvesFormer: boolean
  /** Deleted: folding away. */
  leaving: boolean
  nameOf: (id: string) => string
  money: (minor: bigint) => string
  timezone: string
  onEdit: () => void
  onDeleted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const myShare = expense.shares.find((share) => share.memberId === me)?.amount
  const category = CATEGORIES.find((entry) => entry.id === expense.category)?.label
  const converted = expense.originalCurrency !== expense.accountingCurrency
  const people = expense.shares.length
  const moreId = `expense-more-${expense.id}`

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await deleteExpense(expense.id, expense.version)
      onDeleted()
    } catch (failure) {
      setError(splitErrorMessage(failure instanceof SplitRequestError ? failure.code : null, 'We could not delete this. Nothing was changed.'))
      setBusy(false)
    }
  }

  const quiet = { borderColor: 'var(--border)', color: 'var(--text-secondary)' }
  return (
    <li className="split-fold" data-leaving={leaving ? 'true' : undefined} aria-hidden={leaving || undefined}>
      <div>
        <div className="pb-1.5">
          <article aria-label={expense.description} className="surface flex flex-col gap-1.5 px-3 pt-2.5 pb-1" data-testid="expense-card"
            data-mine={mine ? 'true' : undefined} style={mine ? { borderColor: 'rgba(255,139,77,0.38)' } : undefined}>
            {/* The whole row toggles the details for touch; the Breakdown button below is the accessible control. */}
            <div className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3" onClick={() => setOpen((value) => !value)}>
              <p className="font-mono pt-0.5" style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                <time dateTime={expenseMoment(expense)}>{time || '—'}</time>
              </p>
              <div className="min-w-0">
                <p className="serif-display truncate" style={{ color: 'var(--text-primary)', fontSize: 16, lineHeight: 1.25 }}>{expense.description}</p>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  Paid by {listNames([...expense.payers].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1)).map((payer) => nameOf(payer.memberId)))}
                  {' · '}{people === 1 ? '1 person' : `${people} people`}
                  {category ? ` · ${category}` : ''}
                </p>
                {source && (
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }} data-testid="expense-source">
                    {source.kind === 'booking' ? `From booking${source.title ? `: ${source.title}` : ''} · In itinerary` : 'From a scanned bill'}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="serif-display whitespace-nowrap" style={{ color: 'var(--text-primary)', fontSize: 16, lineHeight: 1.25 }}>{money(expense.accountingAmount)}</p>
                {converted && (
                  <p className="font-mono whitespace-nowrap" style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
                    {formatMoney(expense.originalAmount, expense.originalCurrency)}
                  </p>
                )}
                {myShare !== undefined && (
                  <p className="whitespace-nowrap text-xs" style={{ color: 'var(--text-secondary)' }}>Your share {money(myShare)}</p>
                )}
              </div>
            </div>

            <div id={moreId} hidden={!open} className="split-row__more flex flex-col gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <p style={{ color: 'var(--text-tertiary)' }}>{METHOD_TEXT[expense.splitMethod]} between {people}</p>
              {converted && expense.fxRate && (
                <p style={{ color: 'var(--text-tertiary)' }}>
                  1 {expense.originalCurrency} = {expense.fxRate} {expense.accountingCurrency}
                  {' · '}{expense.fxSource === 'open.er-api.com' ? 'live rate from open.er-api.com' : 'rate entered'}
                  {expense.fxCapturedAt ? `, captured ${formatWhen(expense.fxCapturedAt, timezone)}` : ''}
                </p>
              )}
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                {expense.payers.map((payer) => (
                  <div key={`p-${payer.memberId}`} className="contents">
                    <dt>{nameOf(payer.memberId)} paid</dt><dd className="font-mono text-right">{money(payer.amount)}</dd>
                  </div>
                ))}
                {expense.shares.map((share) => (
                  <div key={`s-${share.memberId}`} className="contents">
                    <dt>{nameOf(share.memberId)}’s share{weightText(expense.splitMethod, share)}</dt><dd className="font-mono text-right">{money(share.amount)}</dd>
                  </div>
                ))}
              </dl>
              <p style={{ color: 'var(--text-tertiary)' }}>
                {expense.spentAt ? `${formatWhen(expense.spentAt, timezone)} · ` : ''}Added by {nameOf(expense.createdBy)}{expense.createdBy === me ? ' (you)' : ''}{expense.spentAt ? '' : ` · ${formatWhen(expense.createdAt, timezone)}`}
                {expense.version > 1 ? ` · edited ${formatWhen(expense.updatedAt, timezone)}` : ''}
              </p>
            </div>

            {canChange && involvesFormer && (
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Includes someone who has left the Trip, so it can’t be edited. It can still be deleted.</p>
            )}
            {error && <p role="alert" className="text-xs" style={{ color: 'var(--accent)' }}>{error}</p>}
            {canChange && confirming ? (
              <div className="flex flex-wrap items-center gap-2 pb-1.5" role="group" aria-label={`Confirm deleting ${expense.description}`}>
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Delete for everyone? Balances will update.</span>
                <NeonBtn type="button" disabled={busy} onClick={() => void remove()} className="min-h-11">{busy ? 'Deleting…' : 'Delete expense'}</NeonBtn>
                <NeonBtn type="button" variant="ghost" disabled={busy} onClick={() => setConfirming(false)} className="min-h-11">Keep</NeonBtn>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <button type="button" aria-expanded={open} aria-controls={moreId} onClick={() => setOpen((value) => !value)}
                  className="m-press -ml-1 min-h-10 flex-1 px-1 text-left text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {open ? '▾' : '▸'} Breakdown
                </button>
                {canChange && !involvesFormer && (
                  <button type="button" onClick={onEdit} aria-label={`Edit ${expense.description}`} className="m-press min-h-10 rounded-md border px-3 text-xs" style={quiet}>Edit</button>
                )}
                {canChange && (
                  <button type="button" onClick={() => setConfirming(true)} aria-label={`Delete ${expense.description}`} className="m-press min-h-10 rounded-md border px-3 text-xs" style={quiet}>Delete</button>
                )}
              </div>
            )}
          </article>
        </div>
      </div>
    </li>
  )
}

function PaymentHistory({ settlements, me, isOwner, nameOf, money, timezone, onChanged }: {
  settlements: LedgerSettlement[]
  me: string
  isOwner: boolean
  nameOf: (id: string) => string
  money: (minor: bigint) => string
  timezone: string
  onChanged: () => void
}) {
  return (
    <section aria-labelledby="split-payments-heading" className="flex flex-col gap-3">
      <h3 id="split-payments-heading" className="serif-eyebrow" style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
        Payments recorded · {settlements.length}
      </h3>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>Records of payments made outside the app. No money moves here.</p>
      <ul aria-label="Payments" className="m-list flex flex-col gap-1.5">
        {settlements.map((settlement) => (
          <PaymentRow key={settlement.id} settlement={settlement} me={me} canDelete={settlement.recordedBy === me || isOwner}
            nameOf={nameOf} money={money} timezone={timezone} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  )
}

function PaymentRow({ settlement, me, canDelete, nameOf, money, timezone, onChanged }: {
  settlement: LedgerSettlement
  me: string
  canDelete: boolean
  nameOf: (id: string) => string
  money: (minor: bigint) => string
  timezone: string
  onChanged: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = `${nameOf(settlement.fromMember)} paid ${nameOf(settlement.toMember)}`

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await deleteSettlement(settlement.id)
      onChanged()
    } catch (failure) {
      setError(splitErrorMessage(failure instanceof SplitRequestError ? failure.code : null, 'We could not delete this. Nothing was changed.'))
      setBusy(false)
    }
  }

  return (
    <li className="flex flex-col gap-1 rounded-md px-3 py-2" aria-label={label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between gap-3">
        <p className="truncate text-sm" style={{ color: 'var(--text-secondary)' }}>{label}</p>
        <p className="serif-display whitespace-nowrap" style={{ color: 'var(--text-primary)', fontSize: 14 }}>{money(settlement.amount)}</p>
      </div>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {settlement.note ? `${settlement.note} · ` : ''}Recorded by {nameOf(settlement.recordedBy)}{settlement.recordedBy === me ? ' (you)' : ''}
        {' · '}{formatWhen(settlement.createdAt, timezone)}
      </p>
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--accent)' }}>{error}</p>}
      {canDelete && (confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Delete this payment record?</span>
          <NeonBtn type="button" disabled={busy} onClick={() => void remove()} className="min-h-11">{busy ? 'Deleting…' : 'Delete payment'}</NeonBtn>
          <NeonBtn type="button" variant="ghost" disabled={busy} onClick={() => setConfirming(false)} className="min-h-11">Keep</NeonBtn>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} aria-label={`Delete payment: ${label}`}
          className="m-press min-h-11 self-start text-xs" style={{ color: 'var(--text-tertiary)' }}>Delete</button>
      ))}
    </li>
  )
}
