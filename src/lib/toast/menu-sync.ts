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
}

export interface RCDiscoveryResult {
  discovered: DiscoveredRC[]
  /** All app revenue centers (mapping targets). */
  revenueCenters: { id: string; name: string }[]
  windowDays: number
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

  const [maps, rcs] = await Promise.all([
    prisma.toastRevenueCenterMap.findMany({
      include: { revenueCenter: { select: { id: true, name: true } } },
    }),
    prisma.revenueCenter.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const discovered: DiscoveredRC[] = maps
    .map((m) => ({
      toastGuid: m.toastGuid,
      orderCount: counts.get(m.toastGuid) ?? m.orderCountSeen,
      mappedTo: m.revenueCenter ? { id: m.revenueCenter.id, name: m.revenueCenter.name } : null,
    }))
    .sort((a, b) => b.orderCount - a.orderCount)

  return { discovered, revenueCenters: rcs, windowDays }
}

/**
 * Fast read of persisted RC mappings (no Toast sweep) — for page loads. Use
 * `discoverRevenueCenters` to refresh order counts / pick up new GUIDs.
 */
export async function listRevenueCenterMappings(): Promise<RCDiscoveryResult> {
  const [maps, rcs] = await Promise.all([
    prisma.toastRevenueCenterMap.findMany({
      include: { revenueCenter: { select: { id: true, name: true } } },
    }),
    prisma.revenueCenter.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ])
  const discovered: DiscoveredRC[] = maps
    .map((m) => ({
      toastGuid: m.toastGuid,
      orderCount: m.orderCountSeen,
      mappedTo: m.revenueCenter ? { id: m.revenueCenter.id, name: m.revenueCenter.name } : null,
    }))
    .sort((a, b) => b.orderCount - a.orderCount)
  return { discovered, revenueCenters: rcs, windowDays: 0 }
}

/**
 * Map (or clear) Toast revenue-center GUIDs → app RevenueCenter via
 * `ToastRevenueCenterMap`. Many GUIDs may point at one RevenueCenter.
 * `revenueCenterId: null` clears that GUID's mapping (keeps the discovery row).
 */
export async function setRevenueCenterMappings(
  mappings: { toastGuid: string; revenueCenterId: string | null }[],
): Promise<void> {
  await prisma.$transaction(
    mappings.map((m) =>
      prisma.toastRevenueCenterMap.upsert({
        where: { toastGuid: m.toastGuid },
        update: { revenueCenterId: m.revenueCenterId },
        create: { toastGuid: m.toastGuid, revenueCenterId: m.revenueCenterId },
      }),
    ),
  )
}
