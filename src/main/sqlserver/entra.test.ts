import { describe, expect, it } from 'vitest'
import type { AccessToken, TokenCredential } from '@azure/core-auth'
import { defaultSqlServerOptions } from '@shared/engines'
import { AZURE_SQL_SCOPE, azureSqlOnly, entraCredential, isAzureSqlScope } from './entra'

describe('Microsoft Entra tokens only for Azure SQL', () => {
  it('accepts the Azure SQL scope of each cloud, nothing else', () => {
    for (const scope of [
      AZURE_SQL_SCOPE,
      'https://DATABASE.windows.net/.default',
      'https://database.usgovcloudapi.net/.default',
      'https://database.chinacloudapi.cn/.default'
    ])
      expect(isAzureSqlScope(scope), scope).toBe(true)
    for (const scope of [
      'https://management.azure.com/.default',
      'https://graph.microsoft.com/.default',
      'https://vault.azure.net/.default',
      'https://storage.azure.com/.default',
      'https://database.windows.net.attacker.example/.default',
      'https://attacker.example/database.windows.net/.default',
      'https://database.windows.net:8443/.default',
      'https://user@database.windows.net/.default',
      'https://database.windows.net/.default?x=1',
      'https://database.windows.net/other/.default',
      'http://database.windows.net/.default',
      'database.windows.net/.default',
      ''
    ])
      expect(isAzureSqlScope(scope), scope).toBe(false)
  })

  it('never asks the sign-in method for a token of another service', async () => {
    const asked: string[] = []
    const inner: TokenCredential = {
      getToken: async (scopes): Promise<AccessToken> => {
        asked.push(String(scopes))
        return { token: 't', expiresOnTimestamp: Date.now() + 60_000 }
      }
    }
    const guarded = azureSqlOnly(inner)
    for (const scope of [
      'https://management.azure.com/.default',
      'https://graph.microsoft.com/.default',
      'https://vault.azure.net/.default'
    ])
      await expect(guarded.getToken(scope)).rejects.toMatchObject({ code: 'E_MS_ENTRA_AUDIENCE' })
    await expect(
      guarded.getToken([AZURE_SQL_SCOPE, 'https://graph.microsoft.com/.default'])
    ).rejects.toMatchObject({ code: 'E_MS_ENTRA_AUDIENCE' })
    expect(asked).toEqual([])
    expect(await guarded.getToken(AZURE_SQL_SCOPE)).toMatchObject({ token: 't' })
    expect(asked).toEqual([AZURE_SQL_SCOPE])
  })

  it('every sign-in method goes through the guard', async () => {
    for (const auth of ['entra-azure-cli', 'entra-service-principal'] as const) {
      const credential = entraCredential(
        { username: '' },
        {
          ...defaultSqlServerOptions(),
          auth,
          tenantId: 'contoso.onmicrosoft.com',
          clientId: 'app'
        },
        'secret'
      )
      // Refused before az runs or the client secret is sent anywhere.
      await expect(
        credential.getToken('https://management.azure.com/.default')
      ).rejects.toMatchObject({ code: 'E_MS_ENTRA_AUDIENCE' })
    }
  })
})
