// Typed wrappers for the Trip join link RPCs (migration 096).
import { supabase } from '../../lib/supabase'
import { isJoinProof } from './joinLink'

export type JoinLinkState = { active: false } | { active: true; proof: string }

export type SetJoinLinkResult = JoinLinkState & { outcome: 'enabled' | 'rotated' | 'disabled' | 'unchanged' }

/** `continue`: needs sign-in. `ready`: signed in and can join. `verification_required`: signed in, email not verified. */
export type JoinInspectionOutcome = 'ready' | 'continue' | 'verification_required' |
  'already_member' | 'closed' | 'archived' | 'removed'

export interface JoinLinkInspection {
  outcome: JoinInspectionOutcome
  /** Present for ready, continue, verification_required and already_member. */
  tripName?: string
  destination?: string
  startDate?: string
  endDate?: string
  /** Present for already_member, so the app can open the Trip. */
  groupId?: string
}

export type JoinWithLinkResult = { outcome: 'joined' | 'already_member'; groupId: string }

/** Errors thrown (as `Error.message`). */
export type JoinLinkError =
  | 'not_authorized' // not a member (get) / not the Owner (set) / not signed in
  | 'trip_archived'
  | 'link_closed' // unknown, malformed, revoked or rotated-away proof
  | 'membership_removed' // removed people need a fresh email invitation
  | 'verification_required'
  | 'join_link_unavailable' // network, unexpected shape, operation_failed

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function mapError(message: string, known: readonly JoinLinkError[]): never {
  const code = (known as readonly string[]).includes(message) ? message : 'join_link_unavailable'
  throw new Error(code)
}

function linkState(result: Record<string, unknown> | null): JoinLinkState {
  if (result?.active === false) return { active: false }
  if (result?.active === true && isJoinProof(result.proof)) return { active: true, proof: result.proof }
  throw new Error('join_link_unavailable')
}

/** The active link for a Trip the caller is an active member of. */
export async function getJoinLink(groupId: string): Promise<JoinLinkState> {
  const { data, error } = await supabase.rpc('get_trip_join_link', { group_id: groupId })
  if (error) mapError(error.message, ['not_authorized'])
  return linkState(object(data))
}

/** Owner only. `enabled: false` revokes; `rotate: true` replaces the active link with a new one. */
export async function setJoinLink(groupId: string, enabled: boolean, rotate = false): Promise<SetJoinLinkResult> {
  const { data, error } = await supabase.rpc('set_trip_join_link', { group_id: groupId, enabled, rotate })
  if (error) mapError(error.message, ['not_authorized', 'trip_archived'])
  const result = object(data)
  const outcome = result?.outcome
  if (outcome !== 'enabled' && outcome !== 'rotated' && outcome !== 'disabled' && outcome !== 'unchanged') {
    throw new Error('join_link_unavailable')
  }
  return { ...linkState(result), outcome }
}

/** Works signed out (anon) too, to show the preview before sign-in. */
export async function inspectJoinLink(proof: string): Promise<JoinLinkInspection> {
  if (!isJoinProof(proof)) return { outcome: 'closed' }
  const { data, error } = await supabase.rpc('inspect_trip_join_link', { proof })
  if (error) throw new Error('join_link_unavailable')
  const result = object(data)
  const outcome = result?.outcome
  if (!result || (outcome !== 'ready' && outcome !== 'continue' && outcome !== 'verification_required'
    && outcome !== 'already_member' && outcome !== 'closed' && outcome !== 'archived'
    && outcome !== 'removed')) throw new Error('join_link_unavailable')
  const inspection: JoinLinkInspection = { outcome }
  if (outcome === 'ready' || outcome === 'continue' || outcome === 'verification_required'
    || outcome === 'already_member') {
    if (typeof result.trip_name !== 'string' || typeof result.destination !== 'string'
      || typeof result.start_date !== 'string' || typeof result.end_date !== 'string') {
      throw new Error('join_link_unavailable')
    }
    inspection.tripName = result.trip_name
    inspection.destination = result.destination
    inspection.startDate = result.start_date
    inspection.endDate = result.end_date
  }
  if (outcome === 'already_member') {
    if (typeof result.group_id !== 'string') throw new Error('join_link_unavailable')
    inspection.groupId = result.group_id
  }
  return inspection
}

/** Signed-in, verified callers only. Safe to retry: an existing active member gets `already_member`. */
export async function joinWithLink(proof: string, requestId: string): Promise<JoinWithLinkResult> {
  if (!isJoinProof(proof)) throw new Error('link_closed')
  const { data, error } = await supabase.rpc('join_trip_with_link', { proof, request_id: requestId })
  if (error) {
    mapError(error.message,
      ['not_authorized', 'trip_archived', 'link_closed', 'membership_removed', 'verification_required'])
  }
  const result = object(data)
  if ((result?.outcome !== 'joined' && result?.outcome !== 'already_member')
    || typeof result.group_id !== 'string') throw new Error('join_link_unavailable')
  return { outcome: result.outcome, groupId: result.group_id }
}
