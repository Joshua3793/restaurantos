#!/usr/bin/env bash
# Runner for UoM-reconcile verification scripts.
# The repo's tsconfig has no `baseUrl`, so `tsconfig-paths` can't resolve the `@/`
# aliases the lib files use internally. TS_NODE_BASEURL=. fixes that. Relative
# imports (../../src/...) also work. Run from the project root:
#   bash scripts/uom-reconcile/run.sh verify-convert-density.ts
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
