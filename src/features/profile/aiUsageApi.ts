import { supabase } from '../../lib/supabase'

export interface AiUsageTotals {
  totalTokens: number
  /** Millionths of a US dollar. */
  costMicroUsd: number
  calls: number
}

/** Everything the AI features have used for me so far, across every Trip. */
export async function loadMyAiUsage(): Promise<AiUsageTotals> {
  const { data, error } = await supabase.rpc('get_my_ai_usage')
  const row = Array.isArray(data) ? data[0] : data
  if (error || !row) throw new Error('ai_usage_unavailable')
  return { totalTokens: Number(row.total_tokens) || 0, costMicroUsd: Number(row.cost_micro_usd) || 0, calls: Number(row.calls) || 0 }
}
