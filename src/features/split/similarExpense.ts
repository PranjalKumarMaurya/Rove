// Duplicate guard: a booking or bill is often paid by one person and then added
// to Split by someone else too. Pure, so it runs under `node --test`.
import type { LedgerExpense } from './ledger.ts'
import { minorUnits, parseAmount } from './money.ts'

/**
 * Expenses already in Split for the same amount in the same currency (within
 * 1%, to allow for rounding or a fee), newest first. `excludeId` skips the
 * expense being edited.
 */
export function findSimilarExpenses(expenses: readonly LedgerExpense[], amount: string, currency: string, excludeId?: string): LedgerExpense[] {
  const code = currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/u.test(code)) return []
  const minor = parseAmount(amount, minorUnits(code))
  if (minor === null || minor <= 0n) return []
  return expenses
    .filter((expense) => expense.id !== excludeId && expense.originalCurrency === code)
    .filter((expense) => {
      const gap = expense.originalAmount > minor ? expense.originalAmount - minor : minor - expense.originalAmount
      return gap * 100n <= minor
    })
    .sort((left, right) => (right.spentAt ?? right.createdAt).localeCompare(left.spentAt ?? left.createdAt))
}
