// Split's expense timeline: every expense grouped by the Trip-time calendar day it
// was spent on (or entered on, when no date was given), Day 1 first and morning
// to night within a day. Days before the Trip's start and after its end are kept
// apart; days without expenses are not listed.
import type { LedgerExpense } from './ledger.ts'
import { utcToZonedWallTime } from '../../../supabase/functions/_shared/documentDraft.ts'

export type TimelineFilter = 'all' | 'mine'
export type TimelinePhase = 'before' | 'during' | 'after'

export interface TimelineEntry {
  expense: LedgerExpense
  /** Trip-time wall clock, YYYY-MM-DDTHH:mm. */
  wall: string
  /** "07:45", Trip time. */
  time: string
}

export interface TimelineDay {
  /** YYYY-MM-DD in Trip time; '' when the expense has no usable date. */
  date: string
  phase: TimelinePhase
  /** 1 for the Trip's start date; null outside the Trip or when it has no start date. */
  dayNumber: number | null
  entries: TimelineEntry[]
  /** Sum of the day's expenses in the accounting currency. */
  total: bigint
  /** My share of the day's expenses. */
  myShare: bigint
}

export interface Timeline {
  before: TimelineDay[]
  during: TimelineDay[]
  after: TimelineDay[]
}

export interface TimelineContext {
  timezone: string
  /** YYYY-MM-DD, may be empty. */
  startDate: string
  /** YYYY-MM-DD, may be empty. */
  endDate: string
  me: string
  /** Expenses still shown (folding away after a delete) but no longer counted in day totals. */
  uncounted?: ReadonlySet<string>
}

/** When an expense happened: the date spent, or when it was entered. */
export function expenseMoment(expense: Pick<LedgerExpense, 'spentAt' | 'createdAt'>): string {
  return expense.spentAt ?? expense.createdAt
}

/** Whether I paid towards or share in an expense. */
export function involvesMe(expense: Pick<LedgerExpense, 'payers' | 'shares'>, me: string): boolean {
  return expense.payers.some((line) => line.memberId === me) || expense.shares.some((line) => line.memberId === me)
}

/** Trip-time wall clock (YYYY-MM-DDTHH:mm) for an instant; UTC if the zone is unusable; '' if the instant is. */
export function tripWallTime(iso: string, timezone: string): string {
  return utcToZonedWallTime(iso, timezone) || utcToZonedWallTime(iso, 'UTC')
}

/** Today's date in Trip time. */
export function tripToday(nowMs: number, timezone: string): string {
  return tripWallTime(new Date(nowMs).toISOString(), timezone).slice(0, 10)
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function utcDay(date: string): number | null {
  const match = DATE.exec(date)
  if (!match) return null
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000
}

/** Day number of `date` counted from `startDate` (the start date is Day 1). */
export function dayNumber(date: string, startDate: string): number | null {
  const day = utcDay(date)
  const start = utcDay(startDate)
  return day === null || start === null ? null : day - start + 1
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Sun 15 Nov" for 2026-11-15. Locale-free so it reads the same on every phone. */
export function dateLabel(date: string): string {
  const day = utcDay(date)
  if (day === null) return 'No date'
  const value = new Date(day * 86_400_000)
  return `${WEEKDAYS[value.getUTCDay()]} ${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]}`
}

/** "Day 2 · Mon 16 Nov" inside the Trip; just "Mon 16 Nov" before or after it. */
export function dayHeading(day: Pick<TimelineDay, 'date' | 'dayNumber'>): string {
  return day.dayNumber === null ? dateLabel(day.date) : `Day ${day.dayNumber} · ${dateLabel(day.date)}`
}

/** The amount a day header shows: the day's total, or my share of it under "Only mine". */
export function headerAmount(day: Pick<TimelineDay, 'total' | 'myShare'>, filter: TimelineFilter): { amount: bigint; yourShare: boolean } {
  return filter === 'mine' ? { amount: day.myShare, yourShare: true } : { amount: day.total, yourShare: false }
}

export function phaseOf(date: string, startDate: string, endDate: string): TimelinePhase {
  if (date && startDate && date < startDate) return 'before'
  if (date && endDate && date > endDate) return 'after'
  return 'during'
}

function compareEntries(a: TimelineEntry, b: TimelineEntry): number {
  const at = (entry: TimelineEntry) => {
    const ms = Date.parse(expenseMoment(entry.expense))
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
  }
  const diff = at(a) - at(b)
  if (diff !== 0 && !Number.isNaN(diff)) return diff
  if (a.expense.createdAt !== b.expense.createdAt) return a.expense.createdAt < b.expense.createdAt ? -1 : 1
  return a.expense.id < b.expense.id ? -1 : a.expense.id > b.expense.id ? 1 : 0
}

/** Groups expenses into Trip-time days: chronological, earliest first, empty days left out. */
export function buildTimeline(expenses: readonly LedgerExpense[], context: TimelineContext): Timeline {
  const byDate = new Map<string, TimelineDay>()
  for (const expense of expenses) {
    const wall = tripWallTime(expenseMoment(expense), context.timezone)
    const date = wall.slice(0, 10)
    let day = byDate.get(date)
    if (!day) {
      const phase = phaseOf(date, context.startDate, context.endDate)
      day = { date, phase, dayNumber: phase === 'during' && date ? dayNumber(date, context.startDate) : null, entries: [], total: 0n, myShare: 0n }
      byDate.set(date, day)
    }
    day.entries.push({ expense, wall, time: wall.slice(11, 16) })
    if (!context.uncounted?.has(expense.id)) {
      day.total += expense.accountingAmount
      for (const share of expense.shares) if (share.memberId === context.me) day.myShare += share.amount
    }
  }
  // Undated (unparseable) expenses sort last.
  const days = [...byDate.values()].sort((a, b) => (a.date === b.date ? 0 : !a.date ? 1 : !b.date ? -1 : a.date < b.date ? -1 : 1))
  for (const day of days) day.entries.sort(compareEntries)
  return {
    before: days.filter((day) => day.phase === 'before'),
    during: days.filter((day) => day.phase === 'during'),
    after: days.filter((day) => day.phase === 'after'),
  }
}

/** True while today (Trip time) falls within the Trip's dates. */
export function isTripOngoing(today: string, startDate: string, endDate: string): boolean {
  return Boolean(startDate && endDate) && today >= startDate && today <= endDate
}
