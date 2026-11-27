// Make a VAPID key pair for Web Push (chat notifications).
//
//   node scripts/generate-vapid.mjs <private-file>
//
// Prints only the PUBLIC key (it goes in the app build as VITE_VAPID_PUBLIC_KEY, or in
// src/features/notifications/pushConfig.ts). The private key is written to <private-file>
// (created new, never overwritten, readable only by you) as an env file:
//
//   VAPID_PUBLIC_KEY=…
//   VAPID_PRIVATE_KEY=…
//
// so it can be set as Edge Function secrets without ever being printed or typed:
//
//   npx supabase secrets set --env-file <private-file>
//
// Keep that file in a private folder, outside the repository. Changing keys later
// makes every existing subscription stop working (devices subscribe again on next open).
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** P-256 key pair as Web Push wants it: the public key uncompressed (65 bytes), the private key raw (32 bytes), base64url. */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  const pub = publicKey.export({ format: 'jwk' })
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')])
  return { publicKey: raw.toString('base64url'), privateKey: Buffer.from(jwk.d, 'base64url').toString('base64url') }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
if (isMain) {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node scripts/generate-vapid.mjs <private-file>')
    process.exit(1)
  }
  const keys = generateVapidKeys()
  try {
    // 'wx': fail if the file exists, so an existing private key is never replaced by accident.
    writeFileSync(resolve(target), `VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    console.error(error && error.code === 'EEXIST' ? 'That file already exists; choose a new path.' : 'Could not write the private key file.')
    process.exit(1)
  }
  console.log(keys.publicKey)
}
