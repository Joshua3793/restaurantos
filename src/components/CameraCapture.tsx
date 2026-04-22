'use client'
/**
 * CameraCapture — full-screen camera overlay for invoice scanning.
 *
 * Features:
 *  • Live rear camera feed via getUserMedia (HTTPS / localhost)
 *  • Document frame guide: dark vignette + corner brackets + alignment tip
 *  • Real-time brightness indicator (updates every 600 ms)
 *  • Post-capture quality analysis: brightness, contrast, sharpness (Laplacian)
 *  • "Use Photo" / "Retake" flow per page; stays open so user can add more pages
 *  • Falls back gracefully when getUserMedia is unavailable (non-HTTPS LAN access)
 *    by using capture="environment" + the same post-capture quality analysis
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { X, RotateCcw, Check, AlertTriangle, Sun, Moon, Camera } from 'lucide-react'

// ─── Quality analysis ─────────────────────────────────────────────────────────

interface Quality {
  brightness: number   // 0–255 luminance average
  sharpness: number    // Laplacian mean (higher = sharper)
  warnings: string[]
}

function analyzeFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number
): Quality {
  if (!w || !h) return { brightness: 128, sharpness: 10, warnings: [] }
  // Sample a centre-crop for speed (max 320×240)
  const sw = Math.min(w, 320)
  const sh = Math.min(h, 240)
  const sx = Math.floor((w - sw) / 2)
  const sy = Math.floor((h - sh) / 2)
  const { data } = ctx.getImageData(sx, sy, sw, sh)

  let lumSum = 0
  let lumSqSum = 0
  const px = data.length / 4

  for (let i = 0; i < data.length; i += 4) {
    const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    lumSum   += l
    lumSqSum += l * l
  }
  const brightness = lumSum / px
  const contrast   = Math.sqrt(lumSqSum / px - brightness * brightness)

  // Laplacian sharpness — centre quarter, every 3rd pixel
  let lapSum = 0
  let lapCount = 0
  const cw = Math.floor(sw / 2)
  const ch = Math.floor(sh / 2)
  const cx0 = Math.floor(sw / 4)
  const cy0 = Math.floor(sh / 4)

  for (let y = cy0 + 1; y < cy0 + ch - 1; y += 3) {
    for (let x = cx0 + 1; x < cx0 + cw - 1; x += 3) {
      const i  = (y * sw + x) * 4
      const g  = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
      const iT = ((y - 1) * sw + x) * 4
      const iB = ((y + 1) * sw + x) * 4
      const iL = (y * sw + x - 1) * 4
      const iR = (y * sw + x + 1) * 4
      const gT = data[iT] * 0.299 + data[iT + 1] * 0.587 + data[iT + 2] * 0.114
      const gB = data[iB] * 0.299 + data[iB + 1] * 0.587 + data[iB + 2] * 0.114
      const gL = data[iL] * 0.299 + data[iL + 1] * 0.587 + data[iL + 2] * 0.114
      const gR = data[iR] * 0.299 + data[iR + 1] * 0.587 + data[iR + 2] * 0.114
      lapSum += Math.abs(4 * g - gT - gB - gL - gR)
      lapCount++
    }
  }
  const sharpness = lapCount > 0 ? lapSum / lapCount : 0

  const warnings: string[] = []
  if (brightness < 55)  warnings.push('Too dark — move to better lighting')
  if (brightness > 215) warnings.push('Too bright — avoid direct light on the page')
  if (contrast  < 15)   warnings.push('Low contrast — make sure the page is flat and fully lit')
  if (sharpness <  6)   warnings.push('May be blurry — hold the phone steady and wait for focus')

  return { brightness, sharpness, warnings }
}

// ─── Corner bracket SVG ───────────────────────────────────────────────────────

function Bracket({ color }: { color: string }) {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round">
      <path d="M2 18 L2 2 L18 2" />
    </svg>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  onCapture: (file: File) => void
  onClose:   () => void
  /** 1-based page number currently being captured */
  pageNumber: number
  maxPages:   number
}

export function CameraCapture({ onCapture, onClose, pageNumber, maxPages }: Props) {
  const videoRef       = useRef<HTMLVideoElement>(null)
  const canvasRef      = useRef<HTMLCanvasElement>(null)
  const fallbackRef    = useRef<HTMLInputElement>(null)
  const streamRef      = useRef<MediaStream | null>(null)
  const intervalRef    = useRef<ReturnType<typeof setInterval> | null>(null)

  const [mode, setMode]       = useState<'loading' | 'live' | 'fallback'>('loading')
  const [camError, setCamError] = useState<string | null>(null)
  const [liveReady, setLiveReady] = useState(false)

  // live brightness: 'dark' | 'ok' | 'bright'
  const [lightLevel, setLightLevel] = useState<'dark' | 'ok' | 'bright'>('ok')

  // post-capture preview state
  const [preview,   setPreview]   = useState<string | null>(null)
  const [quality,   setQuality]   = useState<Quality | null>(null)

  // ── Start camera: get stream, then set mode to 'live' ───────────────────────
  // NOTE: setMode('live') causes React to render the <video> element into the DOM.
  // We cannot set srcObject here because videoRef.current is still null at this point.
  // A second effect (below) attaches the stream once the element exists.
  useEffect(() => {
    let active = true

    if (!navigator.mediaDevices?.getUserMedia) {
      setMode('fallback')
      return
    }

    navigator.mediaDevices
      .getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 2560 },
          height: { ideal: 1440 },
        },
      })
      .then(stream => {
        if (!active) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        setMode('live') // triggers re-render → <video> appears in DOM
      })
      .catch(() => {
        if (active) setMode('fallback')
      })

    return () => {
      active = false
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  // ── Attach stream once <video> is in the DOM ─────────────────────────────────
  useEffect(() => {
    if (mode !== 'live') return
    const v = videoRef.current
    if (!v || !streamRef.current) return

    v.srcObject = streamRef.current

    const onReady = () => {
      v.play().catch(() => {})
      setLiveReady(true)
    }
    v.addEventListener('loadedmetadata', onReady)
    // Belt-and-suspenders: also handle canplay in case loadedmetadata already fired
    v.addEventListener('canplay', onReady)
    return () => {
      v.removeEventListener('loadedmetadata', onReady)
      v.removeEventListener('canplay', onReady)
    }
  }, [mode])

  // ── Live brightness monitor ────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'live' || !liveReady || preview) return

    intervalRef.current = setInterval(() => {
      const v = videoRef.current
      const c = canvasRef.current
      if (!v || !c || !v.videoWidth || !v.videoHeight) return
      const w = 80
      const h = Math.round((v.videoHeight / v.videoWidth) * 80)
      if (!w || !h || !isFinite(h)) return
      c.width  = w
      c.height = h
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.drawImage(v, 0, 0, w, h)
      const { data } = ctx.getImageData(0, 0, w, h)
      let sum = 0
      for (let i = 0; i < data.length; i += 4) {
        sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
      }
      const avg = sum / (data.length / 4)
      setLightLevel(avg < 55 ? 'dark' : avg > 210 ? 'bright' : 'ok')
    }, 600)

    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [mode, liveReady, preview])

  // ── Capture from live feed ──────────────────────────────────────────────────
  // Use toDataURL instead of toBlob — iOS Safari throws SyntaxError with JPEG toBlob
  const captureLive = useCallback(() => {
    const v = videoRef.current
    const c = canvasRef.current
    if (!v || !c || !v.videoWidth || !v.videoHeight) return
    c.width  = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(v, 0, 0)
    const q = analyzeFrame(ctx, c.width, c.height)
    setQuality(q)
    // toDataURL is synchronous and works reliably on iOS Safari
    setPreview(c.toDataURL('image/jpeg', 0.92))
  }, [])

  // ── Capture from native picker (fallback) ───────────────────────────────────
  const handleFallbackCapture = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    const img = new window.Image()
    img.onload = () => {
      const c = canvasRef.current
      if (!c) { setPreview(url); setQuality({ brightness: 128, sharpness: 10, warnings: [] }); return }
      c.width  = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      setQuality(analyzeFrame(ctx, c.width, c.height))
      setPreview(c.toDataURL('image/jpeg', 0.92))
      URL.revokeObjectURL(url) // free the blob URL; we now use the dataURL
    }
    img.src = url
    if (e.target) e.target.value = ''
  }, [])

  // ── Confirm / retake ────────────────────────────────────────────────────────
  // Convert the canvas (still holds last captured frame) to a File via fetch(dataURL)
  const confirmPhoto = useCallback(() => {
    const c = canvasRef.current
    if (!c) return
    const dataUrl = c.toDataURL('image/jpeg', 0.92)
    // fetch(dataURL) converts it to a Blob without triggering iOS toBlob bugs
    fetch(dataUrl)
      .then(r => r.blob())
      .then(blob => {
        const file = new File([blob], `invoice-p${pageNumber}-${Date.now()}.jpg`, { type: 'image/jpeg' })
        onCapture(file)
        setPreview(null)
        setQuality(null)
      })
  }, [onCapture, pageNumber])

  const retake = useCallback(() => {
    setPreview(null)
    setQuality(null)
  }, [])

  // ── Bracket colour ──────────────────────────────────────────────────────────
  const bracketColor = lightLevel === 'ok' ? '#4ade80' : '#ffffff'

  // ── Viewport dimensions for the clear viewfinder rect ──────────────────────
  // The document frame: 88% wide, 76% tall, centred
  const frameStyle: React.CSSProperties = {
    position:  'absolute',
    top:       '12%',
    left:      '6%',
    right:     '6%',
    bottom:    '12%',
    boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
    borderRadius: 6,
    pointerEvents: 'none',
  }

  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="fixed inset-0 z-[70] bg-black flex flex-col">
      {/* Hidden canvas — used for both live analysis and capture */}
      <canvas ref={canvasRef} className="hidden" />

      {/* Fallback file input — opens native camera picker */}
      <input
        ref={fallbackRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFallbackCapture}
      />

      {/* ── TOP BAR ── */}
      <div
        className="absolute top-0 inset-x-0 z-20 flex items-center justify-between px-4 pt-10 pb-6"
        style={{ background: 'linear-gradient(to bottom, rgba(0,0,0,0.75), transparent)' }}
      >
        <button
          onClick={onClose}
          className="w-9 h-9 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center"
        >
          <X size={18} className="text-white" />
        </button>

        <div className="text-center">
          <p className="text-white text-sm font-semibold">
            Page {pageNumber}
            {maxPages > 1 && <span className="opacity-60"> / {maxPages} max</span>}
          </p>
        </div>

        {/* placeholder to keep layout balanced */}
        <div className="w-9" />
      </div>

      {/* ── MAIN AREA ── */}
      <div className="flex-1 relative overflow-hidden">

        {/* ── LIVE MODE: video + overlay ── */}
        {mode === 'live' && !preview && (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="absolute inset-0 w-full h-full object-cover"
            />

            {liveReady && (
              <>
                {/* Dark vignette around document frame */}
                <div style={frameStyle} />

                {/* Corner brackets — rotate via CSS transform */}
                {[
                  { top: 'calc(12% - 4px)',    left:  'calc(6% - 4px)',  transform: 'none' },
                  { top: 'calc(12% - 4px)',    right: 'calc(6% - 4px)',  transform: 'rotate(90deg)' },
                  { bottom: 'calc(12% - 4px)', right: 'calc(6% - 4px)',  transform: 'rotate(180deg)' },
                  { bottom: 'calc(12% - 4px)', left:  'calc(6% - 4px)',  transform: 'rotate(270deg)' },
                ].map((style, i) => (
                  <div key={i} className="absolute z-10 pointer-events-none" style={style}>
                    <Bracket color={bracketColor} />
                  </div>
                ))}

                {/* Alignment hint */}
                <div className="absolute inset-x-0 flex justify-center z-10 pointer-events-none" style={{ top: '13%' }}>
                  <div className="bg-black/50 backdrop-blur-sm rounded-full px-3 py-1">
                    <span className="text-white/80 text-[11px]">
                      Fit the full invoice inside the frame
                    </span>
                  </div>
                </div>

                {/* Live light indicator */}
                {lightLevel !== 'ok' && (
                  <div
                    className="absolute inset-x-0 flex justify-center z-10 pointer-events-none"
                    style={{ bottom: '13%' }}
                  >
                    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold backdrop-blur-sm ${
                      lightLevel === 'dark'
                        ? 'bg-amber-500/90 text-white'
                        : 'bg-orange-400/90 text-white'
                    }`}>
                      {lightLevel === 'dark'
                        ? <><Moon size={12} /> Move to better lighting</>
                        : <><Sun  size={12} /> Avoid direct light on the page</>
                      }
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* ── FALLBACK MODE: tips screen ── */}
        {mode === 'fallback' && !preview && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-8 gap-5 bg-gray-900">
            {/* Illustrated document frame */}
            <div className="relative w-48 aspect-[3/4] border-2 border-white/20 rounded-xl flex items-center justify-center">
              {[
                { top: -3, left: -3, transform: 'none' },
                { top: -3, right: -3, transform: 'rotate(90deg)' },
                { bottom: -3, right: -3, transform: 'rotate(180deg)' },
                { bottom: -3, left: -3, transform: 'rotate(270deg)' },
              ].map((s, i) => (
                <div key={i} className="absolute" style={s}>
                  <Bracket color="#4ade80" />
                </div>
              ))}
              <div className="text-center px-3 space-y-1.5">
                <p className="text-white/50 text-[11px] leading-relaxed">
                  Lay the invoice flat<br />Fill the frame<br />Avoid shadows
                </p>
              </div>
            </div>

            <div className="text-center space-y-1">
              <p className="text-white text-sm font-semibold">Position the invoice, then tap the shutter</p>
              <p className="text-white/40 text-xs">
                Your camera will open — align the invoice before shooting
              </p>
            </div>

            {camError && (
              <p className="text-amber-300 text-xs text-center">{camError}</p>
            )}
          </div>
        )}

        {/* ── LOADING ── */}
        {mode === 'loading' && !preview && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-10 h-10 rounded-full border-2 border-white/30 border-t-white animate-spin" />
          </div>
        )}

        {/* ── PREVIEW with quality feedback ── */}
        {preview && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt="Captured invoice"
              className="absolute inset-0 w-full h-full object-contain"
            />

            {/* Quality badges */}
            <div className="absolute bottom-4 inset-x-4 space-y-2 z-10">
              {quality && quality.warnings.length === 0 && (
                <div className="flex items-center gap-2 bg-green-500/90 backdrop-blur-sm rounded-xl px-3 py-2.5">
                  <Check size={15} className="text-white shrink-0" />
                  <span className="text-white text-xs font-semibold">Looks great — ready to scan</span>
                </div>
              )}
              {quality?.warnings.map((w, i) => (
                <div key={i} className="flex items-center gap-2 bg-amber-500/90 backdrop-blur-sm rounded-xl px-3 py-2.5">
                  <AlertTriangle size={14} className="text-white shrink-0" />
                  <span className="text-white text-xs font-medium">{w}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── BOTTOM CONTROLS ── */}
      <div
        className="absolute bottom-0 inset-x-0 z-20"
        style={{
          background: 'linear-gradient(to top, rgba(0,0,0,0.85) 60%, transparent)',
          paddingBottom: 'max(1.75rem, env(safe-area-inset-bottom, 1rem))',
        }}
      >
        {!preview ? (
          /* ── Shutter ── */
          <div className="flex items-center justify-center pt-8 pb-2">
            <button
              onClick={mode === 'live' ? captureLive : () => fallbackRef.current?.click()}
              disabled={mode === 'loading'}
              className="w-20 h-20 rounded-full bg-white shadow-2xl flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40"
            >
              <div className="w-[68px] h-[68px] rounded-full border-[3px] border-gray-800 bg-white" />
            </button>
          </div>
        ) : (
          /* ── Confirm / Retake ── */
          <div className="flex items-center gap-3 px-6 pt-6 pb-2">
            <button
              onClick={retake}
              className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-2xl border-2 border-white/25 text-white text-sm font-semibold"
            >
              <RotateCcw size={15} /> Retake
            </button>
            <button
              onClick={confirmPhoto}
              className="flex-[2] flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-green-500 text-white text-sm font-semibold"
            >
              <Check size={15} />
              {quality && quality.warnings.length > 0 ? 'Use Anyway' : 'Use Photo'}
            </button>
          </div>
        )}

        {/* Page counter hint */}
        {!preview && (
          <p className="text-center text-white/40 text-[11px] pb-1 mt-1">
            {mode === 'live'
              ? 'Tap the shutter when the invoice fills the frame'
              : 'Tap the shutter · your camera will open'}
          </p>
        )}
      </div>
    </div>
  )
}
