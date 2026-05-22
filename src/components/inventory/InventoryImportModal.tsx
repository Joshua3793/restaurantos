'use client'
import { useState } from 'react'
import { X, UploadCloud, Download, CheckCircle2, AlertCircle, Copy } from 'lucide-react'
import type { ImportReport } from '@/lib/inventory-import'

interface Props {
  onClose: () => void
  onImported: () => void
}

type Step = 'upload' | 'preview' | 'done'

export function InventoryImportModal({ onClose, onImported }: Props) {
  const [step, setStep]       = useState<Step>('upload')
  const [file, setFile]       = useState<File | null>(null)
  const [report, setReport]   = useState<ImportReport | null>(null)
  const [createdCount, setCreatedCount] = useState(0)
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState<string | null>(null)

  async function runPreview(selected: File) {
    setBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', selected)
      const res = await fetch('/api/inventory/import/preview', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Could not read the file'); return }
      setReport(data as ImportReport)
      setStep('preview')
    } catch {
      setError('Network error — try again.')
    } finally {
      setBusy(false)
    }
  }

  async function runImport() {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/inventory/import', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Import failed'); return }
      setCreatedCount(data.created ?? 0)
      setStep('done')
    } catch {
      setError('Network error — try again.')
    } finally {
      setBusy(false)
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    runPreview(f)
  }

  const statusStyle: Record<string, string> = {
    valid:     'bg-green-50 text-green-700',
    error:     'bg-red-50 text-red-700',
    duplicate: 'bg-amber-50 text-amber-700',
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      role="dialog" aria-modal="true"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100 shrink-0">
          <div>
            <h2 className="font-semibold text-gray-900">Import Inventory</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Bulk-add items from a .csv or .xlsx file
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="p-2.5 flex items-center justify-center text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 flex-1 overflow-y-auto">
          {error && (
            <div className="mb-4 flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              <AlertCircle size={15} className="shrink-0" /> {error}
            </div>
          )}

          {step === 'upload' && (
            <div className="space-y-4">
              <a href="/api/inventory/import/template"
                className="flex items-center gap-2 text-sm text-gold hover:underline">
                <Download size={15} /> Download the import template
              </a>
              <p className="text-xs text-gray-500">
                Fill the template, then upload it below. Items import into the
                <span className="font-semibold"> UNASSIGNED</span> category — review
                and assign their category, supplier, and storage area afterward.
              </p>
              <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-gray-200 rounded-xl py-10 cursor-pointer hover:border-[#c9a84c] transition-colors">
                <UploadCloud size={28} className="text-gray-300" />
                <span className="text-sm text-gray-500">
                  {busy ? 'Reading file…' : 'Choose a .csv or .xlsx file'}
                </span>
                <input type="file" accept=".csv,.xlsx" className="hidden"
                  disabled={busy} onChange={handleFile} />
              </label>
            </div>
          )}

          {step === 'preview' && report && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs font-medium">
                <span className="px-2 py-1 rounded-full bg-green-50 text-green-700">
                  {report.validCount} valid
                </span>
                <span className="px-2 py-1 rounded-full bg-red-50 text-red-700">
                  {report.errorCount} errors
                </span>
                <span className="px-2 py-1 rounded-full bg-amber-50 text-amber-700">
                  {report.duplicateCount} duplicates (skipped)
                </span>
              </div>
              <div className="border border-gray-100 rounded-xl divide-y divide-gray-50 max-h-[45vh] overflow-y-auto">
                {report.rows.map(r => (
                  <div key={r.rowNumber} className="px-3 py-2 flex items-start gap-2 text-sm">
                    <span className="text-gray-300 tabular-nums shrink-0 w-7">
                      {r.rowNumber}
                    </span>
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${statusStyle[r.status]}`}>
                      {r.status}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-gray-800 truncate">{r.itemName || '(no name)'}</div>
                      {r.status === 'error' && (
                        <ul className="text-xs text-red-600 mt-0.5 list-disc pl-4">
                          {r.errors.map((e, i) => <li key={i}>{e}</li>)}
                        </ul>
                      )}
                      {r.status === 'valid' && r.computed && (
                        <div className="text-xs text-gray-400 mt-0.5">
                          {r.computed.pricePerBaseUnit.toFixed(4)} / {r.computed.baseUnit}
                        </div>
                      )}
                      {r.status === 'duplicate' && (
                        <div className="text-xs text-amber-600 mt-0.5 flex items-center gap-1">
                          <Copy size={11} /> Already in inventory — skipped
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <CheckCircle2 size={40} className="text-green-500" />
              <p className="text-gray-800 font-medium">
                Created {createdCount} item{createdCount !== 1 ? 's' : ''}.
              </p>
              <p className="text-sm text-gray-500 max-w-sm">
                They are in the <span className="font-semibold">UNASSIGNED</span> category —
                review and assign their category, supplier, and storage area.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-5 border-t border-gray-100 shrink-0">
          {step === 'preview' && (
            <>
              <button type="button" onClick={() => { setStep('upload'); setReport(null); setFile(null) }}
                disabled={busy}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                Back
              </button>
              <button type="button" onClick={runImport}
                disabled={busy || !report || report.validCount === 0}
                className="px-4 py-2 text-sm bg-gold text-white rounded-lg hover:bg-[#a88930] disabled:opacity-50">
                {busy ? 'Importing…' : `Import ${report?.validCount ?? 0} item${report?.validCount === 1 ? '' : 's'}`}
              </button>
            </>
          )}
          {step === 'done' && (
            <button type="button" onClick={() => { onImported(); onClose() }}
              className="px-4 py-2 text-sm bg-gold text-white rounded-lg hover:bg-[#a88930]">
              Done
            </button>
          )}
          {step === 'upload' && (
            <button type="button" onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50">
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
