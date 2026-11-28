// A waste entry as GET/POST /api/wastage return it. Decimals arrive as strings;
// `costImpact` is null below MANAGER (src/app/api/wastage/rules.ts).
export interface WasteLogRow {
  id: string
  date: string
  inventoryItemId: string
  inventoryItem: { id?: string; itemName: string; category: string; baseUnit: string }
  qtyWasted: number | string
  unit: string
  reason: string
  costImpact: number | string | null
  loggedBy: string
  notes: string | null
  /** Optional photo (an UploadThing file link), or null. */
  photoUrl?: string | null
  /** This viewer may delete it (their own, within 24 h — or MANAGER+). */
  canDelete?: boolean
}

export interface WasteDraft {
  inventoryItemId: string
  qtyWasted: string
  unit: string
  reason: string
  notes: string
  date?: string
  /** Only a photo that already uploaded; null/absent = none. */
  photoUrl?: string | null
}

/** What a save hands back to the form: the saved row, or the reason it failed. */
export type SaveResult = { ok: true; log: WasteLogRow } | { ok: false; error: string }
