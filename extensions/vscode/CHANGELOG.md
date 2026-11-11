# Cambios

## 0.7.0 — autocompletado, formato, historial y más en el árbol (2026-11-11)

- **Autocompletado con la estructura** en los documentos `.sql`: palabras clave del motor y las bases de datos,
  esquemas, tablas, vistas, columnas (con su tipo) y funciones de la conexión del documento, con el mismo
  análisis que el editor de escritorio (alias, `JOIN`, `[corchetes]` de SQL Server). Solo mientras la conexión
  está abierta: autocompletar nunca la abre ni pide la contraseña.
- **Dar formato al documento** (o a la selección) con la gramática de cada motor; en SQL Server, lote a lote y
  conservando las líneas `GO`.
- **Vortaq: Historial de consultas**: lo que ejecutaste, con buscador; lo abre en un documento nuevo con la
  misma conexión y base de datos. Se guarda solo en este equipo, sin resultados ni errores
  (`vortaq.queryHistory.enabled`).
- **Árbol**: **Seleccionar las primeras 1000 filas** (se ejecuta al momento), **Script como CREATE** y **Buscar
  tabla o vista…**.
- **Resultados**: **Filtrar filas** de lo cargado, sin perder las ediciones pendientes.

## 0.6.0 — agentes (MCP) en el editor y actualizaciones con un clic (2026-11-10)

- **Agentes (MCP) sin la aplicación de escritorio.** La extensión trae el servidor MCP de Vortaq y lo
  ejecuta dentro del editor con sus propias conexiones: **Vortaq: Agentes (MCP)…** lo activa, elige el
  nivel de cada conexión («Solo estructura», «Lectura», «Lectura y escritura»; nunca escritura en
  Producción) y copia la configuración de Claude Code, Codex, Gemini CLI, Antigravity, Cursor u
  OpenCode. **VS Code (Copilot en modo agente) lo encuentra solo**, sin editar `mcp.json`.
- Solo en `127.0.0.1`, con una clave guardada en el almacén seguro del editor (**Regenerar la clave**),
  sin atender páginas web. Con varias ventanas abiertas atiende una y otra la sustituye al cerrarse.
- El nivel de cada conexión aparece al pasar el ratón por ella en el árbol.
- **Actualizaciones desde la extensión.** El «Auto Update» del editor no sirve con un `.vsix`: ahora
  Vortaq mira una vez al día si hay una versión nueva en GitHub y la instala con un clic, después de
  comprobar su SHA-256 (**Vortaq: Buscar actualizaciones** lo hace en el momento;
  `vortaq.updates.check` apaga la comprobación diaria).
- **SQL Server en Windows** (de Vortaq 2.7.0): en el formulario, **Buscar servidores en este equipo**
  encuentra SQL Server Express y las demás instancias locales, dice si les falta TCP/IP (con los pasos
  para activarlo) y rellena 127.0.0.1, el puerto y tu cuenta de Windows.
- **Certificados autofirmados de SQL Server:** «Confiar y reintentar» al probar la conexión y «Confiar
  en el certificado» si falla al abrirla desde el árbol.
- El motor de una conexión nueva se elige en un selector «Motor»; las pestañas del formulario ya no se
  recortan.
- **Corrección:** «Importar conexiones de Vortaq (escritorio)» no copiaba el bloque de SQL Server
  (método de inicio de sesión, dominio, instancia con nombre, cifrado y «Confiar en el certificado»):
  ahora sí. El acceso para agentes nunca se importa.

## 0.5.0 — SQL Server y Azure SQL (2026-11-10)

- **Nuevo motor: SQL Server** (2012 o posterior), **Azure SQL Database** y **Managed Instance**, con los mismos
  métodos de inicio de sesión que en escritorio: usuario de SQL Server, autenticación de Windows (NTLM), y
  Microsoft Entra ID en el navegador (se abre con el navegador del sistema, con MFA), con la sesión de la CLI de
  Azure (`az login`) o con una aplicación (ID y secreto). Instancias con nombre, túnel SSH y cifrado
  obligatorio, estricto u opcional.
- **«Pegar cadena de conexión»** en el formulario: la de Azure, `appsettings.json`, ODBC o JDBC rellena los campos.
- Documentos `.sql` con **lotes `GO`** (cada lote se envía entero, `DECLARE` vive en su lote), sesión y
  transacción propias por documento, `PRINT` en Mensajes y **Detener** en el servidor.
- `DECIMAL`, `MONEY`, `datetime2` y `datetimeoffset` se muestran exactos; resultados editables con IDENTITY.

## 0.4.0 — editar varias celdas a la vez (2026-10-21)

- **Varias celdas a la vez** en los resultados editables: con un rango o columnas enteras seleccionados, lo que
  escribes o eliges (texto, fechas, valores de un ENUM, la fila de una clave foránea o **NULL**) se aplica a todas
  las celdas seleccionadas como cambio pendiente. Encima del editor se ve a cuántas celdas se aplica. Las columnas
  bloqueadas, la clave primaria y las celdas que no admiten el valor no cambian, y un aviso dice por qué.
- Para editar una celda basta con empezar a escribir (también `Enter`, `F2` o doble clic).
- **Corrección:** «Eliminar» marcaba la fila de la celda pulsada antes y no la de la última (o la de la celda a la
  que llegabas con las flechas). Ahora es siempre la fila de la celda activa.

## 0.3.0 — diagrama de relaciones y consulta gráfica (2026-10-19)

- **Diagrama de relaciones** (botón derecho en una base de datos o en un esquema de PostgreSQL ›
  «Diagrama de relaciones»): todas las tablas con sus columnas y claves, y una línea por clave
  foránea. Las tablas se colocan solas; puedes moverlas, hacer zoom, ver «Solo claves», buscar una
  tabla, abrir sus datos con doble clic y exportar el diagrama a PNG o SVG (con el diálogo de
  guardar del editor).
- **Consulta gráfica** (mismo menú): añade tablas, que se unen solas por sus claves foráneas, o une
  columnas arrastrándolas; marca columnas y elige totales, orden y filtros. El SQL se ve mientras se
  arma; **Abrir en consulta** lo lleva a un documento SQL nuevo con la misma conexión y base de
  datos, y **Ejecutar** además lo ejecuta allí, con las protecciones de siempre.
- **Claves foráneas en los resultados:** en una columna con clave foránea, el botón de la celda (o
  `Alt+↓`) abre las filas de la tabla relacionada, con buscador, para elegir el valor.
- **ENUM:** se edita con su lista de valores; al escribir, la lista se filtra y autocompleta.
- El panel «Texto» muestra los valores de un ENUM tal como están definidos.
- **Resultados con `JOIN` editables** (de Vortaq 2.4.0): un `SELECT` que une varias tablas se edita si incluye la
  clave primaria de una de ellas; las columnas de otras tablas y las calculadas se ven atenuadas y no cambian. En
  PostgreSQL y SQLite escribe las columnas del `JOIN` con su alias (`p.*`, `p.columna`).

## 0.2.0 — copiar y exportar resultados (2026-10-14)

- **Selección en la cuadrícula de resultados**, como en una hoja de cálculo: celdas (clic, `Shift`+clic,
  arrastrar, `Shift`+flechas), filas (número de fila), columnas (cabecera) y todo (`Cmd/Ctrl+A` o `#`),
  también en resultados de varias tablas.
- **Copiar** (`Cmd/Ctrl+C`, texto tabulado para pegar en una hoja de cálculo), **Copiar con
  encabezados** y **Copiar como** CSV, JSON, `INSERT`, `UPDATE`, lista para `IN` o Markdown, desde el
  botón derecho.
- **Exportar** (barra del resultado o botón derecho) a CSV, Excel (`.xlsx`), JSON, SQL (`INSERT`),
  Markdown, HTML o TXT: la selección, las filas cargadas o el **resultado completo**, que vuelve a
  ejecutar la consulta en una sesión nueva de solo lectura y sin límite de filas (en «Ver datos», toda
  la tabla). El archivo se elige con el diálogo de guardar del editor y se escribe como
  `<archivo>.part` hasta que termina.
- El resultado completo muestra su progreso en el panel y en una notificación del editor, las dos con
  **Cancelar**; al terminar, una notificación ofrece **Abrir** y **Mostrar en carpeta**. MongoDB no usa
  esta exportación.

## 0.1.0 — primera versión (2026-10-13)

- Conexiones de MySQL, MariaDB, PostgreSQL, SQLite y MongoDB en la barra de actividad, con su
  motor, color, entorno y candado de producción; conectar, desconectar, refrescar, copiar nombre,
  editar y eliminar.
- Formulario de conexión con los cinco motores, túnel SSH, SSL/TLS, entorno, «Sin contraseña» y
  «Probar conexión».
- Importar conexiones de Vortaq de escritorio, sin contraseñas.
- Ejecutar SQL desde documentos `.sql`: la selección, la sentencia del cursor o todo el documento;
  detener la ejecución; conexión y base de datos por documento.
- Panel de resultados con varios resultados, mensajes, filas y tiempos, copia como TSV, CSV o JSON
  y edición de resultados de una tabla con clave (Aplicar / Descartar, `NULL`).
- «Ver datos» de tablas y vistas; «Ver documentos» de colecciones de MongoDB (solo lectura).
- Confirmación escribiendo el nombre de la conexión antes de escribir en producción.
- Los paneles siguen el tema del editor (claro, oscuro y alto contraste).
