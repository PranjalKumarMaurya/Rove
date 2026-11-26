// Shrink a photo on the device before it is uploaded (see shrinkTarget in scanRules).
// Anything that can't be decoded here (a HEIC photo outside Safari, a PDF) is
// uploaded as it is.
import { jpegFileName, shrinkTarget } from './scanRules'

const JPEG_QUALITY = 0.85

export async function prepareForUpload(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return file
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return file
  }
  try {
    const target = shrinkTarget(bitmap.width, bitmap.height, file.size, file.type)
    if (!target) return file
    const canvas = document.createElement('canvas')
    canvas.width = target.width
    canvas.height = target.height
    const context = canvas.getContext('2d')
    if (!context) return file
    // JPEG has no transparency: paint white first so transparent screenshots stay readable.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, target.width, target.height)
    context.drawImage(bitmap, 0, 0, target.width, target.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
    if (!blob || blob.size === 0) return file
    return new File([blob], jpegFileName(file.name), { type: 'image/jpeg', lastModified: file.lastModified })
  } finally {
    bitmap.close()
  }
}
