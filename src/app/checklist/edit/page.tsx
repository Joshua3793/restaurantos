'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Role } from '@prisma/client'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { useToast } from '@/components/Toast'
import { atLeast } from '@/lib/roles'
import type { Phase } from '@/lib/checklists/rules'
import type { ItemData } from '@/lib/checklists/item-input'
import {
  chipName, chipOrder, moveId, phaseCount,
  type CategoryTree, type EditItem, type EditStation, type EditView,
} from '@/lib/checklists/edit-format'
import { StationChips } from '@/components/checklists/edit/StationChips'
import { CategoryCard } from '@/components/checklists/edit/CategoryCard'
import { ItemSheet } from '@/components/checklists/edit/ItemSheet'
import { CategorySheet, CopySheet, StationSheet } from '@/components/checklists/edit/EditSheets'

// /checklist/edit — MANAGER+ editor for each station's opening and closing list:
// stations, categories and jobs. Changes apply from the next shift; a list a
// cook has already opened keeps its snapshot. Mobile first, capped at 640 px.

type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

async function call<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, status: res.status, error: (data && typeof data.error === 'string' && data.error) || 'Could not save — try again.' }
    return { ok: true, data: data as T }
  } catch {
    return { ok: false, status: 0, error: 'No connection — try again.' }
  }
}

const send = <T,>(url: string, method: string, body?: unknown) =>
  call<T>(url, { method, body: body === undefined ? undefined : JSON.stringify(body) })

type SheetState =
  | { kind: 'item'; item: EditItem | null; categoryId: string }
  | { kind: 'category'; category: CategoryTree | null }
  | { kind: 'station'; station: EditStation | null }
  | { kind: 'copy' }
  | null

/** The view with one station's category list for a phase replaced. */
function withCats(view: EditView, stationId: string, phase: Phase, fn: (cats: CategoryTree[]) => CategoryTree[]): EditView {
  return {
    ...view,
    stations: view.stations.map(s => (s.id === stationId ? { ...s, phases: { ...s.phases, [phase]: fn(s.phases[phase]) } } : s)),
  }
}

/** Reorder `list` to follow `ids`. */
const byIds = <T extends { id: string }>(list: T[], ids: string[]) =>
  ids.map(id => list.find(x => x.id === id)).filter((x): x is T => !!x)

export default function ChecklistEditPage() {
  const { activeRcId, ready } = useRc()
  const { role } = useUser()
  const toast = useToast()

  const [view, setView] = useState<EditView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [stationId, setStationId] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('OPEN')
  const [sheet, setSheet] = useState<SheetState>(null)

  const allowed = !role || atLeast(role as Role, 'MANAGER')

  // Only the latest kitchen's reply may land.
  const rcRef = useRef(activeRcId)
  rcRef.current = activeRcId

  const load = useCallback(async () => {
    const rc = activeRcId
    if (!rc) return
    const r = await call<EditView>(`/api/checklists/stations?rcId=${encodeURIComponent(rc)}`)
    if (rcRef.current !== rc) return
    if (!r.ok) { setLoadError(r.error); return }
    setLoadError(null)
    setView(r.data)
  }, [activeRcId])

  useEffect(() => {
    if (!ready || !allowed) return
    setView(null)
    setLoadError(null)
    setStationId(null)
    setSheet(null)
    if (activeRcId) load()
  }, [ready, allowed, activeRcId, load])

  const ordered = view ? chipOrder(view.stations) : []
  // Default to the first real station (the board's own example opens on Grill).
  const station = ordered.find(s => s.id === stationId) ?? ordered.find(s => !s.isShared) ?? ordered[0] ?? null
  const cats = station ? station.phases[phase] : []
  const unitName = (id: string | null) => (id ? view?.tempUnits.find(u => u.id === id)?.name ?? null : null)
  const meta = station ? `${chipName(station).toUpperCase()} · ${phase === 'OPEN' ? 'OPENING' : 'CLOSING'}` : ''

  const showError = (msg: string) => toast.show({ type: 'error', title: msg })

  // ── Writes: each reloads the editor on success and hands the message back on failure ──

  const write = async (url: string, method: string, body?: unknown): Promise<string | null> => {
    const r = await send<unknown>(url, method, body)
    if (!r.ok) return r.error
    await load()
    return null
  }

  const reorder = async (kind: 'category' | 'item', ids: string[], apply: (v: EditView) => EditView) => {
    if (!view) return
    setView(apply(view))
    const r = await send<unknown>('/api/checklists/reorder', 'POST', { kind, ids })
    if (!r.ok) { showError(r.error); load() }
  }

  const moveCategory = (index: number, dir: -1 | 1) => {
    if (!station) return
    const ids = moveId(cats.map(c => c.id), index, dir)
    reorder('category', ids, v => withCats(v, station.id, phase, list => byIds(list, ids)))
  }

  const moveItem = (cat: CategoryTree, index: number, dir: -1 | 1) => {
    if (!station) return
    const ids = moveId(cat.items.map(i => i.id), index, dir)
    reorder('item', ids, v => withCats(v, station.id, phase, list =>
      list.map(c => (c.id === cat.id ? { ...c, items: byIds(c.items, ids) } : c))))
  }

  const saveStation = async (target: EditStation | null, name: string, color: string) => {
    if (target) return write(`/api/checklists/stations/${target.id}`, 'PATCH', { name, color })
    const r = await send<{ station: EditStation }>('/api/checklists/stations', 'POST', { rcId: activeRcId, name, color })
    if (!r.ok) return r.error
    setStationId(r.data.station.id)
    await load()
    return null
  }

  const copyFrom = async (fromId: string) => {
    if (!station) return 'Pick a station first'
    const r = await send<{ categories: number; items: number }>('/api/checklists/copy', 'POST', {
      fromStationId: fromId, toStationId: station.id, phase,
    })
    if (!r.ok) return r.error
    const { categories: c, items: i } = r.data
    toast.show({ type: 'success', title: `Copied ${c} ${c === 1 ? 'category' : 'categories'} and ${i} ${i === 1 ? 'job' : 'jobs'}` })
    await load()
    return null
  }

  const saveItem = (item: EditItem | null, data: ItemData) =>
    item ? write(`/api/checklists/items/${item.id}`, 'PATCH', data) : write('/api/checklists/items', 'POST', data)

  // ── Render ─────────────────────────────────────────────────────────────

  const shell = (body: React.ReactNode) => (
    <div className="max-w-[640px] mx-auto w-full flex flex-col gap-3.5 pb-6">
      <header className="flex items-center justify-between">
        <Link href="/checklist/today" className="text-[13px] text-ink-3 min-h-[44px] inline-flex items-center">‹ Today</Link>
        <button
          type="button"
          disabled={!station || station.isShared}
          title={station?.isShared ? 'The whole-kitchen list can’t copy from a station' : undefined}
          onClick={() => setSheet({ kind: 'copy' })}
          className="min-h-[44px] px-3 rounded-[9px] border border-line-2 bg-paper text-[13px] text-ink-2 disabled:opacity-40"
        >
          Copy from…
        </button>
      </header>
      <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">Checklists</h1>
      {body}
    </div>
  )

  const panel = (text: React.ReactNode) => (
    <div className="bg-paper border border-line rounded-[14px] p-4 text-[14px] text-ink-3">{text}</div>
  )

  if (!allowed) return shell(panel('Editing checklists is for managers.'))
  if (!ready || (activeRcId && !view && !loadError)) return shell(panel('Loading…'))
  if (!activeRcId) return shell(panel('Pick a kitchen in the top bar to edit its checklists.'))
  if (!view) {
    return shell(
      <div className="bg-paper border border-line rounded-[14px] p-4 flex flex-col gap-3">
        <p className="m-0 text-[14px] text-red-text">{loadError}</p>
        <button type="button" onClick={load} className="self-start min-h-[44px] px-4 rounded-[10px] border border-line-2 text-[13px] font-medium text-ink-2">Try again</button>
      </div>,
    )
  }

  return shell(
    <>
      <StationChips
        stations={ordered}
        selectedId={station?.id ?? null}
        onSelect={setStationId}
        onEdit={s => setSheet({ kind: 'station', station: s })}
        onAdd={() => setSheet({ kind: 'station', station: null })}
      />

      {!station ? panel('No stations yet. Tap “+ Station” to add one.') : (
        <>
          <div className="flex bg-bg-2 rounded-full p-[3px] self-start" role="group" aria-label="Opening or closing">
            {(['OPEN', 'CLOSE'] as Phase[]).map(p => (
              <button
                key={p}
                type="button"
                aria-pressed={phase === p}
                onClick={() => setPhase(p)}
                className={`rounded-full font-mono text-[11px] font-medium px-4 min-h-[44px] ${phase === p ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3'}`}
              >
                {p === 'OPEN' ? 'Opening' : 'Closing'} · {phaseCount(station, p)}
              </button>
            ))}
          </div>

          <p className="m-0 text-[13px] leading-[1.45] text-ink-3">
            Changes start on the next shift. Lists already started keep what they had, so history stays true.
          </p>

          {cats.length === 0 && panel(`${chipName(station)} has nothing on its ${phase === 'OPEN' ? 'opening' : 'closing'} list yet. Add a category, or copy one from another station.`)}

          {cats.map((c, i) => (
            <CategoryCard
              key={c.id}
              category={c}
              phase={phase}
              first={i === 0}
              last={i === cats.length - 1}
              tempUnitName={unitName}
              onMove={dir => moveCategory(i, dir)}
              onEdit={() => setSheet({ kind: 'category', category: c })}
              onMoveItem={(idx, dir) => moveItem(c, idx, dir)}
              onOpenItem={it => setSheet({ kind: 'item', item: it, categoryId: c.id })}
              onAddItem={() => setSheet({ kind: 'item', item: null, categoryId: c.id })}
            />
          ))}

          <button
            type="button"
            onClick={() => setSheet({ kind: 'category', category: null })}
            className="min-h-[50px] rounded-xl border border-dashed border-line-2 text-[14px] font-medium text-ink-2"
          >
            + Add category
          </button>
        </>
      )}

      {sheet?.kind === 'item' && station && (
        <ItemSheet
          key={sheet.item?.id ?? `new-${sheet.categoryId}`}
          item={sheet.item}
          categoryId={sheet.categoryId}
          categories={cats}
          tempUnits={view.tempUnits}
          phase={phase}
          meta={meta}
          onClose={() => setSheet(null)}
          onSave={data => saveItem(sheet.item, data)}
          onRemove={() => (sheet.item ? write(`/api/checklists/items/${sheet.item.id}`, 'DELETE') : Promise.resolve(null))}
        />
      )}
      {sheet?.kind === 'category' && station && (
        <CategorySheet
          category={sheet.category}
          meta={meta}
          onClose={() => setSheet(null)}
          onSave={name => (sheet.category
            ? write(`/api/checklists/categories/${sheet.category.id}`, 'PATCH', { name })
            : write('/api/checklists/categories', 'POST', { stationId: station.id, phase, name }))}
          onRemove={() => (sheet.category ? write(`/api/checklists/categories/${sheet.category.id}`, 'DELETE') : Promise.resolve(null))}
        />
      )}
      {sheet?.kind === 'station' && (
        <StationSheet
          station={sheet.station}
          onClose={() => setSheet(null)}
          onSave={(name, color) => saveStation(sheet.station, name, color)}
          onRemove={async () => {
            if (!sheet.station) return null
            const err = await write(`/api/checklists/stations/${sheet.station.id}`, 'DELETE')
            if (!err) setStationId(null)
            return err
          }}
        />
      )}
      {sheet?.kind === 'copy' && station && (
        <CopySheet target={station} stations={ordered} phase={phase} onClose={() => setSheet(null)} onCopy={copyFrom} />
      )}
    </>,
  )
}
