import { edgeGeometries } from './edges'
import {
  HEADER_H,
  ROW_H,
  contentBounds,
  shortType,
  visibleColumns,
  type Positions,
  type Size
} from './layout'
import type { SchemaModel } from './model'

/** Colours of an exported diagram (resolved from the theme tokens when exporting). */
export interface DiagramPalette {
  background: string
  box: string
  border: string
  header: string
  text: string
  muted: string
  key: string
  link: string
  line: string
}

const MARGIN = 24
const SANS = "Inter, -apple-system, 'Segoe UI', Roboto, sans-serif"
const MONO = "'JetBrains Mono', SFMono-Regular, Menlo, Consolas, monospace"

const xml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Cuts a text to roughly `width` pixels of `charW`-wide characters. */
function fit(text: string, width: number, charW: number): string {
  const max = Math.max(1, Math.floor(width / charW))
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

/**
 * The diagram as a standalone SVG document (no external fonts, styles or
 * images): table boxes, key markers and relationship lines with crow's feet.
 */
export function diagramSvg(
  model: SchemaModel,
  positions: Positions,
  sizes: Record<string, Size>,
  keysOnly: boolean,
  palette: DiagramPalette
): string {
  const b = contentBounds(positions, sizes)
  const ox = MARGIN - b.x
  const oy = MARGIN - b.y
  const width = Math.ceil(b.w + MARGIN * 2)
  const height = Math.ceil(b.h + MARGIN * 2)
  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<defs>',
    `<marker id="many" viewBox="0 0 12 12" refX="12" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path d="M1 6 L12 1 M1 6 L12 6 M1 6 L12 11" fill="none" stroke="${palette.line}" stroke-width="1.3"/></marker>`,
    `<marker id="one" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto"><path d="M7 1 L7 11 M10 1 L10 11" fill="none" stroke="${palette.line}" stroke-width="1.3"/></marker>`,
    '</defs>',
    `<rect width="100%" height="100%" fill="${palette.background}"/>`,
    `<g transform="translate(${ox} ${oy})">`
  )
  for (const e of edgeGeometries(model.relations, model.tables, positions, sizes, keysOnly)) {
    out.push(
      `<path d="${e.path}" fill="none" stroke="${palette.line}" stroke-width="1.4"${
        e.relation.optional ? ' stroke-dasharray="5 4"' : ''
      } marker-start="url(#many)" marker-end="url(#one)"/>`
    )
  }
  for (const t of model.tables) {
    const p = positions[t.name]
    const s = sizes[t.name]
    if (!p || !s) continue
    out.push(
      `<g transform="translate(${p.x} ${p.y})">`,
      `<rect width="${s.w}" height="${s.h}" rx="8" fill="${palette.box}" stroke="${palette.border}"/>`,
      `<path d="M0 8 Q0 0 8 0 H${s.w - 8} Q${s.w} 0 ${s.w} 8 V${HEADER_H} H0 Z" fill="${palette.header}"/>`,
      `<text x="12" y="${HEADER_H / 2 + 4.5}" font-family="${SANS}" font-size="12.5" font-weight="600" fill="${palette.text}">${xml(fit(t.name, s.w - 24, 7.6))}</text>`
    )
    visibleColumns(t, keysOnly).forEach((c, i) => {
      const y = HEADER_H + i * ROW_H + ROW_H / 2 + 4
      const type = shortType(c.type)
      const marker = c.primaryKey ? 'PK' : c.foreignKey ? 'FK' : ''
      if (marker)
        out.push(
          `<text x="10" y="${y}" font-family="${MONO}" font-size="9" font-weight="700" fill="${c.primaryKey ? palette.key : palette.link}">${marker}</text>`
        )
      out.push(
        `<text x="32" y="${y}" font-family="${SANS}" font-size="12" fill="${palette.text}">${xml(
          fit(c.name, s.w - 48 - type.length * 6.6, 7)
        )}</text>`,
        `<text x="${s.w - 10}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="11" fill="${palette.muted}">${xml(type)}</text>`
      )
    })
    out.push('</g>')
  }
  out.push('</g>', '</svg>')
  return out.join('\n')
}
