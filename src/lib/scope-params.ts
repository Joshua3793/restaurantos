/**
 * Writes the active scope onto a URLSearchParams for an API list fetch.
 *  - RC active       → ?rcId (+ ?isDefault for the default stock-pool RC)
 *  - Location active → ?locationId (server expands to the location's child RCs)
 *  - All active      → nothing (unscoped — unchanged behavior)
 *
 * Mirrors the server-side scopeWhereFromParams contract in src/lib/rc-scope.ts.
 */
export function setScopeParams(
  params: URLSearchParams,
  scope: {
    activeKind: 'all' | 'location' | 'rc'
    activeRcId: string | null
    activeRc: { isDefault?: boolean } | null
    activeLocationId: string | null
  },
): void {
  if (scope.activeKind === 'rc' && scope.activeRcId) {
    params.set('rcId', scope.activeRcId)
    if (scope.activeRc?.isDefault) params.set('isDefault', 'true')
  } else if (scope.activeKind === 'location' && scope.activeLocationId) {
    params.set('locationId', scope.activeLocationId)
  }
}
