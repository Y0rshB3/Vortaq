import { describe, expect, it } from 'vitest'
import {
  claudeCodeCommand,
  claudeDesktopConfig,
  codexConfig,
  cursorConfig,
  effectiveMcpAccess,
  genericClientInfo,
  geminiConfig,
  isMcpArgv,
  isMcpEnabled,
  mcpClientSnippets,
  mcpConfigError,
  mcpLaunchOf,
  MCP_WRITE_BLOCKED,
  normalizeMcpConfig,
  opencodeConfig,
  vscodeConfig
} from './mcp'

describe('per-connection MCP setting', () => {
  it('missing means off; anything malformed is off, never a guess', () => {
    expect(normalizeMcpConfig(undefined)).toBeUndefined()
    expect(normalizeMcpConfig(null)).toBeUndefined()
    expect(normalizeMcpConfig(true)).toEqual({ enabled: false, access: 'read' })
    expect(normalizeMcpConfig([])).toEqual({ enabled: false, access: 'read' })
    expect(normalizeMcpConfig({ enabled: true, access: 'admin' })).toEqual({
      enabled: false,
      access: 'read'
    })
    expect(normalizeMcpConfig({ enabled: 'yes', access: 'write' })).toEqual({
      enabled: false,
      access: 'write'
    })
    expect(normalizeMcpConfig({ enabled: true, access: 'structure', extra: 1 })).toEqual({
      enabled: true,
      access: 'structure'
    })
    expect(isMcpEnabled({ mcp: { enabled: true, access: 'read' } })).toBe(true)
    expect(isMcpEnabled({})).toBe(false)
  })

  it('write is lowered to read where the typed confirmation applies (production always)', () => {
    const write = { enabled: true, access: 'write' as const }
    expect(effectiveMcpAccess({ mcp: write, environment: 'local' }, ['production'])).toBe('write')
    expect(effectiveMcpAccess({ mcp: write, environment: 'production' }, [])).toBe('read')
    expect(
      effectiveMcpAccess({ mcp: write, environment: 'staging' }, ['production', 'staging'])
    ).toBe('read')
    expect(
      effectiveMcpAccess(
        { mcp: { enabled: true, access: 'structure' }, environment: 'production' },
        []
      )
    ).toBe('structure')
    expect(
      effectiveMcpAccess({ mcp: { enabled: false, access: 'read' }, environment: 'local' }, [])
    ).toBeNull()
    expect(effectiveMcpAccess({ environment: 'local' }, [])).toBeNull()
  })

  it('saving write on a guarded environment is a form error; off or lower levels are fine', () => {
    expect(
      mcpConfigError({ mcp: { enabled: true, access: 'write' }, environment: 'production' }, [])
    ).toBe(MCP_WRITE_BLOCKED)
    expect(
      mcpConfigError({ mcp: { enabled: false, access: 'write' }, environment: 'production' }, [])
    ).toBeNull()
    expect(
      mcpConfigError({ mcp: { enabled: true, access: 'read' }, environment: 'production' }, [])
    ).toBeNull()
    expect(
      mcpConfigError({ mcp: { enabled: true, access: 'write' }, environment: 'local' }, [
        'production'
      ])
    ).toBeNull()
  })
})

describe('MCP launch command and client snippets', () => {
  const mac = mcpLaunchOf({
    execPath: '/Applications/Vortaq.app/Contents/MacOS/Vortaq',
    packaged: true,
    appPath: '/Applications/Vortaq.app/Contents/Resources/app.asar',
    platform: 'darwin'
  })
  const win = mcpLaunchOf({
    execPath: 'C:\\Users\\Ana\\AppData\\Local\\Programs\\Vortaq\\Vortaq.exe',
    packaged: true,
    appPath: '',
    platform: 'win32'
  })

  it('uses the executable (the AppImage file on Linux) or Electron plus the source folder', () => {
    expect(mac).toEqual({
      command: '/Applications/Vortaq.app/Contents/MacOS/Vortaq',
      args: ['--mcp'],
      platform: 'darwin',
      packaged: true
    })
    expect(
      mcpLaunchOf({
        execPath: '/tmp/.mount_VortaqXyz/vortaq',
        packaged: true,
        appPath: '',
        platform: 'linux',
        appImage: '/home/ana/Apps/Vortaq-2.1.0-x86_64.AppImage'
      }).command
    ).toBe('/home/ana/Apps/Vortaq-2.1.0-x86_64.AppImage')
    expect(
      mcpLaunchOf({
        execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        packaged: false,
        appPath: '/repo',
        platform: 'darwin'
      })
    ).toMatchObject({ args: ['/repo', '--mcp'], packaged: false })
  })

  it('builds each client format', () => {
    expect(claudeCodeCommand(mac)).toBe(
      'claude mcp add vortaq -- "/Applications/Vortaq.app/Contents/MacOS/Vortaq" --mcp'
    )
    expect(claudeCodeCommand(win)).toBe(
      'claude mcp add vortaq -- "C:\\Users\\Ana\\AppData\\Local\\Programs\\Vortaq\\Vortaq.exe" --mcp'
    )
    expect(JSON.parse(claudeDesktopConfig(win))).toEqual({
      mcpServers: { vortaq: { command: win.command, args: ['--mcp'] } }
    })
    expect(JSON.parse(cursorConfig(mac))).toEqual({
      mcpServers: { vortaq: { type: 'stdio', command: mac.command, args: ['--mcp'] } }
    })
    expect(JSON.parse(vscodeConfig(mac))).toEqual({
      servers: { vortaq: { type: 'stdio', command: mac.command, args: ['--mcp'] } }
    })
    const dev = mcpLaunchOf({
      execPath: '/r/Electron',
      packaged: false,
      appPath: '/my repo',
      platform: 'linux'
    })
    expect(claudeCodeCommand(dev)).toBe('claude mcp add vortaq -- "/r/Electron" "/my repo" --mcp')
    expect(mcpClientSnippets(win).map((s) => s.id)).toEqual([
      'claudeCode',
      'claudeDesktop',
      'codex',
      'gemini',
      'antigravity',
      'cursor',
      'vscode',
      'opencode',
      'other'
    ])
    expect(mcpClientSnippets(win)[1].where).toBe('%APPDATA%\\Claude\\claude_desktop_config.json')
    expect(isMcpArgv(['/x/Vortaq', '--mcp'])).toBe(true)
    expect(isMcpArgv(['/x/Electron', '/repo'])).toBe(false)
  })

  it('builds the Codex, Gemini, Antigravity, OpenCode and generic snippets', () => {
    expect(codexConfig(mac)).toBe(
      [
        '[mcp_servers.vortaq]',
        'command = "/Applications/Vortaq.app/Contents/MacOS/Vortaq"',
        'args = ["--mcp"]',
        'tool_timeout_sec = 130'
      ].join('\n')
    )
    // TOML basic strings: backslashes and quotes escaped, control characters as \uXXXX.
    expect(codexConfig(win)).toContain(
      'command = "C:\\\\Users\\\\Ana\\\\AppData\\\\Local\\\\Programs\\\\Vortaq\\\\Vortaq.exe"'
    )
    expect(codexConfig({ ...mac, command: '/x/"a"\tb' })).toContain(
      'command = "/x/\\"a\\"\\u0009b"'
    )
    expect(JSON.parse(geminiConfig(win))).toEqual({
      mcpServers: { vortaq: { command: win.command, args: ['--mcp'] } }
    })
    expect(JSON.parse(opencodeConfig(mac))).toEqual({
      mcp: { vortaq: { type: 'local', command: [mac.command, '--mcp'] } }
    })
    expect(genericClientInfo(mac)).toBe(
      [
        'Tipo: stdio (servidor local)',
        'Comando: /Applications/Vortaq.app/Contents/MacOS/Vortaq',
        'Argumentos: --mcp'
      ].join('\n')
    )
    const dev = mcpLaunchOf({
      execPath: '/r/Electron',
      packaged: false,
      appPath: '/my repo',
      platform: 'linux'
    })
    expect(codexConfig(dev)).toContain('args = ["/my repo", "--mcp"]')
    expect(JSON.parse(opencodeConfig(dev)).mcp.vortaq.command).toEqual([
      '/r/Electron',
      '/my repo',
      '--mcp'
    ])
    expect(genericClientInfo(dev)).toContain('Argumentos: "/my repo" --mcp')
    const where = (launch: typeof mac, id: string) =>
      mcpClientSnippets(launch).find((s) => s.id === id)?.where
    expect(where(win, 'codex')).toMatch(/^%USERPROFILE%\\\.codex\\config\.toml /)
    expect(where(mac, 'codex')).toMatch(/^~\/\.codex\/config\.toml /)
    expect(where(win, 'gemini')).toMatch(/^%USERPROFILE%\\\.gemini\\settings\.json /)
    expect(where(mac, 'antigravity')).toMatch(/^~\/\.gemini\/config\/mcp_config\.json /)
    expect(where(win, 'opencode')).toContain('%USERPROFILE%\\.config\\opencode\\opencode.json')
  })
})
