#!/usr/bin/env sh
# Nightly database backup (cron: 30 2 * * * /opt/aafm/deploy/scripts/backup.sh).
# pg_dump custom format (compressed, restorable table by table); the last 7 are kept.
# Restore: docker compose exec -T db pg_restore -U aafm_owner -d aafm --clean < backups/<file>
# Also back up deploy/secrets/webhook-keyring.json separately: without it, stored webhook
# secrets can't be decrypted (they'd have to be rotated).
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
file="backups/aafm-$(date -u +%Y%m%dT%H%MZ).dump"
docker compose exec -T db pg_dump -U aafm_owner -Fc aafm > "$file"
[ -s "$file" ] || { echo "backup is empty: $file" >&2; exit 1; }
ls -1t backups/aafm-*.dump | tail -n +8 | xargs -r rm -f
echo "backup written: $file ($(du -h "$file" | cut -f1))"
