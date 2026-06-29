/**
 * Toast menu sync + revenue-center discovery.
 *
 * Menu sync: pull the published Menus API, upsert one `ToastItemMap` row per menu
 * item (GUID identity + name + group + menu). `recipeId` stays null until an admin
 * maps it. Idempotent — safe to re-run; gate on `metadata.lastUpdated` to skip
 * no-op pulls.
 *
 * RC discovery: the Config `revenueCenters` endpoint is 403 for our access, so the
 * only source of revenue-center GUIDs is order traffic. We sweep recent orders for
 * distinct `revenueCenter.guid` values and cross-reference `RevenueCenter.toastGuid`
 * so an admin can label the (≈2) unmapped GUIDs as CAFE / Catering.
 */

import { prisma } from '@/lib/prisma'
import {
  fetchMenus,
  fetchMenuMetadata,
  flattenMenuItems,
  fetchOrdersByModifiedWindow,
  type FlatMenuItem,
} from '@/lib/toast/client'
import { classifyGroup } from '@/lib/toast/food-classify'
import { MENU_ROUTE_PREFIX } from '@/lib/toast/sales-sync'

export interface MenuSyncResult {
  lastUpdated?: string
  itemsSeen: number
  created: number
  updated: number
  menus: string[]
  groups: string[]
  /** Distinct group names whose food/non-food class fell back to a guess. */
  unknownGroups: string[]
}

/**
 * Pull the published menu and upsert `ToastItemMap` rows. Returns a summary.
 * Pass `force=false` to skip when `metadata.lastUpdated` hasn't changed since the
 * given marker (caller supplies the last-synced marker).
 */
export async function syncToastMenu(): Promise<MenuSyncResult> {
  const menus = await fetchMenus()
  const items = flattenMenuItems(menus)

  // Dedupe by GUID (an item can appear in more than one menu; first wins).
  const byGuid = new Map<string, FlatMenuItem>()
  for (const it of items) if (!byGuid.has(it.guid)) byGuid.set(it.guid, it)

  const existing = await prisma.toastItemMap.findMany({
    where: { toastItemGuid: { in: [...byGuid.keys()] } },
    select: { toastItemGuid: true },
  })
  const existingGuids = new Set(existing.map((e) => e.toastItemGuid))

  let created = 0
  let updated = 0
  const unknownGroups = new Set<string>()

  // Chunk the upserts to keep pool pressure reasonable.
  const all = [...byGuid.values()]
  const CHUNK = 25
  for (let i = 0; i < all.length; i += CHUNK) {
    const chunk = all.slice(i, i + CHUNK)
    await Promise.all(
      chunk.map((it) => {
        const cls = classifyGroup(it.group)
        if (!cls.known && !cls.ignore) unknownGroups.add(it.group)
        const isNew = !existingGuids.has(it.guid)
        if (isNew) created++
        else updated++
        return prisma.toastItemMap.upsert({
          where: { toastItemGuid: it.guid },
          // Never touch recipeId on update — preserves admin mappings.
          update: {
            toastName: it.name,
            toastGroup: it.group,
            toastMenu: it.menu,
            lastSeenAt: new Date(),
          },
          create: {
            toastItemGuid: it.guid,
            toastName: it.name,
            toastGroup: it.group,
            toastMenu: it.menu,
          },
        })
      }),
    )
  }

  return {
    lastUpdated: menus.lastUpdated,
    itemsSeen: byGuid.size,
    created,
    updated,
    menus: [...new Set(items.map((i) => i.menu))],
    groups: [...new Set(items.map((i) => i.group))],
    unknownGroups: [...unknownGroups],
  }
}

/** Whether the published menu changed since a previously stored marker. */
export async function menuChangedSince(marker?: string | null): Promise<boolean> {
  if (!marker) return true
  const meta = await fetchMenuMetadata()
  return meta.lastUpdated !== marker
}

// ── Revenue-center discovery ─────────────────────────────────────────────────

export interface DiscoveredRC {
  toastGuid: string
  orderCount: number
  /** App RevenueCenter this GUID is mapped to, if any. */
  mappedTo: { id: string; name: string } | null
  /** Raw current target: which kind + which id (preserved across kinds). */
  revenueCenterId: string | null
  locationId: string | null
}

export interface RCDiscoveryLocation {
  id: string
  name: string
  defaultRevenueCenterId: string | null
  revenueCenters: { id: string; name: string; type: string }[]
}

export interface RCDiscoveryResult {
  discovered: DiscoveredRC[]
  /** All app revenue centers (flat list; back-compat for current consumers). */
  revenueCenters: { id: string; name: string }[]
  /** Locations as mapping targets, each grouping its leaf revenue centers. */
  locations: RCDiscoveryLocation[]
  windowDays: number
}

/** Shared: load flat RCs + location-grouped targets (mapping destinations). */
async function loadMappingTargets(): Promise<{
  revenueCenters: { id: string; name: string }[]
  locations: RCDiscoveryLocation[]
}> {
  const [rcs, locations] = await Promise.all([
    prisma.revenueCenter.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.location.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        defaultRevenueCenterId: true,
        revenueCenters: {
          where: { isActive: true },
          select: { id: true, name: true, type: true },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    }),
  ])
  return { revenueCenters: rcs, locations }
}

/**
 * Sweep recent orders for distinct revenue-center GUIDs, persist them to
 * `ToastRevenueCenterMap` (so the mapping UI keeps them even without a sweep),
 * and cross-reference current mappings. One paginated modified-window pull.
 * Default 14-day window; all 3 Fergie's RCs are active daily so this catches them.
 */
export async function discoverRevenueCenters(windowDays = 14): Promise<RCDiscoveryResult> {
  const end = new Date()
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000)
  const orders = await fetchOrdersByModifiedWindow(start, end)

  const counts = new Map<string, number>()
  for (const o of orders) {
    const guid = o.revenueCenter?.guid
    if (guid) counts.set(guid, (counts.get(guid) ?? 0) + 1)
  }

  // Persist discovered GUIDs (preserve any existing revenueCenterId mapping).
  await Promise.all(
    [...counts.entries()].map(([toastGuid, orderCountSeen]) =>
      prisma.toastRevenueCenterMap.upsert({
        where: { toastGuid },
        update: { orderCountSeen, lastSeenAt: new Date() },
        create: { toastGuid, orderCountSeen },
      }),
    ),
  )

  const [maps, targets] = await Promise.all([
    prisma.toastRevenueCenterMap.findMany({
      where: { NOT: { toastGuid: { startsWith: MENU_ROUTE_PREFIX } } },
      include: { revenueCenter: { select: { id: true, name: true } } },
    }),
    loadMappingTargets(),
  ])

  const discovered: DiscoveredRC[] = maps
    .map((m) => ({
      toastGuid: m.toastGuid,
      orderCount: counts.get(m.toastGuid) ?? m.orderCountSeen,
      mappedTo: m.revenueCenter ? { id: m.revenueCenter.id, name: m.revenueCenter.name } : null,
      revenueCenterId: m.revenueCenterId,
      locationId: m.locationId,
    }))
    .sort((a, b) => b.orderCount - a.orderCount)

  return { discovered, revenueCenters: targets.revenueCenters, locations: targets.locations, windowDays }
}

/**
 * Fast read of persisted RC mappings (no Toast sweep) — for page loads. Use
 * `discoverRevenueCenters` to refresh order counts / pick up new GUIDs.
 */
export async function listRevenueCenterMappings(): Promise<RCDiscoveryResult> {
  const [maps, targets] = await Promise.all([
    prisma.toastRevenueCenterMap.findMany({
      where: { NOT: { toastGuid: { startsWith: MENU_ROUTE_PREFIX } } },
      include: { revenueCenter: { select: { id: true, name: true } } },
    }),
    loadMappingTargets(),
  ])
  const discovered: DiscoveredRC[] = maps
    .map((m) => ({
      toastGuid: m.toastGuid,
      orderCount: m.orderCountSeen,
      mappedTo: m.revenueCenter ? { id: m.revenueCenter.id, name: m.revenueCenter.name } : null,
      revenueCenterId: m.revenueCenterId,
      locationId: m.locationId,
    }))
    .sort((a, b) => b.orderCount - a.orderCount)
  return { discovered, revenueCenters: targets.revenueCenters, locations: targets.locations, windowDays: 0 }
}

// ── Menu → revenue-center routing ────────────────────────────────────────────

export interface MenuRoutesResult {
  menus: { menu: string; revenueCenterId: string | null }[]
  revenueCenters: { id: string; name: string }[]
}

/** List distinct Toast menus (from ToastItemMap) + their current RC routing. */
export async function listMenuRoutes(): Promise<MenuRoutesResult> {
  const [items, routes, rcs] = await Promise.all([
    prisma.toastItemMap.findMany({ select: { toastMenu: true }, distinct: ['toastMenu'] }),
    prisma.toastRevenueCenterMap.findMany({ where: { toastGuid: { startsWith: MENU_ROUTE_PREFIX } } }),
    prisma.revenueCenter.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ])
  const byMenu = new Map(routes.map((r) => [r.toastGuid.slice(MENU_ROUTE_PREFIX.length), r.revenueCenterId]))
  const menus = [...new Set(items.map((i) => i.toastMenu).filter((m): m is string => !!m))]
    .filter((m) => !/toast tables|autogenerated/i.test(m)) // hide Toast scaffolding menu
    .sort()
    .map((menu) => ({ menu, revenueCenterId: byMenu.get(menu) ?? null }))
  return { menus, revenueCenters: rcs }
}

/** Set/clear the RC a Toast menu routes to (null clears → falls back to order RC). */
export async function setMenuRoutes(
  mappings: { menu: string; revenueCenterId: string | null }[],
): Promise<void> {
  await prisma.$transaction(
    mappings.map((m) =>
      prisma.toastRevenueCenterMap.upsert({
        where: { toastGuid: MENU_ROUTE_PREFIX + m.menu },
        update: { revenueCenterId: m.revenueCenterId },
        create: { toastGuid: MENU_ROUTE_PREFIX + m.menu, revenueCenterId: m.revenueCenterId },
      }),
    ),
  )
}

/**
 * Map (or clear) Toast revenue-center GUIDs → an app RevenueCenter OR a Location
 * via `ToastRevenueCenterMap`. A GUID targets EITHER a leaf RC OR a location OR
 * nothing (both null = cleared). Both columns are always set on persist so
 * switching target kind clears the other. Many GUIDs may point at one target.
 * Sync resolves a location target via the location's `defaultRevenueCenterId`.
 *
 * Validation: both-set rejected; unknown rc/location id rejected; `menu:`
 * sentinel rows must target a revenue center (a location target is rejected).
 */
export async function setRevenueCenterMappings(
  mappings: { toastGuid: string; revenueCenterId?: string | null; locationId?: string | null }[],
): Promise<void> {
  // Normalize + validate shape.
  const normalized = mappings.map((m) => ({
    toastGuid: m.toastGuid,
    revenueCenterId: m.revenueCenterId ?? null,
    locationId: m.locationId ?? null,
  }))

  for (const m of normalized) {
    if (m.revenueCenterId && m.locationId) {
      throw new Error('a mapping targets either a revenue center or a location, not both')
    }
    if (m.locationId && m.toastGuid.startsWith(MENU_ROUTE_PREFIX)) {
      throw new Error('menu routes must target a revenue center, not a location')
    }
  }

  // Validate referenced ids exist.
  const rcIds = [...new Set(normalized.map((m) => m.revenueCenterId).filter((v): v is string => !!v))]
  const locIds = [...new Set(normalized.map((m) => m.locationId).filter((v): v is string => !!v))]
  const [foundRcs, foundLocs] = await Promise.all([
    rcIds.length
      ? prisma.revenueCenter.findMany({ where: { id: { in: rcIds } }, select: { id: true } })
      : Promise.resolve([]),
    locIds.length
      ? prisma.location.findMany({ where: { id: { in: locIds } }, select: { id: true } })
      : Promise.resolve([]),
  ])
  const foundRcSet = new Set(foundRcs.map((r) => r.id))
  const foundLocSet = new Set(foundLocs.map((l) => l.id))
  for (const id of rcIds) if (!foundRcSet.has(id)) throw new Error(`unknown revenue center: ${id}`)
  for (const id of locIds) if (!foundLocSet.has(id)) throw new Error(`unknown location: ${id}`)

  await prisma.$transaction(
    normalized.map((m) =>
      prisma.toastRevenueCenterMap.upsert({
        where: { toastGuid: m.toastGuid },
        // Set BOTH columns so switching target kind clears the stale one.
        update: { revenueCenterId: m.revenueCenterId, locationId: m.locationId },
        create: { toastGuid: m.toastGuid, revenueCenterId: m.revenueCenterId, locationId: m.locationId },
      }),
    ),
  )
}
