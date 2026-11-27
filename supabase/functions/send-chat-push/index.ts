// send-chat-push: Web Push for the Trip chat. Called only by the database, never
// by the app: a trigger on trip_messages (one call per new message) and a pg_cron
// tick (collapsed summaries that are due), both through pg_net with the shared
// secret in `x-chat-push-secret` (migration 097). Deploy with --no-verify-jwt:
// the caller has no user JWT; the secret is the check.
//
// It reads and writes through three service-role-only RPCs (chat_push_message_context,
// chat_push_claim_due, chat_push_record), decides with rules.ts, and sends with the
// standard Web Push protocol (VAPID + aes128gcm, the `web-push` library). Push
// services' 404/410 replies remove that device's subscription.
//
// Secrets: CHAT_PUSH_SECRET (the same value as the Vault secret `chat_push_secret`),
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (a mailto: or https: contact),
// CHAT_PUSH_STUB=1 (local stacks and tests only: encrypt as for real, but record each
// would-be push in trip_private.chat_push_log instead of sending; an endpoint ending
// in /gone acts as a push service's 410), CHAT_PUSH_COOLDOWN_SECONDS (optional, default
// 60: one ordinary push per recipient per Trip in that window; tests shorten it).
import webpush from 'npm:web-push@3.6.7'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { type PushSender, type PushStore, createPushHandler } from './handler.ts'
import { DEFAULT_RULES } from './rules.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const secret = Deno.env.get('CHAT_PUSH_SECRET') ?? ''
const stub = Deno.env.get('CHAT_PUSH_STUB') === '1'
const vapid = {
  subject: Deno.env.get('VAPID_SUBJECT') ?? '',
  publicKey: Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
  privateKey: Deno.env.get('VAPID_PRIVATE_KEY') ?? '',
}
const hasVapid = Boolean(vapid.subject && vapid.publicKey && vapid.privateKey)
const cooldownSeconds = Number(Deno.env.get('CHAT_PUSH_COOLDOWN_SECONDS') ?? '')
const rules = Number.isFinite(cooldownSeconds) && cooldownSeconds > 0 ? { ...DEFAULT_RULES, cooldownMs: cooldownSeconds * 1000 } : DEFAULT_RULES

const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })

const store: PushStore = {
  async messageContext(messageId) {
    const { data, error } = await db.rpc('chat_push_message_context', { p_message_id: messageId })
    if (error) throw new Error('context_failed')
    return data
  },
  async claimDue() {
    const { data, error } = await db.rpc('chat_push_claim_due', { p_limit: 200 })
    if (error) throw new Error('claim_failed')
    return data
  },
  async record(entries) {
    const { error } = await db.rpc('chat_push_record', { p_entries: entries })
    if (error) throw new Error('record_failed')
  },
}

const sender: PushSender = {
  stub,
  async send(subscription, payload, options) {
    const target = { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }
    const request = { TTL: options.ttl, urgency: options.urgency, topic: options.topic, vapidDetails: vapid }
    if (stub) {
      // Encrypt and sign exactly as for a real send (this throws on a malformed key), but send nothing.
      if (hasVapid) webpush.generateRequestDetails(target, JSON.stringify(payload), request)
      return /\/gone$/u.test(subscription.endpoint) ? { ok: false, gone: true, status: 410 } : { ok: true }
    }
    try {
      await webpush.sendNotification(target, JSON.stringify(payload), request)
      return { ok: true }
    } catch (error) {
      const status = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : undefined
      return { ok: false, gone: status === 404 || status === 410, status }
    }
  },
}

const handle = createPushHandler({
  secret, store, sender, rules, ready: stub || hasVapid,
  // Outcome codes only: never message text, names, endpoints or keys.
  log: (line) => console.log(`send-chat-push ${line}`),
})

Deno.serve(handle)
