import assert from 'node:assert/strict'
import test from 'node:test'

import { costMicroUsd, formatUsd, totalTokens } from '../../supabase/functions/_shared/aiPricing.ts'

test('cost follows the model price per million tokens, rounded up to a millionth of a dollar', () => {
  // Haiku 5.5: $0.10 in, $0.50 out per million.
  assert.equal(costMicroUsd('claude-haiku-5-5', { inputTokens: 100_000, outputTokens: 0 }), 10_000)
  assert.equal(costMicroUsd('claude-haiku-5-5', { inputTokens: 0, outputTokens: 1_000_000 }), 500_000)
  assert.equal(costMicroUsd('claude-haiku-5-5', { inputTokens: 3, outputTokens: 1 }), 1)
  // Above 100K input tokens, the long-context prices apply.
  assert.equal(costMicroUsd('claude-haiku-5-5', { inputTokens: 200_000, outputTokens: 1000 }), 200_000 * 0.5 + 1000 * 2.5)
  // Cache reads are a tenth of input, writes a quarter more.
  assert.equal(costMicroUsd('claude-haiku-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 10_000, cacheWriteTokens: 10_000 }), 100 + 1250)
  assert.equal(costMicroUsd('claude-haiku-4-5', { inputTokens: 1000, outputTokens: 1000 }), 6000)
  // An unknown model is never free.
  assert.ok(costMicroUsd('some-new-model', { inputTokens: 1000, outputTokens: 1000 }) > 0)
  assert.equal(costMicroUsd('claude-haiku-5-5', { inputTokens: -5, outputTokens: Number.NaN }), 0)
})

test('totals and dollars as Profile shows them', () => {
  assert.equal(totalTokens({ inputTokens: 1800, outputTokens: 400, cacheReadTokens: 10 }), 2210)
  assert.equal(formatUsd(0), '$0.00')
  assert.equal(formatUsd(10_000), '$0.01')
  assert.equal(formatUsd(1_240_000), '$1.24')
  assert.equal(formatUsd(1_234_560_000), '$1,234.56')
  assert.equal(formatUsd(380), '$0.0004')
  assert.equal(formatUsd(7), '$0.0001')
})
