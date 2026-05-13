'use client'
// Invoice image viewer with:
//  • Auto-rotate to landscape on load (portrait photos of invoices are rotated 90°)
//  • Zoom / pan / rotate toolbar
//  • SVG bbox highlight overlay — animates to the active line item on expand

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  ZoomIn, ZoomOut, RotateCcw, RotateCw, Maximize2, FileText, Minus, Plus,
} from 'lucide-react'

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

export function ImageViewerV2({ files, activeBbox }: Props) {
  const [activeIdx,    setActiveIdx]    = useState(0)
  const [zoom,         setZoom]         = useState(1)
  const [rotation,     setRotation]     = useState(0)     // 0 / 90 / 180 / 270
  const [pan,          setPan]          = useState({ x: 0, y: 0 })
  const [isDragging,   setIsDragging]   = useState(false)
  const [naturalSize,  setNaturalSize]  = useState<{ w: number; h: number } | null>(null)
  const [bboxKey,      setBboxKey]      = useState(0)     // bumped to retrigger animation

  const containerRef = useRef<HTMLDivElement>(null)
  const dragStart    = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  const file    = files[activeIdx]
  const isPdf   = file?.fileType === 'application/pdf' || file?.fileName?.endsWith('.pdf')
  const isImage = file?.fileType?.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(file?.fileName ?? '')

  // ── Reset when switching files ──────────────────────────────────────────────
  useEffect(() => {
    setZoom(1); setRotation(0); setPan({ x: 0, y: 0 }); setNaturalSize(null)
  }, [activeIdx])

  // ── Switch page when activeBbox points to a different file ──────────────────
  useEffect(() => {
    if (activeBbox && activeBbox.page !== activeIdx) {
      setActiveIdx(activeBbox.page)
    }
  }, [activeBbox]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Record natural size on load (no auto-rotation — invoices may be portrait) ─
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight })
  }, [])

  // ── Auto-pan+zoom to activeBbox ─────────────────────────────────────────────
  const AUTO_ZOOM_MAX = 2.5   // cap auto-zoom so a thin line never fills the whole panel

  useEffect(() => {
    if (!activeBbox || activeBbox.page !== activeIdx || !naturalSize || !containerRef.current) return

    setBboxKey(k => k + 1)   // retrigger CSS animation

    const rect = containerRef.current.getBoundingClientRect()
    const cw = rect.width  - 32
    const ch = rect.height - 32
    if (cw <= 0 || ch <= 0) return

    // Rendered image size at zoom=1 in NATURAL orientation (before CSS rotation)
    const scale  = Math.min(cw / naturalSize.w, ch / naturalSize.h)
    const rendW  = naturalSize.w * scale
    const rendH  = naturalSize.h * scale

    // Bbox center as fraction (0–1) of natural image
    const bboxCx = activeBbox.x + activeBbox.w / 2
    const bboxCy = activeBbox.y + activeBbox.h / 2

    // Bbox visual size after rotation (axis-aligned bounding box of the rotated rect)
    const rad    = (rotation * Math.PI) / 180
    const cosA   = Math.abs(Math.cos(rad))
    const sinA   = Math.abs(Math.sin(rad))
    const bboxVisW = (activeBbox.w * cosA + activeBbox.h * sinA) * rendW
    const bboxVisH = (activeBbox.h * cosA + activeBbox.w * sinA) * rendH

    // Guard: skip auto-zoom for degenerate bboxes (too small to reliably center on)
    if (bboxVisW < 2 || bboxVisH < 2) return

    // Zoom so the bbox fills ~40% of the container's shorter dimension.
    // Cap at AUTO_ZOOM_MAX so thin single-line bboxes don't produce extreme zoom.
    const targetZoom = Math.min(
      Math.max((Math.min(cw, ch) * 0.4) / Math.max(bboxVisW, bboxVisH), 1.2),
      AUTO_ZOOM_MAX,
    )

    // Offset of bbox center from image center in natural image space (px)
    const dx = (bboxCx - 0.5) * rendW
    const dy = (bboxCy - 0.5) * rendH

    // Apply CSS rotation to the offset (CW positive in y-down space)
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const rdx = cos * dx - sin * dy
    const rdy = sin * dx + cos * dy

    // Pan so the rotated bbox center aligns with the container center,
    // clamped so the image can't be pushed completely out of view.
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
  const zoomIn     = () => setZoom(z => Math.min(ZOOM_MAX, +(z + ZOOM_STEP).toFixed(2)))
  const zoomOut    = () => setZoom(z => Math.max(ZOOM_MIN, +(z - ZOOM_STEP).toFixed(2)))
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

  // ── Toolbar button component ────────────────────────────────────────────────
  const Btn = ({ onClick, children, title, disabled }: {
    onClick: () => void; children: React.ReactNode; title: string; disabled?: boolean
  }) => (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className="p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  )

  // ── Active bbox — only show when it matches the current page ────────────────
  const showBbox = activeBbox && activeBbox.page === activeIdx && isImage

  return (
    <div className="flex flex-col bg-gray-50 shrink-0" style={{ width: '460px' }}>

      {/* File / page tabs */}
      {files.length > 1 && (
        <div className="flex gap-1 px-3 py-2 border-b border-gray-200 bg-white overflow-x-auto shrink-0">
          {files.map((f, i) => (
            <button
              key={f.id}
              onClick={() => setActiveIdx(i)}
              className={`px-3 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${
                activeIdx === i ? 'bg-amber-100 text-amber-700' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              Page {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar — images only */}
      {isImage && file?.fileUrl && (
        <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-gray-200 bg-white shrink-0">
          <Btn onClick={zoomOut} title="Zoom out (Ctrl/⌘ + scroll)" disabled={zoom <= ZOOM_MIN}>
            <Minus size={14} />
          </Btn>
          <span className="text-xs font-mono text-gray-400 w-12 text-center select-none">
            {Math.round(zoom * 100)}%
          </span>
          <Btn onClick={zoomIn} title="Zoom in" disabled={zoom >= ZOOM_MAX}>
            <Plus size={14} />
          </Btn>
          <div className="w-px h-4 bg-gray-200 mx-1" />
          <Btn onClick={rotateLeft}  title="Rotate left"><RotateCcw size={14} /></Btn>
          <Btn onClick={rotateRight} title="Rotate right"><RotateCw size={14} /></Btn>
          <div className="w-px h-4 bg-gray-200 mx-1" />
          <Btn onClick={reset} title="Reset view"><Maximize2 size={14} /></Btn>
          {showBbox && (
            <span className="ml-auto text-[10.5px] text-amber-600 font-medium px-2 py-0.5 bg-amber-50 rounded">
              line highlighted
            </span>
          )}
        </div>
      )}

      {/* Image / PDF / fallback */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden flex items-center justify-center p-4 select-none relative"
        style={{ cursor: isImage && zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
      >
        {isImage && file?.fileUrl ? (
          <div
            className="relative"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          >
            {/* Invoice image */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={file.fileUrl}
              alt={file.fileName}
              draggable={false}
              onLoad={handleImageLoad}
              className="max-w-full rounded-lg shadow-sm border border-gray-200 object-contain block"
            />

            {/* SVG highlight overlay — sits exactly over the image */}
            {showBbox && (
              <svg
                key={bboxKey}                   // remount = retrigger animation
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full rounded-lg pointer-events-none overflow-visible"
              >
                {/* Amber fill */}
                <rect
                  className="bbox-highlight"
                  x={activeBbox!.x}
                  y={activeBbox!.y}
                  width={activeBbox!.w}
                  height={activeBbox!.h}
                  fill="rgba(251, 191, 36, 0.22)"
                  rx="0.004"
                />
                {/* Amber stroke ring */}
                <rect
                  className="bbox-ring"
                  x={activeBbox!.x}
                  y={activeBbox!.y}
                  width={activeBbox!.w}
                  height={activeBbox!.h}
                  fill="none"
                  stroke="rgb(245, 158, 11)"
                  strokeWidth="0.003"
                  rx="0.004"
                />
                {/* Corner accents — top-left and bottom-right only */}
                <CornerAccent
                  cx={activeBbox!.x}
                  cy={activeBbox!.y}
                  size={0.018}
                  position="tl"
                />
                <CornerAccent
                  cx={activeBbox!.x + activeBbox!.w}
                  cy={activeBbox!.y + activeBbox!.h}
                  size={0.018}
                  position="br"
                />
              </svg>
            )}
          </div>
        ) : isPdf && file?.fileUrl ? (
          <iframe
            src={file.fileUrl}
            title={file.fileName}
            className="w-full rounded-lg border border-gray-200 bg-white"
            style={{ height: '100%', minHeight: '600px' }}
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 text-gray-400 h-full">
            <FileText size={40} className="text-gray-300" />
            <p className="text-sm">{file?.fileName ?? 'No file'}</p>
            {file?.fileUrl && (
              <a href={file.fileUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">
                Open file ↗
              </a>
            )}
          </div>
        )}
      </div>

      {/* File name footer */}
      <div className="px-3 py-2 border-t border-gray-200 bg-white shrink-0">
        <p className="text-[10px] text-gray-400 truncate">{file?.fileName}</p>
      </div>
    </div>
  )
}

// ── Corner accent ──────────────────────────────────────────────────────────────
// Small L-shaped bracket at the highlight corners (like camera focus brackets).

function CornerAccent({
  cx, cy, size, position,
}: {
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
