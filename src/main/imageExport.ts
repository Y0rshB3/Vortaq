import type { DiagramImage } from '@shared/types'

/**
 * «Exportar imagen» of the relationship diagram (app:saveImage): checks what
 * the renderer sends before main writes it to the path the user chose in
 * main's own save dialog. Electron-free so it can be tested on its own.
 */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The bytes to write: a real PNG, or SVG text that starts as an SVG document. */
export function imageFileBytes(image: unknown): Buffer {
  const i = image as Partial<DiagramImage> | null
  if (!i || typeof i !== 'object' || typeof i.data !== 'string')
    throw new Error('Imagen no válida.')
  if (i.format === 'svg') {
    const bytes = Buffer.from(i.data, 'utf8')
    if (!/^\s*(<\?xml[^>]*\?>\s*)?<svg[\s/>]/.test(i.data)) throw new Error('El SVG no es válido.')
    if (bytes.length > MAX_IMAGE_BYTES)
      throw new Error('La imagen es demasiado grande (máximo 40 MB).')
    return bytes
  }
  if (i.format === 'png') {
    if (i.data.length > (MAX_IMAGE_BYTES * 4) / 3 + 4 || !BASE64.test(i.data))
      throw new Error('La imagen PNG no es válida o supera los 40 MB.')
    const bytes = Buffer.from(i.data, 'base64')
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('La imagen PNG no es válida.')
    return bytes
  }
  throw new Error('Formato de imagen no admitido (PNG o SVG).')
}

/** A file name for the save dialog: no path separators or control characters, with its extension. */
export function imageFileName(name: string, format: DiagramImage['format']): string {
  const base =
    String(name)
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
      .replace(/\.(png|svg)$/i, '')
      .trim()
      .slice(0, 120) || 'diagrama'
  return `${base}.${format}`
}

/** The path to write: the chosen one, with the format's extension added when it lacks it. */
export function imageSavePath(chosen: string, format: DiagramImage['format']): string {
  return chosen.toLowerCase().endsWith(`.${format}`) ? chosen : `${chosen}.${format}`
}
