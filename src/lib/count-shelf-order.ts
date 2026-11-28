// Count in shelf order — the walk a cook takes through the walk-in.
//
// Items sort by storage area (A–Z by name; no area last), then by their
// position on that area's shelf walk (`InventoryItem.shelfOrder`; null = not
// placed yet → after every placed item), then A–Z by name. Pure: used by the
// count-session create route (line sortOrder) and the count page (live sort,
// so open sessions follow a walk set after they were started).

export interface ShelfSortable {
  areaName: string | null | undefined
  shelfOrder: number | null | undefined
  name: string
}

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' })

export function compareShelfOrder(a: ShelfSortable, b: ShelfSortable): number {
  const aa = a.areaName ?? null
  const ba = b.areaName ?? null
  if (aa !== ba) {
    if (aa === null) return 1
    if (ba === null) return -1
    const c = byText(aa, ba)
    if (c !== 0) return c
  }
  const ao = a.shelfOrder ?? null
  const bo = b.shelfOrder ?? null
  if (ao !== bo) {
    if (ao === null) return 1
    if (bo === null) return -1
    return ao - bo
  }
  return byText(a.name, b.name)
}

/** Returns a sorted copy of `items` in shelf-walk order. */
export function sortByShelf<T>(items: T[], key: (t: T) => ShelfSortable): T[] {
  return items
    .map(t => ({ t, k: key(t) }))
    .sort((x, y) => compareShelfOrder(x.k, y.k))
    .map(x => x.t)
}

export type ShelfOrderInput =
  | { ok: true; itemIds: string[] }
  | { ok: false; error: string }

/** Validates the body of PUT /api/storage-areas/[id]/shelf-order. */
export function parseShelfOrderBody(body: unknown): ShelfOrderInput {
  if (!body || typeof body !== 'object' || !('itemIds' in body)) {
    return { ok: false, error: 'itemIds is required.' }
  }
  const ids = (body as { itemIds: unknown }).itemIds
  if (!Array.isArray(ids)) return { ok: false, error: 'itemIds must be a list.' }
  if (ids.length > 2000) return { ok: false, error: 'Too many items.' }
  if (!ids.every(id => typeof id === 'string' && id.trim().length > 0)) {
    return { ok: false, error: 'Every item id must be text.' }
  }
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'An item appears twice.' }
  return { ok: true, itemIds: ids as string[] }
}
