// Trip join links ("anyone with the link can join"): `https://…/#join=<proof>`.
// Same shape as invitation links (invitationLink.ts) but a separate fragment key
// and a separate pending slot, so an email invitation and an open link never
// overwrite each other.
const storageKey = 'trip:pending-join:v1'
const proofPattern = /^[0-9a-f]{64}$/
const maxAgeMs = 7 * 24 * 60 * 60 * 1000

type JoinStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function isJoinProof(value: unknown): value is string {
  return typeof value === 'string' && proofPattern.test(value)
}

export function joinShareUrl(baseUrl: string, proof: string): string {
  if (!isJoinProof(proof)) throw new Error('invalid_join_proof')
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = `join=${proof}`
  return url.toString()
}

/** Whether the fragment is a `#join=` link, and its proof (null when absent or malformed). */
export function joinProofFromHash(hash: string): { present: boolean; proof: string | null } {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  if (!fragment.startsWith('join=')) return { present: false, proof: null }
  const proof = fragment.slice('join='.length)
  return { present: true, proof: isJoinProof(proof) ? proof : null }
}

/**
 * Read a join link from the URL fragment (and remember it, so it survives sign-up
 * and email verification), or fall back to the one remembered in this browser.
 * `consumedHash` tells the caller to clear the fragment from the address bar.
 */
export function pendingJoinFromBrowser(
  hash: string,
  storage: JoinStorage | null,
  now = Date.now(),
): { proof: string | null; consumedHash: boolean } {
  const fromHash = joinProofFromHash(hash)
  if (fromHash.present) {
    if (!fromHash.proof) {
      clearPendingJoin(storage)
      return { proof: null, consumedHash: true }
    }
    try {
      storage?.setItem(storageKey, JSON.stringify({ proof: fromHash.proof, savedAt: now }))
    } catch { /* the current tab can still use the link */ }
    return { proof: fromHash.proof, consumedHash: true }
  }

  try {
    const stored = storage?.getItem(storageKey)
    if (!stored) return { proof: null, consumedHash: false }
    const record: unknown = JSON.parse(stored)
    if (typeof record === 'object' && record !== null
      && 'proof' in record && isJoinProof(record.proof)
      && 'savedAt' in record && typeof record.savedAt === 'number'
      && record.savedAt <= now && now - record.savedAt <= maxAgeMs) {
      return { proof: record.proof, consumedHash: false }
    }
    storage?.removeItem(storageKey)
  } catch { /* treat unavailable or corrupt storage as empty */ }
  return { proof: null, consumedHash: false }
}

export function clearPendingJoin(storage: Pick<Storage, 'removeItem'> | null): void {
  try { storage?.removeItem(storageKey) } catch { /* already unavailable */ }
}
