#!/usr/bin/env bash
# Dump the hosted Trip database into one passphrase-encrypted file.
#
#   SUPABASE_DB_URL=… BACKUP_PASSPHRASE=… scripts/db-backup.sh <output-dir>
#
# Writes <output-dir>/trip-db-<UTC time>.tar.gz.gpg and prints its path. Inside:
# data.sql (every row, restored by scripts/db-restore.sh) and schema.sql (the schema
# at backup time, for reference: a restore rebuilds the schema from the migrations).
# The plain SQL only ever exists in a temporary folder. Storage files (photos,
# tickets) are not included. SUPABASE_CLI overrides the CLI command (default: supabase).
set -euo pipefail

: "${SUPABASE_DB_URL:?set SUPABASE_DB_URL to the database connection string}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}"
out_dir=${1:?usage: scripts/db-backup.sh <output-dir>}
read -r -a cli <<<"${SUPABASE_CLI:-supabase}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stamp=$(date -u +%Y%m%dT%H%M%SZ)

"${cli[@]}" db dump --db-url "$SUPABASE_DB_URL" -f "$work/schema.sql"
# Left out of the data: rows the migrations themselves create (currency and timezone
# reference data, the storage buckets), and Supabase's platform-managed vector-bucket
# tables, which postgres cannot restore and Trip does not use.
"${cli[@]}" db dump --db-url "$SUPABASE_DB_URL" -f "$work/data.sql" --use-copy --data-only \
  -x public.iso_4217_currency_codes \
  -x ir002_private.iana_timezone_reference -x ir002_private.iana_timezone_reference_control \
  -x storage.buckets -x storage.buckets_vectors -x storage.vector_indexes

mkdir -p "$out_dir"
target="$out_dir/trip-db-$stamp.tar.gz.gpg"
# The passphrase goes in on file descriptor 3, so it never appears in the process list.
tar -C "$work" -czf - schema.sql data.sql \
  | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
      --symmetric --cipher-algo AES256 --output "$target" 3<<<"$BACKUP_PASSPHRASE"
echo "$target"
