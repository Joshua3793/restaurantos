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
  files: Array<{ id: string; fileName: string; fileType: string; fileUrl: string }>
  activeBbox?: BBox | null
}

const ZOOM_STEP = 0.25
const ZOOM_MIN  = 0.25
const ZOOM_MAX  = 6
const PADDING   = 16   // px of inset padding around the image

export function ImageViewerV2({ files, activeBbox }: Props) {
  const [activeIdx,   setActiveIdx]   = useState(0)
  const [zoom,        setZoom]        = useState(1)
  const [rotation,    setRotation]    = useState(0)
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

  // ── Compute the pixel rect of the contained image ──────────────────────────
  // object-fit: contain centres the image and letterboxes — we need the exact
  // rendered rect so the bbox SVG overlay aligns with the visible pixels.
  const computeImgRect = useCallback((ns: { w: number; h: number }) => {
    const c = containerRef.current
    if (!c) return
    const availW = c.clientWidth  - PADDING * 2
    const availH = c.clientHeight - PADDING * 2
    if (availW <= 0 || availH <= 0) return
    const scale = Math.min(availW / ns.w, availH / ns.h)
    const rw = ns.w * scale
    const rh = ns.h * scale
    setImgRect({
      x: PADDING + (availW - rw) / 2,
      y: PADDING + (availH - rh) / 2,
      w: rw,
      h: rh,
    })
  }, [])

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
    setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }); setNaturalSize(null); setImgRect(null)
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

    const scale  = Math.min(cw / naturalSize.w, ch / naturalSize.h)
    const rendW  = naturalSize.w * scale
    const rendH  = naturalSize.h * scale

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
  }, [activeBbox, activeIdx, naturalSize, rotation]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Toolbar actions ─────────────────────────────────────────────────────────
  const zoomIn      = () => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))
  const zoomOut     = () => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))
  const rotateRight = () => setRotation(r => (r + 90) % 360)
  const rotateLeft  = () => setRotation(r => (r + 270) % 360)
  const reset       = () => { setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }) }

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
            {/* Image — object-fit:contain guarantees it fits the container at any size */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={file.fileUrl}
              alt={file.fileName}
              draggable={false}
              onLoad={handleImageLoad}
              className="rounded-lg shadow-sm border border-gray-200"
              style={{
                position: 'absolute',
                left: PADDING, top: PADDING, right: PADDING, bottom: PADDING,
                width: `calc(100% - ${PADDING * 2}px)`,
                height: `calc(100% - ${PADDING * 2}px)`,
                objectFit: 'contain',
                objectPosition: 'center',
                display: 'block',
                transform,
                transformOrigin: 'center center',
                transition,
                userSelect: 'none',
              }}
            />

            {/* SVG bbox overlay — positioned to match the rendered image pixels */}
            {showBbox && imgRect && (
              <svg
                key={bboxKey}
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                style={{
                  position: 'absolute',
                  left: imgRect.x,
                  top: imgRect.y,
                  width: imgRect.w,
                  height: imgRect.h,
                  pointerEvents: 'none',
                  overflow: 'visible',
                  transform,
                  transformOrigin: 'center center',
                  transition,
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
          </>
        ) : isPdf && file?.fileUrl ? (
          <div className="absolute inset-0 p-2">
            <iframe
              src={file.fileUrl}
              title={file.fileName}
              className="w-full h-full rounded-lg border border-gray-200 bg-paper"
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-gray-400">
            <FileText size={40} className="text-gray-300" />
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
