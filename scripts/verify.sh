#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

cmd="${1:-all}"

run_typecheck() {
  echo "→ typecheck"
  pnpm exec tsc --noEmit
}

run_lint() {
  echo "→ lint"
  pnpm exec eslint .
}

run_unit() {
  echo "→ unit tests"
  pnpm exec vitest run --passWithNoTests --exclude 'src/core/cacheInvariance.test.ts'
}

run_cache() {
  echo "→ cache-invariance"
  pnpm exec vitest run --passWithNoTests src/core/cacheInvariance.test.ts
}

case "$cmd" in
  typecheck-only)        run_typecheck ;;
  lint-only)             run_lint ;;
  test:unit)             run_unit ;;
  test:cache-invariance) run_cache ;;
  all)                   run_typecheck; run_lint; run_unit; run_cache ;;
  *)
    echo "unknown command: $cmd"
    echo "usage: verify.sh [typecheck-only | lint-only | test:unit | test:cache-invariance | all]"
    exit 1
    ;;
esac

echo "✓ verify.sh $cmd"
