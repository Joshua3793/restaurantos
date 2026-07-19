import { getTheoreticalStockMap } from './count-expected'

/**
 * Short-lived cache around `getTheoreticalStockMap` — the expensive movement-history
 * scan that powers the prep list, the drawer, and the live cost-chrome strip on every
 * page. Recomputing it on every read was the dominant source of "the app feels slow".
 *
 * Trade-off: theoretical stock is already an *estimate*, so a few seconds of staleness
 * is acceptable. Entries expire after `TTL_MS`; stock-moving mutations (count finalize,
 * invoice approve, prep done, wastage, transfers) should call `invalidateTheoreticalCache`
 * to drop the cache immediately within the current server instance. Across serverless
 * instances the TTL is the backstop.
 *
 * The cached Map is returned by reference — callers only ever *read* it (`.get`), never
 * mutate it, so sharing the instance is safe.
 */

const TTL_MS = 30_000

interface Entry {
  map: Map<string, number>
  expires: number
}

const cache = new Map<string, Entry>()

function keyFor(
  rcId: string | null | undefined,
  itemIds?: string[],
  allowedRcIds?: Set<string> | null,
): string {
  const rc = rcId ?? 'ALL'
  const ids = itemIds ? [...itemIds].sort().join(',') : 'ALL'
  const allowed = allowedRcIds ? [...allowedRcIds].sort().join(',') : ''
  return `${rc}|${allowed}|${ids}`
}

export async function getTheoreticalStockMapCached(
  rcId: string | null | undefined,
  itemIds?: string[],
  allowedRcIds?: Set<string> | null,
): Promise<Map<string, number>> {
  const key = keyFor(rcId, itemIds, allowedRcIds)
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.map

  const map = await getTheoreticalStockMap(rcId, itemIds, allowedRcIds)
  cache.set(key, { map, expires: now + TTL_MS })
  return map
}

/** Drop all cached theoretical maps — call after any mutation that moves stock. */
export function invalidateTheoreticalCache(): void {
  cache.clear()
}
