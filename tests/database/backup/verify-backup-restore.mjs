// The deploy and disaster-recovery path in docs/STATUS.md ("Deploy runbook"):
// - `supabase db push` on an empty project builds the same database as the psql
//   replay every other suite uses (tables, RLS, policies, functions, grants, buckets).
// - scripts/db-backup.sh writes one encrypted file (wrong passphrase rejected,
//   passphrase never printed) without the rows the migrations create themselves.
// - scripts/db-restore.sh loads it into a pushed, empty project with every Trip and
//   account row intact, and refuses a project that already has data.
// - The keep-awake workflow's query works.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createLocalStack, root } from '../../support/local-stack.mjs'
import { createTrip, createUsers, quote } from '../../support/db-fixtures.mjs'

const source = createLocalStack({ projectId: 'backup-source', basePort: 59200 })
const target = createLocalStack({ projectId: 'backup-target', basePort: 59220 })
const cli = resolve(root, 'node_modules/.bin/supabase')
const dbUrl = (stack) => `postgresql://postgres:postgres@127.0.0.1:${stack.dbPort}/postgres`
const ours = `(n.nspname = 'public' OR n.nspname LIKE '%private%')`

function sh(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...env } })
  return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' }
}

/** Structure the app depends on, as one comparable object. */
const structure = (stack) => JSON.parse(stack.psql(`SELECT json_build_object(
  'tables', (SELECT string_agg(n.nspname||'.'||c.relname||':'||c.relkind::text||c.relrowsecurity::text||c.relforcerowsecurity::text||coalesce(c.relacl::text, '-'), ',' ORDER BY n.nspname, c.relname)
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','v','m','S') AND ${ours}),
  'columns', (SELECT md5(string_agg(table_schema||'.'||table_name||'.'||column_name||data_type||coalesce(column_default, ''), ',' ORDER BY table_schema, table_name, column_name))
              FROM information_schema.columns WHERE table_schema = 'public' OR table_schema LIKE '%private%'),
  'policies', (SELECT md5(string_agg(schemaname||'.'||tablename||'.'||policyname||cmd||array_to_string(roles, ',')||coalesce(qual, '')||coalesce(with_check, ''), '|' ORDER BY schemaname, tablename, policyname)) FROM pg_policies),
  'functions', (SELECT md5(string_agg(n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'||p.prosecdef::text||pg_get_userbyid(p.proowner)||p.prosrc||coalesce(p.proacl::text, '-'), '|' ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)))
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${ours}),
  'column_grants', (SELECT md5(string_agg(grantee||table_schema||table_name||column_name||privilege_type, '|' ORDER BY grantee, table_schema, table_name, column_name, privilege_type))
                    FROM information_schema.column_privileges WHERE table_schema = 'public' OR table_schema LIKE '%private%'),
  'buckets', (SELECT string_agg(id||':'||public::text, ',' ORDER BY id) FROM storage.buckets),
  'realtime', (SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_publication_tables WHERE pubname = 'supabase_realtime')
)`))

/** One checksum per table that holds Trip or account rows (storage.buckets is rebuilt by the migrations). */
const rowChecksums = (stack) => stack.adminSql(`SELECT string_agg(n.nspname||'.'||c.relname||'='||(xpath('/row/m/text()', query_to_xml(format(
    'SELECT md5(coalesce(string_agg(t::text, ''|'' ORDER BY t::text), '''')) AS m FROM %I.%I t', n.nspname, c.relname), false, true, '')))[1]::text,
    E'\\n' ORDER BY n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND (n.nspname IN ('public', 'auth', 'storage') OR n.nspname LIKE '%private%')
    AND c.relname NOT LIKE '%migrations%' AND (n.nspname, c.relname) <> ('storage', 'buckets');`).split('\n')

const out = mkdtempSync(resolve(tmpdir(), 'trip-backup-'))
try {
  // Source: the psql replay plus real rows.
  source.start(); source.migrate()
  const users = createUsers(source, ['asha', 'ravi', 'meera'])
  const trip = createTrip(source, { groupId: 'f0000000-0000-4000-8000-000000000001', members: { [users.asha]: 'owner', [users.ravi]: 'member' } })
  createTrip(source, { groupId: 'f0000000-0000-4000-8000-000000000002', name: 'Second', members: { [users.meera]: 'owner' } })
  source.psql(`INSERT INTO public.trip_todos (group_id, title, created_by)
    VALUES (${quote(trip.groupId)}, 'Book the ferry', ${quote(trip.memberIds[users.asha])});`)

  // Keep-awake: the workflow's query, as written there.
  const ping = sh('psql', [dbUrl(source), '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-tAc', 'select count(*) from public.group_members'])
  assert.equal(ping.out.trim(), '3', 'keep-awake query')

  // Backup.
  const passphrase = randomBytes(24).toString('hex')
  const backup = sh(resolve(root, 'scripts/db-backup.sh'), [out], { SUPABASE_DB_URL: dbUrl(source), BACKUP_PASSPHRASE: passphrase, SUPABASE_CLI: cli })
  assert.ok(backup.ok, 'backup-script')
  assert.equal((backup.out + backup.err).includes(passphrase), false, 'passphrase printed')
  const [name] = readdirSync(out)
  const file = resolve(out, name)
  assert.match(name, /^trip-db-\d{8}T\d{6}Z\.tar\.gz\.gpg$/u)
  const sealed = readFileSync(file)
  for (const plain of ['COPY', 'example.test', 'Book the ferry']) assert.equal(sealed.includes(plain), false, `plain text in backup: ${plain}`)
  assert.equal(sh('bash', ['-c', `gpg --batch --quiet --pinentry-mode loopback --passphrase wrong --decrypt "${file}" >/dev/null`]).ok, false, 'wrong passphrase')
  const opened = resolve(out, 'opened'); mkdirSync(opened)
  assert.ok(sh('bash', ['-c', `gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "${file}" 3<<<"$P" | tar -xz -C "${opened}"`], { P: passphrase }).ok, 'decrypt')
  assert.deepEqual(readdirSync(opened).sort(), ['data.sql', 'schema.sql'])
  const copied = [...readFileSync(resolve(opened, 'data.sql'), 'utf8').matchAll(/^COPY "([^"]+)"\."([^"]+)"/gmu)].map((m) => `${m[1]}.${m[2]}`)
  for (const table of ['auth.users', 'public.groups', 'public.group_members', 'public.trip_todos']) assert.ok(copied.includes(table), `missing ${table}`)
  for (const table of ['public.iso_4217_currency_codes', 'ir002_private.iana_timezone_reference', 'storage.buckets', 'storage.buckets_vectors']) {
    assert.equal(copied.includes(table), false, `migration-owned ${table} in data`)
  }

  // Target: an empty project built with `supabase db push`, as the runbook does.
  target.start()
  cpSync(resolve(root, 'supabase/migrations'), resolve(target.workdir, 'supabase/migrations'), { recursive: true })
  assert.ok(sh(cli, ['db', 'push', '--local', '--workdir', target.workdir, '--yes']).ok, 'db-push')
  const migrationFiles = readdirSync(resolve(root, 'supabase/migrations')).filter((file) => file.endsWith('.sql')).length
  assert.equal(target.psql('SELECT count(*) FROM supabase_migrations.schema_migrations;'), String(migrationFiles))
  assert.deepEqual(structure(target), structure(source), 'db push builds what the psql replay builds')

  // Restore, then compare every row; a second restore is refused.
  const restoreEnv = { TARGET_DB_URL: dbUrl(target), BACKUP_PASSPHRASE: passphrase }
  assert.ok(sh(resolve(root, 'scripts/db-restore.sh'), [file], restoreEnv).ok, 'restore-script')
  assert.deepEqual(rowChecksums(target), rowChecksums(source), 'restored rows')
  assert.deepEqual(structure(target), structure(source), 'structure after restore')
  assert.equal(target.psql('SELECT title FROM public.trip_todos;'), 'Book the ferry')
  const again = sh(resolve(root, 'scripts/db-restore.sh'), [file], restoreEnv)
  assert.equal(again.ok, false, 'second restore')
  assert.match(again.err, /already has accounts or Trips/u)

  source.stop(); target.stop()
  console.log(JSON.stringify({ dbPushMatchesReplay: 'passed', backupEncrypted: 'passed', restoreRowsIdentical: 'passed', refusesNonEmptyTarget: 'passed', keepAwakeQuery: 'passed', cleanup: 'passed' }))
} catch (error) {
  for (const stack of [source, target]) { try { stack.stop() } catch { /* keep the primary failure */ } }
  console.error(error instanceof Error && /^[a-z0-9-]+$/u.test(error.message) ? error.message : 'backup-restore-verification-failed')
  if (process.env.TRIP_DEBUG === '1') console.error(error)
  process.exitCode = 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
