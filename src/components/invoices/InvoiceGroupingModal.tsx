'use client'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  X, Loader2, ScanLine, FileText, FileSpreadsheet, AlertTriangle, Pencil, Trash2, Undo2,
  Check, Maximize2, MoreHorizontal, ChevronLeft, ChevronRight, Building2, Search, FolderPlus, ArrowRightLeft,
} from 'lucide-react'
import type { ProposedGroup } from '@/lib/invoice-grouping'
import { fileKind } from '@/lib/invoice-grouping'
import {
  DRAFT_VERSION, type GroupingDraft,
  moveFiles, reorderInGroup, discardFiles, restoreFiles, setGroupMeta,
} from '@/lib/invoice-grouping-draft'
import { DiscardBatchDialog } from './DiscardBatchDialog'

// The sorter. One draft object (src/lib/invoice-grouping-draft.ts) is the
// whole state; every edit is a pure function on it and is PUT to the session
// right after, so closing the sheet never loses work.
//
// Interaction model: TAP a page to select it (multi-select), then act on the
// selection from the bar above the confirm button — Move to / New invoice /
// Discard. The small ⤢ on a page opens it full size, where it can be nudged
// earlier/later inside its invoice or discarded on its own.

interface PeekFile { id: string; fileName: string; fileType: string; fileUrl: string }
interface SupplierOpt { id: string; name: string }

interface Props {
  sessionId: string
  onClose: () => void       // keep the batch (session stays GROUPING, draft saved)
  onDone: () => void        // split committed + process fired for every invoice
  onDiscarded: () => void   // the whole batch was deleted
}

type Kind = 'photo' | 'pdf' | 'csv'

// ── Atoms (module scope: sub-components inside the body would remount every render) ──

function EditableChip({ value, placeholder, type = 'text', onCommit, title, mono = true }: {
  value: string | null
  placeholder: string
  type?: 'text' | 'date'
  onCommit: (v: string | null) => void
  title: string
  mono?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])
  const commit = () => {
    const v = draft.trim()
    onCommit(v.length ? v : null)
    setEditing(false)
  }
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => { setDraft(value ?? ''); setEditing(true) }}
        className={`inline-flex items-center gap-1 ${mono ? 'font-mono' : ''} text-xs px-1.5 py-0.5 rounded-md border border-line ${value ? 'text-ink-2' : 'text-ink-4'} hover:border-gold hover:text-ink transition-colors shrink-0 max-w-[12rem]`}
        title={title}
      >
        <span className="truncate">{value ?? placeholder}</span>
        <Pencil size={10} className="text-ink-4 shrink-0" />
      </button>
    )
  }
  return (
    <input
      ref={inputRef}
      autoFocus
      type={type}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
      placeholder={placeholder}
      className={`${mono ? 'font-mono' : ''} text-xs px-1.5 py-0.5 rounded-md border border-gold outline-none w-36 shrink-0 text-ink bg-paper`}
    />
  )
}

// Supplier chip → popover with the directory. Picking a directory name gives
// the split a name matchSupplierByName will resolve exactly; a free-typed name
// is allowed too (it becomes an alias candidate at review, as today).
function SupplierChip({ value, suppliers, onCommit }: {
  value: string | null
  suppliers: SupplierOpt[]
  onCommit: (v: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) { setQ(''); setTimeout(() => inputRef.current?.focus(), 0) } }, [open])
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle ? suppliers.filter(s => s.name.toLowerCase().includes(needle)) : suppliers
    return list.slice(0, 8)
  }, [q, suppliers])
  const typed = q.trim()
  const exact = typed && suppliers.some(s => s.name.toLowerCase() === typed.toLowerCase())
  return (
    <div className="relative shrink-0 min-w-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-1.5 text-sm font-semibold rounded-md px-1.5 py-0.5 -ml-1.5 hover:bg-bg-2 transition-colors max-w-[14rem] ${value ? 'text-ink' : 'text-gold-2'}`}
        title="Change supplier"
      >
        <Building2 size={13} className={value ? 'text-ink-4' : 'text-gold-2'} />
        <span className="truncate">{value ?? 'Unknown supplier'}</span>
        <Pencil size={10} className="text-ink-4 shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[70]" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-[71] w-64 bg-paper border border-line rounded-xl shadow-xl p-2">
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-line bg-bg">
              <Search size={12} className="text-ink-4" />
              <input
                ref={inputRef}
                value={q}
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') setOpen(false)
                  if (e.key === 'Enter' && typed) { onCommit(matches[0]?.name ?? typed); setOpen(false) }
                }}
                placeholder="Search suppliers…"
                className="flex-1 bg-transparent text-sm outline-none text-ink min-w-0"
              />
            </div>
            <div className="mt-1 max-h-56 overflow-y-auto">
              {matches.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => { onCommit(s.name); setOpen(false) }}
                  className={`w-full text-left px-2 py-1.5 rounded-lg text-sm hover:bg-bg-2 ${s.name === value ? 'text-ink font-semibold' : 'text-ink-2'}`}
                >
                  {s.name}
                </button>
              ))}
              {typed && !exact && (
                <button
                  type="button"
                  onClick={() => { onCommit(typed); setOpen(false) }}
                  className="w-full text-left px-2 py-1.5 rounded-lg text-sm text-ink-2 hover:bg-bg-2"
                >
                  Use &ldquo;{typed}&rdquo;
                </button>
              )}
              {matches.length === 0 && !typed && (
                <div className="px-2 py-2 text-xs text-ink-4">No suppliers yet — type a name.</div>
              )}
            </div>
            {value && (
              <button
                type="button"
                onClick={() => { onCommit(null); setOpen(false) }}
                className="w-full text-left px-2 py-1.5 mt-1 border-t border-line text-xs text-ink-4 hover:text-red-text"
              >
                Clear supplier
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function PageThumb({ file, index, selected, dim, onToggle, onView, restoreMode }: {
  file: PeekFile
  index: number | null       // page number inside its invoice; null in unassigned/discarded strips
  selected: boolean
  dim?: boolean
  onToggle: () => void
  onView?: () => void
  restoreMode?: boolean
}) {
  const kind = fileKind(file.fileType, file.fileName)
  return (
    <div className={`relative shrink-0 ${dim ? 'opacity-50 hover:opacity-90' : ''} transition-opacity`}>
      <button
        type="button"
        onClick={onToggle}
        className={`relative block rounded-lg overflow-hidden border-2 transition-colors ${
          selected ? 'border-gold ring-2 ring-gold/30' : 'border-line hover:border-ink-4'
        }`}
        title={restoreMode ? `${file.fileName} — tap to restore` : `${file.fileName} — tap to select`}
        aria-pressed={selected}
      >
        {kind === 'photo' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={file.fileUrl} alt={file.fileName} className="h-28 w-20 object-cover" />
        ) : (
          <span className="h-28 w-20 grid place-items-center bg-bg-2">
            {kind === 'pdf' ? <FileText size={20} className="text-red" /> : <FileSpreadsheet size={20} className="text-green" />}
          </span>
        )}
        {index != null && (
          <span className="absolute top-1 left-1 font-mono text-[10px] font-semibold bg-ink/80 text-paper rounded px-1 leading-4">
            {index + 1}
          </span>
        )}
        {selected && (
          <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-gold text-ink grid place-items-center">
            <Check size={10} strokeWidth={3} />
          </span>
        )}
        {restoreMode && (
          <span className="absolute inset-0 grid place-items-center bg-black/30">
            <Undo2 size={16} className="text-paper" />
          </span>
        )}
      </button>
      {onView && (
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onView() }}
          className="absolute bottom-1 right-1 w-6 h-6 rounded-md bg-ink/75 text-paper grid place-items-center hover:bg-ink"
          title="View full size"
          aria-label="View full size"
        >
          <Maximize2 size={11} />
        </button>
      )}
    </div>
  )
}

function groupLabel(g: ProposedGroup, idx: number): string {
  const bits = [g.supplierName ?? 'Unknown supplier']
  if (g.invoiceNumber) bits.push(`#${g.invoiceNumber}`)
  return `Invoice ${idx + 1} · ${bits.join(' ')}`
}

// ── The sorter ─────────────────────────────────────────────────────────────

export function InvoiceGroupingModal({ sessionId, onClose, onDone, onDiscarded }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [files, setFiles] = useState<PeekFile[]>([])
  const [draft, setDraft] = useState<GroupingDraft | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [moveMenu, setMoveMenu] = useState(false)
  const [headerMenu, setHeaderMenu] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [suppliers, setSuppliers] = useState<SupplierOpt[]>([])

  const fileById = useMemo(() => new Map(files.map(f => [f.id, f])), [files])
  const kindOf = useCallback((id: string): Kind => {
    const f = fileById.get(id)
    return f ? fileKind(f.fileType, f.fileName) : 'photo'
  }, [fileById])

  // ── Persist every edit ───────────────────────────────────────────────────
  // lastSavedRef holds the JSON the server has (seeded at load, so the initial
  // render doesn't re-save); saves are serialised — one in flight, newest
  // pending wins — so a slow earlier response never overwrites a later edit.
  const lastSavedRef = useRef<string | null>(null)
  const pendingRef = useRef<GroupingDraft | null>(null)
  const inflightRef = useRef(false)

  const flushSave = useCallback(async () => {
    if (inflightRef.current) return
    const next = pendingRef.current
    if (!next) return
    pendingRef.current = null
    inflightRef.current = true
    let retryScheduled = false
    try {
      const res = await fetch(`/api/invoices/sessions/${sessionId}/grouping`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw Object.assign(new Error(j.error ?? `Couldn't save your changes (${res.status})`), { status: res.status })
      }
      lastSavedRef.current = JSON.stringify(next)
      setSaveError(null)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e))
      // Network drop / 5xx: keep it queued and retry shortly unless a newer
      // edit replaced it. A 4xx is final — the same body gets the same answer.
      const status = (e as { status?: number }).status
      if ((status === undefined || status >= 500) && !pendingRef.current) {
        pendingRef.current = next
        retryScheduled = true
        setTimeout(() => void flushSave(), 2500)
      }
    } finally {
      inflightRef.current = false
      if (pendingRef.current && !retryScheduled) void flushSave()
    }
  }, [sessionId])

  useEffect(() => {
    if (!draft || lastSavedRef.current === null) return
    const json = JSON.stringify(draft)
    if (json === lastSavedRef.current) return
    pendingRef.current = draft
    void flushSave()
  }, [draft, flushSave])

  // ── Load ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(`/api/invoices/sessions/${sessionId}/peek`, { method: 'POST' })
        const j = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(j.error ?? `Couldn't read the photos (${res.status})`)
        if (!alive) return
        const loaded: GroupingDraft = { v: DRAFT_VERSION, groups: j.groups, unassigned: j.unassigned, discarded: j.discarded ?? [] }
        lastSavedRef.current = JSON.stringify(loaded)
        setFiles(j.files)
        setDraft(loaded)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    fetch('/api/suppliers')
      .then(r => (r.ok ? r.json() : []))
      .then((rows: Array<{ id: string; name: string }>) => { if (alive) setSuppliers(rows.map(r => ({ id: r.id, name: r.name }))) })
      .catch(() => {})
    return () => { alive = false }
  }, [sessionId])

  // ── Edits (all through the pure lib) ─────────────────────────────────────
  const apply = (next: GroupingDraft) => { setDraft(next); setActionError(null) }
  const toggle = (id: string) => setSelected(prev => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })
  const clearSel = () => setSelected(new Set())
  const move = (target: { group: number } | 'new') => {
    if (!draft) return
    const r = moveFiles(draft, [...selected], target, kindOf)
    if (!r.ok) { setActionError(r.error); return }
    apply(r.draft); clearSel(); setMoveMenu(false)
  }
  const discardSelected = () => { if (draft) { apply(discardFiles(draft, [...selected])); clearSel() } }
  const restore = (id: string) => { if (draft) apply(restoreFiles(draft, [id])) }
  const meta = (idx: number, patch: Parameters<typeof setGroupMeta>[2]) => { if (draft) apply(setGroupMeta(draft, idx, patch)) }
  const nudge = (id: string, dir: -1 | 1) => { if (draft) apply(reorderInGroup(draft, id, dir)) }
  const discardOne = (id: string) => { if (draft) { apply(discardFiles(draft, [id])); setViewingId(null); setSelected(prev => { const n = new Set(prev); n.delete(id); return n }) } }
  // Peek failed for every photo → offer today's fallback: everything as one invoice
  // (moveFiles keeps any PDF/CSV as its own invoice).
  const scanAsOne = () => {
    if (!draft) return
    const r = moveFiles(draft, draft.unassigned, 'new', kindOf)
    if (r.ok) apply(r.draft)
  }

  // ── Selection facts for the action bar ───────────────────────────────────
  const selection = useMemo(() => {
    if (!draft || selected.size === 0) return null
    const ids = [...selected]
    const sourceGroups = new Set<number>()
    let fromUnassigned = 0, fromDiscarded = 0
    for (const id of ids) {
      const gi = draft.groups.findIndex(g => g.fileIds.includes(id))
      if (gi >= 0) sourceGroups.add(gi)
      else if (draft.unassigned.includes(id)) fromUnassigned++
      else if (draft.discarded.includes(id)) fromDiscarded++
    }
    const hasNonPhoto = ids.some(id => kindOf(id) !== 'photo')
    const singleSource = sourceGroups.size === 1 && fromUnassigned === 0 && fromDiscarded === 0 ? [...sourceGroups][0] : null
    const from = singleSource != null
      ? `from Invoice ${singleSource + 1}`
      : sourceGroups.size === 0 && fromDiscarded === 0 ? 'unplaced'
      : sourceGroups.size === 0 ? 'discarded'
      : 'from several invoices'
    const targets = draft.groups
      .map((g, i) => ({ g, i }))
      .filter(({ g, i }) => g.kind === 'photos' && i !== singleSource)
    return { ids, count: ids.length, from, hasNonPhoto, targets }
  }, [draft, selected, kindOf])

  // ── Confirm ──────────────────────────────────────────────────────────────
  const confirm = async () => {
    if (!draft) return
    setConfirming(true); setError(null)
    try {
      const res = await fetch(`/api/invoices/sessions/${sessionId}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groups: draft.groups.map(g => ({
            fileIds: g.fileIds, supplierName: g.supplierName, invoiceNumber: g.invoiceNumber, invoiceDate: g.invoiceDate,
          })),
          discardFileIds: draft.discarded,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? `Split failed (${res.status})`)
      for (const id of j.sessionIds as string[]) {
        fetch(`/api/invoices/sessions/${id}/process`, { method: 'POST' }).catch(() => {})
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setConfirming(false)
    }
  }

  const discardBatch = async () => {
    setDiscarding(true)
    try {
      const res = await fetch(`/api/invoices/sessions/${sessionId}`, { method: 'DELETE' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `Couldn't discard (${res.status})`)
      }
      onDiscarded()
    } catch (e) {
      setDiscarding(false); setDiscardOpen(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const allUnassigned = !loading && !error && !!draft && draft.groups.length === 0 && draft.unassigned.length > 0 && draft.discarded.length === 0
  const canConfirm = !!draft && !loading && !confirming && draft.groups.length > 0 && draft.unassigned.length === 0
  const viewing = viewingId ? fileById.get(viewingId) ?? null : null
  const viewingGroup = viewingId && draft ? draft.groups.findIndex(g => g.fileIds.includes(viewingId)) : -1
  const viewingPos = viewingGroup >= 0 && draft ? draft.groups[viewingGroup].fileIds.indexOf(viewingId!) : -1
  const viewingLen = viewingGroup >= 0 && draft ? draft.groups[viewingGroup].fileIds.length : 0
  const photoNoun = files.every(f => fileKind(f.fileType, f.fileName) === 'photo') ? 'photos' : 'files'

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      {/* Full-height sheet on phones; centred dialog from sm: up, confirm pinned in both. */}
      <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center sm:p-4 pointer-events-none">
        <div
          className="pointer-events-auto bg-white w-full sm:max-w-3xl flex flex-col rounded-t-2xl sm:rounded-2xl shadow-xl h-[100dvh] sm:h-auto"
          style={{ maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px))', paddingTop: 'env(safe-area-inset-top, 0px)' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 px-4 sm:px-5 py-3.5 border-b border-line shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-gold/15 flex items-center justify-center shrink-0">
                <ScanLine size={16} className="text-gold" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-bold text-ink leading-tight">Sort {photoNoun} into invoices</h2>
                <p className="text-xs text-ink-4 truncate">Tap pages to select · changes save as you go</p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setHeaderMenu(m => !m)}
                  className="w-8 h-8 grid place-items-center rounded-lg text-ink-4 hover:bg-bg-2 hover:text-ink-2"
                  title="More"
                  aria-label="More"
                >
                  <MoreHorizontal size={16} />
                </button>
                {headerMenu && (
                  <>
                    <div className="fixed inset-0 z-[70]" onClick={() => setHeaderMenu(false)} />
                    <div className="absolute right-0 top-9 z-[71] bg-paper border border-line rounded-xl shadow-xl py-1 min-w-[180px]">
                      <button
                        type="button"
                        onClick={() => { setHeaderMenu(false); setDiscardOpen(true) }}
                        className="w-full px-3 py-2 text-left text-[13px] text-red-text hover:bg-red-soft/50 inline-flex items-center gap-2"
                      >
                        <Trash2 size={13} /> Discard batch
                      </button>
                    </div>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-1.5 px-2 h-8 rounded-lg text-ink-4 hover:bg-bg-2 hover:text-ink-2 text-xs"
                title="Keep for later — your sorting is saved"
              >
                <span className="hidden sm:inline">Keep for later</span>
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
            {loading && (
              <div className="py-12 flex flex-col items-center gap-3 text-ink-3">
                <Loader2 size={24} className="animate-spin" />
                <p className="text-sm">Reading supplier &amp; invoice numbers…</p>
              </div>
            )}

            {error && (
              <div className="bg-red-soft border border-red-soft rounded-xl p-4 text-sm text-red-text">
                <strong>Error:</strong> {error}
              </div>
            )}
            {saveError && (
              <div className="bg-red-soft border border-red-soft rounded-xl p-3 text-xs text-red-text flex items-center gap-2">
                <AlertTriangle size={14} className="shrink-0" />
                <span><strong>Not saved:</strong> {saveError}</span>
              </div>
            )}
            {actionError && (
              <div className="bg-gold-soft border border-gold-soft rounded-xl p-3 text-xs text-gold-2 flex items-center gap-2">
                <AlertTriangle size={14} className="shrink-0" />
                <span>{actionError}</span>
              </div>
            )}

            {allUnassigned && (
              <div className="bg-gold-soft border border-gold-soft rounded-xl p-4 text-sm text-gold-2 space-y-2">
                <p><strong>Couldn&apos;t read these {photoNoun}.</strong> You can scan them all as one invoice instead, or select pages below and build invoices by hand.</p>
                <button type="button" onClick={scanAsOne} className="px-3 py-1.5 rounded-lg bg-ink text-paper text-xs font-semibold">
                  Scan as one invoice
                </button>
              </div>
            )}

            {draft && draft.unassigned.length > 0 && !allUnassigned && (
              <div className="border border-gold rounded-xl p-3 sm:p-4 space-y-2 bg-gold-soft/40">
                <div className="flex items-center gap-2 text-sm font-semibold text-gold-2">
                  <AlertTriangle size={14} /> {draft.unassigned.length} unplaced {draft.unassigned.length > 1 ? 'pages' : 'page'} — select and move them to an invoice
                </div>
                <div className="flex gap-2 flex-wrap">
                  {draft.unassigned.map(id => {
                    const f = fileById.get(id)
                    return f ? (
                      <PageThumb key={id} file={f} index={null} selected={selected.has(id)} onToggle={() => toggle(id)} onView={() => setViewingId(id)} />
                    ) : null
                  })}
                </div>
              </div>
            )}

            {draft?.groups.map((g, i) => (
              <div key={i} className={`border rounded-xl p-3 sm:p-4 space-y-2.5 ${g.kind === 'photos' ? 'border-line' : 'border-dashed border-line bg-bg/40'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.04em] text-ink-4 shrink-0">Invoice {i + 1}</span>
                  <SupplierChip value={g.supplierName} suppliers={suppliers} onCommit={v => meta(i, { supplierName: v })} />
                  <EditableChip value={g.invoiceNumber ? `#${g.invoiceNumber}` : null} placeholder="no number" title="Correct the invoice number"
                    onCommit={v => meta(i, { invoiceNumber: v ? v.replace(/^#/, '') : null })} />
                  <EditableChip value={g.invoiceDate} placeholder="no date" type="date" title="Correct the invoice date"
                    onCommit={v => meta(i, { invoiceDate: v })} />
                  <span className="ml-auto text-xs text-ink-4 shrink-0">
                    {g.kind === 'photos'
                      ? `${g.fileIds.length} ${g.fileIds.length > 1 ? 'pages' : 'page'}`
                      : g.kind.toUpperCase()}
                  </span>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {g.fileIds.map((id, pi) => {
                    const f = fileById.get(id)
                    return f ? (
                      <PageThumb key={id} file={f} index={g.kind === 'photos' ? pi : null} selected={selected.has(id)}
                        onToggle={() => toggle(id)} onView={kindOf(id) === 'photo' ? () => setViewingId(id) : undefined} />
                    ) : null
                  })}
                </div>
              </div>
            ))}

            {draft && draft.discarded.length > 0 && (
              <div className="border border-dashed border-line rounded-xl p-3 sm:p-4 space-y-2 bg-bg-2/40">
                <div className="flex items-center gap-2 text-xs font-semibold text-ink-3 uppercase tracking-wide">
                  <Trash2 size={12} /> Discarded ({draft.discarded.length}) — deleted when you scan · tap to restore
                </div>
                <div className="flex gap-2 flex-wrap">
                  {draft.discarded.map(id => {
                    const f = fileById.get(id)
                    return f ? (
                      <PageThumb key={id} file={f} index={null} selected={false} dim restoreMode onToggle={() => restore(id)} />
                    ) : null
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Footer: selection bar (when selecting) + confirm, both pinned */}
          <div className="border-t border-line shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
            {selection && draft && (
              <div className="px-4 sm:px-5 py-2.5 bg-ink text-paper flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold">{selection.count} selected <span className="text-paper/60 font-normal">{selection.from}</span></span>
                <div className="ml-auto flex items-center gap-1.5 flex-wrap">
                  <div className="relative">
                    <button
                      type="button"
                      disabled={selection.hasNonPhoto || selection.targets.length === 0}
                      onClick={() => setMoveMenu(m => !m)}
                      title={selection.hasNonPhoto ? 'A PDF or spreadsheet is always its own invoice' : selection.targets.length === 0 ? 'No other invoice to move to' : 'Move to another invoice'}
                      className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg bg-paper/10 hover:bg-paper/20 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ArrowRightLeft size={12} /> Move to
                    </button>
                    {moveMenu && (
                      <>
                        <div className="fixed inset-0 z-[70]" onClick={() => setMoveMenu(false)} />
                        <div className="absolute right-0 bottom-10 z-[71] bg-paper text-ink border border-line rounded-xl shadow-xl py-1 min-w-[220px] max-h-64 overflow-y-auto">
                          {selection.targets.map(({ g, i }) => (
                            <button key={i} type="button" onClick={() => move({ group: i })}
                              className="w-full text-left px-3 py-2 text-[13px] hover:bg-bg-2 truncate">
                              {groupLabel(g, i)}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <button type="button" onClick={() => move('new')}
                    className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg bg-paper/10 hover:bg-paper/20 text-xs font-medium">
                    <FolderPlus size={12} /> New invoice
                  </button>
                  <button type="button" onClick={discardSelected}
                    className="inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg bg-red/80 hover:bg-red text-xs font-medium">
                    <Trash2 size={12} /> Discard
                  </button>
                  <button type="button" onClick={clearSel} className="w-8 h-8 grid place-items-center rounded-lg hover:bg-paper/10" title="Clear selection" aria-label="Clear selection">
                    <X size={14} />
                  </button>
                </div>
              </div>
            )}
            <div className="px-4 sm:px-5 py-3.5">
              <button
                type="button"
                onClick={confirm}
                disabled={!canConfirm}
                className="w-full bg-ink text-paper [&_svg]:text-gold rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-ink-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {confirming ? <Loader2 size={18} className="animate-spin" /> : <ScanLine size={18} />}
                {confirming
                  ? 'Starting scans…'
                  : draft && draft.unassigned.length > 0 && !allUnassigned
                    ? `Place ${draft.unassigned.length} unplaced ${draft.unassigned.length > 1 ? 'pages' : 'page'} first`
                    : `Scan ${draft?.groups.length ?? 0} invoice${draft?.groups.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Full-size viewer: nudge a page inside its invoice, or discard it */}
      {viewing && draft && (
        <div className="fixed inset-0 z-[60] flex flex-col">
          <div className="fixed inset-0 bg-black/85" onClick={() => setViewingId(null)} />
          <div className="relative flex-1 min-h-0 flex flex-col items-center justify-center p-4 gap-2" onClick={() => setViewingId(null)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={viewing.fileUrl} alt={viewing.fileName} className="max-h-full max-w-full min-h-0 object-contain rounded-lg shadow-2xl" onClick={e => e.stopPropagation()} />
            <span className="text-[11px] font-mono text-paper/70 shrink-0">
              {viewingGroup >= 0 ? `Invoice ${viewingGroup + 1} · page ${viewingPos + 1} of ${viewingLen}` : draft.unassigned.includes(viewing.id) ? 'unplaced' : 'discarded'} · {viewing.fileName}
            </span>
          </div>
          <div className="relative bg-white w-full sm:max-w-md sm:mx-auto rounded-t-2xl shadow-xl p-3 flex items-center gap-2 shrink-0" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
            {viewingGroup >= 0 && viewingLen > 1 && (
              <>
                <button type="button" disabled={viewingPos === 0} onClick={() => nudge(viewing.id, -1)}
                  className="inline-flex items-center gap-1 px-2.5 h-9 rounded-lg border border-line text-sm text-ink-2 hover:bg-bg-2 disabled:opacity-40">
                  <ChevronLeft size={14} /> Earlier
                </button>
                <button type="button" disabled={viewingPos === viewingLen - 1} onClick={() => nudge(viewing.id, +1)}
                  className="inline-flex items-center gap-1 px-2.5 h-9 rounded-lg border border-line text-sm text-ink-2 hover:bg-bg-2 disabled:opacity-40">
                  Later <ChevronRight size={14} />
                </button>
              </>
            )}
            <button type="button" onClick={() => discardOne(viewing.id)}
              className="inline-flex items-center gap-1.5 px-2.5 h-9 rounded-lg text-sm font-semibold text-red-text hover:bg-red-soft">
              <Trash2 size={14} /> Discard
            </button>
            <button type="button" onClick={() => setViewingId(null)} className="ml-auto px-3 h-9 rounded-lg text-sm text-ink-4 hover:bg-bg-2">
              Close
            </button>
          </div>
        </div>
      )}

      {discardOpen && (
        <DiscardBatchDialog photoCount={files.length} noun={photoNoun} busy={discarding} onCancel={() => setDiscardOpen(false)} onConfirm={discardBatch} />
      )}
    </>
  )
}
