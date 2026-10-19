# Vortaq

Cliente de bases de datos para VS Code y los editores compatibles (Cursor, VSCodium, Windsurf).
Conecta con **MySQL, MariaDB, PostgreSQL, SQLite y MongoDB**, ejecuta SQL desde tus archivos
`.sql`, edita los resultados y cópialos o expórtalos sin salir del editor. Es la extensión de
[Vortaq](https://github.com/Y0rshB3/Vortaq), el cliente de bases de datos de escritorio de código
abierto, y usa su mismo núcleo: los mismos controladores, el mismo análisis de SQL y la misma
protección de las conexiones de producción.

También puedes usar [Vortaq de escritorio](https://github.com/Y0rshB3/Vortaq#readme), la aplicación para
macOS, Windows y Linux, con diseñador de tablas, copias de seguridad y automatización.

## Qué puedes hacer

- **Conexiones en la barra de actividad.** El icono de Vortaq abre el árbol de conexiones:
  conexión › bases de datos (en PostgreSQL, › esquemas) › Tablas y Vistas; en MongoDB, ›
  Colecciones y Vistas; en SQLite, la base principal y las adjuntas. Cada conexión muestra el icono
  de su motor en su color, su entorno (L, S, P) y un candado si sus escrituras piden confirmación.
  Al desplegar una conexión se abre.
- **Añadir y editar conexiones** con el formulario de Vortaq: los cinco motores, túnel SSH,
  SSL/TLS, entorno (incluido Producción), «Sin contraseña» y «Probar conexión».
- **Importar desde Vortaq de escritorio.** «Importar de Vortaq» lee las conexiones de la aplicación
  de escritorio instalada en este equipo y te deja elegir cuáles traer. **Las contraseñas no se
  importan**: la aplicación de escritorio las guarda cifradas con su propia clave. Las escribes una
  vez al conectar y quedan guardadas en el almacén seguro del editor.
- **Ejecutar SQL desde el editor.** En cualquier archivo `.sql` (o documento SQL sin guardar) elige
  la conexión y la base de datos desde la barra de estado, el texto sobre la primera línea o el
  botón del título del editor. Cada documento recuerda la suya.
  - **Ejecutar** (`Cmd+Enter` / `Ctrl+Enter`): la selección; si no hay, la sentencia donde está el
    cursor; si no hay ninguna, el documento entero.
  - **Ejecutar todo** (`Cmd+Shift+Enter` / `Ctrl+Shift+Enter`): el documento completo.
  - **Detener**: cancela la sentencia en PostgreSQL y SQLite; en MySQL y MariaDB descarta los
    resultados que lleguen después.
- **Resultados** en un panel al lado del editor: un resultado por pestaña, la pestaña Mensajes con
  cada sentencia, filas devueltas o afectadas y su tiempo, y **Copiar** todo el resultado como TSV,
  CSV o JSON.
- **Seleccionar y copiar** como en una hoja de cálculo: celdas (clic, `Shift`+clic, arrastrar,
  `Shift`+flechas), filas (el número de fila), columnas (la cabecera) o todo (`Cmd/Ctrl+A`).
  `Cmd/Ctrl+C` copia la selección como texto tabulado, listo para pegar en una hoja de cálculo; el
  botón derecho ofrece **Copiar con encabezados** y **Copiar como** CSV, JSON, `INSERT`, `UPDATE`,
  lista para `IN` o Markdown, con las comillas de cada motor.
- **Exportar** (barra del resultado o botón derecho) a **CSV**, **Excel** (`.xlsx`), **JSON**,
  **SQL** (`INSERT`), **Markdown**, **HTML** o **TXT**: la selección, las filas cargadas o el
  **resultado completo**. El resultado completo vuelve a ejecutar la consulta en una sesión nueva de
  **solo lectura**, sin límite de filas (en «Ver datos», toda la tabla); no ve los cambios sin
  confirmar de tu documento, solo se ofrece para una única sentencia de lectura y por eso no pide la
  confirmación de producción. Su progreso aparece en el panel y en una notificación, con
  **Cancelar**. Eliges el archivo con el diálogo de guardar del editor; se escribe como
  `<archivo>.part` y solo toma su nombre al terminar. Al acabar puedes **Abrir** el archivo o
  **Mostrarlo en la carpeta**. (Los documentos de MongoDB no usan esta exportación.)
- **Resultados editables.** Cuando la consulta lee una sola tabla e incluye su clave primaria,
  puedes editar celdas, añadir y borrar filas, poner `NULL` y pulsar **Aplicar** (o Descartar).
  Las columnas con clave foránea tienen un botón (o `Alt+↓`) para elegir el valor entre las filas
  de la tabla relacionada, y las columnas `ENUM` se editan con su lista de valores.
- **Diagrama de relaciones.** Botón derecho en una base de datos (o en un esquema de PostgreSQL) ›
  «Diagrama de relaciones»: las tablas con sus columnas y claves y una línea por clave foránea.
  Muévelas, haz zoom, mira «Solo claves», abre los datos de una tabla con doble clic y exporta el
  diagrama a PNG o SVG.
- **Consulta gráfica.** En el mismo menú: añade tablas (se unen solas por sus claves foráneas),
  marca columnas y elige totales, orden y filtros, con el SQL a la vista. **Abrir en consulta** lo
  lleva a un documento SQL nuevo y **Ejecutar** además lo ejecuta allí, con las protecciones de
  siempre.
- **Ver datos** de una tabla o vista y **Ver documentos** de una colección de MongoDB (como tabla o
  como JSON; en esta versión, de solo lectura).
- **El tema de tu editor.** Los paneles usan los colores, la fuente y el tamaño del editor, en
  temas claros, oscuros y de alto contraste.

## Conexiones de producción

Cualquier escritura en una conexión marcada como **Producción** te pide escribir el nombre de la
conexión antes de enviarse al servidor: sentencias que no son de solo lectura, cambios aplicados
desde los resultados, etc. Puedes añadir otros entornos con el ajuste
`vortaq.typedConfirmEnvironments`; Producción siempre lo pide. Si algo llegara al servidor sin esa
confirmación, el núcleo de Vortaq lo rechaza igualmente.

Con `vortaq.confirmDestructive` activado (por defecto), `DROP`, `TRUNCATE`, `DELETE` o borrar filas
también piden confirmación en el resto de conexiones.

## Seguridad y privacidad

- Las contraseñas se guardan cifradas (AES-256-GCM) en la carpeta de datos de la extensión. La clave
  está en el almacén seguro del editor (SecretStorage), que usa el llavero del sistema: Llavero de
  macOS, Administrador de credenciales de Windows o el servicio de secretos de Linux. **En Linux**,
  sin un llavero (gnome-keyring, KWallet…) el editor puede recurrir a un almacén más débil; configura
  uno si guardas contraseñas.
- La extensión no envía tus datos a ningún sitio: solo se conecta a los servidores de base de datos
  que configures (y a sus túneles SSH). Exportar escribe únicamente en el archivo que eliges en el
  diálogo de guardar.
- El registro («Vortaq» en el panel Salida) nunca incluye contraseñas ni datos de las filas.
- Las conexiones de la extensión son independientes de las de Vortaq de escritorio: cada aplicación
  guarda las suyas.

## Requisitos

- VS Code 1.123 o posterior, o un editor basado en esa versión o en una más reciente.
- **SQLite** usa el módulo `node:sqlite` del propio editor (Node 24.10 o posterior), sin módulos
  nativos. Si el editor no lo trae (por ejemplo, algunos servidores remotos), SQLite no aparece en el
  formulario y sus conexiones explican por qué.

## Ajustes

| Ajuste                            | Por defecto      | Qué hace                                                              |
| --------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `vortaq.maxRows`                  | `1000`           | Filas que se muestran como máximo en cada resultado y en «Ver datos». |
| `vortaq.typedConfirmEnvironments` | `["production"]` | Entornos que piden escribir el nombre de la conexión al escribir.     |
| `vortaq.confirmDestructive`       | `true`           | Confirmar antes de borrar o eliminar en cualquier conexión.           |
| `vortaq.codeLens`                 | `true`           | Mostrar la conexión y «Ejecutar todo» sobre los documentos SQL.       |

Los dos ajustes de seguridad solo se pueden cambiar en los ajustes de usuario, no en los de un
espacio de trabajo.

## En esta versión todavía no

Diseñador de tablas, copias de seguridad `.vqb`, edición de documentos de MongoDB, consultas de
MongoDB desde el editor, paginación de resultados («Cargar más») y autocompletado con la estructura
de la base de datos. Llegarán en las próximas versiones.

## Licencia

MIT. Los componentes de terceros que incluye la extensión y sus licencias están en
`dist/THIRD_PARTY_NOTICES.txt`.
