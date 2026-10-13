/**
 * Webviews follow the editor's theme (docs/vscode-extension-design.md,
 * "Theming"): the desktop design tokens (--nd-*, src/renderer/src/styles/
 * tokens.css) are re-declared from the --vscode-* variables VS Code puts on
 * the page, for dark, light and both high-contrast themes; Vuetify's theme
 * colours (hex values) are computed from the same variables. Glass, glow and
 * the nebula background become flat, and grids use the editor's font.
 *
 * The functions that build the CSS and the colours are pure (unit-tested);
 * applyEditorTheme wires them to the page and re-runs on theme changes.
 */

export type ThemeKind = 'dark' | 'light' | 'hc-dark' | 'hc-light'

/** `--vscode-<name>` values read from the page, keyed by `<name>`. */
export type VscodeVars = Readonly<Record<string, string>>

/** The body class VS Code sets for each kind of theme. */
export function themeKindOf(classes: { contains(token: string): boolean }): ThemeKind {
  if (classes.contains('vscode-high-contrast-light')) return 'hc-light'
  if (classes.contains('vscode-high-contrast')) return 'hc-dark'
  if (classes.contains('vscode-light')) return 'light'
  return 'dark'
}

const isLight = (kind: ThemeKind): boolean => kind === 'light' || kind === 'hc-light'
const isHighContrast = (kind: ThemeKind): boolean => kind === 'hc-dark' || kind === 'hc-light'

/** `var(--vscode-a, var(--vscode-b, fallback))`. */
export function vsVar(names: readonly string[], fallback: string): string {
  return names.reduceRight((inner, name) => `var(--vscode-${name}, ${inner})`, fallback)
}

const soft = (expr: string, percent: number): string =>
  `color-mix(in srgb, ${expr} ${percent}%, transparent)`
const flat = (expr: string): string => `linear-gradient(${expr}, ${expr})`

/** Default values of VS Code's Dark Modern / Light Modern themes, for missing variables. */
const DEFAULTS = {
  dark: {
    bg: '#1f1f1f',
    widget: '#202020',
    input: '#313131',
    fg: '#cccccc',
    muted: '#9d9d9d',
    border: '#2b2b2b',
    accent: '#0078d4',
    onAccent: '#ffffff'
  },
  light: {
    bg: '#ffffff',
    widget: '#f8f8f8',
    input: '#ffffff',
    fg: '#3b3b3b',
    muted: '#717171',
    border: '#e5e5e5',
    accent: '#005fb8',
    onAccent: '#ffffff'
  }
} as const

/**
 * The token declarations of a theme kind: every colour, font and surface
 * token of tokens.css, as CSS expressions over the --vscode-* variables.
 */
export function tokenDeclarations(kind: ThemeKind): Record<string, string> {
  const d = DEFAULTS[isLight(kind) ? 'light' : 'dark']
  const hc = isHighContrast(kind)
  const bg = vsVar(['editor-background'], d.bg)
  const widget = vsVar(['editorWidget-background'], d.widget)
  const input = vsVar(['input-background'], d.input)
  const fg = vsVar(['foreground'], d.fg)
  const muted = vsVar(['descriptionForeground'], d.muted)
  const border = hc
    ? vsVar(['contrastBorder'], d.border)
    : vsVar(['panel-border', 'widget-border'], d.border)
  const strongBorder = hc
    ? vsVar(['contrastActiveBorder', 'contrastBorder'], d.border)
    : vsVar(['input-border', 'widget-border', 'panel-border'], d.border)
  const accent = vsVar(['button-background'], d.accent)
  const violet = vsVar(['charts-purple'], '#b180d7')
  const focus = vsVar(['focusBorder'], d.accent)
  const error = vsVar(['errorForeground'], '#f85149')
  const warning = vsVar(['editorWarning-foreground'], '#cca700')
  const info = vsVar(['editorInfo-foreground'], '#3794ff')
  const success = vsVar(['testing-iconPassed', 'charts-green'], '#73c991')
  const shadow = vsVar(['widget-shadow'], 'rgba(0, 0, 0, 0.36)')
  return {
    'color-scheme': isLight(kind) ? 'light' : 'dark',
    '--nd-bg-app': bg,
    '--nd-bg-panel': vsVar(['sideBar-background', 'editor-background'], d.bg),
    '--nd-bg-raised': widget,
    '--nd-bg-sunken': input,
    '--nd-bg-input': input,
    '--nd-glass': widget,
    '--nd-glass-strong': widget,
    '--nd-glass-blur': 'none',
    '--nd-scrim': isLight(kind) ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.45)',
    '--nd-border': border,
    '--nd-border-strong': strongBorder,
    '--nd-hairline': hc ? border : soft(border, 70),
    '--nd-hover': vsVar(['list-hoverBackground'], soft(fg, 8)),
    '--nd-pressed': vsVar(['toolbar-activeBackground', 'list-hoverBackground'], soft(fg, 12)),
    '--nd-selected': vsVar(['list-inactiveSelectionBackground'], soft(accent, 14)),
    '--nd-selected-strong': vsVar(['list-activeSelectionBackground'], soft(accent, 24)),
    '--nd-cyan': accent,
    '--nd-violet': violet,
    '--nd-accent': accent,
    '--nd-accent-gradient': flat(accent),
    '--nd-accent-gradient-h': flat(accent),
    '--nd-accent-gradient-v': flat(accent),
    '--nd-accent-gradient-soft': flat(soft(accent, 16)),
    '--nd-on-accent': vsVar(['button-foreground'], d.onAccent),
    '--nd-glow': `0 0 0 1px ${focus}`,
    '--nd-glow-violet': `0 0 0 1px ${focus}`,
    '--nd-glow-error': `0 0 0 1px ${vsVar(['inputValidation-errorBorder', 'errorForeground'], '#f85149')}`,
    '--nd-glow-filter': 'none',
    '--nd-glow-filter-error': 'none',
    '--nd-success': success,
    '--nd-warning': warning,
    '--nd-error': error,
    '--nd-info': info,
    '--nd-success-soft': soft(success, 14),
    '--nd-warning-soft': soft(warning, 14),
    '--nd-error-soft': soft(error, 14),
    '--nd-info-soft': soft(info, 14),
    '--nd-text': fg,
    '--nd-text-2': muted,
    '--nd-text-muted': muted,
    '--nd-text-decorative': vsVar(['disabledForeground'], soft(fg, 50)),
    '--nd-text-disabled': vsVar(['disabledForeground'], soft(fg, 50)),
    '--nd-selection': vsVar(['editor-selectionBackground'], soft(accent, 30)),
    '--nd-shadow-1': hc ? 'none' : `0 2px 8px ${shadow}`,
    '--nd-shadow-2': hc ? 'none' : `0 4px 16px ${shadow}`,
    '--nd-shadow-inset': 'none',
    '--nd-nebula-cyan': 'transparent',
    '--nd-nebula-violet': 'transparent',
    '--nd-scrollbar': vsVar(['scrollbarSlider-background'], soft(fg, 25)),
    '--nd-scrollbar-hover': vsVar(['scrollbarSlider-hoverBackground'], soft(fg, 40)),
    '--nd-radius-card': '6px',
    '--nd-radius-control': '4px',
    '--nd-radius-sm': '3px',
    '--nd-font-ui': vsVar(['font-family'], 'system-ui, sans-serif'),
    '--nd-font-mono': vsVar(['editor-font-family'], 'ui-monospace, Menlo, monospace'),
    '--nd-fs-base': vsVar(['font-size'], '13px')
  }
}

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() and rgba() (the forms VS Code uses). */
export function parseColor(value: string | undefined): Rgba | null {
  const v = value?.trim().toLowerCase() ?? ''
  let m = /^#([0-9a-f]{3,8})$/.exec(v)
  if (m) {
    let hex = m[1]
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('')
    if (hex.length !== 6 && hex.length !== 8) return null
    const n = (i: number): number => parseInt(hex.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 }
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v)
  if (m) {
    const alpha =
      m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return { r: +m[1], g: +m[2], b: +m[3], a: Math.min(1, Math.max(0, alpha)) }
  }
  return null
}

/** Opaque #rrggbb of `color` drawn over `background` (Vuetify needs opaque hex). */
export function toHex(color: Rgba, background: Rgba = { r: 0, g: 0, b: 0, a: 1 }): string {
  const mix = (c: number, b: number): number => Math.round(c * color.a + b * (1 - color.a))
  return (
    '#' +
    [mix(color.r, background.r), mix(color.g, background.g), mix(color.b, background.b)]
      .map((n) => Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0'))
      .join('')
  )
}

const rgbTriplet = (c: Rgba): string => `${c.r}, ${c.g}, ${c.b}`

/** The first variable of `names` that holds a colour, as Rgba. */
function colorOf(vars: VscodeVars, names: readonly string[], fallback: string): Rgba {
  for (const name of names) {
    const c = parseColor(vars[name])
    if (c) return c
  }
  return parseColor(fallback)!
}

/** The whole stylesheet: tokens on :root and on both Vuetify theme classes. */
export function themeCss(vars: VscodeVars, kind: ThemeKind): string {
  const d = DEFAULTS[isLight(kind) ? 'light' : 'dark']
  const decl = tokenDeclarations(kind)
  // rgba(var(--nd-accent-rgb), …) needs plain numbers: computed from the current values.
  const bg = colorOf(vars, ['editor-background'], d.bg)
  const accent = colorOf(vars, ['button-background'], d.accent)
  const violet = colorOf(vars, ['charts-purple'], '#b180d7')
  decl['--nd-accent-rgb'] = rgbTriplet(parseColor(toHex(accent, bg))!)
  decl['--nd-violet-rgb'] = rgbTriplet(parseColor(toHex(violet, bg))!)
  const body = Object.entries(decl)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
  return `:root,\n.v-theme--vortaqDark,\n.v-theme--vortaqLight {\n${body}\n}\n`
}

/** Vuetify theme colours (opaque hex) from the editor's variables. */
export function vuetifyColors(vars: VscodeVars, kind: ThemeKind): Record<string, string> {
  const d = DEFAULTS[isLight(kind) ? 'light' : 'dark']
  const bg = colorOf(vars, ['editor-background'], d.bg)
  const hex = (names: readonly string[], fallback: string): string =>
    toHex(colorOf(vars, names, fallback), bg)
  const surface = hex(['editorWidget-background', 'editor-background'], d.widget)
  const fg = hex(['foreground'], d.fg)
  return {
    background: toHex(bg),
    surface,
    'surface-bright': surface,
    'surface-light': hex(['input-background'], d.input),
    'surface-variant': hex(['input-background'], d.input),
    'on-surface-variant': fg,
    'on-background': fg,
    'on-surface': fg,
    primary: hex(['button-background'], d.accent),
    'on-primary': hex(['button-foreground'], d.onAccent),
    secondary: hex(['charts-purple'], '#b180d7'),
    'on-secondary': '#ffffff',
    accent: hex(['charts-purple'], '#b180d7'),
    success: hex(['testing-iconPassed', 'charts-green'], '#73c991'),
    warning: hex(['editorWarning-foreground'], '#cca700'),
    error: hex(['errorForeground'], '#f85149'),
    info: hex(['editorInfo-foreground'], '#3794ff')
  }
}

/** The Vuetify theme each kind uses. */
export function vuetifyThemeName(kind: ThemeKind): 'vortaqDark' | 'vortaqLight' {
  return isLight(kind) ? 'vortaqLight' : 'vortaqDark'
}

/** --vscode-* variables of the page. */
export function readVscodeVars(
  root: HTMLElement = document.documentElement
): Record<string, string> {
  const vars: Record<string, string> = {}
  const style = getComputedStyle(root)
  for (let i = 0; i < root.style.length; i++) {
    const name = root.style[i]
    if (name.startsWith('--vscode-')) vars[name.slice(9)] = style.getPropertyValue(name).trim()
  }
  return vars
}

interface VuetifyThemeApi {
  themes: { value: Record<string, { colors: Record<string, string | undefined> }> }
  change(name: string): void
}

/**
 * Applies the editor theme now and on every change VS Code makes (body class
 * and the variables on <html>). The stylesheet carries the page's nonce.
 */
export function applyEditorTheme(theme: VuetifyThemeApi, nonce: string): () => void {
  const style = document.createElement('style')
  style.id = 'vortaq-editor-theme'
  if (nonce) style.setAttribute('nonce', nonce)
  document.head.appendChild(style)
  const apply = (): void => {
    const vars = readVscodeVars()
    const kind = themeKindOf(document.body.classList)
    style.textContent = themeCss(vars, kind)
    const name = vuetifyThemeName(kind)
    Object.assign(theme.themes.value[name].colors, vuetifyColors(vars, kind))
    theme.change(name)
    document.documentElement.dataset.vortaqTheme = kind
  }
  apply()
  const observer = new MutationObserver(() => apply())
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  return () => observer.disconnect()
}
