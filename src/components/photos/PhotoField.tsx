'use client'
import { useEffect, useRef, useState } from 'react'
import { Camera, Loader2, RotateCcw, X } from 'lucide-react'
import { uploadFiles } from '@/lib/uploadthing-client'
import { compressPhotoFile } from '@/lib/image-compress'

// One optional photo on a form (a waste entry, a flagged checklist job).
//
// Phone first: "Add photo" opens the back camera (or the photo library). The
// picture is shrunk to ~1600 px JPEG on the phone, uploaded straight away, and
// its link is reported through `onChange`. While it is sending, `onBusyChange`
// says so, so the parent can hold Save for a moment. If it can't send (no
// signal), the cook is told and can try again or remove it — the entry itself
// always saves without the photo. Nothing here ever blocks a save.

const UPLOAD_TIMEOUT_MS = 25_000

type Phase = 'idle' | 'uploading' | 'failed' | 'done'

export function PhotoField({
  value,
  onChange,
  onBusyChange,
  disabled = false,
  label = 'Add photo',
}: {
  /** The uploaded photo's link, or null. */
  value: string | null
  onChange: (url: string | null) => void
  /** True while a photo is sending. */
  onBusyChange?: (busy: boolean) => void
  disabled?: boolean
  label?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>(value ? 'done' : 'idle')
  const [preview, setPreview] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  // Each pick/remove bumps this; an upload that finishes after a newer pick or a remove is ignored.
  const attempt = useRef(0)

  // The parent cleared the value (e.g. the form reset): drop the local photo too.
  useEffect(() => {
    if (value == null && phase === 'done') { setPhase('idle'); setFile(null); setPreview(null) }
    if (value && phase === 'idle') setPhase('done')
  }, [value, phase])

  useEffect(() => { onBusyChange?.(phase === 'uploading') }, [phase, onBusyChange])

  useEffect(() => () => { if (preview?.startsWith('blob:')) URL.revokeObjectURL(preview) }, [preview])

  const send = async (f: File) => {
    const mine = ++attempt.current
    setPhase('uploading')
    let url: string | null = null
    try {
      const small = await compressPhotoFile(f)
      const res = await Promise.race([
        uploadFiles('photoUploader', { files: [small] }),
        new Promise<null>((_, rej) => setTimeout(() => rej(new Error('timeout')), UPLOAD_TIMEOUT_MS)),
      ])
      const up = res?.[0]
      url = up ? (up.ufsUrl ?? up.url ?? null) : null
    } catch {
      url = null
    }
    if (mine !== attempt.current) return
    if (url) { setPhase('done'); onChange(url) }
    else { setPhase('failed'); onChange(null) }
  }

  const pick = (f: File | undefined) => {
    if (!f) return
    setFile(f)
    setPreview(URL.createObjectURL(f))
    void send(f)
  }

  const remove = () => {
    attempt.current++
    setPhase('idle')
    setFile(null)
    setPreview(null)
    onChange(null)
  }

  const shown = preview ?? value
  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      capture="environment"
      className="hidden"
      onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }}
    />
  )

  if (phase === 'idle' || !shown) {
    return (
      <>
        {input}
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="self-start min-h-[44px] px-3.5 rounded-[9px] border border-dashed border-line-2 bg-paper text-[13px] font-medium text-ink-2 inline-flex items-center gap-2 disabled:opacity-50"
        >
          <Camera size={16} aria-hidden /> {label}
        </button>
      </>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {input}
      <div className="flex items-center gap-3">
        <div className="relative flex-none w-16 h-16">
          {phase === 'done' && value ? (
            <a href={value} target="_blank" rel="noopener noreferrer" aria-label="Open the photo" className="block w-16 h-16">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shown} alt="Photo" className="w-16 h-16 rounded-[9px] object-cover border border-line" />
            </a>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shown} alt="Photo" className={`w-16 h-16 rounded-[9px] object-cover border border-line ${phase === 'failed' ? 'opacity-50' : ''}`} />
          )}
          {phase === 'uploading' && (
            <span className="absolute inset-0 rounded-[9px] bg-black/35 grid place-items-center text-white" aria-hidden>
              <Loader2 size={20} className="animate-spin" />
            </span>
          )}
        </div>
        <span className="flex-1 min-w-0 text-[12.5px] leading-[1.4]">
          {phase === 'uploading' && <span className="text-ink-3">Sending photo…</span>}
          {phase === 'done' && <span className="text-ink-3">Photo added</span>}
          {phase === 'failed' && (
            <span className="text-red-text" role="alert">Photo didn’t send — save without it or try again</span>
          )}
        </span>
        {phase === 'failed' && file && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void send(file)}
            aria-label="Try sending the photo again"
            className="flex-none w-11 h-11 rounded-[9px] border border-line-2 bg-paper grid place-items-center text-ink-2 disabled:opacity-50"
          >
            <RotateCcw size={16} />
          </button>
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={remove}
          aria-label="Remove the photo"
          className="flex-none w-11 h-11 rounded-[9px] border border-line-2 bg-paper grid place-items-center text-ink-2 disabled:opacity-50"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}

/** A small photo that opens the full picture. For lists and cards. */
export function PhotoThumb({ url, size = 40, label = 'Open the photo' }: { url: string; size?: number; label?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      className="flex-none inline-grid place-items-center min-w-[44px] min-h-[44px]"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Photo"
        loading="lazy"
        style={{ width: size, height: size }}
        className="rounded-[7px] object-cover border border-line bg-bg-2"
      />
    </a>
  )
}
