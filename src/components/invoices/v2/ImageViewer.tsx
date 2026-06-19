'use client'
// Invoice image viewer with zoom / pan / rotate toolbar and SVG bbox highlight.

import { useState, useRef, useEffect, useCallback } from 'react'
import { RotateCcw, RotateCw, Maximize2, FileText, Minus, Plus } from 'lucide-react'

export interface BBox {
  page: number   // 0-indexed file index
  x: number      // left edge as fraction of image width  (0–1)
  y: number      // top edge  as fraction of image height (0–1)
  w: number      // width  as fraction of image width
  h: number      // height as fraction of image height
}

interface Props {
  files: Array<{ id: string; fileName: string; fileType: string; fileUrl: string; displayRotation?: number }>
  activeBbox?: BBox | null
  /** Session id — needed to persist a user-corrected page rotation. */
  sessionId?: string
  /** Called after the user rotates a page so the parent can keep files in sync. */
  onFileRotated?: (fileId: string, displayRotation: number) => void
}

/** Normalize any rotation to 0/90/180/270. */
function normRot(deg: number | undefined): number {
  return ((((deg ?? 0) % 360) + 360) % 360) as 0 | 90 | 180 | 270
}

const ZOOM_STEP = 0.25
const ZOOM_MIN  = 0.25
const ZOOM_MAX  = 6
const PADDING   = 16   // px of inset padding around the image

export function ImageViewerV2({ files, activeBbox, sessionId, onFileRotated }: Props) {
  const [activeIdx,   setActiveIdx]   = useState(0)
  const [zoom,        setZoom]        = useState(1)
  const [rotation,    setRotation]    = useState(0)
  // User-corrected page rotation (persisted) — overrides the OCR's guess.
  const [pageRot,     setPageRot]     = useState<number | null>(null)
  const [pan,         setPan]         = useState({ x: 0, y: 0 })
  const [isDragging,  setIsDragging]  = useState(false)
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null)
  const [bboxKey,     setBboxKey]     = useState(0)
  // Pixel rect of the rendered image inside containerRef (for bbox SVG positioning)
  const [imgRect,     setImgRect]     = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const dragStart    = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  const file    = files[activeIdx]
  const isPdf   = file?.fileType === 'application/pdf' || file?.fileName?.endsWith('.pdf')
  const isImage = file?.fileType?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(file?.fileName ?? '')

  // Page rotation Claude reported (degrees CW to make the stored image upright).
  // The whole viewer works in the UPRIGHT frame: bbox coords, the contain rect,
  // and auto-zoom all use upright dims; only the <img> itself is rotated.
  const baseRotation = normRot(pageRot ?? file?.displayRotation)
  const swap = baseRotation === 90 || baseRotation === 270

  // ── Compute the pixel rect of the contained (upright) image ─────────────────
  // object-fit: contain centres the image and letterboxes — we need the exact
  // rendered rect so the bbox SVG overlay aligns with the visible pixels. `ns`
  // is the RAW natural size; we swap W/H when the page is rotated 90/270.
  const computeImgRect = useCallback((ns: { w: number; h: number }) => {
    const c = containerRef.current
    if (!c) return
    const o = swap ? { w: ns.h, h: ns.w } : ns   // upright dimensions
    const availW = c.clientWidth  - PADDING * 2
    const availH = c.clientHeight - PADDING * 2
    if (availW <= 0 || availH <= 0) return
    const scale = Math.min(availW / o.w, availH / o.h)
    const rw = o.w * scale
    const rh = o.h * scale
    setImgRect({
      x: PADDING + (availW - rw) / 2,
      y: PADDING + (availH - rh) / 2,
      w: rw,
      h: rh,
    })
  }, [swap])

  // Recompute whenever container resizes (also fires when hidden → visible on tab switch)
  useEffect(() => {
    const c = containerRef.current
    if (!c || !naturalSize) return
    const obs = new ResizeObserver(() => computeImgRect(naturalSize))
    obs.observe(c)
    computeImgRect(naturalSize)
    return () => obs.disconnect()
  }, [naturalSize, computeImgRect])

  // ── Reset when switching files ──────────────────────────────────────────────
  useEffect(() => {
    setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }); setNaturalSize(null); setImgRect(null); setPageRot(null)
  }, [activeIdx])

  // ── Switch page when activeBbox points to a different file ──────────────────
  useEffect(() => {
    if (activeBbox && activeBbox.page !== activeIdx) setActiveIdx(activeBbox.page)
  }, [activeBbox]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Record natural size on load ─────────────────────────────────────────────
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const ns = { w: img.naturalWidth, h: img.naturalHeight }
    setNaturalSize(ns)
    computeImgRect(ns)
  }, [computeImgRect])

  // ── Auto-pan+zoom to activeBbox ─────────────────────────────────────────────
  const AUTO_ZOOM_MAX = 2.5

  useEffect(() => {
    if (!activeBbox || activeBbox.page !== activeIdx || !naturalSize || !containerRef.current) return

    setBboxKey(k => k + 1)

    const rect = containerRef.current.getBoundingClientRect()
    const cw = rect.width  - PADDING * 2
    const ch = rect.height - PADDING * 2
    if (cw <= 0 || ch <= 0) return

    // Work in the UPRIGHT frame (bbox coords are upright).
    const oW = swap ? naturalSize.h : naturalSize.w
    const oH = swap ? naturalSize.w : naturalSize.h
    const scale  = Math.min(cw / oW, ch / oH)
    const rendW  = oW * scale
    const rendH  = oH * scale

    const bboxCx = activeBbox.x + activeBbox.w / 2
    const bboxCy = activeBbox.y + activeBbox.h / 2

    const rad    = (rotation * Math.PI) / 180
    const cosA   = Math.abs(Math.cos(rad))
    const sinA   = Math.abs(Math.sin(rad))
    const bboxVisW = (activeBbox.w * cosA + activeBbox.h * sinA) * rendW
    const bboxVisH = (activeBbox.h * cosA + activeBbox.w * sinA) * rendH

    if (bboxVisW < 2 || bboxVisH < 2) return

    const targetZoom = Math.min(
      Math.max((Math.min(cw, ch) * 0.4) / Math.max(bboxVisW, bboxVisH), 1.2),
      AUTO_ZOOM_MAX,
    )

    const dx = (bboxCx - 0.5) * rendW
    const dy = (bboxCy - 0.5) * rendH
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const rdx = cos * dx - sin * dy
    const rdy = sin * dx + cos * dy

    const panX = -rdx * targetZoom
    const panY = -rdy * targetZoom
    const maxPanX = (rendW  * targetZoom - cw)  / 2
    const maxPanY = (rendH  * targetZoom - ch) / 2
    setZoom(targetZoom)
    setPan({
      x: Math.max(-maxPanX, Math.min(maxPanX, panX)),
      y: Math.max(-maxPanY, Math.min(maxPanY, panY)),
    })
  }, [activeBbox, activeIdx, naturalSize, rotation, swap]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Toolbar actions ─────────────────────────────────────────────────────────
  const zoomIn      = () => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))
  const zoomOut     = () => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))
  // Rotating the PAGE re-orients the image within the fixed bbox frame so the
  // highlight keeps tracing the rows; persist it so the scan stays straight.
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
  const rotateRight = () => rotatePage(90)
  const rotateLeft  = () => rotatePage(270)
  const reset       = () => { setZoom(1); setPan({ x: 0, y: 0 }) }

  // ── Mouse-wheel zoom ────────────────────────────────────────────────────────
  const handleWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    if (e.deltaY < 0) zoomIn(); else zoomOut()
  }

  // ── Drag-to-pan ─────────────────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom <= 1) return
    setIsDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
  }
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !dragStart.current) return
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    })
  }
  const stopDrag = () => { setIsDragging(false); dragStart.current = null }

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

  const showBbox = activeBbox && activeBbox.page === activeIdx && isImage

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`
  const transition = isDragging ? 'none' : 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)'

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
          <span className="text-xs font-mono text-ink-4 w-12 text-center select-none">
            {Math.round(zoom * 100)}%
          </span>
          <Btn onClick={zoomIn} title="Zoom in" disabled={zoom >= ZOOM_MAX}><Plus size={14} /></Btn>
          <div className="w-px h-4 bg-[#3a352d] mx-1" />
          <Btn onClick={rotateLeft}  title="Rotate left"><RotateCcw size={14} /></Btn>
          <Btn onClick={rotateRight} title="Rotate right"><RotateCw size={14} /></Btn>
          <div className="w-px h-4 bg-[#3a352d] mx-1" />
          <Btn onClick={reset} title="Reset view"><Maximize2 size={14} /></Btn>
          {showBbox && (
            <span className="ml-auto text-[10.5px] text-[#fcd34d] font-medium px-2 py-0.5 bg-gold/15 rounded">
              line highlighted
            </span>
          )}
        </div>
      )}

      {/* Image / PDF / fallback */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden select-none relative"
        style={{ cursor: isImage && zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
      >
        {isImage && file?.fileUrl ? (
          <>
            {/* Hidden loader — captures the raw natural size before we can place
                the precise upright group. */}
            {(!imgRect || !naturalSize) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={file.fileUrl}
                alt=""
                onLoad={handleImageLoad}
                style={{
                  position: 'absolute', left: PADDING, top: PADDING,
                  width: `calc(100% - ${PADDING * 2}px)`, height: `calc(100% - ${PADDING * 2}px)`,
                  objectFit: 'contain', opacity: 0, pointerEvents: 'none',
                }}
              />
            )}

            {/* Upright image group — positioned at the contained UPRIGHT rect and
                carrying pan/zoom/user-rotation. The <img> inside is rotated by the
                page's baseRotation so its content reads upright; the bbox overlay
                lives in the same upright frame, so highlights trace the rows. */}
            {imgRect && naturalSize && (
              <div
                style={{
                  position: 'absolute',
                  left: imgRect.x, top: imgRect.y, width: imgRect.w, height: imgRect.h,
                  transform, transformOrigin: 'center center', transition,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={file.fileUrl}
                  alt={file.fileName}
                  draggable={false}
                  onLoad={handleImageLoad}
                  className="rounded-lg shadow-sm border border-line"
                  style={
                    swap
                      ? {
                          position: 'absolute',
                          width: imgRect.h, height: imgRect.w,
                          left: (imgRect.w - imgRect.h) / 2, top: (imgRect.h - imgRect.w) / 2,
                          objectFit: 'contain', display: 'block', userSelect: 'none',
                          transform: `rotate(${baseRotation}deg)`, transformOrigin: 'center center',
                        }
                      : {
                          position: 'absolute', inset: 0, width: '100%', height: '100%',
                          objectFit: 'contain', display: 'block', userSelect: 'none',
                          transform: baseRotation === 180 ? 'rotate(180deg)' : 'none',
                        }
                  }
                />

                {/* SVG bbox overlay — upright frame, fills the group */}
                {showBbox && (
              <svg
                key={bboxKey}
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  pointerEvents: 'none',
                  overflow: 'visible',
                }}
                className="rounded-lg"
              >
                <rect
                  className="bbox-highlight"
                  x={activeBbox!.x} y={activeBbox!.y}
                  width={activeBbox!.w} height={activeBbox!.h}
                  fill="rgba(251, 191, 36, 0.22)" rx="0.004"
                />
                <rect
                  className="bbox-ring"
                  x={activeBbox!.x} y={activeBbox!.y}
                  width={activeBbox!.w} height={activeBbox!.h}
                  fill="none" stroke="rgb(245, 158, 11)" strokeWidth="0.003" rx="0.004"
                />
                <CornerAccent cx={activeBbox!.x} cy={activeBbox!.y} size={0.018} position="tl" />
                <CornerAccent cx={activeBbox!.x + activeBbox!.w} cy={activeBbox!.y + activeBbox!.h} size={0.018} position="br" />
              </svg>
                )}
              </div>
            )}
          </>
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

// ── Corner accent ──────────────────────────────────────────────────────────────
function CornerAccent({ cx, cy, size, position }: {
  cx: number; cy: number; size: number; position: 'tl' | 'br'
}) {
  const s = size
  const paths = {
    tl: `M ${cx + s} ${cy} L ${cx} ${cy} L ${cx} ${cy + s}`,
    br: `M ${cx - s} ${cy} L ${cx} ${cy} L ${cx} ${cy - s}`,
  }
  return (
    <path
      className="bbox-ring"
      d={paths[position]}
      fill="none"
      stroke="rgb(245, 158, 11)"
      strokeWidth="0.004"
      strokeLinecap="round"
    />
  )
}
