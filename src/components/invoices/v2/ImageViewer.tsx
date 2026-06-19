'use client'
// Invoice image viewer — single "plate" architecture (redesign per handoff brief).
//
// The image and the highlight live inside ONE element — the *plate* — which IS the
// upright image's coordinate space. The plate carries one transform; the highlight
// is a plain <div> addressed in percentages of the plate, so layout (not JS) keeps
// them locked together at every zoom / pan / rotation. No imgRect, no SVG, no
// ResizeObserver-measured pixel rect, no second size recompute.

import { useState, useRef, useEffect, useCallback } from 'react'
import { RotateCcw, RotateCw, Maximize2, FileText, Minus, Plus } from 'lucide-react'

export interface BBox {
  page: number   // 0-indexed file index
  x: number      // left edge as fraction of the UPRIGHT image width  (0–1)
  y: number      // top edge  as fraction of the UPRIGHT image height (0–1)
  w: number      // width  as fraction of the upright image width
  h: number      // height as fraction of the upright image height
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
const AUTO_ZOOM_MIN = 1
const AUTO_ZOOM_MAX = 3.4

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** Normalize a rotation to 0/90/180/270. */
const normRot = (deg: number | undefined): number => ((((deg ?? 0) % 360) + 360) % 360)

export function ImageViewerV2({ files, activeBbox, sessionId, onFileRotated, onPickRegion, activeBboxItemId }: Props) {
  const [activeIdx,   setActiveIdx]   = useState(0)
  const [zoom,        setZoom]        = useState(1)
  const [pan,         setPan]         = useState({ x: 0, y: 0 })
  const [isDragging,  setIsDragging]  = useState(false)
  const [stage,       setStage]       = useState<{ w: number; h: number } | null>(null)
  const [natural,     setNatural]     = useState<{ w: number; h: number } | null>(null)
  // Persisted per-file orientation correction (degrees CW to upright the storage).
  const [pageRot,     setPageRot]     = useState<number | null>(null)
  const [bboxKey,     setBboxKey]     = useState(0)

  const stageRef  = useRef<HTMLDivElement>(null)
  const dragStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  const file    = files[activeIdx]
  const isPdf   = file?.fileType === 'application/pdf' || file?.fileName?.endsWith('.pdf')
  const isImage = file?.fileType?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(file?.fileName ?? '')

  // baseRotation = the OCR page rotation (or the user's persisted correction):
  // how far to rotate stored pixels CW so the page reads upright.
  const baseRotation = normRot(pageRot ?? file?.displayRotation)
  const swapBase = baseRotation === 90 || baseRotation === 270

  // Upright natural dims of the active page (the plate's intrinsic size).
  const Wp = natural ? (swapBase ? natural.h : natural.w) : 0
  const Hp = natural ? (swapBase ? natural.w : natural.h) : 0

  // Fit-scale: the single source of truth for "100%". One computation.
  const fit = (stage && Wp > 0 && Hp > 0)
    ? Math.min((stage.w - PAD * 2) / Wp, (stage.h - PAD * 2) / Hp)
    : 1
  const scale = fit * zoom

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

  // ── Reset view when switching files ─────────────────────────────────────────
  useEffect(() => {
    setZoom(1); setPan({ x: 0, y: 0 }); setNatural(null); setPageRot(null)
  }, [activeIdx])

  // ── Switch page when the active bbox points elsewhere ───────────────────────
  useEffect(() => {
    if (activeBbox && activeBbox.page !== activeIdx) setActiveIdx(activeBbox.page)
  }, [activeBbox]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Focus: centre + frame the row in ONE coordinate space, no clamp ─────────
  useEffect(() => {
    if (!activeBbox || activeBbox.page !== activeIdx || !stage || Wp <= 0 || Hp <= 0) return
    setBboxKey(k => k + 1)
    const b = activeBbox
    // plate-centre → bbox-centre, in plate-local px (upright frame)
    const lx = (b.x + b.w / 2) * Wp - Wp / 2
    const ly = (b.y + b.h / 2) * Hp - Hp / 2
    // userRot is 0 here (rotate buttons correct storage orientation, not the view)
    const visW = b.w * Wp
    const visH = b.h * Hp
    if (visW < 1 || visH < 1) return
    const want = clamp(
      Math.min((stage.w * 0.62) / (visW * fit), (stage.h * 0.42) / (visH * fit)),
      AUTO_ZOOM_MIN, AUTO_ZOOM_MAX,
    )
    const s = fit * want
    setZoom(want)
    setPan({ x: -lx * s, y: -ly * s })   // exact centre — no clamp (kills overshoot)
  }, [activeBbox, activeIdx, stage, Wp, Hp, fit])

  // ── Toolbar ──────────────────────────────────────────────────────────────────
  const zoomIn  = () => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))
  const zoomOut = () => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))
  const reset   = () => { setZoom(1); setPan({ x: 0, y: 0 }) }

  // Rotating the PAGE re-orients the image within the fixed upright frame so the
  // highlight keeps tracing the rows; persist so the scan stays straight. (OCR's
  // auto-detected rotation is unreliable for no-EXIF sideways captures.)
  const rotatePage = (delta: number) => {
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

  // ── Drag-to-pan (mouse + touch) — clamp here, with max(0,…) so it can't invert ─
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

  const showBbox = !!activeBbox && activeBbox.page === activeIdx && isImage && Wp > 0 && Hp > 0

  // The image element's box inside the plate, corrected for storage orientation.
  const imgStyle: React.CSSProperties = swapBase
    ? {
        position: 'absolute',
        width: Hp, height: Wp,                       // swapped — fills plate after 90/270
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
      {files.length > 1 && (
        <div className="flex gap-1 px-3 py-2 border-b border-[#3a352d] bg-[#27241f] overflow-x-auto shrink-0">
          {files.map((f, i) => (
            <button
              key={f.id}
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
      {isImage && file?.fileUrl && (
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-[#3a352d] bg-[#27241f] shrink-0">
          <Btn onClick={zoomOut} title="Zoom out" disabled={zoom <= ZOOM_MIN}><Minus size={14} /></Btn>
          <span className="text-xs font-mono text-ink-4 w-12 text-center select-none">{Math.round(zoom * 100)}%</span>
          <Btn onClick={zoomIn} title="Zoom in" disabled={zoom >= ZOOM_MAX}><Plus size={14} /></Btn>
          <div className="w-px h-4 bg-[#3a352d] mx-1" />
          <Btn onClick={() => rotatePage(270)} title="Rotate left"><RotateCcw size={14} /></Btn>
          <Btn onClick={() => rotatePage(90)}  title="Rotate right"><RotateCw size={14} /></Btn>
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
        style={{ cursor: isImage && zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
        onWheel={handleWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={endDrag}
      >
        {isImage && file?.fileUrl ? (
          <div
            // The PLATE — sized to the upright natural dims; one transform; the
            // image and the highlight ride it together.
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
              src={file.fileUrl}
              alt={file.fileName}
              draggable={false}
              onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              className="rounded-[3px] shadow-sm border border-line bg-paper"
              style={imgStyle}
            />

            {/* Highlight — a % rect of the plate (Box style). --s counter-scales
                the ring so it stays ~2px crisp at any zoom. */}
            {showBbox && (
              <div
                key={bboxKey}
                className="bbox-overlay bbox-box"
                onClick={() => activeBboxItemId && onPickRegion?.(activeBboxItemId)}
                style={{
                  left:   `${activeBbox!.x * 100}%`,
                  top:    `${activeBbox!.y * 100}%`,
                  width:  `${activeBbox!.w * 100}%`,
                  height: `${activeBbox!.h * 100}%`,
                  ['--s' as string]: String(scale),
                }}
              >
                <div className="bbox-box-fill" />
                <span className="bbox-corner tl" />
                <span className="bbox-corner tr" />
                <span className="bbox-corner bl" />
                <span className="bbox-corner br" />
              </div>
            )}
          </div>
        ) : isPdf && file?.fileUrl ? (
          <div className="absolute inset-0 p-2">
            <iframe
              src={file.fileUrl}
              title={file.fileName}
              className="w-full h-full rounded-lg border border-line bg-paper"
            />
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
