# Cambios

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
