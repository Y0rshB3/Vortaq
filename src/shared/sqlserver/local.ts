/**
 * «Buscar servidores en este equipo» (SQL Server on Windows): what the scan of
 * src/main/sqlserver/localInstances.ts returns and the steps the connection
 * form shows when an instance does not accept TCP connections yet.
 */

export type LocalTcpState = 'enabled' | 'disabled' | 'unknown'

export interface LocalSqlServerInstance {
  /** Instance name; '' is the default instance (service MSSQLSERVER). */
  instance: string
  /** The Windows service is running. */
  running: boolean
  /** «2022», «2019»… from the service's program folder (MSSQL16.…), when known. */
  version: string | null
  /** SQL Server Configuration Manager of that version, e.g. «SQLServerManager16.msc». */
  configManager: string | null
  /**
   * enabled: a TCP port is known (from SQL Server Browser, or 1433 answering);
   * disabled: SQL Server Browser lists the instance without TCP;
   * unknown: nothing says either way (SQL Server Browser stopped).
   */
  tcp: LocalTcpState
  tcpPort: number | null
}

export interface LocalSqlServerScan {
  /** False on macOS and Linux: there is nothing to look for. */
  supported: boolean
  instances: LocalSqlServerInstance[]
  /** The SQL Server Browser service is running (named instances by name). */
  browserRunning: boolean
  /** For «Autenticación de Windows»: USERDOMAIN (the computer name for a local account). */
  windowsDomain: string
  windowsUser: string
  /** Why the scan could not list the services (PowerShell blocked…), or null. */
  problem: string | null
}

/** Display name: «SQLEXPRESS» or «Instancia predeterminada (MSSQLSERVER)». */
export function localInstanceLabel(instance: LocalSqlServerInstance): string {
  return instance.instance || 'Instancia predeterminada (MSSQLSERVER)'
}

/**
 * What to do so that Vortaq can connect: start the service, then turn TCP/IP on
 * with a fixed port. Vortaq connects over TCP only (the Microsoft tools on the
 * same PC use shared memory, which needs no network protocol).
 */
export function localInstanceSteps(instance: LocalSqlServerInstance): string[] {
  const steps: string[] = []
  const service = instance.instance
    ? `SQL Server (${instance.instance})`
    : 'SQL Server (MSSQLSERVER)'
  const manager = instance.configManager
    ? `Pulsa Win+R y escribe ${instance.configManager} (Administrador de configuración de SQL Server${instance.version ? ` ${instance.version}` : ''}).`
    : 'Abre el Administrador de configuración de SQL Server (Win+R: SQLServerManager16.msc en SQL Server 2022, 15 en 2019, 14 en 2017).'
  if (!instance.running)
    steps.push(
      `El servicio «${service}» está detenido: arráncalo en Servicios de Windows o en el Administrador de configuración.`
    )
  if (instance.tcp !== 'enabled') {
    const protocols = instance.instance
      ? `Protocolos de ${instance.instance}`
      : 'Protocolos de MSSQLSERVER'
    steps.push(
      manager,
      `Configuración de red de SQL Server › ${protocols} › TCP/IP: clic derecho › Habilitar.`,
      'Doble clic en TCP/IP › pestaña «Direcciones IP» › al final, en «IPAll»: deja vacío «Puertos dinámicos TCP» y escribe 1433 en «Puerto TCP» (u otro puerto libre).',
      `Servicios de SQL Server › «${service}»: clic derecho › Reiniciar.`,
      'Vuelve aquí, pulsa «Buscar» otra vez y «Usar». Si Vortaq está en otro equipo, abre también ese puerto en el Firewall de Windows.'
    )
  }
  return steps
}
