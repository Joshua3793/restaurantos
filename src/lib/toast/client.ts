/**
 * Toast POS API client — foundation for the sales sync.
 *
 * Auth model: OAuth2 client-credentials ("machine client"). We POST clientId +
 * clientSecret to the authentication API and get a short-lived Bearer token,
 * cached in-process and refreshed on expiry or any 401. Every data request also
 * carries a `Toast-Restaurant-External-ID` header naming the restaurant GUID.
 *
 * Access is Standard API (read-only). We only ever GET.
 *
 * Structure of THIS restaurant: a single Toast restaurant whose orders carry an
 * internal `revenueCenter.guid` (CAFE / Catering). We sync once per night and
 * split downstream by that GUID → app `RevenueCenter.toastGuid`.
 *
 * Docs: https://doc.toasttab.com/doc/devguide/authentication.html
 *       https://doc.toasttab.com/doc/devguide/apiOrdersGetDetailedInfoAboutMultipleOrders.html
 */

import fs from 'fs'
import path from 'path'

// ── Config / env ─────────────────────────────────────────────────────────────

const DEFAULT_HOST = 'https://ws-api.toasttab.com'

// Claude Code's shell sometimes exports VAR="" which dotenv won't override.
// Mirror invoice-ocr.ts: fall back to reading .env directly so local dev works.
function resolveEnv(key: string): string {
  if (process.env[key]) return process.env[key] as string
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf-8')
    const m = raw.match(new RegExp(`^${key}=["']?([^"'\\r\\n]+)["']?`, 'm'))
    return m?.[1] ?? ''
  } catch {
    return ''
  }
}

export interface ToastCredentials {
  host: string
  clientId: string
  clientSecret: string
  restaurantGuid: string
}

/** Reads + validates Toast credentials from the environment. Throws if any are missing. */
export function getToastCredentials(): ToastCredentials {
  const creds: ToastCredentials = {
    host: resolveEnv('TOAST_API_HOST') || DEFAULT_HOST,
    clientId: resolveEnv('TOAST_CLIENT_ID'),
    clientSecret: resolveEnv('TOAST_CLIENT_SECRET'),
    restaurantGuid: resolveEnv('TOAST_RESTAURANT_GUID'),
  }
  const ENV_NAMES: Record<keyof ToastCredentials, string> = {
    host: 'TOAST_API_HOST',
    clientId: 'TOAST_CLIENT_ID',
    clientSecret: 'TOAST_CLIENT_SECRET',
    restaurantGuid: 'TOAST_RESTAURANT_GUID',
  }
  const missing = (['clientId', 'clientSecret', 'restaurantGuid'] as const).filter(
    (k) => !creds[k],
  )
  if (missing.length) {
    throw new ToastError(
      `Missing Toast credentials in env: ${missing.map((k) => ENV_NAMES[k]).join(', ')}`,
    )
  }
  return creds
}

export class ToastError extends Error {
  status?: number
  body?: string
  constructor(message: string, status?: number, body?: string) {
    super(message)
    this.name = 'ToastError'
    this.status = status
    this.body = body
  }
}

// ── Token cache ──────────────────────────────────────────────────────────────

interface CachedToken {
  accessToken: string
  expiresAt: number // epoch ms
}
let tokenCache: CachedToken | null = null

// Toast's auth response reports expiresIn as 86400 but the token is honoured for
// ~1h in practice. Cap our cached lifetime conservatively and lean on 401-refresh
// as the real safety net.
const MAX_TOKEN_TTL_MS = 50 * 60 * 1000 // 50 min
const TOKEN_SKEW_MS = 60 * 1000 // refresh 1 min early

interface ToastAuthResponse {
  token?: { accessToken?: string; expiresIn?: number; tokenType?: string }
}

async function fetchToken(creds: ToastCredentials): Promise<CachedToken> {
  const res = await fetch(`${creds.host}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      userAccessType: 'TOAST_MACHINE_CLIENT',
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ToastError(`Toast auth failed (${res.status})`, res.status, body)
  }
  const json = (await res.json()) as ToastAuthResponse
  const accessToken = json.token?.accessToken
  if (!accessToken) {
    throw new ToastError('Toast auth response had no accessToken', res.status)
  }
  const ttlMs = Math.min((json.token?.expiresIn ?? 3600) * 1000, MAX_TOKEN_TTL_MS)
  return { accessToken, expiresAt: Date.now() + ttlMs - TOKEN_SKEW_MS }
}

async function getToken(creds: ToastCredentials, force = false): Promise<string> {
  if (!force && tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken
  }
  tokenCache = await fetchToken(creds)
  return tokenCache.accessToken
}

// ── Rate limiting ────────────────────────────────────────────────────────────

// Toast caps ordersBulk polling at 5 req/location/sec. Keep a comfortable margin.
const MIN_REQUEST_INTERVAL_MS = 250
let lastRequestAt = 0
async function throttle() {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
}

// ── Core GET ─────────────────────────────────────────────────────────────────

/**
 * Authenticated GET against the Toast API. Adds the Bearer token and the
 * restaurant header, throttles, refreshes the token once on 401, and backs off
 * once on 429. Returns the parsed JSON body.
 */
export async function toastGet<T = unknown>(
  apiPath: string,
  params?: Record<string, string | number | undefined>,
  creds: ToastCredentials = getToastCredentials(),
): Promise<T> {
  const url = new URL(creds.host + apiPath)
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }

  const doFetch = async (token: string) => {
    await throttle()
    return fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        'Toast-Restaurant-External-ID': creds.restaurantGuid,
        Accept: 'application/json',
      },
    })
  }

  let token = await getToken(creds)
  let res = await doFetch(token)

  // Token expired mid-stream → refresh once and retry.
  if (res.status === 401) {
    token = await getToken(creds, true)
    res = await doFetch(token)
  }

  // Rate limited → honour Retry-After (or 1s) and retry once.
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After')) || 1
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
    res = await doFetch(token)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ToastError(`Toast GET ${apiPath} failed (${res.status})`, res.status, body)
  }
  return (await res.json()) as T
}

// ── Order types (subset we consume) ──────────────────────────────────────────
// Only the fields the sales sync reads. Toast objects are far larger; we keep
// this intentionally narrow so the shape we depend on is explicit.

export interface ToastRef {
  guid: string
  entityType?: string
  externalId?: string | null
}

export interface ToastSelection {
  guid: string
  item?: ToastRef // the menu item → maps to ToastItemMap.toastItemGuid
  itemGroup?: ToastRef // menu group → drives food/non-food split
  displayName?: string
  quantity?: number
  /** Final price after quantity + discounts, excluding tax. */
  price?: number
  /** Gross price reflecting quantity, before discounts. */
  preDiscountPrice?: number
  tax?: number
  selectionType?: string // e.g. NONE, HOUSE_ACCOUNT_PAY_BALANCE, COMBO
  voided?: boolean
  deferred?: boolean // gift cards etc.
}

export interface ToastCheck {
  guid: string
  /** Total incl. discounts + service charges, excluding gratuity + tax. Net-sales basis. */
  amount?: number
  taxAmount?: number
  totalAmount?: number
  voided?: boolean
  deleted?: boolean
  selections?: ToastSelection[]
}

export interface ToastOrder {
  guid: string
  /** yyyymmdd integer — the date the order was fulfilled. */
  businessDate?: number
  openedDate?: string
  closedDate?: string
  voided?: boolean
  deleted?: boolean
  excessFood?: boolean
  guestCount?: number
  revenueCenter?: ToastRef // internal CAFE/Catering → RevenueCenter.toastGuid
  diningOption?: ToastRef
  checks?: ToastCheck[]
}

// ── ordersBulk ───────────────────────────────────────────────────────────────

const MAX_PAGE_SIZE = 100

/**
 * Pull every order for one business day, following pagination to the end.
 * `businessDate` is a Date (we format to yyyymmdd in the restaurant's terms —
 * callers should pass the intended business day).
 */
export async function fetchOrdersForBusinessDate(
  businessDate: Date,
  creds: ToastCredentials = getToastCredentials(),
): Promise<ToastOrder[]> {
  const yyyymmdd =
    businessDate.getFullYear() * 10000 +
    (businessDate.getMonth() + 1) * 100 +
    businessDate.getDate()
  return fetchOrdersForBusinessDateInt(yyyymmdd, creds)
}

/**
 * Pull every order for a business day given as a yyyymmdd integer (restaurant-
 * local calendar day). Prefer this in the cron, which must compute the LA-local
 * day itself rather than rely on the server's (UTC) clock.
 */
export async function fetchOrdersForBusinessDateInt(
  yyyymmdd: number,
  creds: ToastCredentials = getToastCredentials(),
): Promise<ToastOrder[]> {
  return fetchAllOrderPages({ businessDate: yyyymmdd }, creds)
}

/**
 * Pull every order modified within an ISO time window (better for catching late
 * voids/edits than businessDate, which is creation-only).
 */
export async function fetchOrdersByModifiedWindow(
  startDate: Date,
  endDate: Date,
  creds: ToastCredentials = getToastCredentials(),
): Promise<ToastOrder[]> {
  return fetchAllOrderPages(
    { startDate: startDate.toISOString(), endDate: endDate.toISOString() },
    creds,
  )
}

async function fetchAllOrderPages(
  query: Record<string, string | number>,
  creds: ToastCredentials,
): Promise<ToastOrder[]> {
  const out: ToastOrder[] = []
  for (let page = 1; ; page++) {
    const batch = await toastGet<ToastOrder[]>(
      '/orders/v2/ordersBulk',
      { ...query, page, pageSize: MAX_PAGE_SIZE },
      creds,
    )
    if (!Array.isArray(batch) || batch.length === 0) break
    out.push(...batch)
    if (batch.length < MAX_PAGE_SIZE) break // last (partial) page
  }
  return out
}

// ── Menus API (published) ────────────────────────────────────────────────────
// Used in place of the (403) Config API to learn item GUIDs + names + structure.

export interface ToastMenuItem {
  guid: string
  name?: string
  multiLocationId?: string
}

export interface ToastMenuGroup {
  guid: string
  name?: string
  menuItems?: ToastMenuItem[]
  menuGroups?: ToastMenuGroup[] // groups can nest
}

export interface ToastMenu {
  guid: string
  name?: string
  menuGroups?: ToastMenuGroup[]
}

export interface ToastMenusResponse {
  restaurantGuid?: string
  lastUpdated?: string
  restaurantTimeZone?: string
  menus?: ToastMenu[]
}

export interface ToastMenuMetadata {
  restaurantGuid?: string
  lastUpdated?: string
}

/** Full published-menu tree (menus → groups → items). */
export async function fetchMenus(
  creds: ToastCredentials = getToastCredentials(),
): Promise<ToastMenusResponse> {
  return toastGet<ToastMenusResponse>('/menus/v2/menus', undefined, creds)
}

/** Cheap `lastUpdated` probe — gate a full menu re-pull on whether this changed. */
export async function fetchMenuMetadata(
  creds: ToastCredentials = getToastCredentials(),
): Promise<ToastMenuMetadata> {
  return toastGet<ToastMenuMetadata>('/menus/v2/metadata', undefined, creds)
}

/** Flattened menu item with its group + top-level menu names (groups may nest). */
export interface FlatMenuItem {
  guid: string
  name: string
  group: string
  menu: string
}

/** Walk the menu tree into a flat item list, carrying the nearest group + menu name. */
export function flattenMenuItems(menus: ToastMenusResponse): FlatMenuItem[] {
  const out: FlatMenuItem[] = []
  const walkGroup = (grp: ToastMenuGroup, menuName: string, groupName: string) => {
    const name = grp.name || groupName
    for (const it of grp.menuItems ?? []) {
      out.push({ guid: it.guid, name: it.name ?? '', group: name, menu: menuName })
    }
    for (const sub of grp.menuGroups ?? []) walkGroup(sub, menuName, name)
  }
  for (const menu of menus.menus ?? []) {
    const menuName = menu.name ?? ''
    for (const grp of menu.menuGroups ?? []) walkGroup(grp, menuName, menuName)
  }
  return out
}

// ── Connection test ──────────────────────────────────────────────────────────

interface ToastRestaurantInfo {
  general?: { name?: string; locationName?: string; timeZone?: string }
}

export interface ToastConnectionTest {
  ok: boolean
  restaurantName?: string
  timeZone?: string
  sampleBusinessDate: number
  sampleOrderCount: number
  error?: string
}

/**
 * Verifies the credentials end-to-end: authenticates, reads restaurant info
 * (confirms the GUID + header), and counts yesterday's orders (confirms
 * ordersBulk access + the data shape). Cheap, read-only, safe to call anytime.
 */
export async function testConnection(): Promise<ToastConnectionTest> {
  const creds = getToastCredentials()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const sampleBusinessDate =
    yesterday.getFullYear() * 10000 +
    (yesterday.getMonth() + 1) * 100 +
    yesterday.getDate()

  try {
    const info = await toastGet<ToastRestaurantInfo>(
      `/restaurants/v1/restaurants/${creds.restaurantGuid}`,
      undefined,
      creds,
    )
    const orders = await fetchOrdersForBusinessDate(yesterday, creds)
    return {
      ok: true,
      restaurantName: info.general?.name ?? info.general?.locationName,
      timeZone: info.general?.timeZone,
      sampleBusinessDate,
      sampleOrderCount: orders.length,
    }
  } catch (e) {
    return {
      ok: false,
      sampleBusinessDate,
      sampleOrderCount: 0,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
