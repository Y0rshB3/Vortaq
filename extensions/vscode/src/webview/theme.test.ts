import { describe, expect, it } from 'vitest'
import tokensCss from '@renderer/styles/tokens.css?raw'
import {
  parseColor,
  themeCss,
  themeKindOf,
  toHex,
  tokenDeclarations,
  vsVar,
  vuetifyColors,
  vuetifyThemeName,
  type ThemeKind
} from './theme'

/** Tokens that are sizes, motion or layout, not colours or fonts: they keep the desktop values. */
const LAYOUT_TOKENS = new Set([
  '--nd-radius-pill',
  '--nd-fs-dense',
  '--nd-fs-small',
  '--nd-fs-xs',
  '--nd-fs-title',
  '--nd-fs-heading',
  '--nd-fs-label',
  '--nd-fw-heading',
  '--nd-row-h',
  '--nd-control-h',
  '--nd-form-row-gap',
  '--nd-statusbar-h',
  '--nd-toolbar-h',
  '--nd-drag-region',
  '--nd-window-controls',
  '--nd-ease',
  '--nd-dur-fast',
  '--nd-dur',
  '--nd-dur-slow',
  // Computed from the editor's colours by themeCss (rgba(var(--nd-accent-rgb), …)).
  '--nd-accent-rgb',
  '--nd-violet-rgb'
])

const darkBlock = tokensCss.slice(
  tokensCss.indexOf(':root,'),
  tokensCss.indexOf('/*\n * Windows/Linux')
)
const desktopTokens = [...new Set([...darkBlock.matchAll(/(--nd-[a-z0-9-]+):/g)].map((m) => m[1]))]

const DARK_MODERN = {
  'editor-background': '#1f1f1f',
  'button-background': '#0078d4',
  'button-foreground': '#ffffff',
  foreground: '#cccccc',
  'editorWidget-background': '#202020',
  'charts-purple': '#b180d7',
  'list-hoverBackground': '#2a2d2e'
}

describe('editor theme → design tokens', () => {
  it('re-declares every colour and font token of the desktop app, in every kind of theme', () => {
    expect(desktopTokens.length).toBeGreaterThan(50)
    for (const kind of ['dark', 'light', 'hc-dark', 'hc-light'] as ThemeKind[]) {
      const declared = tokenDeclarations(kind)
      const missing = desktopTokens.filter((t) => !LAYOUT_TOKENS.has(t) && !(t in declared))
      expect(missing, kind).toEqual([])
    }
  })

  it('maps tokens to the editor variables with fallbacks', () => {
    const dark = tokenDeclarations('dark')
    expect(dark['--nd-bg-app']).toBe('var(--vscode-editor-background, #1f1f1f)')
    expect(dark['--nd-font-mono']).toContain('var(--vscode-editor-font-family')
    expect(dark['--nd-accent']).toContain('--vscode-button-background')
    expect(dark['--nd-nebula-cyan']).toBe('transparent')
    expect(dark['--nd-glow-filter']).toBe('none')
    expect(dark['color-scheme']).toBe('dark')
    expect(tokenDeclarations('light')['color-scheme']).toBe('light')
    expect(vsVar(['a', 'b'], '#000')).toBe('var(--vscode-a, var(--vscode-b, #000))')
  })

  it('high-contrast themes draw borders with the contrast border colour', () => {
    expect(tokenDeclarations('hc-dark')['--nd-border']).toContain('--vscode-contrastBorder')
    expect(tokenDeclarations('hc-light')['--nd-border-strong']).toContain(
      '--vscode-contrastActiveBorder'
    )
    expect(tokenDeclarations('dark')['--nd-border']).not.toContain('contrastBorder')
    expect(tokenDeclarations('hc-dark')['--nd-shadow-1']).toBe('none')
  })

  it('computes the rgb triplets the desktop styles use, over every theme class', () => {
    const css = themeCss(DARK_MODERN, 'dark')
    expect(css.startsWith(':root,\n.v-theme--vortaqDark,\n.v-theme--vortaqLight {')).toBe(true)
    expect(css).toContain('--nd-accent-rgb: 0, 120, 212;')
    expect(css).toContain('--nd-violet-rgb: 177, 128, 215;')
  })

  it('gives Vuetify opaque hex colours and the matching theme', () => {
    const colors = vuetifyColors(
      { ...DARK_MODERN, 'button-background': 'rgba(0, 120, 212, 0.5)' },
      'dark'
    )
    for (const value of Object.values(colors)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
    expect(colors.background).toBe('#1f1f1f')
    // Half-transparent accent blended over the editor background.
    expect(colors.primary).toBe('#104c7a')
    expect(vuetifyThemeName('hc-light')).toBe('vortaqLight')
    expect(vuetifyThemeName('hc-dark')).toBe('vortaqDark')
  })

  it('reads the theme kind from the body class VS Code sets', () => {
    const classes = (...names: string[]) => ({ contains: (c: string) => names.includes(c) })
    expect(themeKindOf(classes('vscode-light'))).toBe('light')
    expect(themeKindOf(classes('vscode-dark'))).toBe('dark')
    expect(themeKindOf(classes('vscode-high-contrast'))).toBe('hc-dark')
    expect(themeKindOf(classes('vscode-high-contrast', 'vscode-high-contrast-light'))).toBe(
      'hc-light'
    )
  })

  it('parses the colour forms VS Code uses', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#0078d480')).toEqual({ r: 0, g: 120, b: 212, a: 128 / 255 })
    expect(parseColor('rgba(10, 20, 30, 0.25)')).toEqual({ r: 10, g: 20, b: 30, a: 0.25 })
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
    expect(parseColor('transparent')).toBeNull()
    expect(toHex({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 })).toBe('#808080')
  })
})
