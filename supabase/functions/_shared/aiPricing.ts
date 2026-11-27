// What a model call cost, from its token counts. Prices are US dollars per
// million tokens from Anthropic's price list (checked 2026-11-27); update this
// table when prices or the model change. Cache prices follow Anthropic's
// standard multipliers (reads 0.1x, writes 1.25x of input); Scan doesn't cache.

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

interface Price {
  input: number
  output: number
  /** Prompts above `longAbove` input tokens are billed at the long-context prices. */
  longAbove?: number
  longInput?: number
  longOutput?: number
}

const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50, longAbove: 100_000, longInput: 0.50, longOutput: 2.50 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
}

/** Unknown models are priced as the default Scan model, so nothing is ever recorded as free. */
const FALLBACK = PRICES['claude-haiku-5-5']

const whole = (value: number | undefined) => (Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 0)

/** Cost in millionths of a dollar (dollars per million tokens × tokens), rounded up. */
export function costMicroUsd(model: string, usage: TokenUsage): number {
  const price = PRICES[model] ?? FALLBACK
  const input = whole(usage.inputTokens)
  const output = whole(usage.outputTokens)
  const cacheRead = whole(usage.cacheReadTokens)
  const cacheWrite = whole(usage.cacheWriteTokens)
  const long = price.longAbove !== undefined && input + cacheRead + cacheWrite > price.longAbove
  const inputPrice = long ? price.longInput ?? price.input : price.input
  const outputPrice = long ? price.longOutput ?? price.output : price.output
  const micro = input * inputPrice + output * outputPrice + cacheRead * inputPrice * 0.1 + cacheWrite * inputPrice * 1.25
  // `+ 0` turns -0 (from ceil of a tiny negative) into 0.
  return Math.max(0, Math.ceil(micro - 1e-9)) + 0
}

/** Total tokens shown to people (every kind added up). */
export function totalTokens(usage: TokenUsage): number {
  return whole(usage.inputTokens) + whole(usage.outputTokens) + whole(usage.cacheReadTokens) + whole(usage.cacheWriteTokens)
}

/**
 * Dollars for Profile: "$0.00" for nothing, two decimals from a cent up
 * ("$0.01", "$1.24"), and up to four decimals below a cent so early use still
 * shows ("$0.0007").
 */
export function formatUsd(micro: number): string {
  const dollars = Math.max(0, micro) / 1_000_000
  if (dollars === 0) return '$0.00'
  if (dollars >= 0.01) return '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fixed = dollars.toFixed(4)
  return '$' + (fixed === '0.0000' ? '0.0001' : fixed)
}
