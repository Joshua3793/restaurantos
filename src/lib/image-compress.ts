'use client'

// Compress an image file to ≤1 MB at ≤2000 px using Canvas.
// Non-image files (PDF, CSV) are returned as-is.
export const compressImageFile = (file: File): Promise<File> => {
  if (!file.type.startsWith('image/') || file.size <= 1 * 1024 * 1024) return Promise.resolve(file)
  return shrinkToJpeg(file, 2000)
}

// A photo on a waste entry or a flagged job: always re-encoded (a phone's HEIC or
// PNG becomes a JPEG) and no wider than `maxDim` px.
export const compressPhotoFile = (file: File, maxDim = 1600): Promise<File> => {
  if (!file.type.startsWith('image/')) return Promise.resolve(file)
  return shrinkToJpeg(file, maxDim)
}

function shrinkToJpeg(file: File, MAX_DIM: number): Promise<File> {
  return new Promise((resolve) => {
    const img = new window.Image()
    const objectUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      let { width, height } = img
      if (width > MAX_DIM || height > MAX_DIM) {
        const scale = MAX_DIM / Math.max(width, height)
        width  = Math.round(width  * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width  = width
      canvas.height = height
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
      canvas.toBlob(
        (blob) => {
          if (!blob) { resolve(file); return }
          const name = file.name.replace(/\.[^.]+$/, '.jpg')
          resolve(new File([blob], name, { type: 'image/jpeg' }))
        },
        'image/jpeg',
        0.82,
      )
    }
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file) }
    img.src = objectUrl
  })
}
