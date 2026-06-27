#!/usr/bin/env bash
# Runner for UoM-reconcile verification scripts.
# The repo's tsconfig has no `baseUrl`, so `tsconfig-paths` can't resolve the `@/`
# aliases the lib files use internally. TS_NODE_BASEURL=. fixes that. Relative
# imports (../../src/...) also work. Run from the project root:
#   bash scripts/uom-reconcile/run.sh verify-convert-density.ts
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Plain ts-node doesn't auto-load .env the way Next.js does; DB-touching scripts
# (Prisma) need DATABASE_URL in the environment. Source it if present.
root="$(cd "$here/../.." && pwd)"
if [ -f "$root/.env" ]; then set -a; . "$root/.env"; set +a; fi
script="$1"
# Accept either a bare filename or a path; normalize to scripts/uom-reconcile/<file>.
case "$script" in
  */*) target="$script" ;;
  *)   target="$here/$script" ;;
esac
TS_NODE_BASEURL=. exec npx ts-node \
  --compiler-options '{"module":"CommonJS","baseUrl":"."}' \
  -r tsconfig-paths/register \
  "$target"
