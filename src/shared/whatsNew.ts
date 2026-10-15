import { compareVersions, parseVersion, releaseOf } from './semver'
import type { TourStep } from './tour'

/**
 * Curated, bundled «novedades» shown once after updating (works offline).
 * Keep each entry short: at most 5 highlights in Spanish, one line each, and
 * `important` only for things the user has to know or do.
 * Add the entry of a version before tagging it.
 */
export interface WhatsNewEntry {
  version: string
  /** Release date, YYYY-MM-DD. */
  date: string
  /** At most 5 short bullets. */
  highlights: string[]
  /** Actions or changes the user must be aware of (shown first, highlighted). */
  important?: string[]
  /**
   * Optional «Mostrarme cómo» steps. Targets are `data-tour` values; when a
   * feature lives inside a dialog that is closed, leave `target` out and
   * explain where to find it in the text.
   */
  tour?: TourStep[]
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '2.1.1',
    date: '2026-10-15',
    highlights: [
      'Ajustes › Agentes (MCP) lista todas tus conexiones: actívalas para agentes y elige su nivel ahí mismo, sin abrir cada una',
      'Los cambios se aplican al pulsar «Guardar»; en Producción «Lectura y escritura» sigue sin poder elegirse'
    ],
    tour: [
      {
        target: 'toolbar-settings',
        title: 'Permisos de agentes',
        text: 'En Ajustes › Agentes (MCP) cada conexión tiene su interruptor y su nivel. Pulsa «Guardar» y el agente lo verá en su siguiente llamada.'
      }
    ]
  },
  {
    version: '2.1.0',
    date: '2026-10-14',
    highlights: [
      'Agentes (MCP): Claude Code, Claude Desktop, Cursor o VS Code pueden usar las conexiones que elijas; Vortaq no les da contraseñas, hosts, usuarios ni rutas',
      'Actívalo en Ajustes › Agentes (MCP), donde está la configuración lista para copiar en cada cliente; el agente arranca Vortaq solo, con la app abierta o cerrada',
      'Cada conexión decide en editar conexión › Agentes (MCP): «Solo estructura», «Lectura» (por defecto) o «Lectura y escritura»',
      'Las conexiones de producción nunca permiten escribir a un agente; las consultas de lectura van en una sesión de solo lectura, con límite de filas y de tiempo',
      'Con «Lectura» los resultados de las consultas del agente llegan a su proveedor de IA; con «Solo estructura» no se envía ningún resultado'
    ],
    tour: [
      {
        target: 'toolbar-settings',
        title: 'Agentes (MCP)',
        text: 'En Ajustes › Agentes (MCP) activa el acceso para agentes y copia la configuración de tu cliente. Después, en cada conexión, abre Editar › Agentes (MCP) y elige qué puede hacer el agente.'
      }
    ]
  },
  {
    version: '2.0.2',
    date: '2026-10-14',
    highlights: [
      'Selecciona celdas, filas o columnas enteras en los resultados y en la vista de datos: clic en la cabecera para la columna, Shift y Cmd/Ctrl para ampliar',
      'Cmd/Ctrl+C copia la selección para pegarla en una hoja de cálculo; con el botón derecho, «Copiar como» CSV, JSON, INSERT, UPDATE, lista para IN o Markdown',
      '«Exportar» a CSV, Excel, JSON, SQL, Markdown, HTML o TXT: la selección, las filas cargadas o el resultado completo, sin límite de filas',
      'El resultado completo se vuelve a ejecutar en una sesión de solo lectura, con progreso y «Cancelar»',
      'Los resultados de varias tablas también se pueden seleccionar, copiar y exportar; para ordenar, usa la flecha de la cabecera'
    ],
    tour: [
      {
        target: 'toolbar-query',
        title: 'Copiar y exportar resultados',
        text: 'Ejecuta una consulta: haz clic en la cabecera de una columna para seleccionarla y usa el botón derecho para «Copiar como» o «Exportar…». El botón «Exportar» de la barra del resultado también guarda el resultado completo.'
      }
    ]
  },
  {
    version: '2.0.1',
    date: '2026-10-08',
    highlights: [
      'Nuevo editor de tareas: secuencia de pasos arriba y «Añadir pasos» abajo; reordena arrastrando o con Alt+↑/↓ y ajusta cada paso en un panel lateral',
      'Busca en conexión › base de datos y añade copias, consultas guardadas, SQL o restauraciones con doble clic, arrastrando o con «Seleccionar todo»',
      '«Copiar y restaurar»: copia todas las bases de datos de una conexión (p. ej. Staging) y restáuralas en otra (Local) en cada ejecución, con o sin copia previa del destino',
      '«Restaurar paquete»: un solo paso restaura todas las copias de la tarea, o el último paquete de otra tarea, con sus nombres de destino; la lista de restauraciones se agrupa por tarea',
      'Programación, Opciones e Historial en sus propias secciones; y una pantalla de inicio con el logo de Vortaq mientras carga la app'
    ],
    tour: [
      {
        target: 'toolbar-automation',
        title: 'Nuevo editor de tareas',
        text: 'Abre o crea una tarea: elige el tipo de paso en «Añadir pasos», busca la conexión y la base de datos y añade lo que quieras ejecutar. Haz clic en un paso para ver sus ajustes y arrástralo para cambiar el orden.'
      }
    ]
  },
  {
    version: '2.0.0',
    date: '2026-10-07',
    highlights: [
      'ElectronDB ahora se llama Vortaq, con nuevo icono y barra de herramientas reorganizada',
      'Copias .vqb: formato propio, abierto y con cifrado opcional',
      'Importa conexiones y copias desde DBeaver, MySQL Workbench, Navicat y .sql, y exporta copias en .sql',
      'PostgreSQL, SQLite y MongoDB, con copias .vqb y tareas automáticas: Conexión › Nueva conexión',
      'MariaDB como motor propio: secuencias, tablas versionadas y cuentas ed25519/parsec'
    ],
    important: ['Tus datos se trasladan automáticamente a Vortaq'],
    tour: [
      {
        target: 'toolbar-objects',
        title: 'Objetos',
        text: 'Tablas, vistas, funciones, eventos y consultas guardadas de la base de datos seleccionada, y los botones para crear tablas, vistas y rutinas, ahora están juntos en «Objetos».'
      },
      {
        target: 'toolbar-more',
        title: 'Más',
        text: 'Importar, buscar actualizaciones, el tour de bienvenida, el registro, los ajustes y «Acerca de Vortaq» (con las licencias de terceros) están en «Más».'
      },
      {
        target: 'toolbar-more',
        title: 'Importar desde otros gestores',
        text: 'Más › Importar… trae conexiones de Navicat (carpeta o archivo .ncx), DBeaver y MySQL Workbench, y restaura volcados .sql o .sql.gz y copias .nb3.'
      },
      {
        target: 'toolbar-backup',
        title: 'Copias .vqb',
        text: '«Nueva copia» guarda por defecto un .vqb: el formato abierto y documentado de Vortaq, para todos los motores, con «Cifrar con contraseña» opcional. En MySQL y MariaDB sigues pudiendo elegir .nb3 (Navicat) o .sql, también en los pasos de copia de la automatización.'
      },
      {
        target: 'toolbar-connection',
        title: 'PostgreSQL',
        text: 'Conexión › Nueva conexión PostgreSQL: bases de datos y esquemas, una sesión con su transacción por pestaña de consulta, datos editables, diseñador y copias .vqb.'
      },
      {
        target: 'toolbar-connection',
        title: 'SQLite',
        text: 'Conexión › Nueva conexión SQLite abre un archivo .db o crea uno nuevo. Las pestañas de consulta de un archivo comparten su transacción: confírmala o deshazla desde la pestaña que la abrió.'
      },
      {
        target: 'toolbar-connection',
        title: 'MongoDB',
        text: 'Conexión › Nueva conexión MongoDB (con «Pegar URI»): documentos en tabla, árbol o JSON que se editan sin cambiar sus tipos, consultas con órdenes del shell como db.pedidos.find({...}) o aggregate([...]), índices, validador y copias .vqb.'
      },
      {
        target: 'toolbar-connection',
        title: 'MariaDB',
        text: 'Conexión › Nueva conexión MariaDB: secuencias en el árbol, tablas versionadas en el diseñador, tipos UUID e INET6 y cuentas ed25519 o parsec. Tus conexiones MySQL a servidores MariaDB pasan a ser MariaDB al abrirlas, con sus copias y tareas.'
      },
      {
        target: 'toolbar-automation',
        title: 'Tareas para todos los motores',
        text: 'Las tareas automáticas copian y restauran también bases de datos PostgreSQL, SQLite y MongoDB, en .vqb y con cifrado opcional. Las restauraciones nunca escriben en producción sin escribir su nombre.'
      },
      {
        target: 'toolbar-ai',
        title: 'El asistente ve toda la conexión',
        text: 'En el panel de IA, el nombre de la base de datos es un menú: «Solo <base de datos>» o «Toda la conexión», para preguntas que cruzan bases de datos (en PostgreSQL, todos los esquemas de la base de datos). Solo se envía la estructura.'
      }
    ]
  },
  {
    version: '0.1.9',
    date: '2026-10-07',
    highlights: [
      'Actualización integrada: descarga e instala la nueva versión desde la app (Windows y Linux; en Mac descarga el instalador)',
      'Instalador de Windows más robusto al actualizar'
    ]
  },
  {
    version: '0.1.8',
    date: '2026-10-07',
    highlights: [
      'Conexiones sin contraseña: para proxies, túneles o certificados (Autenticación › Sin contraseña)'
    ]
  },
  {
    version: '0.1.7',
    date: '2026-10-07',
    highlights: [
      'Tour de bienvenida y guía de novedades',
      'Detección automática de Navicat',
      'El brillo de los campos ya no cruza la etiqueta ni se ve cuadrado'
    ],
    tour: [
      {
        target: 'toolbar-more',
        title: 'Tour de bienvenida',
        text: 'Puedes repetir el recorrido por Vortaq cuando quieras desde Más › Ver tour de bienvenida, o desde Ajustes.'
      },
      {
        target: 'toolbar-connection',
        title: 'Detección automática de Navicat',
        text: 'En Conexión › Importar…, Vortaq busca la carpeta de Navicat por ti y te pregunta si es la correcta antes de importar.'
      }
    ]
  },
  {
    version: '0.1.6',
    date: '2026-10-06',
    highlights: [
      'Al reemplazar una base de datos puedes elegir «Solo estructura» (tablas y relaciones sin datos)',
      'Asistente de IA con tu propia clave (Claude, OpenAI, Groq, Grok, GLM, Ollama): pregunta sobre tu base de datos, genera y explica SQL; solo se envía la estructura'
    ],
    tour: [
      {
        target: 'toolbar-ai',
        title: 'Asistente de IA',
        text: 'Abre el panel del asistente para preguntar sobre tu base de datos. Actívalo antes en Ajustes › IA con tu propia clave; solo se envía la estructura, nunca los datos.'
      },
      {
        target: ['ai-generate', 'toolbar-query'],
        title: 'Generar SQL con IA',
        text: 'En una pestaña de consulta, «Generar SQL con IA» escribe la consulta a partir de tu descripción y la inserta en el editor sin ejecutarla.'
      },
      {
        title: 'Restaurar «Solo estructura»',
        text: 'Al restaurar una copia con «Reemplazar la base de datos completa», elige «Solo estructura» para recrear las tablas y relaciones sin copiar los datos.'
      }
    ]
  },
  {
    version: '0.1.5',
    date: '2026-10-06',
    highlights: [
      'Elige en Ajustes › Seguridad qué entornos piden escribir el nombre antes de escribir (Producción por defecto)',
      'Las conexiones que piden escribir el nombre muestran un candado junto a su entorno',
      'Las tareas automáticas no restauran sobre los entornos que piden escribir el nombre'
    ],
    important: ['Producción ahora siempre pide escribir el nombre; ya no se puede desactivar.']
  },
  {
    version: '0.1.4',
    date: '2026-10-06',
    highlights: [
      'Confirmación antes de borrar o eliminar en cualquier conexión (DROP, TRUNCATE, DELETE, filas, tablas, bases de datos…)',
      'Las consultas avisan de los DELETE o UPDATE sin WHERE antes de ejecutarlos',
      'Aviso de nueva versión en una ventana con lo más destacado',
      'Esta ventana de novedades tras cada actualización'
    ],
    important: [
      'La confirmación está activada por defecto. Puedes desactivarla en Ajustes › Seguridad.'
    ]
  },
  {
    version: '0.1.3',
    date: '2026-10-06',
    highlights: [
      'Aviso al iniciar cuando hay una versión nueva en GitHub',
      'Nueva opción «Buscar actualizaciones…» en el menú y en Ajustes'
    ]
  },
  {
    version: '0.1.2',
    date: '2026-10-06',
    highlights: [
      'Selector de conexión en las pestañas de consulta',
      'Filtros de tabla visuales, sin escribir SQL',
      'Selector de fecha y hora en la cuadrícula',
      'Columnas redimensionables',
      'Panel Texto para ver y editar valores largos'
    ]
  },
  {
    version: '0.1.1',
    date: '2026-10-06',
    highlights: [
      '«Restaurar todo en Local» desde las ejecuciones de automatización y los paquetes de copias',
      'Copia de seguridad automática de Local antes de cada restauración'
    ]
  }
]

/**
 * Entries newer than `previous` (exclusive) up to `current` (inclusive), newest
 * first. A pre-release of `current` (2.0.0-alpha.1) includes the entry of the
 * release it leads to (2.0.0), which is written before tagging. Empty for a
 * fresh profile (no previous version), the same version, a downgrade or
 * invalid versions.
 */
export function whatsNewBetween(
  previous: string | null | undefined,
  current: string,
  entries: WhatsNewEntry[] = WHATS_NEW
): WhatsNewEntry[] {
  if (!previous || !parseVersion(previous) || !parseVersion(current)) return []
  if ((compareVersions(current, previous) ?? 0) <= 0) return []
  const upTo = releaseOf(current) ?? current
  return entries
    .filter(
      (e) =>
        (compareVersions(e.version, previous) ?? 0) > 0 &&
        (compareVersions(e.version, upTo) ?? 1) <= 0
    )
    .sort((a, b) => compareVersions(b.version, a.version) ?? 0)
}

/** «Mostrarme cómo» steps of the given entries, oldest version first. */
export function tourStepsOf(entries: readonly WhatsNewEntry[]): TourStep[] {
  return [...entries]
    .sort((a, b) => compareVersions(a.version, b.version) ?? 0)
    .flatMap((e) => e.tour ?? [])
}

/** Entry of `version` (of the release it leads to, for a pre-release), if any. */
export function whatsNewFor(
  version: string,
  entries: WhatsNewEntry[] = WHATS_NEW
): WhatsNewEntry | null {
  const release = releaseOf(version) ?? version
  return entries.find((e) => compareVersions(e.version, release) === 0) ?? null
}
