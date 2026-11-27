// send-chat-push's request handling, without Deno or network specifics so it runs
// under `node --test` with fakes (tests/unit/chat-push-handler.test.ts). index.ts
// wires it to the database (service role RPCs) and to Web Push.
import {
  type DeviceSubscription, type PushPayload, type PushRules, DEFAULT_RULES,
  decideMessage, decideSummary, deliveryOptions, readDueSummaries, readMessageContext,
} from './rules.ts'

export type SendResult = { ok: true } | { ok: false; gone: boolean; status?: number }

export interface PushSender {
  send(subscription: DeviceSubscription, payload: PushPayload, options: ReturnType<typeof deliveryOptions>): Promise<SendResult>
  /** Stub mode: record each would-be push in the log instead of sending it. */
  readonly stub: boolean
}

export interface LogRow { message_id: string | null; kind: string; endpoint: string; payload: PushPayload }

export interface RecordEntry {
  group_id: string
  member_id: string
  outcome: 'sent' | 'mention' | 'deferred' | 'cleared' | 'none'
  due_at?: string
  ok: string[]
  gone: string[]
  log: LogRow[]
}

export interface PushStore {
  /** `chat_push_message_context(message_id)`: raw JSON, or null. */
  messageContext(messageId: string): Promise<unknown>
  /** `chat_push_claim_due()`: raw JSON array. */
  claimDue(): Promise<unknown>
  record(entries: RecordEntry[]): Promise<void>
}

export interface PushHandlerDeps {
  /** CHAT_PUSH_SECRET; the database sends it as `x-chat-push-secret`. Empty: every call is refused. */
  secret: string
  /** False when VAPID keys are missing (and not in stub mode): nothing can be sent. */
  ready: boolean
  store: PushStore
  sender: PushSender
  now?: () => number
  rules?: PushRules
  /** Outcome codes only; never message text, names or endpoints. */
  log?: (line: string) => void
}

export interface PushCounts { sent: number; deferred: number; skipped: number; cleared: number; removed: number; failed: number }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Constant-time comparison, so the secret cannot be guessed a character at a time. */
export function sameSecret(given: string, expected: string): boolean {
  if (!expected) return false
  let diff = given.length ^ expected.length
  for (let index = 0; index < expected.length; index += 1) diff |= (given.charCodeAt(index) || 0) ^ expected.charCodeAt(index)
  return diff === 0
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export function createPushHandler(deps: PushHandlerDeps) {
  const rules = deps.rules ?? DEFAULT_RULES
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})

  /** Send one payload to every device of a recipient; collect which worked and which are gone. */
  async function deliver(entry: RecordEntry, subscriptions: DeviceSubscription[], payload: PushPayload, counts: PushCounts) {
    const options = deliveryOptions(payload)
    const results = await Promise.all(subscriptions.map(async (subscription) => {
      try { return { subscription, result: await deps.sender.send(subscription, payload, options) } } catch { return { subscription, result: { ok: false, gone: false } as SendResult } }
    }))
    for (const { subscription, result } of results) {
      if (result.ok) {
        entry.ok.push(subscription.id)
        if (deps.sender.stub) entry.log.push({ message_id: payload.messageId, kind: payload.kind, endpoint: subscription.endpoint, payload })
      } else if (result.gone) {
        entry.gone.push(subscription.id)
        counts.removed += 1
      } else {
        counts.failed += 1
        log(`push_failed status=${result.status ?? 'none'}`)
      }
    }
  }

  async function onMessage(messageId: string): Promise<PushCounts> {
    const counts: PushCounts = { sent: 0, deferred: 0, skipped: 0, cleared: 0, removed: 0, failed: 0 }
    const context = readMessageContext(await deps.store.messageContext(messageId))
    if (!context) return counts
    const nowMs = now()
    const entries: RecordEntry[] = []
    await Promise.all(context.recipients.map(async (recipient) => {
      const decision = decideMessage(context, recipient, nowMs, rules)
      const entry: RecordEntry = { group_id: context.trip.groupId, member_id: recipient.memberId, outcome: 'none', ok: [], gone: [], log: [] }
      if (decision.action === 'send') {
        entry.outcome = decision.outcome
        counts.sent += 1
        await deliver(entry, recipient.subscriptions, decision.payload, counts)
      } else if (decision.action === 'defer') {
        entry.outcome = 'deferred'
        entry.due_at = decision.dueAt
        counts.deferred += 1
      } else {
        counts.skipped += 1
      }
      entries.push(entry)
    }))
    if (entries.length) await deps.store.record(entries)
    return counts
  }

  async function onFlush(): Promise<PushCounts> {
    const counts: PushCounts = { sent: 0, deferred: 0, skipped: 0, cleared: 0, removed: 0, failed: 0 }
    const due = readDueSummaries(await deps.store.claimDue())
    const nowMs = now()
    const entries: RecordEntry[] = []
    await Promise.all(due.map(async (summary) => {
      const decision = decideSummary(summary, nowMs, rules)
      const entry: RecordEntry = { group_id: summary.trip.groupId, member_id: summary.recipient.memberId, outcome: 'cleared', ok: [], gone: [], log: [] }
      if (decision.action === 'send') {
        entry.outcome = 'sent'
        counts.sent += 1
        await deliver(entry, summary.recipient.subscriptions, decision.payload, counts)
      } else {
        counts.cleared += 1
      }
      entries.push(entry)
    }))
    if (entries.length) await deps.store.record(entries)
    return counts
  }

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    if (!sameSecret(request.headers.get('x-chat-push-secret') ?? '', deps.secret)) return json({ error: 'not_authorized' }, 401)
    if (!deps.ready) {
      log('push_not_configured')
      return json({ error: 'not_configured' }, 503)
    }
    let body: Record<string, unknown>
    try {
      const parsed = await request.json()
      body = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    } catch {
      return json({ error: 'invalid_request' }, 400)
    }
    try {
      if (typeof body.message_id === 'string' && UUID.test(body.message_id)) {
        const counts = await onMessage(body.message_id)
        log(`message sent=${counts.sent} deferred=${counts.deferred} skipped=${counts.skipped} removed=${counts.removed} failed=${counts.failed}`)
        return json(counts)
      }
      if (body.flush === true) {
        const counts = await onFlush()
        log(`flush sent=${counts.sent} cleared=${counts.cleared} removed=${counts.removed} failed=${counts.failed}`)
        return json(counts)
      }
      return json({ error: 'invalid_request' }, 400)
    } catch {
      log('push_handler_error')
      return json({ error: 'push_failed' }, 500)
    }
  }
}
