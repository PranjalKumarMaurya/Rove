import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearPendingJoin, isJoinProof, joinProofFromHash, joinShareUrl, pendingJoinFromBrowser,
} from '../../src/features/invitations/joinLink.ts'

const proof = 'ab'.repeat(32)
const other = 'cd'.repeat(32)
const day = 24 * 60 * 60 * 1000

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

test('a join proof is exactly 64 lowercase hex characters', () => {
  assert.equal(isJoinProof(proof), true)
  assert.equal(isJoinProof(proof.toUpperCase()), false)
  assert.equal(isJoinProof(proof.slice(1)), false)
  assert.equal(isJoinProof(`${proof}0`), false)
  assert.equal(isJoinProof(42), false)
  assert.equal(isJoinProof(null), false)
})

test('the share URL keeps the origin and path and puts only the proof in the fragment', () => {
  assert.equal(joinShareUrl('https://rove.example/app/?x=1#invite=zz', proof), `https://rove.example/app/#join=${proof}`)
  assert.throws(() => joinShareUrl('https://rove.example/', 'nope'), /invalid_join_proof/u)
})

test('parsing the fragment tells #join= apart from other fragments', () => {
  assert.deepEqual(joinProofFromHash(`#join=${proof}`), { present: true, proof })
  assert.deepEqual(joinProofFromHash(`join=${proof}`), { present: true, proof })
  assert.deepEqual(joinProofFromHash('#join=bad'), { present: true, proof: null })
  assert.deepEqual(joinProofFromHash(`#invite=${proof}`), { present: false, proof: null })
  assert.deepEqual(joinProofFromHash(''), { present: false, proof: null })
})

test('a link in the fragment is remembered and the fragment consumed', () => {
  const storage = memoryStorage()
  assert.deepEqual(pendingJoinFromBrowser(`#join=${proof}`, storage, 1000), { proof, consumedHash: true })
  assert.deepEqual(pendingJoinFromBrowser('', storage, 2000), { proof, consumedHash: false })
  // A newer link replaces the remembered one.
  assert.deepEqual(pendingJoinFromBrowser(`#join=${other}`, storage, 3000), { proof: other, consumedHash: true })
  assert.deepEqual(pendingJoinFromBrowser('', storage, 4000), { proof: other, consumedHash: false })
})

test('a malformed link clears the pending one; invitation fragments are left alone', () => {
  const storage = memoryStorage()
  pendingJoinFromBrowser(`#join=${proof}`, storage, 1000)
  assert.deepEqual(pendingJoinFromBrowser(`#invite=${other}`, storage, 2000), { proof, consumedHash: false })
  assert.deepEqual(pendingJoinFromBrowser('#join=bad', storage, 3000), { proof: null, consumedHash: true })
  assert.deepEqual(pendingJoinFromBrowser('', storage, 4000), { proof: null, consumedHash: false })
})

test('a remembered link expires after seven days, and corrupt or future records are dropped', () => {
  const storage = memoryStorage()
  pendingJoinFromBrowser(`#join=${proof}`, storage, 0)
  assert.equal(pendingJoinFromBrowser('', storage, 7 * day).proof, proof)
  assert.equal(pendingJoinFromBrowser('', storage, 7 * day + 1).proof, null)
  assert.equal(storage.values.size, 0)

  storage.setItem('trip:pending-join:v1', '{not json')
  assert.equal(pendingJoinFromBrowser('', storage, 0).proof, null)
  storage.setItem('trip:pending-join:v1', JSON.stringify({ proof, savedAt: 5000 }))
  assert.equal(pendingJoinFromBrowser('', storage, 1000).proof, null, 'saved in the future')
  storage.setItem('trip:pending-join:v1', JSON.stringify({ proof: 'bad', savedAt: 0 }))
  assert.equal(pendingJoinFromBrowser('', storage, 0).proof, null)
  assert.equal(storage.values.size, 0)
})

test('it keeps working without storage or when storage throws', () => {
  assert.deepEqual(pendingJoinFromBrowser(`#join=${proof}`, null), { proof, consumedHash: true })
  assert.deepEqual(pendingJoinFromBrowser('', null), { proof: null, consumedHash: false })
  const broken = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  }
  assert.deepEqual(pendingJoinFromBrowser(`#join=${proof}`, broken), { proof, consumedHash: true })
  assert.deepEqual(pendingJoinFromBrowser('', broken), { proof: null, consumedHash: false })
  clearPendingJoin(broken)
})

test('clearing removes the pending join and nothing else', () => {
  const storage = memoryStorage()
  storage.setItem('trip:pending-invitation:v1', 'keep')
  pendingJoinFromBrowser(`#join=${proof}`, storage, 0)
  clearPendingJoin(storage)
  assert.deepEqual([...storage.values.keys()], ['trip:pending-invitation:v1'])
})
