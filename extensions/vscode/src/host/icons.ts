/**
 * Connection icons of the tree: the engine's glyph in the connection's colour
 * (or the editor's icon colour), with a lock on connections whose writes need
 * the typed name. VS Code cannot tint a custom SVG, so each variant is written
 * once to the extension's storage folder.
 *
 * Glyphs: Material Design Icons by Pictogrammers (Apache License 2.0), the
 * same icons the desktop app shows (src/shared/engines.ts); see the notices.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineId } from '@core'

/** mdi-dolphin, mdi-seal, mdi-elephant, mdi-database-outline, mdi-leaf, mdi-database-cog (24×24). */
export const ENGINE_GLYPHS: Record<EngineId, string> = {
  mysql:
    'M20 7C20 7 20 3 15 3C13.47 3 12.15 3.19 11 3.5C10.5 3.06 7.26 .309 4 3.57L6.56 6.13C2.5 10.53 4 18 4 18S1 18 1 22C1 22 5 21 5 21C5 21 9 22 9 22C9 18 6 18 6 18S6.85 12.24 13 11.18V14C15 14 15.68 12.19 15.89 11H18C22 11 23 10 23 9S21 7 20 7M18 8C17.45 8 17 7.55 17 7S17.45 6 18 6 19 6.45 19 7 18.55 8 18 8Z',
  mariadb:
    'M20.39,19.37L16.38,18L15,22L11.92,16L9,22L7.62,18L3.61,19.37L6.53,13.37C5.57,12.17 5,10.65 5,9A7,7 0 0,1 12,2A7,7 0 0,1 19,9C19,10.65 18.43,12.17 17.47,13.37L20.39,19.37M7,9L9.69,10.34L9.5,13.34L12,11.68L14.5,13.33L14.33,10.34L17,9L14.32,7.65L14.5,4.67L12,6.31L9.5,4.65L9.67,7.66L7,9Z',
  postgresql:
    'M19.5,15.5A0.5,0.5 0 0,1 19,16A0.5,0.5 0 0,1 18.5,15.5V8.5C18.5,6.57 16.43,5 14.5,5H6A4,4 0 0,0 2,9V19H6V15H11V19H15V14.5A0.5,0.5 0 0,1 15.5,14A0.5,0.5 0 0,1 16,14.5V16A3,3 0 0,0 19,19A3,3 0 0,0 22,16V14H19.5V15.5Z',
  sqlite:
    'M12 3C7.58 3 4 4.79 4 7V17C4 19.21 7.59 21 12 21S20 19.21 20 17V7C20 4.79 16.42 3 12 3M18 17C18 17.5 15.87 19 12 19S6 17.5 6 17V14.77C7.61 15.55 9.72 16 12 16S16.39 15.55 18 14.77V17M18 12.45C16.7 13.4 14.42 14 12 14C9.58 14 7.3 13.4 6 12.45V9.64C7.47 10.47 9.61 11 12 11C14.39 11 16.53 10.47 18 9.64V12.45M12 9C8.13 9 6 7.5 6 7S8.13 5 12 5C15.87 5 18 6.5 18 7S15.87 9 12 9Z',
  mongodb:
    'M17,8C8,10 5.9,16.17 3.82,21.34L5.71,22L6.66,19.7C7.14,19.87 7.64,20 8,20C19,20 22,3 22,3C21,5 14,5.25 9,6.25C4,7.25 2,11.5 2,13.5C2,15.5 3.75,17.25 3.75,17.25C7,8 17,8 17,8Z',
  // Outline taken from the Material Design Icons webfont the desktop ships (glyph F164B).
  sqlserver:
    'M3.98 6.98Q3.98 5.91 5.06 4.99Q6.14 4.08 7.99 3.54Q9.84 3 12 3Q14.16 3 16.01 3.54Q17.86 4.08 18.94 4.99Q20.02 5.91 20.02 7.01Q20.02 8.11 18.94 9.02Q17.86 9.94 16.01 10.48Q14.16 11.02 12 11.02Q9.84 11.02 7.99 10.48Q6.14 9.94 5.06 9.02Q3.98 8.11 3.98 6.98ZM12.09 18H12Q9.84 18 7.99 17.46Q6.14 16.92 5.06 16.01Q3.98 15.09 3.98 14.02V17.02Q3.98 18.09 5.06 19.01Q6.14 19.92 7.99 20.46Q9.84 21 12 21H12.28Q12 19.97 12 18.98Q12 18.52 12.09 18ZM20.02 12.09Q20.02 12.05 20.02 12V9Q20.02 10.08 18.94 10.99Q17.86 11.91 16.01 12.45Q14.16 12.98 12 12.98Q9.84 12.98 7.99 12.45Q6.14 11.91 5.06 10.99Q3.98 10.08 3.98 9V12Q3.98 13.08 5.06 13.99Q6.14 14.91 7.99 15.45Q9.84 15.98 12 15.98H12.7Q13.55 14.2 15.26 13.1Q16.97 12 18.98 12Q19.45 12 20.02 12.09ZM23.81 20.39Q23.86 20.39 23.86 20.46Q23.86 20.53 23.81 20.58L22.78 22.31Q22.69 22.41 22.5 22.41L21.28 21.98L20.48 22.5L20.3 23.81Q20.3 23.86 20.23 23.93Q20.16 24 20.11 24H18.09Q18 24 17.81 23.81L17.58 22.5Q17.16 22.36 16.78 21.98L15.61 22.5Q15.42 22.5 15.28 22.41L14.3 20.72Q14.2 20.58 14.39 20.39L15.52 19.59V18.61L14.39 17.81Q14.3 17.72 14.3 17.48L15.28 15.8Q15.42 15.7 15.61 15.7L16.78 16.22L17.58 15.7L17.81 14.39Q17.81 14.2 18.09 14.2H20.11Q20.16 14.2 20.23 14.27Q20.3 14.34 20.3 14.39L20.48 15.7Q20.81 15.8 21.42 16.22L22.59 15.7Q22.92 15.7 22.92 15.8L23.91 17.48Q24 17.58 23.81 17.81L22.69 18.61V19.59ZM20.48 18.98Q20.48 18.42 20.04 17.95Q19.59 17.48 19.01 17.48Q18.42 17.48 17.95 17.95Q17.48 18.42 17.48 19.01Q17.48 19.59 17.95 20.04Q18.42 20.48 19.01 20.48Q19.59 20.48 20.04 20.04Q20.48 19.59 20.48 18.98Z'
}

/** mdi-lock, drawn small in the bottom-right corner. */
const LOCK =
  'M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z'

/** VS Code's default icon foregrounds (light and dark themes). */
export const DEFAULT_ICON_COLORS = { light: '#424242', dark: '#c5c5c5' } as const

const HEX = /^#[0-9a-fA-F]{6}$/

/** An SVG of the engine glyph in `color`, with the lock badge when `locked`. */
export function engineIconSvg(
  engine: EngineId,
  color: string,
  locked: boolean,
  lockColor: string
): string {
  const glyph = ENGINE_GLYPHS[engine] ?? ENGINE_GLYPHS.mysql
  if (!locked)
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"><path fill="${color}" d="${glyph}"/></svg>`
  // The glyph is cut where the badge sits, so the lock reads on any background.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">` +
    `<defs><mask id="m"><rect width="24" height="24" fill="#fff"/><circle cx="18" cy="18" r="7" fill="#000"/></mask></defs>` +
    `<path fill="${color}" mask="url(#m)" d="${glyph}"/>` +
    `<path fill="${lockColor}" transform="translate(12.5 12) scale(0.46)" d="${LOCK}"/>` +
    `</svg>`
  )
}

export interface IconPaths {
  light: string
  dark: string
}

/**
 * File paths of the icon for a connection, written under `dir` the first
 * time. `color` is the connection's #rrggbb colour or null (theme default).
 */
export function connectionIcon(
  dir: string,
  engine: EngineId,
  color: string | null,
  locked: boolean
): IconPaths {
  mkdirSync(dir, { recursive: true })
  const custom = color && HEX.test(color) ? color.toLowerCase() : null
  const lock = '#e5484d'
  const write = (variant: 'light' | 'dark'): string => {
    const fill = custom ?? DEFAULT_ICON_COLORS[variant]
    const file = join(dir, `${engine}-${fill.slice(1)}${locked ? '-lock' : ''}.svg`)
    if (!existsSync(file)) writeFileSync(file, engineIconSvg(engine, fill, locked, lock))
    return file
  }
  return { light: write('light'), dark: write('dark') }
}
