'use client'
// Invoice image viewer — single "plate" architecture (redesign per handoff brief).
//
// The image and the highlight live inside ONE element — the *plate* — which IS the
// upright image's coordinate space. The plate carries one transform; the highlight
// is a plain <div> addressed in percentages of the plate, so layout (not JS) keeps
// them locked together at every zoom / pan / rotation. No imgRect, no SVG, no
// ResizeObserver-measured pixel rect, no second size recompute.
//
// PDFs are rasterised per page with pdfjs-dist and fed the IDENTICAL plate/overlay
// path — a rasterised page is just an image with a known (upright) natW/natH.

import { useState, useRef, useEffect, useCallback } from 'react'
import { RotateCcw, RotateCw, Maximize2, FileText, Minus, Plus, Loader2 } from 'lucide-react'

export interface BBox {
  page: number   // 0-indexed page (image: file index · PDF: internal page index)
  x: number      // left edge as fraction of the UPRIGHT page width  (0–1)
  y: number      // top edge  as fraction of the UPRIGHT page height (0–1)
  w: number      // width  as fraction of the upright page width
  h: number      // height as fraction of the upright page height
}

interface Props {
  files: Array<{ id: string; fileName: string; fileType: string; fileUrl: string; displayRotation?: number }>
  activeBbox?: BBox | null
  /** Session id — needed to persist a user-corrected page rotation. */
  sessionId?: string
  /** Called after the user rotates a page so the parent can keep files in sync. */
  onFileRotated?: (fileId: string, displayRotation: number) => void
  /** Tapping the highlight returns to the line (mobile round-trip). */
  onPickRegion?: (bboxItemId: string) => void
  /** Item id behind the active bbox — passed back through onPickRegion. */
  activeBboxItemId?: string | null
}

const ZOOM_STEP = 0.25
const ZOOM_MIN  = 0.25
const ZOOM_MAX  = 6
const PAD       = 16   // px inset around the plate inside the stage
const AUTO_ZOOM_MIN = 1.35   // floor so a focused row actually reads as zoomed-in
const AUTO_ZOOM_MAX = 3.4

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const normRot = (deg: number | undefined): number => ((((deg ?? 0) % 360) + 360) % 360)
const isPdfFile   = (f?: { fileType?: string; fileName?: string }) =>
  f?.fileType === 'application/pdf' || !!f?.fileName?.toLowerCase().endsWith('.pdf')
const isImageFile = (f?: { fileType?: string; fileName?: string }) =>
  f?.fileType?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(f?.fileName ?? '')

interface Raster { url: string; w: number; h: number }

export function ImageViewerV2({ files, activeBbox, sessionId, onFileRotated, onPickRegion, activeBboxItemId }: Props) {
  const [activeIdx,   setActiveIdx]   = useState(0)
  const [zoom,        setZoom]        = useState(1)
  const [pan,         setPan]         = useState({ x: 0, y: 0 })
  const [isDragging,  setIsDragging]  = useState(false)
  const [stage,       setStage]       = useState<{ w: number; h: number } | null>(null)
  const [natural,     setNatural]     = useState<{ w: number; h: number } | null>(null)
  const [pageRot,     setPageRot]     = useState<number | null>(null)
  const [bboxKey,     setBboxKey]     = useState(0)
  // PDF rasterisation
  const [raster,      setRaster]      = useState<Raster | null>(null)
  const [pdfPages,    setPdfPages]    = useState(1)
  const [pdfFailed,   setPdfFailed]   = useState(false)
  const rasterCache = useRef<Map<string, Raster>>(new Map())

  const stageRef  = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  // A single PDF file is paged by its INTERNAL pages (activeIdx = page index);
  // otherwise each file is a page (activeIdx = file index).
  const singlePdf = files.length === 1 && isPdfFile(files[0])
  const file      = singlePdf ? files[0] : files[activeIdx]
  const isPdf     = isPdfFile(file)
  const isImage   = !isPdf && isImageFile(file)
  const tabCount  = singlePdf ? pdfPages : files.length

  // For a rasterised PDF the bitmap is already upright; images use the stored rotation.
  const baseRotation = isImage ? normRot(pageRot ?? file?.displayRotation) : 0
  const swapBase = baseRotation === 90 || baseRotation === 270

  const Wp = natural ? (swapBase ? natural.h : natural.w) : 0
  const Hp = natural ? (swapBase ? natural.w : natural.h) : 0

  const fit = (stage && Wp > 0 && Hp > 0)
    ? Math.min((stage.w - PAD * 2) / Wp, (stage.h - PAD * 2) / Hp)
    : 1
  const scale = fit * zoom

  const imgSrc = singlePdf ? raster?.url : file?.fileUrl
  const plateReady = (isImage && !!file?.fileUrl) || (singlePdf && !!raster)

  // ── Stage size — ONE ResizeObserver ─────────────────────────────────────────
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // ── Reset view when switching page/file ─────────────────────────────────────
  useEffect(() => {
    setZoom(1); setPan({ x: 0, y: 0 }); setNatural(null); setPageRot(null)
    if (!singlePdf) { setRaster(null); setPdfFailed(false) }
  }, [activeIdx, singlePdf])

  // ── Switch page when the active bbox points elsewhere ───────────────────────
  useEffect(() => {
    if (activeBbox && activeBbox.page !== activeIdx) setActiveIdx(activeBbox.page)
  }, [activeBbox]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Rasterise the active PDF page (lazy, cached by file+page) ────────────────
  useEffect(() => {
    if (!singlePdf || !file?.fileUrl) return
    const pageIdx = activeIdx
    const key = `${file.id}:${pageIdx}`
    const hit = rasterCache.current.get(key)
    if (hit) { setRaster(hit); setNatural({ w: hit.w, h: hit.h }); return }
    let cancelled = false
    setRaster(null); setPdfFailed(false)
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist')
        // Worker is served statically from /public (copied from pdfjs-dist build).
        // Referencing it as a plain string keeps webpack from bundling it.
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
        const doc = await pdfjs.getDocument({ url: file.fileUrl }).promise
        if (!cancelled) setPdfPages(doc.numPages)
        const page = await doc.getPage(Math.min(pageIdx + 1, doc.numPages))
        const vp = page.getViewport({ scale: 2 })   // 2× for crisp zoom
        const canvas = document.createElement('canvas')
        canvas.width = vp.width; canvas.height = vp.height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        await page.render({ canvasContext: ctx, viewport: vp }).promise
        const r: Raster = { url: canvas.toDataURL('image/png'), w: vp.width, h: vp.height }
        rasterCache.current.set(key, r)
        if (!cancelled) { setRaster(r); setNatural({ w: r.w, h: r.h }) }
      } catch {
        if (!cancelled) setPdfFailed(true)
      }
    })()
    return () => { cancelled = true }
  }, [singlePdf, file?.id, file?.fileUrl, activeIdx])

  // ── Focus: centre + frame the row in ONE coordinate space, no clamp ─────────
  useEffect(() => {
    if (!activeBbox || activeBbox.page !== activeIdx || !stage || Wp <= 0 || Hp <= 0) return
    setBboxKey(k => k + 1)
    const b = activeBbox
    const lx = (b.x + b.w / 2) * Wp - Wp / 2
    const ly = (b.y + b.h / 2) * Hp - Hp / 2
    const visW = b.w * Wp
    const visH = b.h * Hp
    if (visW < 1 || visH < 1) return
    const want = clamp(
      Math.min((stage.w * 0.98) / (visW * fit), (stage.h * 0.34) / (visH * fit)),
      AUTO_ZOOM_MIN, AUTO_ZOOM_MAX,
    )
    const s = fit * want
    setZoom(want)
    setPan({ x: -lx * s, y: -ly * s })
  }, [activeBbox, activeIdx, stage, Wp, Hp, fit])

  // ── Toolbar ──────────────────────────────────────────────────────────────────
  const zoomIn  = () => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))
  const zoomOut = () => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))
  const reset   = () => { setZoom(1); setPan({ x: 0, y: 0 }) }

  const rotatePage = (delta: number) => {
    if (!isImage) return   // rasterised PDFs are already upright
    const next = normRot((pageRot ?? normRot(file?.displayRotation)) + delta)
    setPageRot(next)
    if (file && sessionId) {
      fetch(`/api/invoices/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: file.id, displayRotation: next }),
      }).then(() => onFileRotated?.(file.id, next)).catch(() => {})
    }
  }

  const handleWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    if (e.deltaY < 0) zoomIn(); else zoomOut()
  }

  const beginDrag = (cx: number, cy: number) => {
    if (zoom <= 1) return
    setIsDragging(true)
    dragStart.current = { x: cx, y: cy, panX: pan.x, panY: pan.y }
  }
  const moveDrag = (cx: number, cy: number) => {
    if (!isDragging || !dragStart.current || !stage) return
    const maxX = Math.max(0, (Wp * scale - stage.w) / 2)
    const maxY = Math.max(0, (Hp * scale - stage.h) / 2)
    setPan({
      x: clamp(dragStart.current.panX + (cx - dragStart.current.x), -maxX, maxX),
      y: clamp(dragStart.current.panY + (cy - dragStart.current.y), -maxY, maxY),
    })
  }
  const endDrag = () => { setIsDragging(false); dragStart.current = null }

  const onMouseDown  = (e: React.MouseEvent) => beginDrag(e.clientX, e.clientY)
  const onMouseMove  = (e: React.MouseEvent) => moveDrag(e.clientX, e.clientY)
  const onTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]; if (t) beginDrag(t.clientX, t.clientY) }
  const onTouchMove  = (e: React.TouchEvent) => { const t = e.touches[0]; if (t) moveDrag(t.clientX, t.clientY) }

  const Btn = ({ onClick, children, title, disabled }: {
    onClick: () => void; children: React.ReactNode; title: string; disabled?: boolean
  }) => (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="p-1.5 rounded-md text-ink-4 hover:bg-[#3a352d] hover:text-bg-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  )

  const showBbox = !!activeBbox && activeBbox.page === activeIdx && plateReady && Wp > 0 && Hp > 0
  const showToolbar = isImage || singlePdf

  const imgStyle: React.CSSProperties = swapBase
    ? {
        position: 'absolute',
        width: Hp, height: Wp,
        left: (Wp - Hp) / 2, top: (Hp - Wp) / 2,
        transform: `rotate(${baseRotation}deg)`, transformOrigin: 'center center',
        objectFit: 'contain', display: 'block', userSelect: 'none',
      }
    : {
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        transform: baseRotation === 180 ? 'rotate(180deg)' : 'none',
        objectFit: 'contain', display: 'block', userSelect: 'none',
      }

  return (
    <div className="flex flex-col bg-[#1f1d1a] w-full md:flex-1 md:min-w-0 overflow-hidden">

      {/* File / page tabs */}
      {tabCount > 1 && (
        <div className="flex gap-1 px-3 py-2 border-b border-[#3a352d] bg-[#27241f] overflow-x-auto shrink-0">
          {Array.from({ length: tabCount }).map((_, i) => (
            <button
              key={singlePdf ? `p${i}` : files[i].id}
              onClick={() => setActiveIdx(i)}
              className={`px-3 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                activeIdx === i ? 'bg-gold/15 text-[#fcd34d]' : 'text-ink-4 hover:bg-[#3a352d]'
              }`}
            >
              Page {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar */}
      {showToolbar && file?.fileUrl && (
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-[#3a352d] bg-[#27241f] shrink-0">
          <Btn onClick={zoomOut} title="Zoom out" disabled={zoom <= ZOOM_MIN}><Minus size={14} /></Btn>
          <span className="text-xs font-mono text-ink-4 w-12 text-center select-none">{Math.round(zoom * 100)}%</span>
          <Btn onClick={zoomIn} title="Zoom in" disabled={zoom >= ZOOM_MAX}><Plus size={14} /></Btn>
          {isImage && (
            <>
              <div className="w-px h-4 bg-[#3a352d] mx-1" />
              <Btn onClick={() => rotatePage(270)} title="Rotate left"><RotateCcw size={14} /></Btn>
              <Btn onClick={() => rotatePage(90)}  title="Rotate right"><RotateCw size={14} /></Btn>
            </>
          )}
          <div className="w-px h-4 bg-[#3a352d] mx-1" />
          <Btn onClick={reset} title="Reset view"><Maximize2 size={14} /></Btn>
          {showBbox && (
            <span className="ml-auto text-[10.5px] text-[#fcd34d] font-medium px-2 py-0.5 bg-gold/15 rounded">
              line highlighted
            </span>
          )}
        </div>
      )}

      {/* Stage */}
      <div
        ref={stageRef}
        className="flex-1 overflow-hidden select-none relative flex items-center justify-center"
        style={{ cursor: plateReady && zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
        onWheel={handleWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={endDrag}
      >
        {plateReady && imgSrc ? (
          <div
            style={{
              position: 'relative',
              width: Wp > 0 ? Wp : (stage ? stage.w - PAD * 2 : '100%'),
              height: Hp > 0 ? Hp : (stage ? stage.h - PAD * 2 : '100%'),
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)',
              flex: 'none',
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imgSrc}
              alt={file.fileName}
              draggable={false}
              onLoad={singlePdf ? undefined : (e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }))}
              className="rounded-[3px] shadow-sm border border-line bg-paper"
              style={imgStyle}
            />

            {showBbox && (
              <div
                key={bboxKey}
                className="bbox-overlay"
                onClick={() => activeBboxItemId && onPickRegion?.(activeBboxItemId)}
                style={{
                  left:   `${activeBbox!.x * 100}%`,
                  top:    `${activeBbox!.y * 100}%`,
                  width:  `${activeBbox!.w * 100}%`,
                  height: `${activeBbox!.h * 100}%`,
                  ['--s' as string]: String(scale),
                }}
              >
                <div className="bbox-tag-fill" />
                <div className="bbox-tag-bar" />
              </div>
            )}
          </div>
        ) : singlePdf && !pdfFailed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-4">
            <Loader2 size={22} className="animate-spin" />
            <p className="text-xs">Rendering PDF…</p>
          </div>
        ) : isPdf && file?.fileUrl ? (
          // Multi-file PDF, or rasterisation failed → fallback link.
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-ink-4 p-4 text-center">
            <FileText size={40} className="text-ink-4" />
            <p className="text-sm">{file.fileName}</p>
            <a href={file.fileUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue hover:underline">
              Open PDF ↗
            </a>
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-ink-4">
            <FileText size={40} className="text-ink-4" />
            <p className="text-sm">{file?.fileName ?? 'No file'}</p>
            {file?.fileUrl && (
              <a href={file.fileUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue hover:underline">
                Open file ↗
              </a>
            )}
          </div>
        )}
      </div>

      {/* File name footer */}
      <div className="px-3 py-2 border-t border-[#3a352d] bg-[#27241f] shrink-0">
        <p className="font-mono text-[10px] text-ink-3 truncate">{file?.fileName}</p>
      </div>
    </div>
  )
}
