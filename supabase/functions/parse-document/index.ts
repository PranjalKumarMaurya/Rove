// parse-document: read one private Trip document and return an Event draft for
// review. Runs as the calling user (anon key + the caller's JWT), so Row Level
// Security decides which documents and objects exist; it never creates Events.
// The service-role key is used for one thing only: recording the call's AI
// usage (tokens and cost) in `ai_usage`, which clients can read but not write.
//
// Secrets: ANTHROPIC_API_KEY (required for real parsing), SCAN_PARSE_MODEL
// (optional, default claude-haiku-5-5; claude-haiku-4-5 also works),
// SCAN_PARSE_STUB=1 (local stacks and tests only: deterministic draft),
// SCAN_PARSE_DAILY_LIMIT_MEMBER / SCAN_PARSE_DAILY_LIMIT_TRIP (parses per person
// and per Trip in any 24 hours; default 50 and 100). The stub counts too.
import { createClient } from 'npm:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk@1'
import { DOCUMENT_BUCKET } from '../_shared/documentDraft.ts'
import {
  EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT, type Extractor, type ParseStore,
  buildExtractionPrompt, bytesToBase64, createParseHandler, createStubExtractor, parseLimitsFromEnv, parseModelText,
} from './handler.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
// Only for writing AI usage rows (see the top of this file).
const usageWriter = serviceKey ? createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}) : null

function openStore(authorization: string): ParseStore {
  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const token = authorization.slice('Bearer '.length)
  return {
    async currentUserId() {
      const { data, error } = await client.auth.getUser(token)
      return error ? null : data.user?.id ?? null
    },
    async findDocument(id) {
      const { data } = await client.from('trip_documents')
        .select('id, group_id, storage_path, file_name, mime_type').eq('id', id).maybeSingle()
      return data ? { id: data.id, groupId: data.group_id, storagePath: data.storage_path, fileName: data.file_name, mimeType: data.mime_type } : null
    },
    async tripContext(groupId) {
      const { data } = await client.from('group_configurations')
        .select('timezone, start_date, end_date, destination').eq('group_id', groupId).maybeSingle()
      return data ? { timezone: data.timezone, startDate: data.start_date, endDate: data.end_date, destination: data.destination } : null
    },
    async download(path) {
      const { data, error } = await client.storage.from(DOCUMENT_BUCKET).download(path)
      if (error || !data) return null
      return { bytes: new Uint8Array(await data.arrayBuffer()), mimeType: data.type }
    },
    async claimParse(documentId, limits) {
      const { data, error } = await client.rpc('claim_document_parse', {
        p_document_id: documentId, p_member_limit: limits.member, p_trip_limit: limits.trip,
      })
      if (error || (data !== 'claimed' && data !== 'member_limit' && data !== 'trip_limit')) throw new Error('claim_failed')
      return data
    },
    async saveResult(documentId, result) {
      const { error } = await client.from('trip_documents').update(result.status === 'parsed'
        ? { parse_status: 'parsed', extracted: result.draft, parse_error: null }
        : { parse_status: 'failed', parse_error: result.error }).eq('id', documentId)
      if (error) throw new Error('save_failed')
    },
    async recordUsage({ userId, groupId, documentId, usage, costMicroUsd }) {
      if (!usageWriter) throw new Error('usage_writer_missing')
      const profile = await usageWriter.from('profiles').select('id').eq('auth_user_id', userId).maybeSingle()
      if (profile.error || !profile.data) throw new Error('usage_profile_missing')
      const { error } = await usageWriter.from('ai_usage').insert({
        profile_id: profile.data.id, group_id: groupId, feature: 'scan', document_id: documentId, model: usage.model,
        input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
        cache_read_tokens: usage.cacheReadTokens ?? 0, cache_write_tokens: usage.cacheWriteTokens ?? 0,
        cost_micro_usd: costMicroUsd,
      })
      if (error) throw new Error('usage_failed')
    },
  }
}

function anthropicExtractor(apiKey: string, model: string): Extractor {
  const anthropic = new Anthropic({ apiKey, maxRetries: 1, timeout: 60_000 })
  // Haiku 5.5 thinks by default, and thinking counts toward max_tokens: low effort
  // keeps a ticket read quick and cheap, and the cap leaves room for both. Haiku 4.x
  // rejects the effort setting, so it only goes to newer models.
  const effort = /^claude-haiku-4/u.test(model) ? {} : { effort: 'low' as const }
  return async ({ file, trip, onUsage }) => {
    const data = bytesToBase64(file.bytes)
    const source = file.mimeType === 'application/pdf'
      ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
      : { type: 'image' as const, source: { type: 'base64' as const, media_type: file.mimeType as 'image/jpeg' | 'image/png' | 'image/webp', data } }
    const response = await anthropic.messages.create({
      model,
      max_tokens: 16_000,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [source, { type: 'text', text: buildExtractionPrompt(trip) }] }],
      output_config: { ...effort, format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
    })
    // Thinking tokens are billed as output and already counted in output_tokens.
    onUsage?.({
      model: response.model || model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    })
    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') throw new Error('extraction_incomplete')
    const text = response.content.find((block) => block.type === 'text')
    if (!text || text.type !== 'text') throw new Error('extraction_empty')
    return parseModelText(text.text)
  }
}

const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const extractor: Extractor | null = Deno.env.get('SCAN_PARSE_STUB') === '1'
  ? createStubExtractor()
  : apiKey ? anthropicExtractor(apiKey, Deno.env.get('SCAN_PARSE_MODEL') || 'claude-haiku-5-5') : null

// Log only outcome codes: never document content, names, or tokens.
Deno.serve(createParseHandler({
  openStore, extractor, limits: parseLimitsFromEnv((name) => Deno.env.get(name)),
  log: (event) => console.log(`parse-document ${event}`),
}))
