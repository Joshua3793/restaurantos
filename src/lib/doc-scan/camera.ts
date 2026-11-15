'use client'
// Camera plumbing for the browser page scanner: open the back camera at the
// highest resolution the phone will give, keep it focusing, grab frames.
//
// Resolution matters for small print, so ask for up to 4K video (iPhone Safari
// and most Androids honour it). The shot is the video frame at the instant of
// the snap — never ImageCapture.takePhoto(): its shutter lag (up to ~2 s on
// Android) meant the photo was taken while the cook was already moving.

/** Captures are capped here: the flattened page is ≤ 2500 px, so more is just memory. */
export const CAPTURE_LONG = 3264

export interface CameraHandle {
  stream: MediaStream
  track: MediaStreamTrack
  torch: boolean
}

export async function openCamera(video: HTMLVideoElement): Promise<CameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('nocamera')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    })
  } catch (e) {
    const name = (e as DOMException)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error('denied')
    // Over-constrained on an older phone: plain back camera.
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } })
  }
  const track = stream.getVideoTracks()[0]
  let torch = false
  try {
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { focusMode?: string[]; torch?: boolean }
    torch = !!caps.torch
    if (caps.focusMode?.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
    }
  } catch { /* focus/torch are nice-to-haves */ }

  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  await video.play().catch(() => {})
  if (!video.videoWidth) {
    await new Promise<void>(res => {
      const done = () => { video.removeEventListener('loadedmetadata', done); res() }
      video.addEventListener('loadedmetadata', done)
      setTimeout(done, 3000)
    })
  }
  return { stream, track, torch }
}

export function closeCamera(handle: CameraHandle | null, video?: HTMLVideoElement | null) {
  handle?.stream.getTracks().forEach(t => t.stop())
  if (video) video.srcObject = null
}

export async function setTorch(handle: CameraHandle, on: boolean): Promise<boolean> {
  try {
    await handle.track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
    return on
  } catch {
    return false
  }
}

function drawToImageData(src: CanvasImageSource, w: number, h: number, maxLong: number): ImageData {
  const k = Math.min(1, maxLong / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0, cw, ch)
  return ctx.getImageData(0, 0, cw, ch)
}

/** The current video frame, scaled so its long side is at most `maxLong`. */
export function grabVideoFrame(video: HTMLVideoElement, maxLong: number): ImageData | null {
  const w = video.videoWidth, h = video.videoHeight
  if (!w || !h) return null
  return drawToImageData(video, w, h, maxLong)
}

/** A photo file (from the phone's own camera or library) as pixels, upright. */
export async function fileToImageData(file: File): Promise<ImageData> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  try {
    return drawToImageData(bmp, bmp.width, bmp.height, CAPTURE_LONG)
  } finally {
    bmp.close()
  }
}

/** RGBA pixels → JPEG file. */
export async function pixelsToJpeg(data: Uint8ClampedArray, width: number, height: number, name: string, quality = 0.9): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', quality))
  canvas.width = canvas.height = 0
  if (!blob) throw new Error('could not save the page')
  return new File([blob], name, { type: 'image/jpeg' })
}
