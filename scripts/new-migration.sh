#!/usr/bin/env bash
# Create a migration from the schema diff without the interactive `prisma migrate dev`
# (useful in CI / non-interactive shells). Usage: scripts/new-migration.sh <name>
set -euo pipefail
name="${1:?migration name}"
shadow="${SHADOW_DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/codcc_shadow?schema=public}"
dir="prisma/migrations/$(date -u +%Y%m%d%H%M%S)_${name}"
mkdir -p "$dir"
pnpm -s prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$shadow" --script > "$dir/migration.sql"
if ! grep -qv '^--' "$dir/migration.sql"; then rm -rf "$dir"; echo "no changes"; exit 0; fi
echo "created $dir"
