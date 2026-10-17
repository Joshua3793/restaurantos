'use client'
// Recipe Scan — review one scanned recipe and save it as a PREP recipe.
// The chef checks what the scanner read, fixes the flagged lines (pick, create
// or keep uncosted; confirm a guessed amount; tick allergens on an unlinked
// line), tidies the method, and saves. Every change autosaves to the draft
// (800 ms after the last edit); Save sends the screen's own copy, so an
// autosave still in flight can never make the recipe from an older one.
// MANAGER+ only. Design: Controla OS "Recipe scan" group.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { FileText, X } from 'lucide-react'
import { useUser } from '@/contexts/UserContext'
import { useDrawer } from '@/contexts/DrawerContext'
import { atLeast } from '@/lib/roles'
import { useToast } from '@/components/Toast'
import { ImageViewerV2 } from '@/components/invoices/v2/ImageViewer'
import { validateMethod } from '@/lib/recipe-method'
import { saveBlockers } from '@/lib/recipe-scan/save-rules'
import type { DraftData } from '@/lib/recipe-scan/types'
import { singleFlight, type FlightStep, type SingleFlight } from '@/lib/recipe-scan/single-flight'
import {
  costSummary, timeSummary, needsYou, type LineCosts, type LinkInfo, type MethodState,
} from '@/lib/recipe-scan/review'
import { ReviewHead, type CategoryOption } from '@/components/recipes/scan/ReviewHead'
import { CostStrip } from '@/components/recipes/scan/CostStrip'
import { IngredientList } from '@/components/recipes/scan/IngredientList'
import { MethodReview } from '@/components/recipes/scan/MethodReview'

const AUTOSAVE_MS = 800
const RETRY_MS = 5000

interface ScanFile { id: string; fileName: string; fileType: string; fileUrl: string }
interface DraftResponse {
  id: string
  scanId: string
  index: number
  title: string
  status: 'OPEN' | 'SAVED' | 'DISCARDED'
  savedRecipeId: string | null
  data: DraftData
  costs: LineCosts
  links?: Record<string, LinkInfo>
  existingNames?: string[]
  scan: {
    id: string
    revenueCenterId: string | null
    files: ScanFile[]
    drafts: { id: string; index: number; title: string; status: string }[]
  }
}

type SaveState = 'saved' | 'pending' | 'saving' | 'retrying' | 'failed' | 'locked'

const AUTOSAVE_LABEL: Record<SaveState, string> = {
  saved: 'All changes saved to the draft',
  pending: 'Saving…',
  saving: 'Saving…',
  retrying: 'Not saved yet — trying again',
  failed: 'Not saved',
  locked: 'This draft can no longer change',
}

function useIsDesktop(): boolean {
  const [desk, setDesk] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const on = () => setDesk(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return desk
}

const isViewable = (f: ScanFile) => {
  const t = f.fileType.toLowerCase()
  const n = f.fileName.toLowerCase()
  return t.startsWith('image/') || t === 'application/pdf' || n.endsWith('.pdf')
}

function crumbFor(files: ScanFile[], index: number, count: number): string {
  const first = files[0]
  const parts: string[] = []
  if (first) parts.push(first.fileName)
  const allPhotos = files.length > 0 && files.every(f => f.fileType.toLowerCase().startsWith('image/'))
  if (allPhotos) parts.push(`${files.length} ${files.length === 1 ? 'page' : 'pages'}`)
  else if (files.length > 1) parts.push(`${files.length} files`)
  if (count > 1) parts.push(`recipe ${index + 1} of ${count}`)
  return parts.join(' · ')
}

/** The scan's original pages: the invoice viewer for photos/PDFs, a plain link for Word/Excel. */
function OriginalPane({ files }: { files: ScanFile[] }) {
  const viewable = files.filter(isViewable)
  const other = files.filter(f => !isViewable(f))
  return (
    <div className="flex flex-col h-full min-h-0 rounded-lg overflow-hidden border border-line bg-paper">
      {viewable.length > 0 && (
        <div className="flex flex-1 min-h-0">
          <ImageViewerV2 files={viewable} />
        </div>
      )}
      {other.length > 0 && (
        <div className="p-4 flex flex-col gap-2">
          <p className="ui-label">Original file</p>
          {other.map(f => (
            <a key={f.id} href={f.fileUrl} target="_blank" rel="noreferrer" download={f.fileName}
              className="flex items-center gap-2 text-[13.5px] text-ink hover:text-gold-2">
              <FileText size={14} className="text-ink-3" />{f.fileName}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

function Message({ title, body }: { title: string; body?: React.ReactNode }) {
  return (
    <div className="max-w-md mx-auto mt-16 text-center">
      <h1 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">{title}</h1>
      {body && <div className="text-[14px] text-ink-3 mt-2">{body}</div>}
      <Link href="/recipes" className="inline-block mt-5 text-[13px] font-medium text-ink-2 hover:text-ink">← Recipe Book</Link>
    </div>
  )
}

export default function RecipeScanReviewPage({ params }: { params: { draftId: string } }) {
  const { draftId } = params
  const router = useRouter()
  const toast = useToast()
  const { role, loading: userLoading } = useUser()
  const canReview = role != null && atLeast(role, 'MANAGER')
  const isDesktop = useIsDesktop()

  const [draft, setDraft] = useState<DraftResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [data, setData] = useState<DraftData | null>(null)
  const [costs, setCosts] = useState<LineCosts>({})
  const [links, setLinks] = useState<Record<string, LinkInfo>>({})
  const [categories, setCategories] = useState<CategoryOption[]>([])
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autosaveError, setAutosaveError] = useState<string | null>(null)
  const [serverBlockers, setServerBlockers] = useState<string[]>([])
  const [showOriginal, setShowOriginal] = useState(false)
  const { setDrawerOpen } = useDrawer()
  // The full-screen original hides the floating chat button, like any drawer.
  useEffect(() => {
    if (!showOriginal) return
    setDrawerOpen(true)
    return () => setDrawerOpen(false)
  }, [showOriginal, setDrawerOpen])

  const dataRef = useRef<DraftData | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirty = useRef(false)
  const keepaliveNext = useRef(false)
  const done = useRef(false) // saved or discarded: autosave stops

  // ── Load ──
  useEffect(() => {
    if (!canReview) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/recipe-scans/drafts/${draftId}`, { cache: 'no-store' })
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) { setLoadError(json.error ?? 'Could not open this scan.'); return }
        const d = json as DraftResponse
        setDraft(d)
        setData(d.data)
        dataRef.current = d.data
        setCosts(d.costs ?? {})
        setLinks(d.links ?? {})
        if (d.status !== 'OPEN') { done.current = true; setSaveState('locked') }
      } catch {
        if (!cancelled) setLoadError('Could not open this scan — check the connection.')
      }
    })()
    return () => { cancelled = true }
  }, [draftId, canReview])

  const rcId = data?.revenueCenterId ?? draft?.scan.revenueCenterId ?? ''
  useEffect(() => {
    if (!draft) return
    fetch(`/api/recipes/categories?type=PREP&rcId=${encodeURIComponent(rcId)}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : []))
      .then((cats: CategoryOption[]) => setCategories(Array.isArray(cats) ? cats : []))
      .catch(() => {})
  }, [draft, rcId])

  // ── Autosave ──
  // Single-flight (single-flight.ts): at most one PATCH at a time — the server
  // keeps whichever lands last, so an older copy must never overtake a newer
  // one. A flush during a flight makes the same run send the newest copy after.
  // One send; 'stop' ends the run (error / locked), 'done' lets it go round again.
  const sendOnce = async (): Promise<FlightStep> => {
    const body = dataRef.current
    if (!body || done.current || !dirty.current) return 'stop'
    const keepalive = keepaliveNext.current
    keepaliveNext.current = false
    dirty.current = false
    setSaveState('saving')
    let res: Response
    try {
      res = await fetch(`/api/recipe-scans/drafts/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: body }),
        keepalive,
      })
    } catch {
      if (!done.current) retryLater() // network: try again
      return 'stop'
    }
    if (done.current) return 'stop'
    if (res.status === 409) {
      done.current = true
      setSaveState('locked')
      setError('This recipe was already saved or discarded — changes here are not kept.')
      return 'stop'
    }
    if (res.status >= 500) { retryLater(); return 'stop' }
    if (!res.ok) {
      // A 4xx won't get better by sending the same copy again: say so and stop.
      const json = await res.json().catch(() => ({}))
      dirty.current = true
      setSaveState('failed')
      setAutosaveError(json.error ?? 'Could not save your changes to the draft.')
      return 'stop'
    }
    const json = await res.json().catch(() => null)
    // Paint costs only when this answer is for the copy on screen (nothing
    // edited since it was sent; a newer copy goes next and paints then).
    if (json && !dirty.current) {
      setCosts(json.costs ?? {})
      setSaveState('saved')
      setAutosaveError(null)
    }
    return 'done'
  }
  const sendRef = useRef(sendOnce)
  sendRef.current = sendOnce
  const flight = useRef<SingleFlight | null>(null)
  if (!flight.current) flight.current = singleFlight(() => sendRef.current())

  const flush = useCallback((opts: { keepalive?: boolean } = {}): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (opts.keepalive) keepaliveNext.current = true
    return flight.current!.trigger()
  }, [])

  function retryLater() {
    dirty.current = true
    setSaveState('retrying')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { flush() }, RETRY_MS)
  }

  const update = useCallback((next: DraftData) => {
    if (done.current) return
    const prev = dataRef.current
    dataRef.current = next
    setData(next)
    setServerBlockers([])
    // A line whose link or amount changed has no live cost until the next save answers.
    if (prev) {
      const before = new Map(prev.lines.map(l => [l.key, l]))
      setCosts(c => {
        let out = c
        for (const l of next.lines) {
          const b = before.get(l.key)
          if (b && (b.link?.id !== l.link?.id || b.qty !== l.qty || b.unit !== l.unit) && out[l.key]) {
            if (out === c) out = { ...c }
            delete out[l.key]
          }
        }
        return out
      })
    }
    dirty.current = true
    setSaveState('pending')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { flush() }, AUTOSAVE_MS)
  }, [flush])

  // Leaving the page (or the tab) with an edit not yet sent: send it now,
  // through the same single-flight path (keepalive so it survives an unload).
  // If a PATCH is already in flight, the follow-up runs when it settles — on an
  // in-app navigation the run carries on after unmount; on a real unload only
  // the in-flight copy is guaranteed to arrive.
  useEffect(() => {
    const send = () => {
      if (!dirty.current || done.current || !dataRef.current) return
      flush({ keepalive: true })
    }
    const onHide = () => { if (document.visibilityState === 'hidden') send() }
    window.addEventListener('pagehide', send)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', send)
      document.removeEventListener('visibilitychange', onHide)
      send() // in-app navigation away
    }
  }, [flush])

  // ── Derived ──
  const blockers = useMemo(() => {
    if (!data) return []
    const out = saveBlockers(data, draft?.existingNames ?? [])
    const v = validateMethod(data.method)
    if (!v.ok) out.push(v.error)
    for (const b of serverBlockers) if (!out.includes(b)) out.push(b)
    return out
  }, [data, draft?.existingNames, serverBlockers])

  const cost = useMemo(() => (data ? costSummary(data, costs) : null), [data, costs])
  const time = useMemo(() => (data ? timeSummary(data.method, data.guessed ?? {}) : null), [data])
  const firstOpen = data?.lines.find(needsYou)?.key ?? null

  const categoryColor = useCallback(
    (name: string) => categories.find(c => c.name.trim().toLowerCase() === name.trim().toLowerCase())?.color ?? null,
    [categories],
  )

  // ── Actions ──
  const save = async () => {
    if (!dataRef.current || saving) return
    setSaving(true)
    setError(null)
    // The save sends the screen's own copy, so a pending autosave is not needed —
    // but one already in flight must settle first, or it could land after the save.
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    await flight.current!.current()?.catch(() => {})
    if (timer.current) { clearTimeout(timer.current); timer.current = null } // a retry it may have queued
    const body = dataRef.current!
    try {
      const res = await fetch(`/api/recipe-scans/drafts/${draftId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: body }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.status === 201) {
        done.current = true
        dirty.current = false
        const name = body.name.trim()
        toast.show({ type: 'success', title: `Recipe saved — ${name} is in the Recipe Book and on the prep list.` })
        router.push(`/recipes?item=${json.recipeId}`)
        return
      }
      if (res.status === 400 && Array.isArray(json.blockers)) setServerBlockers(json.blockers)
      else setError(json.error ?? 'Could not save the recipe.')
      if (res.status === 409 && json.error && /already saved/i.test(json.error)) {
        done.current = true
        setSaveState('locked')
      }
    } catch {
      setError('Could not save the recipe — check the connection.')
    } finally {
      setSaving(false)
      // Not saved: the edits the save carried still have to reach the draft.
      if (!done.current && dirty.current) flush()
    }
  }

  const discard = async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    await flight.current!.current()?.catch(() => {})
    if (timer.current) { clearTimeout(timer.current); timer.current = null } // a retry it may have queued
    try {
      const res = await fetch(`/api/recipe-scans/drafts/${draftId}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(json.error ?? 'Could not discard this recipe.')
        return
      }
      done.current = true
      dirty.current = false
      router.push('/recipes')
    } catch {
      setError('Could not discard this recipe — check the connection.')
    } finally {
      // Still here (the discard failed): the pending edits go to the draft after all.
      if (!done.current && dirty.current) flush()
    }
  }

  const nextToFix = () => {
    if (!firstOpen) return
    document.getElementById(`line-${firstOpen}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // ── Render ──
  if (userLoading) return <div className="h-40 animate-pulse bg-bg-2 rounded-lg" />
  if (!canReview) {
    return <Message title="Managers only" body="Scanning recipes is for managers and above — the people who edit recipes and see costs." />
  }
  if (loadError) return <Message title="This scan can't be opened" body={loadError} />
  if (!draft || !data || !cost || !time) {
    return (
      <div className="flex flex-col gap-4 animate-pulse">
        <div className="h-24 bg-bg-2 rounded-lg" />
        <div className="h-20 bg-bg-2 rounded-lg" />
        <div className="h-72 bg-bg-2 rounded-lg" />
      </div>
    )
  }
  if (draft.status !== 'OPEN') {
    return (
      <Message
        title={draft.status === 'SAVED' ? 'This recipe is already saved' : 'This recipe was discarded'}
        body={draft.status === 'SAVED' && draft.savedRecipeId
          ? <Link href={`/recipes?item=${draft.savedRecipeId}`} className="text-gold-2 hover:text-gold">Open {draft.title} in the Recipe Book</Link>
          : undefined}
      />
    )
  }

  const files = draft.scan.files
  const openCount = data.lines.filter(needsYou).length

  return (
    <div className="flex flex-col gap-4 md:gap-5 pb-10">
      <ReviewHead
        crumb={crumbFor(files, draft.index, draft.scan.drafts.length)}
        name={data.name}
        onName={name => update({ ...dataRef.current!, name })}
        ingredients={data.lines.length}
        steps={data.method.length}
        needYou={openCount}
        categories={categories}
        categoryId={data.categoryId}
        onCategory={id => update({ ...dataRef.current!, categoryId: id })}
        yieldQty={data.yieldQty}
        yieldUnit={data.yieldUnit}
        yieldGuessed={data.yieldGuessed}
        onYield={(q, u) => update({ ...dataRef.current!, yieldQty: q, yieldUnit: u, yieldGuessed: false })}
        blockers={blockers}
        saving={saving}
        onSave={save}
        onDiscard={discard}
        autosave={saveState === 'failed' && autosaveError
          ? `Not saved to the draft — ${autosaveError.replace(/\.?$/, '.')} Your next change tries again.`
          : AUTOSAVE_LABEL[saveState]}
        error={error}
      />

      {files.length > 0 && (
        <button
          type="button"
          onClick={() => setShowOriginal(true)}
          className="md:hidden self-start flex items-center gap-1.5 px-3.5 py-2 rounded-[9px] text-[13px] font-medium text-ink-2 bg-paper border border-line hover:border-ink-3"
        >
          <FileText size={13} className="text-ink-3" />
          See original
        </button>
      )}

      <div className="md:grid md:grid-cols-[minmax(0,1fr)_minmax(300px,38%)] md:gap-5 md:items-start">
        <div className="flex flex-col gap-4 min-w-0">
          <CostStrip cost={cost} time={time} yieldUnit={data.yieldUnit} onNextToFix={firstOpen ? nextToFix : null} />
          <IngredientList
            data={data}
            costs={costs}
            links={links}
            categoryColor={categoryColor}
            isDesktop={isDesktop}
            revenueCenterId={rcId || null}
            onChange={update}
            onLink={(key, info) => setLinks(l => ({ ...l, [key]: info }))}
          />
          <MethodReview
            method={data.method}
            guessed={data.guessed ?? {}}
            onChange={(next: MethodState) => update({ ...dataRef.current!, method: next.method, guessed: next.guessed })}
          />
        </div>
        {isDesktop && files.length > 0 && (
          <aside className="sticky top-4 h-[calc(100vh-6rem)] min-h-[420px]">
            <OriginalPane files={files} />
          </aside>
        )}
      </div>

      {showOriginal && !isDesktop && (
        <div className="fixed inset-0 z-[60] bg-paper flex flex-col">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line pt-safe">
            <span className="font-mono text-[11px] uppercase text-ink-3 truncate">Original · {files[0]?.fileName}</span>
            <button type="button" onClick={() => setShowOriginal(false)} aria-label="Close the original" className="p-1 text-ink-3 hover:text-ink">
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 min-h-0 p-2">
            <OriginalPane files={files} />
          </div>
        </div>
      )}
    </div>
  )
}
