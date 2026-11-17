'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Role } from '@prisma/client'
import { useRc } from '@/contexts/RevenueCenterContext'
import { useUser } from '@/contexts/UserContext'
import { useToast } from '@/components/Toast'
import { atLeast } from '@/lib/roles'
import { defaultPhase, dueText, type Phase } from '@/lib/checklists/rules'
import type { ItemData } from '@/lib/checklists/item-input'
import {
  chipName, chipOrder, moveId, phaseCount,
  type CategoryTree, type EditItem, type EditStation, type EditView,
} from '@/lib/checklists/edit-format'
import { linkStations, listsOf, phaseWord, readyBy, tidyUps, type TidyUp } from '@/lib/checklists/builder'
import { StationChips } from '@/components/checklists/edit/StationChips'
import { CategoryCard, type DragJob } from '@/components/checklists/edit/CategoryCard'
import { ItemForm, ItemSheet } from '@/components/checklists/edit/ItemSheet'
import { CategorySheet, CopySheet, Sheet, StationSheet } from '@/components/checklists/edit/EditSheets'
import { PreviewCard, StationRail, TidyUpBar } from '@/components/checklists/edit/BuilderParts'
import { ChecklistTabs } from '@/components/checklists/ChecklistTabs'

// /checklist/edit — MANAGER+ builder for each station's opening and closing
// list: stations, categories and jobs. Changes apply from the next shift; a list
// a cook has already opened keeps its snapshot.
//
// Phone: one list at a time (station chips, Opening/Closing toggle), jobs edit
// in a bottom sheet. Computer (lg+): lists on the left, Opening and Closing side
// by side, the job form and a cook preview on the right; jobs drag between
// categories and across the two halves of the day.

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
  | { kind: 'item'; itemId: string | null; categoryId: string; phase: Phase; draft?: string }
  | { kind: 'category'; category: CategoryTree | null; phase: Phase }
  | { kind: 'station'; station: EditStation | null }
  | { kind: 'copy'; phase: Phase }
  | { kind: 'preview' }
  | null

const PHASES: Phase[] = ['OPEN', 'CLOSE']
const DISMISS_KEY = 'checklist-builder-tidy-dismissed'

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

/** Where a job sits on a station: its category and phase. */
function locate(station: EditStation, itemId: string): { cat: CategoryTree; phase: Phase; item: EditItem } | null {
  for (const phase of PHASES) {
    for (const cat of station.phases[phase]) {
      const item = cat.items.find(i => i.id === itemId)
      if (item) return { cat, phase, item }
    }
  }
  return null
}

/** A job's saved fields as the save route reads them. */
const asData = (it: EditItem, categoryId: string): ItemData => ({
  title: it.title, howTo: it.howTo, isBlocker: it.isBlocker, answer: it.answer, unit: it.unit,
  safeMin: it.safeMin, safeMax: it.safeMax, tempUnitId: it.tempUnitId, days: it.days, dueBy: it.dueBy, categoryId,
})

function useWide(): boolean {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const on = () => setWide(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

function readDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

/** One half of the day for the selected station: its categories, then "+ Add category". */
function PhaseColumn({
  station, phase, className, children, onAddCategory, onCopy,
}: {
  station: EditStation
  phase: Phase
  className: string
  children: React.ReactNode
  onAddCategory: () => void
  /** null on the whole-kitchen list, which can't copy from a station. */
  onCopy: (() => void) | null
}) {
  const count = phaseCount(station, phase)
  const by = readyBy(station, phase)
  return (
    <div className={`flex-col gap-3 min-w-0 ${className}`}>
      <div className="hidden lg:flex items-center gap-2 pl-1">
        <h3 className="m-0 text-[15px] font-semibold">{phaseWord(phase)}</h3>
        <span className="flex-1 font-mono text-[10.5px] text-ink-3">
          {count} {count === 1 ? 'job' : 'jobs'}{by ? ` · ready by ${dueText(by)}` : ''}
        </span>
        {onCopy && (
          <button type="button" onClick={onCopy} className="min-h-[36px] px-2 font-mono text-[11px] text-ink-3 hover:text-ink">
            Copy from…
          </button>
        )}
      </div>
      {children}
      <button
        type="button"
        onClick={onAddCategory}
        className="min-h-[50px] rounded-xl border border-dashed border-line-2 text-[14px] font-medium text-ink-2"
      >
        + Add category
      </button>
    </div>
  )
}

export default function ChecklistEditPage() {
  const { activeRcId, ready } = useRc()
  const { role } = useUser()
  const toast = useToast()
  const wide = useWide()

  const [view, setView] = useState<EditView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [stationId, setStationId] = useState<string | null>(null)
  // Opens on the half of the day the clock is in, like the cook screen and the board.
  const [phase, setPhase] = useState<Phase>(() => defaultPhase())
  const [sheet, setSheet] = useState<SheetState>(null)
  const [drag, setDrag] = useState<DragJob>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())

  useEffect(() => { setDismissed(readDismissed()) }, [])

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

  const ordered = useMemo(() => (view ? chipOrder(view.stations) : []), [view])
  // Default to the first real station (the board's own example opens on Grill).
  const station = ordered.find(s => s.id === stationId) ?? ordered.find(s => !s.isShared) ?? ordered[0] ?? null
  const kitchenList = ordered.find(s => s.isShared) ?? null
  const unitName = (id: string | null) => (id ? view?.tempUnits.find(u => u.id === id)?.name ?? null : null)
  const metaFor = (p: Phase) => (station ? `${chipName(station).toUpperCase()} · ${p === 'OPEN' ? 'OPENING' : 'CLOSING'}` : '')
  const links = useMemo(() => ({
    OPEN: view ? linkStations(view, 'OPEN') : new Map<string, string[]>(),
    CLOSE: view ? linkStations(view, 'CLOSE') : new Map<string, string[]>(),
  }), [view])
  const tidy = useMemo(() => (view ? tidyUps(view, dismissed) : []), [view, dismissed])

  const showError = (msg: string) => toast.show({ type: 'error', title: msg })

  // ── Writes: each reloads the builder on success and hands the message back on failure ──

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

  const moveCategory = (p: Phase, index: number, dir: -1 | 1) => {
    if (!station) return
    const cats = station.phases[p]
    const ids = moveId(cats.map(c => c.id), index, dir)
    reorder('category', ids, v => withCats(v, station.id, p, list => byIds(list, ids)))
  }

  const moveItem = (p: Phase, cat: CategoryTree, index: number, dir: -1 | 1) => {
    if (!station) return
    const ids = moveId(cat.items.map(i => i.id), index, dir)
    reorder('item', ids, v => withCats(v, station.id, p, list =>
      list.map(c => (c.id === cat.id ? { ...c, items: byIds(c.items, ids) } : c))))
  }

  /** Drop the dragged job into `target` before `index`: a reorder, or a move to another category then a reorder. */
  const dropJob = async (targetPhase: Phase, target: CategoryTree, index: number) => {
    const d = drag
    setDrag(null)
    if (!d || !station) return
    const from = locate(station, d.itemId)
    if (!from) return
    if (from.cat.id === target.id) {
      const rest = target.items.map(i => i.id).filter(id => id !== d.itemId)
      const at = Math.max(0, Math.min(rest.length, index > target.items.findIndex(i => i.id === d.itemId) ? index - 1 : index))
      const ids = [...rest.slice(0, at), d.itemId, ...rest.slice(at)]
      if (ids.join() === target.items.map(i => i.id).join()) return
      reorder('item', ids, v => withCats(v, station.id, targetPhase, list =>
        list.map(c => (c.id === target.id ? { ...c, items: byIds(c.items, ids) } : c))))
      return
    }
    const moved = await send<unknown>(`/api/checklists/items/${d.itemId}`, 'PATCH', asData(from.item, target.id))
    if (!moved.ok) { showError(moved.error); return }
    const rest = target.items.map(i => i.id)
    const at = Math.max(0, Math.min(rest.length, index))
    if (at < rest.length) {
      const r = await send<unknown>('/api/checklists/reorder', 'POST', { kind: 'item', ids: [...rest.slice(0, at), d.itemId, ...rest.slice(at)] })
      if (!r.ok) showError(r.error)
    }
    if (from.phase !== targetPhase && from.item.linkId) {
      toast.show({ type: 'success', title: `Moved to ${phaseWord(targetPhase)}. It's on this list only now.` })
    }
    await load()
  }

  const quickAdd = async (cat: CategoryTree, title: string): Promise<string | null> => {
    const r = await send<unknown>('/api/checklists/items', 'POST', {
      title, answer: 'TICK', isBlocker: false, days: 127, categoryId: cat.id,
    })
    if (!r.ok) return r.error
    await load()
    return null
  }

  const saveStation = async (target: EditStation | null, name: string, color: string) => {
    if (target) return write(`/api/checklists/stations/${target.id}`, 'PATCH', { name, color })
    const r = await send<{ station: EditStation }>('/api/checklists/stations', 'POST', { rcId: activeRcId, name, color })
    if (!r.ok) return r.error
    setStationId(r.data.station.id)
    await load()
    return null
  }

  const copyFrom = async (p: Phase, fromId: string) => {
    if (!station) return 'Pick a station first'
    const r = await send<{ categories: number; items: number }>('/api/checklists/copy', 'POST', {
      fromStationId: fromId, toStationId: station.id, phase: p,
    })
    if (!r.ok) return r.error
    const { categories: c, items: i } = r.data
    toast.show({ type: 'success', title: `Copied ${c} ${c === 1 ? 'category' : 'categories'} and ${i} ${i === 1 ? 'job' : 'jobs'}` })
    await load()
    return null
  }

  const saveItem = (itemId: string | null, data: ItemData) =>
    itemId ? write(`/api/checklists/items/${itemId}`, 'PATCH', data) : write('/api/checklists/items', 'POST', data)

  const dismiss = (t: TidyUp) => {
    const next = new Set(dismissed)
    next.add(t.key)
    setDismissed(next)
    try { window.localStorage.setItem(DISMISS_KEY, JSON.stringify(Array.from(next))) } catch { /* private window: forget on reload */ }
  }

  const actOn = async (t: TidyUp) => {
    if (t.kind === 'must') {
      setStationId(t.stationId)
      setPhase(t.phase)
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    const err = t.kind === 'share'
      ? await write('/api/checklists/items/link', 'POST', { ids: t.itemIds })
      : await write(`/api/checklists/categories/${t.fromId}/merge`, 'POST', { intoId: t.intoId })
    if (err) showError(err)
    else toast.show({ type: 'success', title: t.kind === 'share' ? `Shared: one job on ${t.stations.length} lists` : `Merged into one “${t.name}”` })
  }

  // ── Render ─────────────────────────────────────────────────────────────

  const shell = (body: React.ReactNode, actions?: React.ReactNode) => (
    <div className="max-w-[640px] lg:max-w-[1400px] mx-auto w-full flex flex-col gap-3.5 pb-6">
      <ChecklistTabs active="edit" />
      <header className="flex items-center justify-between gap-3">
        <h1 className="m-0 text-[26px] leading-[1.1] font-semibold tracking-[-0.035em]">Build lists</h1>
        {actions}
      </header>
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

  // The job open in the form, read fresh from the view so its lists stay true after each save.
  const itemSheet = sheet?.kind === 'item' ? sheet : null
  const openItem = itemSheet?.itemId && station ? locate(station, itemSheet.itemId)?.item ?? null : null
  const itemPhase = itemSheet?.phase ?? phase
  const formProps = itemSheet && station ? {
    item: openItem,
    categoryId: itemSheet.categoryId,
    categories: station.phases[itemPhase],
    tempUnits: view.tempUnits,
    phase: itemPhase,
    meta: metaFor(itemPhase),
    draftTitle: itemSheet.draft,
    stations: ordered.map(s => ({ id: s.id, name: chipName(s), color: s.color })),
    ownStationId: station.id,
    lists: openItem ? listsOf(links[itemPhase], openItem, station.id) : [station.id],
    onClose: () => setSheet(null),
    onSave: (data: ItemData) => saveItem(itemSheet.itemId, data),
    onRemove: () => (itemSheet.itemId ? write(`/api/checklists/items/${itemSheet.itemId}`, 'DELETE') : Promise.resolve(null)),
    onLists: (ids: string[]) => (itemSheet.itemId ? write(`/api/checklists/items/${itemSheet.itemId}/lists`, 'PUT', { stationIds: ids }) : Promise.resolve(null)),
  } : null
  // A job removed elsewhere while open: close the form.
  const staleItem = itemSheet?.itemId != null && !openItem

  const copyButton = (p: Phase, cls: string) => (
    <button
      type="button"
      disabled={!station || station.isShared}
      title={station?.isShared ? 'The whole-kitchen list can’t copy from a station' : undefined}
      onClick={() => setSheet({ kind: 'copy', phase: p })}
      className={`min-h-[44px] px-2.5 rounded-[9px] border border-line-2 bg-paper text-[13px] text-ink-2 whitespace-nowrap disabled:opacity-40 ${cls}`}
    >
      Copy from…
    </button>
  )

  return shell(
    <>
      <TidyUpBar items={tidy} onAct={actOn} onDismiss={dismiss} />

      <div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-[200px_minmax(0,1fr)_340px] lg:gap-4 lg:items-start">
        <div className="hidden lg:block lg:sticky lg:top-4">
          <StationRail
            stations={ordered}
            selectedId={station?.id ?? null}
            onSelect={id => { setStationId(id); setSheet(null) }}
            onEdit={s => setSheet({ kind: 'station', station: s })}
            onAdd={() => setSheet({ kind: 'station', station: null })}
          />
        </div>

        <div className="flex flex-col gap-3.5 min-w-0">
          <div className="lg:hidden">
            <StationChips
              stations={ordered}
              selectedId={station?.id ?? null}
              onSelect={id => { setStationId(id); setSheet(null) }}
              onEdit={s => setSheet({ kind: 'station', station: s })}
              onAdd={() => setSheet({ kind: 'station', station: null })}
            />
          </div>

          {!station ? panel('No lists yet. Tap “+ New list” to add one.') : (
            <>
              <div className="hidden lg:flex items-center gap-2.5">
                <span className="w-3 h-3 rounded-full flex-none" style={{ background: station.color }} aria-hidden />
                <h2 className="m-0 flex-1 text-[24px] font-semibold tracking-[-0.03em]">{chipName(station)}</h2>
              </div>

              <div className="flex lg:hidden items-center gap-1.5">
                <div className="flex bg-bg-2 rounded-full p-[3px]" role="group" aria-label="Opening or closing">
                  {PHASES.map(p => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={phase === p}
                      onClick={() => setPhase(p)}
                      className={`rounded-full font-mono text-[11px] font-medium px-3 min-h-[44px] whitespace-nowrap ${phase === p ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3'}`}
                    >
                      {phaseWord(p)} · {phaseCount(station, p)}
                    </button>
                  ))}
                </div>
                <span className="flex-1" />
                <button type="button" onClick={() => setSheet({ kind: 'preview' })} className="min-h-[44px] px-2.5 rounded-[9px] border border-line-2 bg-paper text-[13px] text-ink-2">
                  Preview
                </button>
                {copyButton(phase, '')}
              </div>

              <p className="m-0 text-[13px] leading-[1.45] text-ink-3">
                Changes start on the next shift. Lists already started keep what they had, so history stays true.
                <span className="hidden lg:inline"> Type in “Add a job…” and press Enter to keep adding. Drag a job by its handle to move it, even across to the other half of the day.</span>
              </p>

              <div className="flex flex-col gap-3.5 lg:grid lg:grid-cols-2 lg:gap-3 lg:items-start">
                {PHASES.map(p => {
                  const cats = station.phases[p]
                  return (
                    <PhaseColumn
                      key={p}
                      station={station}
                      phase={p}
                      className={p === phase ? 'flex' : 'hidden lg:flex'}
                      onAddCategory={() => setSheet({ kind: 'category', category: null, phase: p })}
                      onCopy={station.isShared ? null : () => setSheet({ kind: 'copy', phase: p })}
                    >
                      {cats.length === 0 && panel(`${chipName(station)} has nothing on its ${p === 'OPEN' ? 'opening' : 'closing'} list yet. Add a category, or copy one from another list.`)}
                      {cats.map((c, i) => (
                        <CategoryCard
                          key={c.id}
                          category={c}
                          phase={p}
                          first={i === 0}
                          last={i === cats.length - 1}
                          tempUnitName={unitName}
                          listCount={it => listsOf(links[p], it, station.id).length}
                          selectedId={wide && itemSheet ? itemSheet.itemId : null}
                          drag={drag}
                          onMove={dir => moveCategory(p, i, dir)}
                          onEdit={() => setSheet({ kind: 'category', category: c, phase: p })}
                          onMoveItem={(idx, dir) => moveItem(p, c, idx, dir)}
                          onOpenItem={it => { setPhase(p); setSheet({ kind: 'item', itemId: it.id, categoryId: c.id, phase: p }) }}
                          onAddItem={draft => { setPhase(p); setSheet({ kind: 'item', itemId: null, categoryId: c.id, phase: p, draft }) }}
                          onQuickAdd={title => quickAdd(c, title)}
                          onDragStart={id => setDrag({ itemId: id, categoryId: c.id })}
                          onDragEnd={() => setDrag(null)}
                          onDrop={idx => dropJob(p, c, idx)}
                        />
                      ))}
                    </PhaseColumn>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {station && (
          <aside className="hidden lg:flex lg:sticky lg:top-4 flex-col gap-3 min-w-0 max-h-[calc(100vh-2rem)] overflow-y-auto">
            {wide && formProps && !staleItem ? (
              <div className="bg-paper border border-line rounded-[14px] p-4">
                <ItemForm key={itemSheet?.itemId ?? `new-${itemSheet?.categoryId}`} {...formProps} variant="panel" />
              </div>
            ) : (
              <div className="bg-paper border border-dashed border-line-2 rounded-[14px] p-4 text-[13px] text-ink-3 leading-[1.45]">
                Pick a job to edit it here. Type in “Add a job…” and press Enter to add one fast.
              </div>
            )}
            <div className="flex bg-bg-2 rounded-full p-[3px] self-start" role="group" aria-label="Preview opening or closing">
              {PHASES.map(p => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={phase === p}
                  onClick={() => setPhase(p)}
                  className={`rounded-full font-mono text-[10.5px] font-medium px-3 min-h-[34px] ${phase === p ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : 'text-ink-3'}`}
                >
                  {phaseWord(p)}
                </button>
              ))}
            </div>
            <PreviewCard station={station} phase={phase} tempUnits={view.tempUnits} kitchenJobs={station.isShared ? null : kitchenList} />
          </aside>
        )}
      </div>

      {!wide && formProps && !staleItem && (
        <ItemSheet key={itemSheet?.itemId ?? `new-${itemSheet?.categoryId}`} {...formProps} />
      )}
      {sheet?.kind === 'preview' && station && (
        <Sheet label="Preview as a cook" onClose={() => setSheet(null)}>
          <PreviewCard station={station} phase={phase} tempUnits={view.tempUnits} kitchenJobs={station.isShared ? null : kitchenList} />
        </Sheet>
      )}
      {sheet?.kind === 'category' && station && (
        <CategorySheet
          category={sheet.category}
          meta={metaFor(sheet.phase)}
          onClose={() => setSheet(null)}
          onSave={name => (sheet.category
            ? write(`/api/checklists/categories/${sheet.category.id}`, 'PATCH', { name })
            : write('/api/checklists/categories', 'POST', { stationId: station.id, phase: sheet.phase, name }))}
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
        <CopySheet target={station} stations={ordered} phase={sheet.phase} onClose={() => setSheet(null)} onCopy={id => copyFrom(sheet.phase, id)} />
      )}
    </>,
    <span className="hidden lg:inline font-mono text-[11px] text-ink-3">Changes start next shift</span>,
  )
}
