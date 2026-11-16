#!/usr/bin/env bash
# Restore a backup made by scripts/db-backup.sh into a NEW, EMPTY Supabase project.
#
# 1. Build the schema there from the migrations, at the commit the backup was taken
#    on or a later one:  npx supabase link --project-ref <ref> && npx supabase db push
# 2. TARGET_DB_URL=… BACKUP_PASSPHRASE=… scripts/db-restore.sh <trip-db-….tar.gz.gpg>
#
# Loads every row in one transaction and refuses a project that already has accounts
# or Trips. Storage files (photos, tickets) are not in the backup; copy them separately.
set -euo pipefail

: "${TARGET_DB_URL:?set TARGET_DB_URL to the connection string of the new project}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
backup=${1:?usage: scripts/db-restore.sh <trip-db-….tar.gz.gpg>}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$backup" 3<<<"$BACKUP_PASSPHRASE" \
  | tar -xz -C "$work" data.sql

guard="DO \$\$ BEGIN
  IF to_regclass('public.group_members') IS NULL THEN
    RAISE EXCEPTION 'Apply the migrations to the target first (npx supabase db push).';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users) OR EXISTS (SELECT 1 FROM public.groups) THEN
    RAISE EXCEPTION 'The target already has accounts or Trips: restore only into a new, empty project.';
  END IF;
END \$\$;"

# Replica mode skips triggers and foreign-key checks while the rows go back in as they were.
psql "$TARGET_DB_URL" --no-psqlrc --single-transaction -v ON_ERROR_STOP=1 --quiet \
  -c "$guard" \
  -c 'SET session_replication_role = replica' \
  -f "$work/data.sql" \
  -c 'SET session_replication_role = DEFAULT' >/dev/null
echo "Restored $(basename "$backup")"
