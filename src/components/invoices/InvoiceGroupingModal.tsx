'use client'
import { useState, useEffect, useMemo, useRef } from 'react'
import { X, Loader2, ScanLine, FileText, FileSpreadsheet, AlertTriangle, Pencil, Trash2, Undo2 } from 'lucide-react'
import type { ProposedGroup } from '@/lib/invoice-grouping'

interface PeekFile { id: string; fileName: string; fileType: string; fileUrl: string }

interface Props {
  sessionId: string
  onClose: () => void   // keep the batch (session stays GROUPING, resumable from the list)
  onDone: () => void    // split committed + process fired for every invoice
}

function groupLabel(g: ProposedGroup, idx: number): string {
  const bits = [g.supplierName ?? 'Unknown supplier']
  if (g.invoiceNumber) bits.push(`#${g.invoiceNumber}`)
  if (g.invoiceDate) bits.push(g.invoiceDate)
  return `Invoice ${idx + 1} — ${bits.join(' · ')}`
}

// Tap-to-edit invoice number: the OCR read is a suggestion, the user is the
// authority. Committed value flows into the split prefill for that invoice.
function EditableInvoiceNumber({ value, onCommit }: { value: string | null; onCommit: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = () => {
    const v = draft.trim()
    onCommit(v.length ? v : null)
    setEditing(false)
  }

  if (!editing) {
    return (
      <button
        onClick={() => { setDraft(value ?? ''); setEditing(true) }}
        className="inline-flex items-center gap-1 font-mono text-xs px-1.5 py-0.5 rounded-md border border-line text-ink-2 hover:border-gold hover:text-ink transition-colors shrink-0"
        title="Correct the invoice number"
      >
        {value ? `#${value}` : 'no number'}
        <Pencil size={10} className="text-ink-4" />
      </button>
    )
  }
  return (
    <input
      ref={inputRef}
      autoFocus
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setEditing(false)
      }}
      placeholder="invoice #"
      className="font-mono text-xs px-1.5 py-0.5 rounded-md border border-gold outline-none w-32 shrink-0 text-ink"
    />
  )
}

// Module scope (project rule: sub-components defined inside a component body
// remount every render and lose state).
function FileThumb({ file, onClick }: { file: PeekFile; onClick: () => void }) {
  const isPdf = file.fileType === 'application/pdf' || file.fileName.toLowerCase().endsWith('.pdf')
  const isCsv = file.fileType === 'text/csv' || file.fileName.toLowerCase().endsWith('.csv')
  return (
    <button
      onClick={onClick}
      className="relative shrink-0 rounded-lg border border-line overflow-hidden hover:border-gold focus:border-gold transition-colors"
      title={`${file.fileName} — tap to view & assign`}
    >
      {isPdf || isCsv ? (
        <span className="h-28 w-20 grid place-items-center bg-bg-2">
          {isPdf ? <FileText size={20} className="text-red" /> : <FileSpreadsheet size={20} className="text-green" />}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={file.fileUrl} alt={file.fileName} className="h-28 w-20 object-cover" />
      )}
    </button>
  )
}

export function InvoiceGroupingModal({ sessionId, onClose, onDone }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<PeekFile[]>([])
  const [groups, setGroups] = useState<ProposedGroup[]>([])
  const [unassigned, setUnassigned] = useState<string[]>([])
  const [movingId, setMovingId] = useState<string | null>(null)
  const [discarded, setDiscarded] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(`/api/invoices/sessions/${sessionId}/peek`, { method: 'POST' })
        const j = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(j.error ?? `Couldn't read the photos (${res.status})`)
        if (!alive) return
        setFiles(j.files); setGroups(j.groups); setUnassigned(j.unassigned)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [sessionId])

  const fileById = useMemo(() => new Map(files.map(f => [f.id, f])), [files])

  // Move a file out of wherever it is, into groups[target] or a new group.
  const moveFile = (fileId: string, target: number | 'new') => {
    setUnassigned(prev => prev.filter(id => id !== fileId))
    setGroups(prev => {
      const stripped = prev
        .map(g => ({ ...g, fileIds: g.fileIds.filter(id => id !== fileId) }))
      const targetGroup = target === 'new'
        ? null
        : stripped[target] ?? null
      const next = stripped.filter(g => g.fileIds.length > 0 || g === targetGroup)
      if (targetGroup) targetGroup.fileIds.push(fileId)
      else next.push({ fileIds: [fileId], kind: 'photos', supplierName: null, invoiceNumber: null, invoiceDate: null })
      return next
    })
    setMovingId(null)
  }

  // Throw out a double-shot / blurry photo. Removed from every group (empty
  // groups drop) and queued for deletion at confirm; restorable until then.
  const discardFile = (fileId: string) => {
    setUnassigned(prev => prev.filter(id => id !== fileId))
    setGroups(prev => prev
      .map(g => ({ ...g, fileIds: g.fileIds.filter(id => id !== fileId) }))
      .filter(g => g.fileIds.length > 0))
    setDiscarded(prev => [...prev, fileId])
    setMovingId(null)
  }

  // Restore lands in "unassigned" so the user must place it deliberately.
  const restoreFile = (fileId: string) => {
    setDiscarded(prev => prev.filter(id => id !== fileId))
    setUnassigned(prev => [...prev, fileId])
  }

  const setGroupNumber = (idx: number, v: string | null) => {
    setGroups(prev => prev.map((g, i) => (i === idx ? { ...g, invoiceNumber: v } : g)))
  }

  // Peek totally failed (e.g. every photo unreadable) → offer today's behavior.
  const allUnassigned = !loading && !error && groups.length === 0 && unassigned.length > 0 && discarded.length === 0
  const scanAsOne = () => {
    setGroups([{ fileIds: files.map(f => f.id), kind: 'photos', supplierName: null, invoiceNumber: null, invoiceDate: null }])
    setUnassigned([])
    setDiscarded([])
  }

  const confirm = async () => {
    setConfirming(true); setError(null)
    try {
      const res = await fetch(`/api/invoices/sessions/${sessionId}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groups: groups.map(g => ({
            fileIds: g.fileIds,
            supplierName: g.supplierName,
            invoiceNumber: g.invoiceNumber,
            invoiceDate: g.invoiceDate,
          })),
          discardFileIds: discarded,
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? `Split failed (${res.status})`)
      // Fire OCR per invoice, fire-and-forget — the list's poll shows progress.
      for (const id of j.sessionIds as string[]) {
        fetch(`/api/invoices/sessions/${id}/process`, { method: 'POST' }).catch(() => {})
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setConfirming(false)
    }
  }

  const movingFromLabel = movingId
    ? groups.findIndex(g => g.fileIds.includes(movingId))
    : -1

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-2xl shadow-xl w-full max-w-2xl flex flex-col"
          style={{ maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 2rem)' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-line shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gold/15 flex items-center justify-center">
                <ScanLine size={16} className="text-gold" />
              </div>
              <div>
                <h2 className="text-base font-bold text-ink">Confirm invoices</h2>
                <p className="text-xs text-ink-4">Tap a photo to move it if something&apos;s misfiled</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg text-ink-4 hover:bg-bg-2" title="Keep for later">
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
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

            {allUnassigned && (
              <div className="bg-gold-soft border border-gold-soft rounded-xl p-4 text-sm text-gold-2 space-y-2">
                <p><strong>Couldn&apos;t read these photos.</strong> You can scan them all as one invoice instead.</p>
                <button onClick={scanAsOne} className="px-3 py-1.5 rounded-lg bg-ink text-paper text-xs font-semibold">
                  Scan as one invoice
                </button>
              </div>
            )}

            {!loading && unassigned.length > 0 && !allUnassigned && (
              <div className="border border-gold rounded-xl p-4 space-y-2 bg-gold-soft/40">
                <div className="flex items-center gap-2 text-sm font-semibold text-gold-2">
                  <AlertTriangle size={14} /> Couldn&apos;t place {unassigned.length} photo{unassigned.length > 1 ? 's' : ''} — tap to assign
                </div>
                <div className="flex gap-2 flex-wrap">
                  {unassigned.map(id => {
                    const f = fileById.get(id)
                    return f ? <FileThumb key={id} file={f} onClick={() => setMovingId(id)} /> : null
                  })}
                </div>
              </div>
            )}

            {groups.map((g, i) => (
              <div key={i} className="border border-line rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-semibold text-ink truncate">
                      Invoice {i + 1} — {g.supplierName ?? 'Unknown supplier'}
                    </span>
                    <EditableInvoiceNumber value={g.invoiceNumber} onCommit={v => setGroupNumber(i, v)} />
                    {g.invoiceDate && <span className="text-xs text-ink-4 shrink-0">{g.invoiceDate}</span>}
                  </span>
                  <span className="text-xs text-ink-4 shrink-0">
                    {g.fileIds.length} {g.kind === 'photos' ? `photo${g.fileIds.length > 1 ? 's' : ''}` : g.kind.toUpperCase()}
                  </span>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {g.fileIds.map(id => {
                    const f = fileById.get(id)
                    return f ? (
                      <FileThumb
                        key={id}
                        file={f}
                        onClick={() => g.kind === 'photos' ? setMovingId(id) : undefined}
                      />
                    ) : null
                  })}
                </div>
              </div>
            ))}
            {discarded.length > 0 && (
              <div className="border border-dashed border-line rounded-xl p-4 space-y-2 bg-bg-2/40">
                <div className="flex items-center gap-2 text-xs font-semibold text-ink-3 uppercase tracking-wide">
                  <Trash2 size={12} /> Discarded ({discarded.length}) — removed when you scan · tap to restore
                </div>
                <div className="flex gap-2 flex-wrap">
                  {discarded.map(id => {
                    const f = fileById.get(id)
                    return f ? (
                      <button
                        key={id}
                        onClick={() => restoreFile(id)}
                        className="relative shrink-0 rounded-lg border border-line overflow-hidden opacity-50 hover:opacity-90 transition-opacity"
                        title={`${f.fileName} — tap to restore`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={f.fileUrl} alt={f.fileName} className="h-20 w-14 object-cover" />
                        <span className="absolute inset-0 grid place-items-center bg-black/30">
                          <Undo2 size={16} className="text-paper" />
                        </span>
                      </button>
                    ) : null
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-5 py-4 border-t border-line shrink-0">
            <button
              onClick={confirm}
              disabled={loading || confirming || groups.length === 0 || unassigned.length > 0}
              className="w-full bg-ink text-paper [&_svg]:text-gold rounded-xl py-3 font-semibold flex items-center justify-center gap-2 hover:bg-ink-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {confirming ? <Loader2 size={18} className="animate-spin" /> : <ScanLine size={18} />}
              {confirming ? 'Starting scans…' : `Scan ${groups.length} invoice${groups.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>

      {/* Photo viewer + assign — you SEE the photo you're assigning, full size */}
      {movingId && (
        <div className="fixed inset-0 z-[60] flex flex-col">
          <div className="fixed inset-0 bg-black/85" onClick={() => setMovingId(null)} />
          {/* Image area: click anywhere outside the sheet closes */}
          <div
            className="relative flex-1 min-h-0 flex flex-col items-center justify-center p-4 gap-2"
            onClick={() => setMovingId(null)}
          >
            {(() => {
              const f = fileById.get(movingId)
              return f ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={f.fileUrl}
                    alt={f.fileName}
                    className="max-h-full max-w-full min-h-0 object-contain rounded-lg shadow-2xl"
                    onClick={e => e.stopPropagation()}
                  />
                  <span className="text-[11px] font-mono text-paper/70 shrink-0">{f.fileName}</span>
                </>
              ) : null
            })()}
          </div>
          {/* Assign sheet */}
          <div className="relative bg-white w-full sm:max-w-md sm:mx-auto rounded-t-2xl shadow-xl p-4 space-y-1.5 max-h-[40dvh] overflow-y-auto shrink-0">
            <p className="text-xs font-semibold text-ink-3 uppercase tracking-wide px-1 pb-1">Assign this photo to…</p>
            {groups.map((g, i) => (
              g.kind === 'photos' && i !== movingFromLabel ? (
                <button
                  key={i}
                  onClick={() => moveFile(movingId, i)}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-bg-2 text-sm text-ink-2"
                >
                  {groupLabel(g, i)}
                </button>
              ) : null
            ))}
            <button
              onClick={() => moveFile(movingId, 'new')}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-bg-2 text-sm font-semibold text-ink"
            >
              + New invoice
            </button>
            <button
              onClick={() => discardFile(movingId)}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-red-soft text-sm font-semibold text-red-text flex items-center gap-2"
            >
              <Trash2 size={14} /> Discard this photo
            </button>
            <button
              onClick={() => setMovingId(null)}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-bg-2 text-sm text-ink-4"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  )
}
