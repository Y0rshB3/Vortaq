import type { DiagramPalette } from './svgExport'

/** The exported diagram's colours: the current theme's tokens. */
export function themePalette(root: Element = document.documentElement): DiagramPalette {
  const style = getComputedStyle(root)
  const token = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  return {
    background: token('--nd-bg-panel', '#ffffff'),
    box: token('--nd-bg-raised', '#ffffff'),
    border: token('--nd-border-strong', '#c8ced8'),
    header: token('--nd-bg-sunken', '#f1f4f8'),
    text: token('--nd-text', '#0f172a'),
    muted: token('--nd-text-muted', '#64748b'),
    key: token('--nd-warning', '#d97706'),
    link: token('--nd-accent', '#0891b2'),
    line: token('--nd-text-muted', '#64748b')
  }
}

/** Largest bitmap Chromium draws reliably (per side and in total). */
const MAX_SIDE = 16384
const MAX_AREA = 120_000_000

/** PNG (base64, no data: prefix) of an SVG document, at up to twice its size. */
export async function diagramPng(svg: string, preferredScale = 2): Promise<string> {
  const w = Number(/width="(\d+)"/.exec(svg)?.[1] ?? 0)
  const h = Number(/height="(\d+)"/.exec(svg)?.[1] ?? 0)
  if (!w || !h) throw new Error('El diagrama está vacío.')
  const scale = Math.min(preferredScale, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_AREA / (w * h)))
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(w * scale))
  canvas.height = Math.max(1, Math.floor(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No se pudo dibujar la imagen.')
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0)
  return canvas.toDataURL('image/png').split(',')[1] ?? ''
}
