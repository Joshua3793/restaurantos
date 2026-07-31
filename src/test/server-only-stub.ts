// Empty stub for the 'server-only' import guard, aliased in vitest.config.ts so
// server-only modules (e.g. src/lib/tips/sales.ts) can be unit-tested without a
// bundler enforcing the marker. Do NOT remove `import 'server-only'` from the
// modules themselves — this stub only satisfies module resolution under vitest.
export {}
