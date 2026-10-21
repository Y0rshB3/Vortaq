<div align="center">

<img src="build/icons/256x256.png" alt="Logo de Vortaq" width="128" height="128" />

# Vortaq

**Gestor de bases de datos de escritorio, abierto y en español**

MySQL · MariaDB · PostgreSQL · SQLite · MongoDB

[![Última versión](https://img.shields.io/github/v/release/Y0rshB3/Vortaq?label=%C3%BAltima%20versi%C3%B3n&color=7c3aed&cacheSeconds=300)](https://github.com/Y0rshB3/Vortaq/releases/latest)
[![Descargas de la última versión](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FY0rshB3%2FVortaq%2Fbadges%2Fdownloads-latest.json)](https://github.com/Y0rshB3/Vortaq/releases/latest)
[![Descargas totales](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FY0rshB3%2FVortaq%2Fbadges%2Fdownloads-total.json)](https://github.com/Y0rshB3/Vortaq/releases)
[![Licencia MIT](https://img.shields.io/badge/licencia-MIT-22c55e)](LICENSE)
[![Plataformas](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-0ea5e9)](https://github.com/Y0rshB3/Vortaq/releases/latest)
[![Extensión para editores](https://img.shields.io/github/v/release/Y0rshB3/Vortaq?filter=vscode-v%2A&label=extensi%C3%B3n%20para%20editores&color=0ea5e9&cacheSeconds=300)](#extensión-para-editores-vs-code-cursor-vscodium-windsurf)

[**Descargar para macOS**](https://github.com/Y0rshB3/Vortaq/releases/latest) ·
[**Windows**](https://github.com/Y0rshB3/Vortaq/releases/latest) ·
[**Linux**](https://github.com/Y0rshB3/Vortaq/releases/latest)

Extensión para **VS Code, Cursor, VSCodium y Windsurf**:
[**descargar `.vsix`**](https://github.com/Y0rshB3/Vortaq/releases/download/vscode-v0.2.0/vortaq-0.2.0.vsix) ·
[cómo instalarla](#instalar-la-extensión)

<br />

<img src="docs/images/consulta-mysql.png" alt="Vortaq: consulta con resultados editables" width="900" />

</div>

<table>
  <tr>
    <td width="50%"><img src="docs/images/documentos-mongodb.png" alt="Documentos de MongoDB en tabla" /><br /><sub><b>MongoDB</b>: documentos en tabla, árbol o JSON, sin perder los tipos</sub></td>
    <td width="50%"><img src="docs/images/postgresql.png" alt="Consulta de PostgreSQL con transacción" /><br /><sub><b>PostgreSQL</b>: una sesión y su transacción por pestaña</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/asistente-ia.png" alt="Asistente de IA" /><br /><sub><b>Asistente de IA</b> con tu propia clave: solo ve la estructura, nunca tus datos</sub></td>
    <td width="50%"><img src="docs/images/disenador-sqlite.png" alt="Diseñador de tablas de SQLite" /><br /><sub><b>Diseñador de tablas</b>, también para SQLite (con reconstrucción segura)</sub></td>
  </tr>
</table>

Vortaq es un gestor de bases de datos de escritorio, independiente y de código abierto, para macOS, Windows y
Linux. Trabaja con MySQL, MariaDB, PostgreSQL, SQLite y MongoDB: explora y edita datos, escribe consultas con
autocompletado, diseña tablas, saca copias de seguridad y automatiza copias y restauraciones entre entornos (por
ejemplo, de staging a local). Funciona por su cuenta: no necesita `mysql`/`mysqldump`, `psql`, `sqlite3` ni
`mongosh`, porque usa sus propios drivers. Si
ya usabas otro gestor, puede importar tus conexiones (Navicat, DBeaver, MySQL Workbench) y tus copias `.sql` o
`.nb3`, y exportar copias en `.sql` que otros programas leen (ver
[Importar desde otros gestores](#importar-desde-otros-gestores)). Sus copias nuevas usan `.vqb`, un formato propio,
abierto y documentado, con cifrado opcional ([Copias .vqb](#copias-vqb-formato-abierto-con-cifrado-opcional)).

Está construido con Electron, Vue 3 y TypeScript. La interfaz está en español; el código y los comentarios, en
inglés. Antes se llamaba ElectronDB (y, en sus primeras versiones, Navidog).

## Índice

- [Funciones](#funciones)
- [Compatibilidad por sistema operativo](#compatibilidad-por-sistema-operativo)
- [Requisitos](#requisitos)
- [Inicio rápido](#inicio-rápido)
- [Generar un instalador](#generar-un-instalador)
- [Primer uso](#primer-uso)
- [Copias de seguridad y rollback a local](#copias-de-seguridad-y-rollback-a-local)
- [Automatización](#automatización)
- [Asistente de IA](#asistente-de-ia)
- [Agentes (MCP)](#agentes-mcp)
- [Extensión para editores (VS Code, Cursor, VSCodium, Windsurf)](#extensión-para-editores-vs-code-cursor-vscodium-windsurf)
- [Dónde se guardan los datos](#dónde-se-guardan-los-datos)
- [Actualizaciones](#actualizaciones)
- [Solución de problemas](#solución-de-problemas)
- [Desarrollo](#desarrollo)
- [Seguridad](#seguridad)
- [Licencia](#licencia)
- [Licencias de terceros](#licencias-de-terceros)
- [Marcas](#marcas)

## Funciones

- **PostgreSQL**: bases de datos y esquemas, consultas con sesión y transacción propias por pestaña,
  cancelación, datos editables, diseñador y DDL ([PostgreSQL](#postgresql)).
- **SQLite**: abre un archivo `.db` o crea uno nuevo (nunca se crea por error), bases de datos adjuntas,
  consultas con cancelación, datos editables por `rowid`, diseñador que reconstruye la tabla sin perder datos y
  copias `.vqb` ([SQLite](#sqlite)).
- **MongoDB**: independiente, conjunto de réplicas o SRV (también por túnel SSH), documentos en tabla, árbol o
  JSON que se editan **sin cambiar sus tipos BSON**, pestañas de consulta con órdenes del shell (sin ejecutar
  JavaScript), índices, validador, transacciones en conjuntos de réplicas y copias `.vqb`
  ([MongoDB](#mongodb)).
- **MariaDB** como motor propio: secuencias, tablas versionadas (también en las copias, con su historial) y
  cuentas ed25519/parsec ([MariaDB](#mariadb)).
- **Conexiones MySQL/MariaDB** con colores, entorno (Local, Staging, Producción, Otro), túnel SSH (contraseña o
  clave privada), SSL, sin contraseña para proxies o certificados, lista de bases de datos personalizada y
  consultas iniciales de sesión.
- **Explorador de objetos**: tablas, vistas, funciones, procedimientos, eventos y usuarios.
- **Editor de consultas** con autocompletado, formateo de SQL, varias sentencias y resultados editables cuando
  incluyen la clave primaria de una tabla, también con `JOIN` (se editan las columnas de esa tabla). La
  conexión se puede cambiar desde la propia pestaña.
- **Vista de datos** con edición de celdas, `NULL`, alta y baja de filas; los cambios se aplican en una
  transacción y se deshacen todos si falla uno. Filtro visual por condiciones con paréntesis y perfiles,
  selector de fecha y hora, columnas redimensionables y panel **Texto** con el valor completo de la celda.
- **Diseñador de tablas** (columnas, índices, claves foráneas) y editor DDL de vistas y rutinas.
- **Copias de seguridad `.vqb` y `.nb3`**: crear, listar (incluidas las importadas de otros gestores, en solo
  lectura), restaurar en cualquier conexión del mismo motor y "rollback a local". Por defecto se usa `.vqb`, el
  formato abierto de Vortaq, con **Cifrar con contraseña** opcional (para todos los motores); en MySQL y
  MariaDB, `.nb3` sigue disponible para compartir copias con Navicat.
- **Automatización**: trabajos con pasos de backup y de restauración para todos los motores (y de SQL en MySQL y
  MariaDB), programador tipo cron, historial y registro de ejecución. **Restaurar todo en Local** reemplaza tus bases de datos locales con las copias que
  sacó una ejecución (por ejemplo, todo staging en local); **Restaurar paquete en Local** hace lo mismo desde
  la lista de copias de seguridad con un paquete entero (también los lotes importados de otros gestores).
- **Importación desde otros gestores** (**Más › Importar…**): conexiones de Navicat (carpeta de macOS o archivo
  `.ncx`, con contraseñas si lo exportaste con ellas), DBeaver y MySQL Workbench; volcados `.sql`/`.sql.gz` de
  mysqldump, phpMyAdmin, HeidiSQL y otros gestores (uno o una carpeta entera) y copias `.vqb` y `.nb3`. Es de solo
  lectura: no modifica nada del otro programa y nunca lee sus almacenes de contraseñas
  ([Importar desde otros gestores](#importar-desde-otros-gestores)).
- **Exportar a `.sql`**: copias en SQL plano compatibles con `mysql` y otros gestores, también como formato de
  los pasos de copia de la automatización ([Exportar a .sql](#exportar-a-sql)).
- **Copiar y exportar resultados**: selecciona celdas, filas o columnas enteras (también en resultados de varias
  tablas) y cópialas como texto tabulado, CSV, JSON, `INSERT`, `UPDATE`, lista para `IN` o Markdown; exporta lo
  cargado o el **resultado completo** (se vuelve a ejecutar en una sesión de solo lectura, sin límite de filas) a
  CSV, Excel (`.xlsx`), JSON, SQL, Markdown, HTML o TXT ([Copiar y exportar resultados](#copiar-y-exportar-resultados)).
- **Protección de producción**: toda escritura sobre una conexión marcada como Producción pide escribir su
  nombre. En **Ajustes › Seguridad** puedes extenderlo a Staging, Local u Otro.
- **Confirmación antes de borrar en cualquier conexión**: DROP, TRUNCATE, DELETE y eliminar filas, tablas,
  vistas, rutinas, eventos o bases de datos piden confirmación también en Local o Staging
  ([Producción y confirmaciones](#producción-y-confirmaciones)).
- **Aviso de versiones nuevas** publicadas en GitHub, con la descarga para tu sistema o los comandos para
  actualizar la carpeta del código ([Actualizaciones](#actualizaciones)).
- **Asistente de IA con tu propia clave** (Claude, OpenAI, Groq, Grok, GLM, Ollama o cualquier servidor
  compatible con OpenAI): pregunta sobre tu base de datos, genera SQL en el editor y explica consultas y
  errores. Solo se envía la estructura, nunca tus datos ([Asistente de IA](#asistente-de-ia)).
- **Agentes (MCP)**: Claude Code, Codex, Gemini CLI, Cursor, VS Code o cualquier otro cliente MCP pueden usar las
  conexiones que actives (solo estructura, lectura o lectura y escritura) sin que Vortaq les dé contraseñas, hosts, usuarios
  ni rutas;
  nunca escriben en Producción ([Agentes (MCP)](#agentes-mcp)).
- **Diagrama de relaciones y consulta gráfica**: dibuja las tablas de una base de datos o esquema con sus claves
  foráneas (moverlas, zoom, «Solo claves», exportar a PNG o SVG) y arma consultas añadiendo tablas, que se unen
  solas por sus claves, marcando columnas y eligiendo totales, orden y filtros, con el SQL a la vista
  ([Diagrama de relaciones y consulta gráfica](#diagrama-de-relaciones-y-consulta-gráfica)).
- Tema oscuro y claro.

## Compatibilidad por sistema operativo

El desarrollo y las pruebas diarias se hacen en macOS. Windows y Linux compilan y empaquetan, pero todavía no se
han probado a fondo en un equipo real: trátalos como **experimentales**.

| Función                                   | macOS                        | Windows                                        | Linux                                            |
| ----------------------------------------- | ---------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| Ejecutar desde el código (`npm run dev`)  | Sí                           | Sí (experimental)                              | Sí (experimental)                                |
| Instalador                                | `.dmg` y `.zip` (sin firmar) | Instalador NSIS y `.exe` portable (sin firma)  | AppImage y `.deb`                                |
| Conexiones, consultas, datos, diseñador   | Sí                           | Sí                                             | Sí                                               |
| Copias `.vqb` y `.nb3` (crear, restaurar) | Sí                           | Sí                                             | Sí                                               |
| Importar desde Navicat                    | Sí, detección automática     | Solo copiando la carpeta de un Mac (ver abajo) | Solo copiando la carpeta de un Mac (ver abajo)   |
| Trabajos programados con la app abierta   | Sí                           | Sí                                             | Sí                                               |
| Trabajos programados con la app cerrada   | Sí (launchd)                 | **No** de forma integrada (ver Automatización) | **No** de forma integrada (ver Automatización)   |
| Cifrado de contraseñas guardadas          | Llavero de macOS             | DPAPI de Windows                               | libsecret / KWallet; **sin llavero, sin cifrar** |

Limitaciones conocidas fuera de macOS:

- Navicat para Windows guarda sus conexiones en el Registro y Navicat para Linux en otra carpeta; Vortaq
  todavía no lee ninguno de los dos formatos. Solo entiende la carpeta `Navicat CC` de macOS, así que fuera de
  macOS la ruta de importación empieza vacía y el diálogo explica cómo usar una copia de esa carpeta.
- La barra de herramientas hace de barra de título: en macOS lleva los semáforos a la izquierda y en
  Windows/Linux los botones nativos de minimizar, maximizar y cerrar a la derecha, con los colores del tema.
- La opción **"Ejecutar aunque la app esté cerrada"** de un trabajo solo existe en macOS. En Windows y Linux
  aparece desactivada (al pasar el ratón explica la alternativa) y la app nunca escribe en
  `~/Library/LaunchAgents`. Un trabajo que la tenga activada (por ejemplo, copiado de un Mac) se ejecuta con
  el programador interno mientras la app está abierta.
- Los textos de ayuda dicen `Cmd`; en Windows y Linux usa `Ctrl` en su lugar.

## Requisitos

| Requisito | Versión                                            | Notas                                                          |
| --------- | -------------------------------------------------- | -------------------------------------------------------------- |
| Node.js   | **24 LTS** (la usada en desarrollo); mínimo **24** | Trae `npm`. Los tests de SQLite usan `node:sqlite` de Node 24. |
| Git       | Cualquiera reciente                                | Para clonar y actualizar.                                      |
| Docker    | Opcional                                           | Solo para el MySQL desechable de los tests de integración.     |

Sistemas: macOS 13 (Ventura) o posterior (Apple Silicon o Intel), Windows 10/11 de 64 bits, Linux de escritorio
de 64 bits (por ejemplo Ubuntu 22.04+, Debian 12+, Fedora 41+).

Después de instalar Node, comprueba la versión con `node -v`: debe ser `v24.x` o superior. (La aplicación
instalada no usa tu Node: trae el suyo dentro de Electron.)
El repositorio incluye un `.nvmrc` con `24`, así que con `nvm` basta `nvm install` y `nvm use` dentro de la
carpeta del proyecto (nvm-windows no lee `.nvmrc`: indica la versión, `nvm install 24`).

No hace falta instalar compiladores (Visual Studio Build Tools, Python, Xcode, `make`). La única dependencia
nativa (`cpu-features`, una aceleración opcional de `ssh2`) puede fallar al compilarse durante `npm ci` y
mostrar errores de `node-gyp`: es normal, la instalación termina bien y los túneles SSH funcionan igual.

### macOS

Opción A, con Homebrew. `node@24` no se añade solo al `PATH`, por eso la segunda línea:

```sh
brew install node@24 git
echo 'export PATH="$(brew --prefix node@24)/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node -v   # v24.x
```

Opción B, con un gestor de versiones (fnm). Necesita una línea en `~/.zshrc` antes de usarlo:

```sh
brew install fnm git
echo 'eval "$(fnm env --use-on-cd --shell zsh)"' >> ~/.zshrc
source ~/.zshrc
fnm install 24
fnm default 24
node -v   # v24.x
```

Si no tienes Homebrew, Git viene con las herramientas de línea de comandos de Xcode: `xcode-select --install`.

### Windows (PowerShell)

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
# Cierra y vuelve a abrir la terminal, luego comprueba:
node -v
npm -v
```

Alternativa con varias versiones de Node (nvm-windows):

```powershell
winget install --id CoreyButler.NVMforWindows -e
# Nueva terminal:
nvm install 24
nvm use 24
```

Si PowerShell bloquea `npm` con un error de "ejecución de scripts deshabilitada", ejecuta una vez
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` o usa `cmd`.

### Linux (Debian/Ubuntu)

```sh
sudo apt update && sudo apt install -y git curl
# Node con nvm (sin sudo, por usuario)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# Abre una terminal nueva:
nvm install 24
nvm use 24
```

En una instalación mínima (sin escritorio completo) Electron puede necesitar estas bibliotecas:

```sh
sudo apt install -y libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64 libsecret-1-0
# En Ubuntu 22.04 / Debian 12 el paquete de audio se llama libasound2
```

En Fedora instala `git` y `curl` con `sudo dnf install -y git curl` y usa los mismos pasos de `nvm`. El paquete
`nodejs` de Fedora 40 y anteriores es Node 20 y no sirve; si usas el de tu distribución, comprueba que `node -v`
sea 24 o superior.

## Inicio rápido

```sh
git clone https://github.com/Y0rshB3/Vortaq.git
cd Vortaq
npm ci
npm run dev
```

- `npm ci` instala exactamente las versiones de `package-lock.json`.
- `npm run dev` compila y abre la app con recarga en caliente. **La primera vez** descarga Electron (unos
  100 MB) y muestra `Downloading Electron binary...`; tarda un poco más. La terminal debe quedar abierta mientras
  usas la app; `Ctrl+C` la cierra.

Si te pasaron el código como `.zip` en lugar de clonarlo, descomprímelo, entra en la carpeta con `cd` y sigue
desde `npm ci`. Si estás detrás de un proxy, mira [Descargas detrás de un proxy](#descargas-detrás-de-un-proxy).

Para usarla a diario sin la terminal abierta, genera un instalador (siguiente sección).

## Generar un instalador

Compila **en el mismo sistema operativo** al que va destinado el instalador. Los archivos quedan en `release/`.

| Sistema | Comando              | Resultado en `release/`                                                                  |
| ------- | -------------------- | ---------------------------------------------------------------------------------------- |
| macOS   | `npm run dist:mac`   | `Vortaq-<versión>-<arch>.dmg` y `Vortaq-<versión>-<arch>-mac.zip` (arquitectura del Mac) |
| Windows | `npm run dist:win`   | `Vortaq-<versión>-x64-setup.exe` (instalador) y `Vortaq-<versión>-x64-portable.exe`      |
| Linux   | `npm run dist:linux` | `Vortaq-<versión>-x86_64.AppImage` y `vortaq_<versión>_amd64.deb`                        |
| Actual  | `npm run dist`       | Los formatos del sistema en el que lo ejecutas                                           |

Notas:

- Para un Mac con otro procesador: `npm run dist:mac -- --x64` (Intel) o `npm run dist:mac -- --universal`.
- Desde un Mac (también Apple Silicon sin Rosetta) se generan los instaladores de Windows y Linux:
  `electron-builder.yml` elige las herramientas NSIS y AppImage nativas (`toolsets`).
- Los nombres de los archivos los fija `electron-builder.yml` (`artifactName`). **No los renombres**: los
  archivos `latest*.yml` que usa la actualización integrada apuntan a esos nombres.
- Los iconos (`build/icon.icns`, `build/icon.ico`, `build/icons/`) salen de `build/vortaq-icon-source.png`
  con `scripts/make-icons.py` (ver `build/README.md`).
- Ningún comando `dist` publica nada (`--publish never`).

### Preparar una versión para GitHub

`npm run release:build` compila la app y todos los instaladores en `release/v<versión>/`, comprueba los
archivos de actualización y escribe `SHA256SUMS.txt`. **No publica nada**: sube a mano a la versión de GitHub
todos los archivos que lista al terminar, sin renombrarlos:

- los instaladores (`.dmg`, `-mac.zip`, `-setup.exe`, `-portable.exe`, `.AppImage`, `.deb`);
- `latest.yml`, `latest-linux.yml` y `latest-mac.yml` (sin ellos la app no puede actualizarse sola);
- los `.blockmap` (descargas parciales en Windows);
- `SHA256SUMS.txt` (la descarga del `.dmg` desde la app en Mac lo exige).

Opciones: `--platforms win,linux` (solo algunos sistemas), `--out <carpeta>`, `--skip-build` (usa `out/` ya
compilado), `--clean` (vacía antes la carpeta de salida). Ejemplo: `npm run release:build -- --platforms win`.

### Aplicación sin firmar: primer arranque

Los instaladores no están firmados con un certificado de Apple ni de Microsoft, así que el sistema avisa la
primera vez:

- **macOS (Gatekeeper)**: arrastra la app a **Aplicaciones** y, antes de abrirla, quita la marca de
  "descargado de internet" que macOS pone a lo que llega por navegador, AirDrop o chat. Es la solución que
  funciona en todos los casos, incluidos los avisos "**está dañada y no se puede abrir**" y "**no se ha podido
  verificar**":

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Vortaq.app"
  ```

  Sin terminal: intenta abrirla una vez, ve a **Ajustes del Sistema → Privacidad y seguridad** y pulsa
  **Abrir igualmente** (en macOS 13 y 14 también vale clic derecho sobre la app → **Abrir** → **Abrir**).

- **Windows (SmartScreen)**: en "Windows protegió su PC" pulsa **Más información → Ejecutar de todas formas**.
- **Linux (AppImage)**: dale permiso de ejecución. En Ubuntu 22.04+ las AppImage necesitan `libfuse2`
  (`libfuse2t64` en 24.04):

  ```sh
  chmod +x Vortaq-*.AppImage
  sudo apt install -y libfuse2t64   # o libfuse2
  ./Vortaq-*.AppImage
  ```

  El `.deb` se instala con `sudo apt install ./vortaq_*_amd64.deb`.

## Primer uso

### Tour de bienvenida

La primera vez que abres Vortaq con un perfil nuevo aparece un recorrido corto (9 pasos): qué es la app,
**Mis conexiones**, **Nueva consulta** (autocompletado, **Formatear SQL**, selector de conexión), datos y filtros,
copias de seguridad y **Restaurar en Local**, automatización, el asistente de IA (**Ajustes › IA**, solo se envía
la estructura) y **Ajustes › Seguridad** (Producción). Cada paso resalta el botón del que habla; si ese elemento
no está en pantalla, la tarjeta sale centrada.

- **Siguiente** / **Atrás** o las flechas ← → para moverte, **Saltar tour** o `Esc` para cerrarlo.
- El último paso, **Importar tus datos**, busca Navicat (ver abajo). Si lo encuentra pregunta «Se detectó
  Navicat en … (4 conexiones, 3 tareas, 105 copias). ¿Es correcto?»: **Sí, importar** abre la importación ya en
  el paso **Seleccionar**; **No es esta carpeta** la abre en el primer paso para elegirla; **Ahora no** cierra.
  Si no lo encuentra ofrece **Nueva conexión** o **Importar desde otro gestor**.
- Terminarlo o saltarlo se recuerda en `tour.json` del perfil y no vuelve a salir. Puedes repetirlo cuando quieras
  desde **Más → Ver tour de bienvenida** o en **Ajustes → Actualizaciones → Ver tour de bienvenida**.
- Si actualizas desde una versión anterior (0.1.6 o antes) no sale el tour de bienvenida: ya conoces la app. En
  su lugar, la ventana de novedades ofrece **Mostrarme cómo** (ver [Actualizaciones](#actualizaciones)).
- Vortaq ya no abre la importación de Navicat sola al arrancar sin conexiones; sigue a mano en
  **Conexión → Importar…** (también en **Más**) y en el estado vacío de **Mis conexiones**.

### La barra de herramientas

**Conexión** (nueva conexión e **Importar…**) · **Nueva consulta** · **Objetos** (tablas, vistas, funciones y
procedimientos, eventos y consultas guardadas de la base de datos seleccionada, y **Nueva tabla/vista/función/
procedimiento**) · **Usuarios** · **Copias de seguridad** · **Automatización** · **Más** (**Importar…**, **Buscar
actualizaciones…**, **Ver tour de bienvenida**, **Registro**, **Ajustes…** y **Acerca de Vortaq**). A la
derecha, el asistente de IA (✦) y los ajustes (⚙).

### Crear una conexión

1. **Conexión → Nueva conexión MySQL…** (o MariaDB, PostgreSQL, SQLite o MongoDB; el formulario también deja
   cambiar de motor antes de guardar).
2. Rellena host, puerto, usuario y contraseña (en SQLite, el archivo). Elige el **Entorno**: marca como **Producción** cualquier servidor
   real que no quieras modificar por accidente.
3. Opcional: túnel SSH (contraseña o archivo de clave privada) y SSL (CA, certificado y clave de cliente).
4. **Probar conexión** y guarda.

**Conexiones sin contraseña.** Si el servidor no pide contraseña (un proxy local que autentica por su cuenta,
como Cloud SQL Auth Proxy con IAM; un usuario MySQL con contraseña vacía; o autenticación solo con certificado
de cliente en la pestaña SSL), elige **Autenticación › Sin contraseña (proxy, certificado o usuario sin clave)**.
El campo de contraseña desaparece, no se guarda ninguna y la conexión, los trabajos automáticos, las copias y
el asistente de IA conectan sin ella. Si dejas **Contraseña** pero no hay ninguna guardada, Vortaq prueba
una vez sin contraseña: si el servidor la acepta conecta (y **Probar conexión** sugiere marcar «Sin
contraseña»); si la rechaza verás «No hay contraseña guardada para la conexión X: escríbela en la conexión o
marca «Sin contraseña»». Las conexiones importadas de Navicat quedan en modo **Contraseña**, porque Navicat no
guarda si hace falta.

### MariaDB

**Conexión › Nueva conexión MariaDB** crea una conexión MariaDB: el mismo formulario que MySQL (puerto 3306,
SSH, SSL, consultas iniciales, carpeta de copias) y admite también las cuentas **ed25519** y **parsec** además de
`mysql_native_password`. Tiene todo lo de MySQL (usuarios, copias `.vqb`, `.nb3` y `.sql`, automatización) y
además:

- **Secuencias** en el árbol (grupo Secuencias): abrir muestra su `CREATE SEQUENCE` en una pestaña de consulta;
  el menú tiene **Ver estado**, **Fijar siguiente valor…** (`SETVAL`, en una pestaña), **Nueva secuencia**,
  DDL y eliminar.
- **Diseñador**: los tipos `uuid`, `inet4` e `inet6`, `json` (MariaDB lo guarda como `LONGTEXT` con
  `json_valid`, y Vortaq lo sigue mostrando como `json`) y, en **Opciones**, **Versionado de sistema (WITH SYSTEM
  VERSIONING)**: crear la tabla versionada, añadirlo o quitarlo (quitarlo borra el historial y lo avisa). Al
  modificar una tabla versionada se mantiene el historial (`system_versioning_alter_history = KEEP`).
- **Editor**: resaltado y autocompletado de MariaDB (secuencias, `RETURNING`, `FOR SYSTEM_TIME`, tipos
  propios); los comentarios `/*M! … */` se ejecutan como sentencias.
- **Producción**: además de lo de MySQL, cuentan como escritura `NEXTVAL`/`SETVAL`/`NEXT VALUE FOR`, el contenido
  de `/*M! … */` y la sentencia de `SET STATEMENT … FOR`.
- **Asistente de IA**: sabe que es MariaDB (secuencias, `RETURNING`, tablas versionadas, JSON como alias).
- **Copias**: las copias `.vqb` y `.sql` guardan las **secuencias** (con su valor) y las **tablas versionadas
  con todo su historial**; al restaurar en MariaDB 10.11 o posterior el historial se recupera tal cual (en un
  servidor más antiguo, solo las filas actuales, con un aviso). Las `.nb3` guardan las tablas versionadas con
  sus filas actuales y no tienen sitio para secuencias (la ventana de copia lo avisa). Al **reemplazar** una
  base de datos con secuencias o tablas versionadas, la copia previa se guarda en `.vqb` aunque restaures un
  `.nb3`, para no perder nada. Solo el historial de las tablas versionadas **por transacción** (columnas de
  periodo con ids de transacción) no se puede llevar a otro servidor: la copia guarda sus filas actuales con un
  aviso, y reemplazar una base de datos que las tenga con copia previa se rechaza. Una copia `.vqb` de MariaDB
  con secuencias o tablas versionadas no se restaura en un servidor MySQL (se avisa antes de tocar nada), y el
  historial de un `.sql` solo se importa en MariaDB 10.11 o posterior.

**Tus conexiones MySQL a MariaDB** siguen funcionando: las importadas de una entrada MariaDB (Navicat `.ncx`
o la sección MariaDB de su carpeta) pasan a ser MariaDB al arrancar, y una conexión MySQL cuyo servidor
resulta ser MariaDB se guarda como MariaDB la primera vez que la abres, con su id, contraseñas, copias, tareas
y consultas guardadas. **Probar conexión** avisa si el tipo elegido no coincide con el servidor.

#### Servidores MariaDB en conexiones MySQL

Mientras una conexión siga siendo MySQL (por ejemplo, la que usa una tarea programada antes de abrirla en la
app), Vortaq detecta MariaDB al conectar (por `VERSION()`) y aplica estos ajustes solo a ese servidor; con
MySQL nada cambia.

- Las **tablas versionadas** (`WITH SYSTEM VERSIONING`) aparecen con las demás tablas y se editan igual (el
  historial lo guarda el servidor).
- Los **valores por defecto** se muestran sin las comillas que añade MariaDB (`'x'` → `x`, `NULL` → sin valor).
- Las columnas **INVISIBLE** se ven en la vista de datos (se piden por nombre, porque `SELECT *` las omite).
- **Usuarios** se lee de `mysql.global_priv` (en MariaDB `mysql.user` es una vista sin `account_locked`).
- El total de filas usa `SET STATEMENT max_statement_time` (MariaDB ignora la pista de MySQL) y el tipo de las
  columnas JSON, UUID e INET aparece con su nombre.
- El diseñador parte de la colación de la base de datos al crear una tabla.
- **Copias**: como en las conexiones MariaDB (ver arriba): `.vqb` y `.sql` lo guardan todo; `.nb3` guarda las
  filas actuales de las tablas versionadas y no las secuencias, y la ventana de copia y el registro de la tarea
  lo avisan con sus nombres.

### PostgreSQL

**Conexión › Nueva conexión PostgreSQL…** crea una conexión PostgreSQL.

- **Conexión**: host, puerto (5432), usuario, contraseña o «Sin contraseña», **base de datos inicial**,
  `search_path` opcional y «Mostrar esquemas y bases de datos del sistema». Pestaña **SSL** con los modos de
  libpq (`disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full`), CA, certificado y clave de cliente
  (con su contraseña). Con túnel SSH, `verify-full` comprueba el nombre del servidor real, no `127.0.0.1`.
  **Avanzado**: consultas iniciales, zona horaria de sesión, tiempo de conexión y keepalive. Vortaq solo usa
  las credenciales que le das: nunca `PGPASSWORD`, `~/.pgpass`, `PGUSER` ni otras variables de entorno.
- **Árbol**: conexión › base de datos › esquema › Tablas, Vistas, Vistas materializadas, Funciones (con sus
  sobrecargas), Secuencias, Tipos (enumerados, dominios, compuestos) y Consultas. Cada base de datos abre su
  propio grupo de conexiones al desplegarla (su icono se rellena) y **Cerrar base de datos** lo cierra (no la
  inicial, ni mientras una pestaña suya tenga una transacción abierta). Las **particiones** cuelgan de su tabla
  particionada (también las subparticiones y las de otros esquemas), con su rango en la descripción.
- **Editor de consultas**: dos selectores, base de datos y esquema; el esquema elegido va primero en el
  `search_path` y se mantiene el resto (las extensiones de `public` siguen visibles). Cada pestaña tiene su
  propia sesión: `BEGIN`, `SET` y las tablas temporales se conservan entre ejecuciones, con los botones
  **Confirmar** (COMMIT) y **Deshacer** (ROLLBACK) y el aviso «Transacción abortada: ejecuta ROLLBACK». Al
  cerrar una pestaña con una transacción abierta pregunta si confirmar o deshacer. **Detener** cancela la
  sentencia en el servidor (`pg_cancel_backend`). Los avisos (`RAISE NOTICE`) salen en Mensajes y un error
  lleva al punto exacto de la sentencia. Autocompletado con nombres cualificados y entrecomillado cuando hace
  falta (`"Clientes"`, `"user"`).
- **Datos**: vista de tabla con filtros (`contiene` no distingue mayúsculas, booleanos, JSON y listas),
  edición por clave primaria (las tablas sin clave primaria y las vistas materializadas son de solo lectura),
  inserciones que dejan a `serial`/identidad generar el valor (se devuelve con `RETURNING`) y resultados
  editables de un `SELECT` que incluye la clave primaria de una tabla, también con `JOIN`. Fechas, `numeric`, `bigint` y JSON se muestran tal como los
  devuelve el servidor, sin cambios de zona horaria.
- **Diseñador de tablas**: tipos del servidor (también los tuyos y los de extensiones) con casilla de lista
  (`text[]`), predeterminados como expresiones SQL, identidad, columnas `serial` reconocidas, `USING` al cambiar
  un tipo, restricciones UNIQUE/CHECK, índices por método (btree, gin…), comentarios y `UNLOGGED`. Todos los
  cambios se aplican en **una transacción**; añadir un valor a un enumerado se hace antes, porque PostgreSQL no
  permite usarlo en la misma transacción. Editor DDL de vistas, vistas materializadas, funciones,
  procedimientos y triggers (`$$ … $$`, sin DELIMITER).
- **Menús**: truncar (también reiniciando identidad o en cascada, con la lista de tablas afectadas), vaciar,
  `ANALYZE`, refrescar vistas materializadas, valor actual y `setval` de secuencias, añadir valores a un
  enumerado, extensiones de la base de datos y «Copiar URI» (sin contraseña).
- **Producción**: en conexiones que piden escribir el nombre, las sesiones PostgreSQL son de **solo lectura**
  en el servidor salvo para la sentencia que confirmas; también cuentan como escritura `nextval`, `setval`,
  `set_config`, `pg_terminate_backend` y los CTE con `INSERT`/`UPDATE`/`DELETE`. Una lectura nunca confirma
  una transacción tuya a medias.
- **Asistente de IA**: lee solo la estructura (catálogo `pg_catalog`/`information_schema`) con la misma regla
  que en MySQL.
- **Importar**: las conexiones PostgreSQL de DBeaver, de los `.ncx` de Navicat y de la sección PostgreSQL de la
  carpeta de Navicat (Redshift y otras variantes quedan como no soportadas; con varios servidores solo se usa
  el primero, con un aviso).
- **Copias de seguridad**: en formato `.vqb` (ver [Copias .vqb](#copias-vqb-formato-abierto-con-cifrado-opcional)),
  también desde la [Automatización](#automatización) (pasos de copia y de restauración).
- **Límites**: sin pantalla de usuarios y roles.

### SQLite

**Conexión › Nueva conexión SQLite…**. Una conexión SQLite es un **archivo**: no hay servidor, usuario,
contraseña, SSH ni SSL.

- **Abrir o crear**: **Abrir archivo…** elige un archivo existente; **Crear base de datos nueva…** pregunta dónde
  guardarlo y lo crea; **Recientes** ofrece los últimos archivos que abriste o creaste (solo en este equipo). Es la única forma en que Vortaq crea un archivo SQLite: abrir, probar o importar una ruta
  que no existe (o una ruta de Windows en un Mac) **nunca crea un archivo vacío**, y un `ATTACH` de un archivo
  que no existe se rechaza. Las rutas importadas de otro equipo quedan marcadas hasta que eliges el archivo.
- **Opciones**: **Solo lectura** (activada por defecto en Producción; el menú de la conexión tiene **Reabrir en
  modo escritura…** con confirmación), **Aplicar claves foráneas** (`PRAGMA foreign_keys`: activado en los
  archivos creados con Vortaq y desactivado en los abiertos o importados, para no cambiar el comportamiento de
  archivos de otras aplicaciones), **bases de datos adjuntas** (alias + archivo), tiempo de espera si el archivo
  está ocupado y consultas iniciales (`PRAGMA`…). El modo de diario (`journal_mode`) no se toca. Si el archivo o
  su carpeta no se pueden escribir, se abre en solo lectura y el panel de información lo dice.
- **Árbol**: conexión › `main` (y cada base adjunta) › Tablas, Vistas, Índices, Triggers y Consultas. El DDL es el
  texto original de `sqlite_schema`.
- **Editor de consultas**: autocompletado de SQLite (tablas, `alias.columna`, `adjunta.tabla`, `PRAGMA`,
  funciones), los triggers con `BEGIN … END` se ejecutan como una sola sentencia y **Detener** corta cualquier
  consulta en menos de un segundo: el archivo se vuelve a abrir (se pierden las tablas temporales, los `ATTACH`
  hechos a mano y la transacción abierta, y el mensaje lo avisa).
- **Una transacción compartida**: todas las pestañas de un archivo usan la misma conexión. La pestaña que abre
  una transacción ve **Transacción abierta (compartida con las demás pestañas)** con **Confirmar** y
  **Deshacer**; las demás muestran **Transacción abierta en otra pestaña**: pueden leer (y ven esos cambios sin
  confirmar), pero no escribir ni guardar en la cuadrícula hasta que se confirme o se deshaga. Cerrar la pestaña
  dueña pregunta qué hacer.
- **Datos**: SQLite guarda cada valor con su propio tipo (entero, real, texto, blob o NULL), así que cada celda
  lo conserva al editarla; el tooltip lo muestra. Las filas se editan por `rowid` (en tablas `WITHOUT ROWID`,
  por su clave primaria); el `rowid` y las columnas generadas no se editan. Un resultado de consulta se puede
  editar si incluye la clave de una tabla (`SELECT rowid, * FROM t` en tablas sin `INTEGER PRIMARY KEY`; con
  `JOIN`, `SELECT t.rowid, t.* …`). El filtro «contiene» usa `LIKE`, que en SQLite no distingue mayúsculas solo en letras ASCII (`á` y `Á` sí
  se distinguen).
- **Diseñador de tablas**: cuando SQLite no puede cambiar algo con `ALTER TABLE` (tipo, nulos, valor por
  defecto, claves, orden de columnas, `WITHOUT ROWID`/`STRICT`…), Vortaq **reconstruye la tabla** en una sola
  transacción: conserva los datos, el contador de `AUTOINCREMENT`, los índices, los triggers y las vistas que
  dependen de ella, y lo que el diseñador no edita (COLLATE, CHECK, columnas generadas). Solo se cancela si el
  cambio deja **nuevas** filas sin su fila referenciada; las que ya existían se avisan. La vista previa muestra
  el script entero, con la opción **Copiar el archivo antes**. Editor DDL de vistas y triggers (se eliminan y se
  vuelven a crear en una transacción: si falla, no cambia nada).
- **Menús**: vaciar tabla (`DELETE`), **Copiar archivo…** (`VACUUM INTO`, una copia coherente), comprobar
  integridad y claves foráneas, compactar (`VACUUM`) y **Mostrar en Finder**.
- **Producción**: además de la confirmación con el nombre, la conexión funciona con `PRAGMA query_only` hasta
  que confirmas la escritura.
- **Copias**: `.vqb` de una base de datos (cada valor con su tipo exacto), que se restaura en un **archivo
  nuevo** (opcionalmente con su conexión) o **reemplazando** la base de datos tras una copia de seguridad previa.
  La [Automatización](#automatización) también copia y restaura bases de datos SQLite.
- **Asistente de IA**: lee solo la estructura (`sqlite_schema` y los `PRAGMA` de lectura).
- **Importar**: las conexiones SQLite de DBeaver, de los `.ncx` de Navicat y de la carpeta de Navicat (los
  archivos cifrados de Navicat no se pueden abrir; una ruta de otro equipo queda marcada hasta que eliges el
  archivo).
- **Límites**: no se abren archivos cifrados (SQLCipher); como mucho 4 archivos SQLite abiertos a la vez (cada
  uno usa su propio proceso).

### MongoDB

**Conexión › Nueva conexión MongoDB…**.

- **Conexión**: **Pegar URI** rellena los campos a partir de una URI `mongodb://` o `mongodb+srv://` (la
  contraseña pasa a su campo y la URI no se guarda; una URI con credenciales en los parámetros, como
  `authMechanismProperties` o `tlsCertificateKeyFilePassword`, se rechaza). Método **Independiente**,
  **Conjunto de réplicas** (lista de miembros y nombre del conjunto) o **Clúster fragmentado**; **Registro SRV**
  (activa TLS). Autenticación SCRAM (negociada, SHA-1 o SHA-256), LDAP (PLAIN), certificado X.509 o ninguna, con
  su base de autenticación (`authSource`); Kerberos, AWS y OIDC no están soportados. Base de datos
  predeterminada, preferencia de lectura, conexión directa, TLS (CA, certificado y clave de cliente con su
  contraseña, verificación del nombre del servidor), tiempo de conexión (10 s por defecto), reintentos y
  opciones extra sin credenciales. Por **túnel SSH** solo se conecta a un servidor (independiente o directo a un
  miembro); TLS comprueba el nombre del servidor real, no `127.0.0.1`. **Copiar URI** (menú de la conexión) nunca
  incluye la contraseña. **Probar conexión** dice la topología y el papel del miembro (un secundario es de solo
  lectura).
- **Árbol**: conexión › base de datos › **Colecciones** (con documentos, tamaño, almacenamiento, índices y
  tamaño medio), **Vistas**, **Índices** y Consultas. Las colecciones `system.*` no se muestran.
- **Documentos**: doble clic abre la colección. **Filtro**, **Orden** y **Proyección** con la sintaxis del shell
  (`{ estado: 'A', creado: { $gt: ISODate('2026-01-01') } }`, `ObjectId('…')`, `NumberLong('…')`, `/re/i`…;
  recuerda las últimas de cada colección), páginas con límite y **Cargar más** sobre el mismo cursor. Tres
  modos: **Tabla** (un campo por columna, `_id` primero, icono de tipo en cada celda y aviso «mixto» si una
  columna tiene varios tipos), **Árbol** (clave, valor y tipo, con añadir y quitar campos o elementos) y
  **JSON**. Las fechas se ven en UTC con la hora local en el tooltip (o en hora local con **Hora local**); el
  tooltip de un `ObjectId` dice cuándo se creó, y el menú copia el valor, el filtro `{ _id: … }` o el documento.
- **Edición**: doble clic en un valor abre el editor con su **tipo BSON** (Int32, Int64, Double, Decimal128,
  texto, booleano, fecha, ObjectId, null): escribir `5` en un Int32 lo deja en Int32. Los cambios se acumulan
  hasta **Aplicar** y se envían como `$set`/`$unset` por `_id`, comprobando que el documento no ha cambiado
  desde que se cargó («El documento ha cambiado… recarga»). Cambiar un elemento de un array reescribe el array
  entero (un `$unset` dejaría un `null`). Los campos con `.` o que empiezan por `$` se editan desde el documento
  completo. **Editar** abre el documento entero en sintaxis del shell (si estaba proyectado o era muy grande se
  vuelve a leer completo antes; reemplazar un documento parcial borraría lo que no se ve), **Insertar** propone
  los campos de la colección con valores de ejemplo de su tipo y **Duplicar** copia uno sin `_id`. Vistas,
  colecciones limitadas, series temporales y fragmentos de GridFS son de solo lectura (con el motivo). En un
  conjunto de réplicas, los cambios de **Aplicar** van en una transacción (todos o ninguno); en un servidor
  independiente se aplican uno a uno y, si uno falla, se dice cuál y no se envían los siguientes.
- **Pestañas de consulta**: `db.colección.find(…)`, `findOne`, `aggregate`, `countDocuments`,
  `estimatedDocumentCount`, `distinct`, `getIndexes`, `stats`, `explain`, los de escritura (`insertOne/Many`,
  `updateOne/Many`, `replaceOne`, `deleteOne/Many`, `findOneAnd…`, `bulkWrite`, `createIndex`, `dropIndex`,
  `drop`, `renameCollection`), `db.stats()`, `db.getCollectionNames()`, `db.createCollection()`,
  `rs.status()`, `use <bd>` y `show dbs|collections`. Se aceptan `.sort()`, `.limit()`, `.skip()`,
  `.project()`, `.count()`, `.pretty()` y `.toArray()` copiados del shell. **Nunca se ejecuta JavaScript**: el
  texto se analiza con una gramática cerrada y los argumentos solo pueden ser valores (con `ObjectId()`,
  `ISODate()`, `new Date()`…); `var`, funciones, `forEach` o `runCommand` se rechazan con la posición del error
  y no se ejecuta nada del script. Autocompletado de colecciones, métodos, operadores `$` y nombres de campos.
  **Detener** corta la operación en el servidor (`killOp`). Cada pestaña tiene su base de datos (`use`) y, en
  conjuntos de réplicas, **Iniciar transacción** / **Confirmar** / **Deshacer**. Los documentos de `find` y de un
  `aggregate` con solo `$match`, `$sort`, `$limit`, `$skip` y `$project` de inclusión se editan en el resultado.
- **Diseñar** una colección: **Índices** (crear con campos ascendentes, descendentes, texto, 2dsphere o hash,
  único, disperso, oculto, TTL, filtro parcial e intercalación; eliminar con confirmación; `_id_` no se
  elimina), **Validador** (`$jsonSchema` u operadores, nivel y acción, con **Generar esquema** a partir de una
  muestra de tipos) y **Opciones** (solo lectura, y **Renombrar**). El menú de la colección también tiene
  **Duplicar…** (opciones, validador e índices, y los documentos con sus tipos si lo marcas; una vista se
  duplica con su pipeline), **Contar exacto**, **Vaciar** (`deleteMany({})`) y **Eliminar**; el de la base de datos, **Nueva colección** y
  **Eliminar base de datos**. **Nueva base de datos** pide también la primera colección.
- **Producción**: toda escritura (cuadrícula, editor, consultas, índices, validador, colecciones, copias)
  pide el nombre de la conexión. Un `aggregate` con `$out` o `$merge` es una escritura, aunque esté escrito con
  escapes: se decide con el pipeline ya analizado.
- **Copias**: `.vqb` de una base de datos (o de algunas colecciones): documentos con todos sus tipos BSON,
  opciones de cada colección, validador, índices y vistas. Se restaura en otra base de datos (nueva o
  existente) o **reemplazando** la base de datos tras una copia previa. La [Automatización](#automatización)
  también copia y restaura bases de datos MongoDB.
- **Asistente de IA**: lee solo la estructura (nombres de colecciones, índices, la parte estructural del
  `$jsonSchema` y los nombres y tipos de los campos de una muestra; nunca valores) y responde con órdenes del
  shell.
- **Importar**: las conexiones MongoDB de los `.ncx` de Navicat (con sus contraseñas), de la carpeta de Navicat
  y de DBeaver (DocumentDB y Cosmos DB, sin reintento de escrituras).
- **Límites**: sin pantallas de usuarios y roles; sin constructor visual de agregaciones (los `aggregate` se
  escriben en la pestaña de consulta) ni vista de `explain`; sin conjuntos de réplicas ni SRV por túnel SSH; sin
  GSSAPI, AWS ni OIDC.

### Importar desde otros gestores

**Más › Importar…** (también **Conexión › Importar…**, el botón **Importar…** de la lista vacía y el último paso
del tour) abre un asistente: eliges el **origen**, luego el **archivo o la carpeta**, revisas lo que contiene y
marcas qué traer. Vortaq solo lee el archivo o la carpeta que eliges (o que confirmas en su ubicación habitual):
nunca lee el Llavero, el Administrador de credenciales, el Registro ni los almacenes cifrados de otros programas.

| Origen                          | Qué se importa                                                                   | Contraseñas                                |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------ |
| **Navicat — carpeta (macOS)**   | Conexiones, colores, trabajos por lotes y copias `.nb3`                          | No (no están en esos archivos)             |
| **Navicat — archivo .ncx**      | Conexiones MySQL, MariaDB, PostgreSQL, SQLite y MongoDB con SSH y SSL            | Sí, si lo exportaste con «Export Password» |
| **DBeaver**                     | Conexiones MySQL, MariaDB, PostgreSQL, SQLite y MongoDB de `data-sources.json`   | No                                         |
| **MySQL Workbench**             | Conexiones de `connections.xml` (con túnel SSH y SSL)                            | No                                         |
| **Archivo .sql**                | Un volcado `.sql` o `.sql.gz` en una conexión                                    | —                                          |
| **Carpeta de volcados .sql**    | Un volcado por base de datos, como un paquete                                    | —                                          |
| **Copia .vqb (Vortaq)**         | Se restaura con el diálogo de **Restaurar** (pide la contraseña si está cifrada) | —                                          |
| **Copia .nb3 (Navicat/Vortaq)** | Se restaura con el diálogo de **Restaurar**                                      | —                                          |

Las conexiones de otros motores (SQL Server, Oracle…) aparecen como **no soportadas** y no se importan. MariaDB se
importa como conexión MariaDB. Si una conexión ya se importó antes desde
el mismo programa (mismo nombre), sale como **ya importada**: al marcarla se actualizan sus datos y se
conservan su entorno (Producción nunca se rebaja), su carpeta de copias y sus contraseñas guardadas.

#### Navicat: archivo .ncx (con contraseñas)

En Navicat: **Archivo › Exportar conexiones…**, marca **Export Password** si quieres las contraseñas y guarda el
`.ncx`. En Vortaq: **Importar… › Navicat — archivo .ncx › Elegir archivo…**. La vista previa marca qué
conexiones traen contraseña. Para las que ya importaste desde la carpeta de Navicat eliges **Actualizar solo la
contraseña** (así juntas la carpeta del Mac, con colores y trabajos, y las contraseñas del `.ncx`) o
**Reemplazar sus datos**. Las contraseñas (de la base de datos, del túnel SSH y de la clave SSL) se guardan solo
en el almacén de credenciales de Vortaq y nunca se escriben en el registro.

> **Borra el `.ncx` después de importar**: el formato guarda las contraseñas con una clave fija conocida, así
> que cualquiera con el archivo puede recuperarlas. El asistente lo recuerda al terminar y abre su carpeta.

Funciona en macOS, Windows y Linux (es la forma de traer conexiones de Navicat para Windows o Linux).

#### DBeaver y MySQL Workbench

El asistente busca el archivo en su sitio habitual y, si existe, pregunta «¿Usar este archivo?» (o **Elegir
otro…**):

| Programa        | macOS                                                                 | Windows                                                               | Linux                                                                      |
| --------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| DBeaver         | `~/Library/DBeaverData/workspace6/General/.dbeaver/data-sources.json` | `%APPDATA%\DBeaverData\workspace6\General\.dbeaver\data-sources.json` | `~/.local/share/DBeaverData/workspace6/General/.dbeaver/data-sources.json` |
| MySQL Workbench | `~/Library/Application Support/MySQL/Workbench/connections.xml`       | `%APPDATA%\MySQL\Workbench\connections.xml`                           | `~/.mysql/workbench/connections.xml`                                       |

- **DBeaver** guarda usuarios y contraseñas cifrados en otro archivo (`credentials-config.json`) con una clave
  propia: Vortaq **no lo lee**. Las conexiones llegan sin contraseña (y, si DBeaver guardó el usuario ahí, sin
  usuario): escríbelos al editar cada conexión. El tipo de conexión de DBeaver (Producción, Test, Desarrollo)
  da el entorno.
- **MySQL Workbench** guarda las contraseñas en el llavero del sistema: Vortaq no las lee. Se importan host,
  puerto, usuario, esquema por defecto, túnel SSH (servidor, usuario, clave) y SSL.

#### Volcados .sql

**Importar… › Archivo .sql** acepta volcados de mysqldump, MySQL Workbench, phpMyAdmin, HeidiSQL, Adminer,
DBeaver, TablePlus o cualquier script de sentencias, también comprimidos (`.sql.gz`). Antes de importar se ve
qué programa lo generó (si lo dice su cabecera), su tamaño, sus bases de datos y cuántas tablas, vistas,
rutinas, triggers y eventos crea. Eliges la conexión de destino (por defecto la **Local**) y:

- **Respetar las bases de datos del archivo**: sus `USE` y `CREATE DATABASE` deciden dónde va cada cosa (lo
  normal en un volcado de varias bases de datos). Puedes indicar un esquema para las sentencias que van antes
  del primer `USE`.
- **Importar todo en `<esquema>`**: todo va al esquema que elijas (por defecto, el del archivo o su nombre). Los
  `CREATE DATABASE` del archivo se omiten y sus `USE` apuntan al destino; si el archivo tiene varias bases de
  datos, el asistente lo avisa (los nombres calificados `base.tabla` no se cambian). Con **Vaciar … antes de
  importar** el esquema se borra y se crea de nuevo, con una **copia previa** (etiqueta
  `previo-importacion`) si ya existía, en el formato elegido en **Ajustes › Copias** (`.vqb` por defecto;
  `.nb3` si lo eliges).

El archivo se lee por partes (no se carga entero en memoria, sirve para volcados de varios GB) y se ejecuta
sentencia a sentencia en una sola sesión, respetando `DELIMITER`, comentarios, comillas y los
`/*!40101 SET … */` del volcado. El progreso va por bytes leídos, con **Cancelar** y un registro en vivo (objetos
creados, base de datos actual, errores). Al terminar se ve el resumen: sentencias, filas afectadas, objetos
creados y cada error con **su número de línea**. Con **Continuar si una sentencia falla** sigue con las demás;
si no, se detiene en el primer error. Un `DEFINER` cuya cuenta no existe en el destino se quita (el objeto
queda a nombre de tu usuario), igual que al restaurar un `.nb3`. En **Producción** (y en los entornos de
**Ajustes › Seguridad**) hay que escribir el nombre de la conexión.

**Importar… › Carpeta de volcados .sql** importa una carpeta con un archivo por base de datos
(`ventas.sql`, `crm.sql.gz`…) como un paquete, igual que **Restaurar paquete en Local**: cada archivo propone su
base de datos (su nombre sin `.sql`), que puedes cambiar; **Reemplazar las bases de datos que ya existen** las
borra y crea de nuevo, con copia previa de cada una. Los nombres repetidos y las bases de datos del sistema se
rechazan.

#### Navicat: carpeta (macOS)

1. **Importar… › Navicat — carpeta (macOS)**. Si la carpeta guardada no existe o está vacía, Vortaq **busca
   Navicat solo** en los sitios habituales de macOS:
   - `~/Library/Application Support/PremiumSoft CyberTech/Navicat CC` (la habitual);
   - la versión de la App Store: `~/Library/Containers/<carpeta con «navicat» en el nombre>/Data/Library/Application Support/PremiumSoft CyberTech/Navicat CC`;
   - versiones antiguas: `~/Library/Application Support/PremiumSoft CyberTech/Navicat` (si tiene `Common/conn.plist`).

   Solo cuenta una carpeta cuyo `Common/conn.plist` se pueda leer. Si hay una, pregunta «Se detectó Navicat en
   … ¿Es correcto?»: **Sí** pasa a **Seleccionar** y guarda la carpeta en **Ajustes**; **Elegir otra** deja
   escribir la ruta o usar **Elegir carpeta…**. Si hay varias, aparecen en una lista (primero la que tiene más
   conexiones y, a igualdad, la más reciente). **Detectar** con la ruta vacía vuelve a buscar. La búsqueda solo
   lee: no escribe nada en esas carpetas, no usa la red y no guarda nada salvo la carpeta que confirmes.

2. Marca las conexiones y los trabajos que quieras traer. Navicat no se modifica. Se leen las secciones MySQL,
   MariaDB, PostgreSQL, SQLite y MongoDB (las cuatro últimas, con los nombres de campo documentados en
   `docs/navicat-storage.md`, sin comprobar todavía con archivos reales): en SQLite se guarda la ruta del archivo
   tal cual (si no existe en este equipo, la conexión queda marcada hasta que lo eliges; nunca se crea ni se
   abre al importar) y las bases de datos adjuntas no se importan. Los trabajos por lotes de Navicat son de
   MySQL.
3. Navicat no guarda las contraseñas en esos archivos y Vortaq no las busca en ningún otro sitio (tampoco en el
   Llavero): escríbelas una vez en cada conexión, o márcala **Sin contraseña** si el servidor no la pide.

**En Windows o Linux**: copia la carpeta `Navicat CC` desde un Mac (por ejemplo a `C:\Datos\Navicat CC` o
`~/navicat-cc`) y escribe esa ruta en el diálogo de importación (o en **Ajustes** para no repetirla), que fuera
de macOS empieza vacío (o exporta un `.ncx` desde Navicat para Windows o Linux, arriba). Vortaq también busca una carpeta llamada `Navicat CC` copiada en tu carpeta personal
o un nivel por debajo (por ejemplo `~/Navicat CC` o `~/Documentos/Navicat CC`), sin recorrer el disco entero. Las contraseñas se escriben a mano, como en macOS.
Las copias `.nb3` se buscan en la carpeta de cada conexión dentro de `Navicat CC`, porque las rutas de un Mac
no existen en otro equipo.

### Contraseñas

- Se guardan cifradas con el almacén del sistema (Llavero, DPAPI o libsecret/KWallet), nunca en
  `connections.json`.
- Si desmarcas **Guardar contraseña**, la app la pedirá cuando haga falta. El error
  `No hay contraseña guardada para la conexión …` significa que falta: edita la conexión y escríbela.
- En Linux sin un llavero activo (GNOME Keyring o KWallet) las contraseñas se guardan **solo en base64, sin
  cifrar**, y la app lo avisa una vez al arrancar. Instala y desbloquea un llavero si guardas contraseñas de
  servidores reales.

### Producción y confirmaciones

En una conexión con entorno **Producción**, restaurar, borrar, crear bases de datos, editar filas o ejecutar
sentencias que escriben exige escribir el nombre de la conexión para confirmar. El proceso principal también lo
comprueba y rechaza la operación si la interfaz no envió la confirmación. Desde la versión 0.1.5 **no se puede
desactivar** para Producción (si tenías apagado el antiguo interruptor, vuelve a pedirlo).

En **Más → Ajustes… → Seguridad → «Pedir confirmación escribiendo el nombre antes de escribir en:»** eliges
qué otros entornos se comportan igual: **Staging**, **Local** u **Otro** (Producción aparece marcada y bloqueada).
Para una conexión de un entorno marcado:

- cualquier escritura pide escribir su nombre, con el mismo diálogo que Producción («La conexión «Pre» (entorno
  Staging) requiere confirmación: escribe su nombre»), y el proceso principal la rechaza sin esa confirmación;
- se muestra solo ese diálogo, nunca también el de borrado;
- los **pasos de restauración de una tarea** no pueden usarla como destino (al ejecutarla, programada o con
  launchd nadie escribe el nombre); usa **Restaurar todo** desde el historial, que pide confirmación;
- en el árbol de conexiones y en el selector de la consulta lleva un **candado** junto al entorno. La línea roja y
  la etiqueta roja siguen siendo solo de Producción.

Las tareas con pasos de SQL sobre esas conexiones piden escribir el nombre al ejecutarlas a mano y al
programarlas (como Producción). Una tarea ya programada antes de marcar su entorno sigue ejecutándose; guárdala
de nuevo para revisarla.

En **cualquier otra conexión** (Local, Staging, Otro), con **Ajustes → Seguridad → Confirmar antes de borrar o
eliminar en cualquier conexión** activado (lo está por defecto, también en perfiles anteriores), Vortaq pide
una confirmación sencilla, sin escribir el nombre, antes de:

- eliminar una tabla, vista, función, procedimiento, evento o base de datos, o vaciar una tabla (árbol de
  conexiones, lista de objetos y menús contextuales);
- **Aplicar** cambios de una tabla o de un resultado editable que **eliminan filas** (dice cuántas y cuáles);
- ejecutar una consulta con `DROP`, `TRUNCATE`, `DELETE`, `ALTER TABLE … DROP` (columna, índice, clave,
  restricción o partición) o un `UPDATE` sin `WHERE`. El diálogo lista las sentencias y marca las que no tienen
  `WHERE` («sin WHERE: afecta a todas las filas»). Las palabras dentro de comentarios o cadenas no cuentan, y un
  `SELECT`, un `INSERT` o un `UPDATE … WHERE` no preguntan;
- aplicar el editor DDL cuando elimina y vuelve a crear el objeto, guardar el diseñador de tablas cuando elimina
  campos, índices o claves, y eliminar un usuario.

El diálogo muestra la conexión con su entorno, lo que se va a borrar, y deja el foco en **Cancelar** (Intro no
borra nada). En una conexión de Producción (o de un entorno marcado en Seguridad) se muestra solo la
confirmación con el nombre, nunca las dos. Es una ayuda de la interfaz: el proceso principal no la exige (la del
nombre sí). Si la desactivas, todo vuelve a funcionar como antes: las conexiones que no piden el nombre solo
preguntan donde ya preguntaban.

### Atajos de teclado

En macOS se usa `Cmd`; en Windows y Linux, `Ctrl`.

| Atajo                           | Acción                                                                |
| ------------------------------- | --------------------------------------------------------------------- |
| `Cmd/Ctrl+N`                    | Nueva consulta en la conexión seleccionada                            |
| `Cmd/Ctrl+R` o `Cmd/Ctrl+Enter` | Ejecuta la consulta de la pestaña activa                              |
| `Cmd/Ctrl+S`                    | Guarda (consulta, diseño de tabla, objeto DDL o cambios en los datos) |
| `Cmd/Ctrl+W`                    | Cierra la pestaña activa (pregunta si hay cambios sin guardar)        |
| `Cmd/Ctrl+D`                    | Estructura de la tabla abierta (o de la seleccionada en el árbol)     |
| `Alt+↓` (en la rejilla)         | Valores permitidos de un ENUM o filas de la tabla relacionada (FK)    |
| `Cmd/Ctrl+C` (en la rejilla)    | Copia la selección como texto tabulado (se pega en hojas de cálculo)  |
| `Shift+Cmd/Ctrl+C` (rejilla)    | Copia la selección con la fila de encabezados                         |
| `Cmd/Ctrl+A` (en la rejilla)    | Selecciona todas las celdas del resultado                             |
| `Shift+Cmd/Ctrl+W`              | Cierra la ventana                                                     |
| `Shift+Alt+Cmd/Ctrl+R`          | Recarga la ventana (desarrollo)                                       |
| `Alt+Cmd/Ctrl+I`                | Herramientas de desarrollo (desarrollo)                               |

En el editor de consultas, un resultado que incluye la **clave primaria completa de una tabla** se edita igual
que la vista de datos, también cuando la consulta une otras tablas con `JOIN` para filtrar. Se editan las
columnas de esa tabla (`r.*`, `r.columna`); las de otras tablas y las calculadas se ven atenuadas y no cambian.
Un aviso sobre la rejilla indica `Editable · esquema.tabla` (y cuántas columnas son de solo lectura) o
`Solo lectura` con el motivo (subconsulta, agrupación, filas repetidas por el `JOIN`, vista, sin clave
primaria…). En PostgreSQL y SQLite escribe las columnas de un `JOIN` con su alias (`p.*`, `p.columna`): el
servidor no dice de qué alias viene cada una.

## Copias de seguridad y rollback a local

- **Copias de seguridad** (barra superior) abre las copias de la conexión seleccionada: las propias y, en solo
  lectura, las que creó Navicat.
- **Nueva copia** genera un `.vqb` (por defecto; ver abajo), un `.nb3` o un `.sql` del esquema elegido
  (estructura y, si quieres, datos) con barra de progreso y opción de cancelar. El formato por defecto se cambia
  en **Ajustes › Carpetas › Formato de las copias nuevas**. Las copias cifradas salen en la lista con un
  candado; al seleccionarlas, el panel de detalles pide la contraseña para mostrar su contenido.
- **Restaurar** carga una copia en la conexión y el esquema que elijas. Puedes crear el esquema, borrar antes
  los objetos, restaurar solo estructura o solo datos y elegir objetos concretos.
- **Reemplazar la base de datos completa** (modo de **Restaurar**) borra la base de datos de destino y la crea
  de nuevo con la copia. En **Contenido** eliges **Estructura y datos** (por defecto) o **Solo estructura**:
  las tablas con sus relaciones (claves foráneas, índices), vistas, rutinas, eventos y triggers, pero **sin
  filas** y con los contadores `AUTO_INCREMENT` empezando de nuevo (no se aplica el valor de la copia). La
  comprobación de la copia, la copia previa, las bases de datos del sistema y la confirmación de Producción
  funcionan igual en los dos modos; la confirmación y el resultado dicen «Solo estructura».
- **Rollback a local** de una sola copia: para traer el estado de un servidor remoto a tu MySQL local:
  1. Crea una conexión a tu MySQL local con entorno **Local**.
  2. En la conexión remota, pulsa **Nueva copia**.
  3. Selecciona esa copia y pulsa **Restaurar en Local**.

Las copias nuevas se guardan en `<perfil>/backups/<conexión>/<esquema>/`, salvo que cambies la carpeta en la
conexión o en **Ajustes** (si venías de ElectronDB o de Navidog, siguen en la carpeta `backups` de ese perfil).

### Copias .vqb: formato abierto con cifrado opcional

`.vqb` («Vortaq Backup») es el formato propio de Vortaq y el que usan por defecto las copias nuevas y los pasos
de copia nuevos de la automatización. Su especificación es pública: [docs/vqb-format.md](docs/vqb-format.md).

- **Abierto**: es un ZIP normal con un `manifest.json`, el DDL de cada objeto y las filas en JSON comprimido
  (`.jsonl.gz`) con tipos exactos (decimales, enteros grandes, binarios, fechas sin cambios de zona horaria,
  JSON, arrays de PostgreSQL). Se puede abrir sin Vortaq con `unzip`, `gunzip` y cualquier lector de JSON; la
  especificación trae un lector de ejemplo en Python.
- **SQLite**: la copia incluye una base de datos entera (tablas con cada valor y su tipo exacto, índices, vistas,
  triggers y contadores de `AUTOINCREMENT`) y se restaura en un archivo nuevo o reemplazando la base de datos.
- **MongoDB**: cada documento se guarda en Extended JSON canónico, así que un Int64, un Decimal128 o la
  diferencia entre Int32 y Double vuelven tal cual; también las opciones de cada colección, su validador, sus
  índices y las vistas. Se restaura en otra base de datos o reemplazando la base de datos.
- **MySQL, MariaDB y PostgreSQL**: en PostgreSQL la copia incluye la base de datos entera (todos sus esquemas,
  extensiones, tipos, secuencias, tablas y datos, funciones, vistas, índices, claves foráneas y triggers). Una
  copia se restaura solo en el mismo motor. En PostgreSQL la restauración es una única transacción: si algo
  falla (y no marcas «Continuar en caso de error»), la base de datos queda exactamente como estaba.
- **Cifrar con contraseña** (opcional, en **Nueva copia** y en cada paso de copia de la automatización):
  AES-256-GCM con una clave derivada de tu contraseña (scrypt). Se cifra todo menos una pequeña cabecera, así
  que ni los nombres de las tablas ni el de la conexión se ven sin la contraseña. **Si pierdes la contraseña,
  la copia no se puede recuperar.** Una contraseña incorrecta se detecta antes de tocar el destino, y una copia
  modificada o dañada se rechaza con un error de integridad.
- **Restaurar** pide la contraseña una vez; **Restaurar paquete en Local** y **Restaurar todo** la piden una vez
  para todo el paquete, salvo que la tarea que hizo las copias tenga su contraseña guardada.
- La copia previa de un reemplazo usa el formato de la copia que se restaura (y su contraseña, si está cifrada).
- **Guardar el nombre de la conexión** (activado por defecto) se puede desmarcar para que la copia no lo
  incluya.

### Exportar a .sql

Para llevar una base de datos a otro gestor (o al cliente `mysql`), en **Copias de seguridad** pulsa
**Exportar a .sql…** (o **Nueva copia** y elige **Formato: .sql**). El archivo es SQL plano, compatible con
`mysql < archivo.sql`, phpMyAdmin, HeidiSQL, DBeaver o MySQL Workbench:

- cada tabla con `DROP TABLE IF EXISTS` + `CREATE TABLE`, sus filas en `INSERT` de varias filas (hasta 500 filas
  o 1 MiB por sentencia, sin las columnas generadas) y sus triggers; después funciones y procedimientos, vistas
  (en orden de dependencia) y eventos, con bloques `DELIMITER ;;`;
- `utf8mb4`, lectura en una instantánea consistente y `TIME_ZONE='+00:00'` para que los `TIMESTAMP` vuelvan
  igual;
- opciones: **Incluir estructura**, **Incluir datos**, **Incluir CREATE DATABASE** (desactivado: el archivo se
  importa en el esquema que elijas) y **Comprimir (.sql.gz)**.

Se guarda en la carpeta de copias de la conexión (`<esquema>/<fecha>[-etiqueta].sql`) y al terminar puedes
abrir su carpeta. Los archivos `.sql` no aparecen en la lista de copias (que muestra las `.vqb` y `.nb3`) y los
`DEFINER` se conservan tal como los da el servidor.

En **Automatización**, cada paso de copia tiene **Formato: .vqb | .nb3 | .sql** (los pasos nuevos empiezan en
`.vqb`; los pasos guardados antes siguen en `.nb3`). Con `.vqb` puedes marcar **Cifrar con contraseña**: la tarea
pide una contraseña (una para todos sus pasos cifrados) que se guarda cifrada en este equipo, como las de las
conexiones, para que las ejecuciones programadas puedan cifrar sin que nadie la escriba; nunca aparece en el
registro. Un paso de restauración no puede usar una copia `.sql` (las restauraciones automáticas necesitan `.vqb`
o `.nb3`): el trabajo no se guarda hasta que cambies el formato. Para volver a cargar un `.sql`, usa
**Importar… › Archivo .sql**.

### Restaurar todo en Local (rollback de una ejecución)

Si un trabajo de automatización saca copias de varias bases de datos (por ejemplo, todas las de staging), puedes
pasarlas todas a tu MySQL local de una vez y dejarlo **igual que estaba en el momento del backup**:

1. En **Automatización**, selecciona el trabajo y, en el **Historial**, pulsa el icono **Restaurar todo en
   Local** de una ejecución terminada (también está dentro de la ejecución al desplegarla).
2. Elige la **conexión de destino**. Por defecto es la primera conexión con entorno **Local**; nunca se
   preselecciona una de producción.
3. Revisa la lista: cada base de datos muestra `origen → destino` (mismo nombre), cuántos objetos y filas
   tiene la copia, su tamaño y si en el destino **se reemplaza** (ya existe) o es **nueva**. Desmarca las que
   no quieras. Las copias que no se pueden usar (archivo borrado, otra base de datos dentro, cifrada, o una
   base de datos del sistema como `mysql`, `sys` o `performance_schema`, que nunca se reemplaza) aparecen
   desactivadas con el motivo. Las copias **solo de estructura** (paso de copia sin «Incluir datos») o sin
   ninguna fila salen con un aviso, porque dejarían las tablas vacías; las de solo estructura vienen
   desmarcadas y la confirmación las nombra aparte («quedarán SIN DATOS»).
4. En **Contenido** deja **Estructura y datos** o elige **Solo estructura** (todas las bases de datos marcadas
   se crean con sus tablas vacías, sin filas). Deja marcada **Copia de seguridad previa de Local**
   (recomendado) y pulsa **Restaurar**. La confirmación
   lista exactamente qué bases de datos se van a reemplazar y cuáles se van a crear.

Para cada base de datos marcada, en este orden:

1. Se comprueba la copia: que existe, que contiene esa base de datos y que **se lee entera sin errores** (se
   verifican la suma de verificación y la descompresión de cada bloque de datos, así que una copia dañada se
   detecta antes de borrar nada). Si falla, esa base de datos no se toca.
2. Si ya existe en el destino y la copia previa está activada, se guarda una copia de seguridad en
   `<carpeta de backups del destino>/<esquema>/<fecha>-previo-rollback.nb3`. **Si esa copia falla, esa base
   de datos no se toca** y aparece con ERROR.
3. Se borra (`DROP DATABASE`) y se crea de nuevo con el juego de caracteres y la colación de la copia cuando
   el servidor de destino los tiene (si no, los del servidor).
4. Se restauran todos los objetos con sus datos (o, con **Solo estructura**, sin filas y sin el
   `AUTO_INCREMENT` de la copia). Funciona entre versiones (por ejemplo, MySQL 5.7 → 8.4): los
   `DEFINER` de usuarios que no existen en el destino se quitan para que vistas, triggers y rutinas funcionen.

La restauración aparece en el historial del trabajo como una ejecución más (**Restauración**, nombre
`Rollback a Local · <trabajo>`) con su registro en vivo: un encabezado por base de datos (`Base de datos auth:
Staging -> Local`), la comprobación de la copia, la copia previa, el borrado y la creación, una línea por objeto
restaurado, el modo (`Contenido: estructura y datos` o `Contenido: solo estructura`), el resultado (`Solo
estructura: 7 objetos, 0 filas` en ese modo) y un resumen final con los fallos y la lista de **copias previas** guardadas. No cambia
el estado ni la «Última ejecución» del trabajo de backup, y no impide ejecutarlo mientras dura.

Si un objeto falla (por ejemplo, una función de 5.7 sin `DETERMINISTIC` en un 8.4 con binlog), el paso dice qué
objetos fallaron, el error con una pista en español (en ese caso, `SET GLOBAL log_bin_trust_function_creators
= 1` en el destino), que la base de datos **ha quedado incompleta** y cuál es su copia previa. Lo mismo si
cancelas o cierras Vortaq a mitad: cancelar una restauración pide confirmación, y salir de la aplicación
mientras restaura también.

**Deshacer.** Cada base de datos reemplazada muestra en el historial su **Copia previa** y un botón
**Deshacer**, que abre esa copia en **Restaurar** con el modo **Reemplazar la base de datos completa**: la base
de datos se borra y se crea de nuevo con lo que tenía antes (lo que trajo la restauración desaparece; antes se
guarda otra copia previa). También puedes hacerlo desde **Copias de seguridad › conexión › base de datos ›
copia `previo-rollback` › Restaurar**. El modo «Restaurar objetos» (el de siempre) solo sobrescribe los objetos
de la copia y deja los demás.

Si el destino es una conexión de **Producción**, hay que escribir su nombre para confirmar.

### Restaurar un paquete de copias en Local (desde Copias de seguridad)

En **Copias de seguridad** de una conexión, las copias que se hicieron juntas se agrupan en **paquetes** (el
interruptor **Agrupar por paquete**, abajo a la derecha, está activado por defecto y se recuerda):

- **Automatización**: las copias que escribió una misma ejecución de un trabajo de Vortaq. Título
  `<trabajo> · <fecha de la ejecución>`, por ejemplo `Backup staging · 2026-10-05 23:16`.
- **Lote**: el resto (los lotes de Navicat, copias antiguas o hechas a mano) se agrupan por conexión y
  etiqueta (el sufijo del nombre, `…-backup-staging.nb3`) cuando cada copia se hizo menos de 10 minutos
  después de la anterior y no repite base de datos. Título `<etiqueta o «Sin etiqueta»> · <fecha de la
primera>`.

Un paquete necesita al menos dos copias; las sueltas siguen como filas normales. Los paquetes salen plegados:
la flecha los despliega. Para restaurar el paquete entero en tu MySQL local:

1. Pulsa la cabecera del paquete (o su casilla): se marcan todas sus copias. También puedes marcar copias
   sueltas a mano, o seleccionar una fila de un paquete.
2. Pulsa **Restaurar paquete en Local**. Se abre el mismo diálogo que «Restaurar todo en Local», con las
   bases de datos marcadas; la confirmación lista qué se **reemplaza** y qué se **crea**.

Si todas las copias marcadas son de una misma ejecución, se usa esa ejecución (como desde el historial). Si no
(un lote de Navicat, copias elegidas a mano), la restauración se hace **por archivos** con las mismas reglas:
cada archivo tiene que estar en la carpeta de copias de una conexión conocida (la propia o una de Navicat), solo
una copia por base de datos (si marcas dos de `auth`, te pide que elijas una), comprobación completa de cada
copia antes de borrar nada, copia previa `previo-rollback`, nunca bases de datos del sistema y, en
**Producción**, escribir su nombre. Queda en el historial del trabajo que hizo las copias o, si vienen de varios
trabajos o de ninguno, en **Automatización › Restauraciones manuales**, con su registro.

## Automatización

Un trabajo agrupa pasos de **backup de esquema**, de **SQL** y de **restauración**, con una programación tipo
cron, historial y registro de cada ejecución.

Todos los motores tienen trabajos: en **PostgreSQL**, **SQLite** y **MongoDB** los pasos de copia guardan un
`.vqb` (con **Cifrar con contraseña** opcional, la misma contraseña de la tarea) y los pasos de restauración
reemplazan una base de datos del mismo motor con esa copia (en SQLite, `main` o una base adjunta; con la copia
previa propia de cada motor). Los pasos **SQL** y los formatos `.nb3` y `.sql` son solo de MySQL y MariaDB, y
una copia nunca se restaura en una conexión de otro motor (el editor solo ofrece destinos del mismo motor).

El paso **Restaurar** reemplaza una base de datos con una copia, igual que «Restaurar todo en Local»
(comprobación de la copia, copia previa, borrado y creación, restauración). Su origen es:

- **un paso de copia anterior del mismo trabajo** (restaura el archivo que ese paso acaba de generar; solo
  puede ser un paso solo de estructura si el paso Restaurar también es «Solo estructura»), o
- **la última copia completa de una tarea** de un esquema de una conexión: la copia con datos más reciente que
  hizo un paso de copia de una tarea de Vortaq sobre esa misma conexión y que sigue en disco. Nunca usa
  copias manuales, parciales, solo de estructura, de Navicat, de otra conexión ni copias previas.

Como en el diálogo de restaurar, el paso tiene **Contenido**: **Estructura y datos** (por defecto, también en
los trabajos guardados antes de la 0.1.6) o **Solo estructura** (tablas vacías con sus relaciones); se guarda
en `jobs.json` con el paso.

La base de datos de destino tiene por defecto el mismo nombre que la de origen. Así se monta un trabajo
**Staging → Local**: un paso de copia por cada base de datos de staging y, detrás, un paso Restaurar de cada
una en la conexión Local; programado, mantiene tu local al día cada mañana. Por seguridad, **un paso Restaurar
nunca puede escribir en una conexión de Producción** (las ejecuciones programadas o de launchd no tienen a nadie
que confirme): Vortaq lo rechaza al guardar el trabajo y otra vez al ejecutarlo. Tampoco permite restaurar
una base de datos sobre sí misma (misma conexión y esquema que el origen) ni sobre una base de datos del sistema
(`mysql`, `sys`, `performance_schema`, `information_schema`; en PostgreSQL `template0`/`template1`, en MongoDB
`admin`, `local` y `config`).

| Modo                                  | Sistemas   | Cómo funciona                                                                       |
| ------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| Programador interno                   | Todos      | Ejecuta los trabajos a su hora **mientras la app está abierta**.                    |
| "Ejecutar aunque la app esté cerrada" | Solo macOS | Crea un LaunchAgent en `~/Library/LaunchAgents/` que lanza la app sin ventana.      |
| Línea de comandos `--run-job=<id>`    | Todos      | Ejecuta un trabajo sin ventana y termina. Útil con el Programador de tareas o cron. |

Un trabajo con pasos SQL sobre Producción pide confirmación al guardarlo; las ejecuciones programadas usan esa
confirmación.

Ejecución por línea de comandos (código de salida `0` = éxito, `1` = fallo, `2` = el trabajo no existe). El
`<id>` del trabajo está en `<perfil>/jobs.json`.

```sh
# Desde el código
npm run build
npx electron . --run-job=<id>

# App instalada
/Applications/Vortaq.app/Contents/MacOS/Vortaq --run-job=<id>     # macOS
"%LOCALAPPDATA%\Programs\Vortaq\Vortaq.exe" --run-job=<id>        # Windows (ruta por defecto del instalador)
/opt/Vortaq/vortaq --run-job=<id>                                 # Linux (.deb)
```

Para programarlo con la app cerrada fuera de macOS:

- **Windows**: Programador de tareas → Crear tarea básica → Acción "Iniciar un programa" con la ruta del `.exe`
  y el argumento `--run-job=<id>`.
- **Linux** (experimental): cron no tiene pantalla ni acceso al llavero de tu sesión, y Electron necesita
  ambos aunque no abra ventana. Indícalos en la línea de `crontab -e` y deja tu sesión de escritorio iniciada
  (con el llavero desbloqueado). Cambia `1000` por tu UID, que sale con `id -u`:

  ```sh
  0 3 * * * DISPLAY=:0 XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /opt/Vortaq/vortaq --run-job=<id> >> /tmp/vortaq-cron.log 2>&1
  ```

  El registro de la ejecución queda en `/tmp/vortaq-cron.log` y en el `logs/` del perfil.

### Cambiar la conexión de una consulta

En la barra de la pestaña de consulta, a la izquierda de la base de datos, está el **selector de conexión**: cada
conexión aparece con su color, su nombre y su entorno (Producción en rojo). Al cambiarla:

- El SQL del editor se conserva. La conexión se abre si hacía falta.
- Se recarga la lista de bases de datos: si la nueva conexión tiene una base con el mismo nombre se mantiene; si
  no, queda sin base de datos seleccionada. El autocompletado pasa a usar la nueva conexión.
- El título de la pestaña cambia a `consulta@base (conexión)` y los resultados anteriores se vacían (pertenecían
  a la otra conexión).
- No se puede cambiar mientras se ejecuta una consulta; si un resultado tiene cambios sin aplicar, primero
  pregunta si quieres descartarlos.
- Con una conexión de **Producción** la barra y el selector se tiñen de rojo, y las confirmaciones de escritura
  se aplican siempre a la conexión **actual** de la pestaña.
- Las consultas guardadas son de cada conexión: si abres una guardada y cambias de conexión, al pulsar
  **Guardar** se guarda en la conexión nueva (la original no cambia). El botón lo indica con un icono y un aviso.

### Filtrar datos de una tabla

El botón **Filtro** de la vista de datos muestra u oculta el panel de filtro; con un filtro aplicado el botón
muestra cuántas condiciones hay aunque el panel esté oculto. El filtro se lee como frases:

```
☑ email contiene jorge y
☑ (
☑   country está en la lista (ES, MX) o
☑   credit_limit entre 1000 y 6000
  ) y
☐ city empieza por Val          ← desmarcada: se conserva, pero no se aplica
```

- Haz clic en cada palabra para cambiarla: la **columna** y el **operador** abren un menú, el **valor** se edita en
  el sitio (`<?>` si está vacío; en columnas de fecha u hora con el calendario) y el **conector** alterna entre
  `y` y `o`. Al lado del valor, una etiqueta pequeña indica qué tipo de valor compara (`número`, `texto`,
  `fecha`...).
- `+` añade una condición y `(+` un paréntesis (en la raíz o, desde la línea `)`, dentro de ese paréntesis). Los
  paréntesis se pueden anidar.
- Clic derecho en una línea: Insertar condición, Insertar paréntesis, Agrupar con paréntesis, Borrar condición,
  Borrar paréntesis (conserva sus condiciones), Borrar paréntesis y condiciones, Limpiar todo y los **perfiles**.
  Clic derecho en el espacio vacío o en una línea `)`: Añadir condición, Limpiar todo y los perfiles.
- Operadores: `=`, `!=`, `<`, `<=`, `>`, `>=`, contiene, no contiene, empieza por, no empieza por, termina en, no
  termina en, es nulo, no es nulo, está vacío, no está vacío, está en la lista, no está en la lista, entre, no
  entre y **SQL libre** (un fragmento SQL tuyo para esa línea).
- **Aplicar filtro** (o `Cmd/Ctrl+Enter`, o `Enter` al editar un valor) recarga la tabla desde la primera página;
  el total y la paginación usan el mismo filtro. **Limpiar** quita el filtro y recarga todo.
- **Editar como texto (WHERE)** muestra el `WHERE` que se ejecutaría para retocarlo a mano. Ese texto es SQL tuyo
  y se ejecuta tal cual; al volver al editor visual se descarta lo editado (se avisa antes).
- El filtro y la visibilidad del panel se conservan mientras la pestaña está abierta. Los **perfiles** (Guardar
  perfil, Guardar perfil como…, Cargar perfil, Eliminar perfil) se guardan por conexión, base de datos y tabla
  en `filter-profiles.json` del perfil.

Cómo se interpreta, para que no haya sorpresas:

- `y` tiene prioridad sobre `o`, como en SQL: `a o b y c` es `a o (b y c)`. Usa paréntesis para otro orden.
- **está vacío** es `(columna = '' OR columna IS NULL)`; **no está vacío** es lo contrario.
- `!=`, **no contiene**, **no está en la lista**, etc. siguen a SQL: las filas con `NULL` en esa columna no
  aparecen. Usa **es nulo** si también las quieres.
- **contiene / empieza por / termina en** buscan el texto literal: `%`, `_` y `\` no son comodines.
- La SQL la construye el proceso principal: las columnas se comprueban contra la tabla real y los valores van
  escapados por el controlador de MySQL. Solo **SQL libre** y el modo texto son SQL escrito por ti.

### Editar fechas y horas

Al editar una celda `DATE`, `DATETIME`, `TIMESTAMP`, `TIME` o `YEAR` el editor sigue siendo un campo de texto
(puedes escribir o pegar `2026-09-30 23:45:00`) con un botón de calendario que también se abre con `Alt+↓`:

- `DATE`: calendario. `DATETIME`/`TIMESTAMP`: calendario y hora con segundos (y fracción de segundo si la columna
  la tiene, por ejemplo `DATETIME(3)`). `TIME`: horas, minutos y segundos (en el texto admite más de 24 h y
  negativos, como MySQL). `YEAR`: selector de años.
- **Hoy/Ahora** pone la fecha u hora de tu reloj; **NULL** solo aparece si la columna admite `NULL`.
- `Enter` valida y guarda el cambio pendiente; `Esc` cancela. Un valor no válido se marca en rojo y no se guarda.
- Se escribe siempre el formato de MySQL (`AAAA-MM-DD`, `AAAA-MM-DD hh:mm:ss[.ffffff]`, `hh:mm:ss`) sin
  conversiones de zona horaria. Las fechas cero (`0000-00-00`) se muestran y se pueden conservar.

### Listas de ENUM y valores de claves foráneas

- Una columna `ENUM` (MySQL, MariaDB y los tipos enumerados de PostgreSQL) se edita con su lista de valores: al
  abrir la celda aparecen todos, y al escribir la lista se filtra (primero los que empiezan por el texto). `↑/↓`
  recorren la lista; `Enter` o un clic guardan el cambio pendiente. Un texto que no es uno de los valores se
  marca en rojo y no se guarda. **NULL** solo aparece si la columna lo admite.
- En una columna con **clave foránea** la cabecera muestra un icono de enlace, y la celda activa un botón
  **Elegir de «tabla»** (también `Alt+↓` o el menú del botón derecho). Abre las filas de la tabla relacionada,
  ordenadas por su clave, con buscador (busca en las columnas de la clave y en las de texto) y **Cargar más**.
  Elegir una fila escribe sus valores en las columnas de la clave, todas a la vez si la clave es compuesta, como
  cambio pendiente. Solo se lee la tabla relacionada; nada se escribe hasta **Aplicar**.
- Funciona en la vista de datos y en los resultados editables del editor de consultas.

### Diagrama de relaciones y consulta gráfica

En la pestaña **Objetos**, con una base de datos (MySQL, MariaDB, SQLite) o un esquema (PostgreSQL) seleccionado,
o abierto en la lista, aparecen dos botones:

- **Diagrama**: todas las tablas con sus columnas (icono de llave en la clave primaria y de enlace en las
  foráneas) y una línea por clave foránea, con la «pata de gallo» en la tabla que apunta y discontinua si la
  clave admite `NULL`. Las tablas relacionadas se colocan solas (las referenciadas a la izquierda) y las sueltas
  aparte. Arrastra el fondo o usa la rueda para moverte, `Cmd/Ctrl` + rueda para el zoom, arrastra una cabecera
  para mover una tabla y haz doble clic para abrir sus datos (botón derecho: **Diseñar tabla**). **Solo claves**
  deja solo las columnas de claves; **Reorganizar** vuelve a la colocación automática; **Exportar** guarda una
  imagen PNG o SVG. Dónde dejas cada tabla se recuerda en este equipo. Se leen como mucho 300 tablas (por orden
  alfabético) y solo su estructura; las claves que apuntan a otra base o esquema se cuentan pero no se dibujan.
- **Consulta gráfica**: haz clic en las tablas de la lista para añadirlas. Si tienen claves foráneas entre sí,
  se unen solas (`INNER JOIN`); para otra unión, arrastra el punto de una columna hasta una columna de otra tabla.
  Un clic en una línea la cambia a «todas las filas de…» (`LEFT JOIN`) o la quita. Marca columnas en las tablas y,
  abajo, elige alias, **Total** (contar, suma, media, mínimo, máximo; las demás columnas visibles pasan a
  `GROUP BY` y los filtros de un total van a `HAVING`), orden y filtro (`=`, `≠`, `<`, `contiene`, `es nulo`,
  `en la lista`…). La pestaña **SQL** muestra la consulta tal como se va armando; **Abrir en consulta** la lleva
  a una pestaña de consulta y **Ejecutar** además la ejecuta allí, con las protecciones de siempre. Los valores
  se escriben como literales escapados según el motor; nada se ejecuta desde la propia consulta gráfica.

### Columnas y panel Texto

- Arrastra el borde derecho de una cabecera para cambiar el ancho de la columna (mínimo 48 px); doble clic en el
  borde la ajusta al contenido visible (máximo 600 px). Los anchos se recuerdan por tabla (también al paginar,
  refrescar o volver a abrirla). Editar una celda no cambia el ancho de su columna.
- Para ordenar, usa la flecha que aparece en la cabecera al pasar el ratón (o el menú del botón derecho:
  **Ordenar ascendente**, **Ordenar descendente**, **Quitar orden**); un clic en la cabecera selecciona la columna.
- El botón **Texto** (vista de datos y resultados de consulta) abre un panel inferior redimensionable
  con el valor completo de la celda seleccionada: columna, tipo y tamaño; JSON formateado y coloreado; binarios
  en hexadecimal; `NULL` como estado. Sigue a la celda activa también con las flechas.
- Si la rejilla es editable, el panel también: el cambio queda pendiente como en la celda (Aplicar, Descartar,
  `Cmd/Ctrl+S`). **Formatear JSON** guarda el JSON con sangría; si no, se guarda exactamente lo que escribes.
  **NULL** solo aparece si la columna admite `NULL`. Las confirmaciones de producción no cambian.

### Copiar y exportar resultados

En la vista de datos y en todos los resultados de consulta (también los de solo lectura que leen de varias
tablas) se puede seleccionar como en una hoja de cálculo:

- **Celdas**: clic, `Shift`+clic o arrastrar para un rectángulo; `Shift`+flechas lo amplía. **Filas**: clic en el
  número de fila (`Shift` para un rango, `Cmd/Ctrl` para añadir). **Columnas**: clic en la cabecera (`Shift` y
  `Cmd/Ctrl` igual). **Todo**: `Cmd/Ctrl+A` o clic en `#`. `Esc` vuelve a la celda activa.
- **Eliminar** sigue trabajando solo con las filas elegidas en la columna `#` (o la fila de la celda activa):
  seleccionar columnas o todo nunca marca filas para borrar.
- `Cmd/Ctrl+C` copia la selección como texto tabulado, listo para pegar en Excel, Numbers o Google Sheets
  (`NULL` queda como celda vacía). El botón derecho ofrece **Copiar**, **Copiar con encabezados** y **Copiar
  como**: CSV, JSON, `INSERT` (con las comillas del motor y la tabla de origen cuando el resultado tiene una),
  `UPDATE` (las columnas seleccionadas por la clave primaria, cuando se conoce), **Lista para IN** (cada valor una
  vez; `NULL` se omite porque `IN` nunca lo encuentra, y el aviso lo dice) y Markdown. Los valores se copian tal
  como se ven: fechas, decimales y enteros grandes no se reformatean.
- **Exportar** (barra del resultado o menú del botón derecho) guarda un archivo **CSV** (separador coma, punto y
  coma o tabulador, BOM opcional para Excel), **Excel `.xlsx`** (encabezado fijo; los números de más de 15
  cifras se guardan como texto y ningún valor se convierte en fórmula), **JSON** (objetos o arreglos),
  **SQL** (`INSERT` de una fila o en lotes), **Markdown**, **HTML** o **TXT** tabulado. Qué exportar:
  - **Selección** o **Filas cargadas**: lo que ves en la rejilla (con los cambios aún sin aplicar).
  - **Resultado completo**: vuelve a ejecutar la consulta (o el `SELECT` de la tabla con su filtro y su orden,
    sin paginar) en una **sesión nueva de solo lectura** y escribe todas las filas en el archivo poco a poco, sin
    límite. No ve los cambios sin confirmar de la pestaña. Solo se permite con una única sentencia de lectura
    (`SELECT`, `WITH`, `SHOW`…); cualquier cosa que pueda escribir se rechaza, y aunque algo pasara el filtro la
    sesión no puede escribir (`START TRANSACTION READ ONLY` en MySQL/MariaDB, `BEGIN READ ONLY` en PostgreSQL y
    un proceso aparte que abre el archivo SQLite en solo lectura). Por eso no pide la confirmación de
    producción. El progreso aparece en la tarjeta de operaciones con **Cancelar**, que detiene la consulta en el
    servidor y borra el archivo a medias. Se ejecuta en la base de datos (y el esquema) de la pestaña, así que no
    se ofrece cuando otra sentencia del mismo script cambia la sesión o los datos (`USE`, `SET search_path`,
    `CREATE TEMPORARY TABLE`, escrituras…) ni cuando la consulta usa variables de sesión `@…` de MySQL/MariaDB:
    en esos casos exporta las filas cargadas o ejecuta la consulta sola.
- Los `INSERT`/`UPDATE` copiados o exportados para MySQL/MariaDB escapan con barra invertida (`\'`, `\\`): si el
  servidor de destino usa `NO_BACKSLASH_ESCAPES`, exporta en CSV o JSON.
- El archivo se escribe primero como `<archivo>.part` y solo toma su nombre al terminar. Excel admite hasta
  1.048.576 filas y 16.384 columnas por hoja y 32.767 caracteres por celda: si te pasas, Vortaq lo dice (y sugiere
  CSV) o recorta las celdas largas y avisa de cuántas.
- MongoDB tiene su propia vista de documentos y no usa esta exportación.
- En la [extensión para editores](#extensión-para-editores-vs-code-cursor-vscodium-windsurf) funciona igual en el
  panel de resultados: el archivo se elige con el diálogo de guardar del editor y el progreso del resultado completo
  aparece en el panel y en una notificación del editor, las dos con **Cancelar**.

## Asistente de IA

Un panel lateral **IA** (botón ✦ a la derecha de la barra superior; se alterna con el panel Información) para
preguntar sobre tu base de datos con el proveedor de IA que elijas y **tu propia clave**. Está **desactivado
por defecto**: añade un proveedor en **Ajustes › IA** y activa «Activar asistente de IA».

### Proveedores

| Proveedor                             | URL base                                                                               | Clave    |
| ------------------------------------- | -------------------------------------------------------------------------------------- | -------- |
| Anthropic Claude                      | SDK oficial de Anthropic (`@anthropic-ai/sdk`)                                         | Sí       |
| OpenAI                                | `https://api.openai.com/v1`                                                            | Sí       |
| Groq                                  | `https://api.groq.com/openai/v1`                                                       | Sí       |
| xAI Grok                              | `https://api.x.ai/v1`                                                                  | Sí       |
| Zhipu GLM / Z.ai GLM (internacional)  | `https://open.bigmodel.cn/api/paas/v4` / `https://api.z.ai/api/paas/v4`                | Sí       |
| Ollama (local)                        | `http://localhost:11434/v1` (editable)                                                 | No       |
| Personalizado (compatible con OpenAI) | La que indiques: `https://` obligatorio, `http://` solo para `localhost` o `127.0.0.1` | Opcional |

- Claude se usa siempre con el SDK oficial de Anthropic. Modelos sugeridos: `claude-opus-5-5` (por defecto),
  `claude-sonnet-5-5`, `claude-haiku-4-5` y `claude-fable-5-1`; puedes escribir otro ID. En Opus 5.5, Sonnet 5.5
  y Fable 5.1 el razonamiento es siempre adaptativo y el **esfuerzo** (Bajo / Medio / Alto, en Ajustes) controla
  cuánto piensa; Haiku 4.5 no usa ni razonamiento ni esfuerzo.
- El resto de proveedores usan el SDK oficial `openai` con su URL base. El modelo se escribe a mano o se elige
  tras pulsar **Cargar modelos** (si el proveedor no permite listarlos, escribe el ID). Si un servidor
  compatible no admite herramientas, la petición se repite una vez sin ellas.
- **Probar** hace una petición mínima con la clave (en Claude solo consulta el modelo, sin generar texto).
- Las claves se guardan cifradas en `credentials.json` con el almacén del sistema, como las contraseñas, y
  **nunca vuelven a la interfaz** (solo se ve si hay una guardada). Todas las llamadas de red salen del proceso
  principal con la configuración de red del sistema (proxy incluido).

**Coste**: cada pregunta la factura el proveedor a tu clave según sus tarifas. El pie del panel muestra los
tokens de la última respuesta (entrada, salida y, en Claude, los leídos de la caché). Con Claude, las
instrucciones y la estructura van marcadas para la caché de prompts, así que las preguntas seguidas sobre la
misma base de datos cuestan bastante menos.

**Rechazos de Claude**: si los filtros de seguridad de Claude rechazan una petición se muestra un aviso en
español. En `claude-opus-5-5`, `claude-sonnet-5-5` y `claude-fable-5-1` está activado el **reintento en el
servidor** (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): Anthropic repite la petición con
el modelo que recomienda para ese tipo de rechazo, dentro de la misma llamada, y se factura con las tarifas de
ese modelo. El pie indica el modelo que respondió.

### Qué se envía y qué nunca

Solo se envía la **estructura** de la base de datos seleccionada: nombres de bases de datos, tablas y columnas,
tipos, claves primarias y únicas, índices, claves foráneas, firmas de vistas y rutinas, estimaciones de filas y
el entorno de la conexión (Local, Staging, Producción). La estructura se lee **solo de `information_schema`**
(en PostgreSQL también `pg_catalog`; en SQLite, `sqlite_schema` y los `PRAGMA` de lectura): el lector del
asistente rechaza cualquier otra consulta, así que no puede leer filas aunque haya un error.

**Nunca** se envían filas, resultados de consultas, valores de celdas, ni el servidor, usuario o contraseña de
la conexión (tampoco su nombre).

También se envía lo que tú escribes: tus preguntas, el historial de la conversación, tus notas de **Memoria** y,
al usar «Explicar / optimizar» o «Explicar error», el SQL del editor y el mensaje de error del servidor (es tu
texto, no datos de tus tablas). «Explicar / optimizar» añade el resultado de `EXPLAIN` **solo si el SQL es una
única sentencia SELECT**; `EXPLAIN` no ejecuta la consulta y devuelve el plan (índices, tipo de acceso,
estimaciones), no datos. **Ver contexto enviado** (icono del panel) muestra el texto exacto que se mandará.

En bases de datos muy grandes la estructura se limita a unos 60.000 caracteres: van primero la tabla de la
pestaña abierta, las tablas que nombras en la pregunta o en el editor y las relacionadas por claves foráneas; el
resto aparece solo por nombre y el modelo puede pedir su estructura con una herramienta de solo lectura (que
tampoco lee filas).

### Funciones

- **Chat** con el contexto de la conexión y base de datos de la pestaña activa (o de la selección del árbol).
  El nombre de la base de datos del panel es un menú: **Solo <base de datos>** (las demás se nombran y el
  asistente puede pedir su estructura) o **Toda la conexión** (la estructura de todas las bases de datos de
  usuario, con las tablas como `base.tabla`, para preguntas que las cruzan; con más de 40 se incluyen 40 y el
  resto por nombre). En PostgreSQL «Toda la conexión» son todos los esquemas de la base de datos de la pestaña;
  en SQLite, `main` y sus bases de datos adjuntas; en MongoDB, todas las bases de datos (sin valores). La
  elección se recuerda; sin base de datos seleccionada siempre es toda la conexión.
  Respuestas en markdown; cada bloque SQL tiene **Insertar en el editor** y **Copiar**. Enter envía, Mayús+Enter
  añade una línea, **Detener** corta la respuesta.
- **Generar SQL con IA** (barra del editor de consultas): describe lo que necesitas y el SQL se inserta en el
  cursor. **Nunca se ejecuta solo**: al pulsar Ejecutar pasa por las mismas confirmaciones de siempre
  (producción, borrados).
- **Explicar / optimizar** la selección o todo el editor.
- **Explicar error**: en la pestaña Mensajes, cada sentencia que falla tiene ese botón.
- **Memoria**: notas libres por conexión y por base de datos (reglas de negocio, significado de los estados,
  convenciones) que acompañan a la estructura. No escribas datos sensibles.
- **Conversaciones** por conexión: lista, renombrar, eliminar y «Nueva conversación». Se guardan solo en tu
  perfil (`ai/`), nunca se sincronizan.

En conexiones de Producción el asistente funciona igual (solo estructura) y el panel muestra la etiqueta del
entorno.

## Agentes (MCP)

Vortaq incluye un servidor [MCP](https://modelcontextprotocol.io) (Model Context Protocol) para que un agente
de IA use **tus conexiones guardadas** sin que Vortaq le dé nunca su configuración: ni la contraseña, ni el host, el puerto, el usuario, la configuración SSH, la
cadena de conexión o la ruta del archivo SQLite. El agente se refiere a cada conexión por su nombre.

Sirve con **cualquier cliente que admita servidores MCP locales (stdio)** y con el modelo que uses en él (Claude,
GPT, Gemini, GLM, Qwen…): Claude Code, Claude Desktop, Codex, Gemini CLI, Antigravity, Cursor, VS Code, OpenCode,
Cline, Windsurf, Zed y otros. Las apps web (ChatGPT, Gemini o claude.ai en el navegador) solo se conectan a
servidores remotos y no pueden arrancar un programa de tu equipo, así que no pueden usarlo.

El cliente arranca Vortaq él mismo en modo MCP (`Vortaq --mcp`, sin ventana, comunicándose por la entrada y
salida estándar). Funciona con la app abierta o cerrada; los cambios que hagas en la app (activar una conexión,
cambiar su nivel o su entorno, apagar el acceso) se aplican en la siguiente llamada del agente, sin reiniciarlo.
El modo MCP solo **lee** tu perfil: nunca modifica `connections.json`, `settings.json` ni las contraseñas.

### Activarlo

1. **Ajustes › Agentes (MCP)**: activa «Permitir que agentes usen Vortaq (MCP)» (desactivado por defecto).
   Mientras esté apagado, el agente recibe un error que le dice dónde activarlo.
2. En la misma sección, **Conexiones para agentes** lista todas tus conexiones: activa las que quieras ofrecer,
   elige el nivel de cada una y pulsa **Guardar**. También se cambia desde **Editar conexión › Agentes (MCP)**.
   Una conexión sin activar **no existe** para el agente. Importar conexiones nunca las activa.
3. Copia la configuración de tu cliente desde **Ajustes › Agentes (MCP)** (ya lleva la ruta real de tu
   ejecutable) y pégala donde indica.

| Nivel                     | Qué puede hacer el agente                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Solo estructura**       | Bases de datos y esquemas, tablas, vistas y colecciones, columnas, tipos, claves, índices y claves foráneas. Nunca el contenido de las filas.                                                            |
| **Lectura** (por defecto) | Lo anterior y consultas de solo lectura, con límite de filas, en una sesión nueva que no puede escribir.                                                                                                 |
| **Lectura y escritura**   | También modificaciones de datos y DDL (autocommit). **Nunca** en conexiones que piden escribir el nombre para confirmar (Producción y los entornos de **Ajustes › Seguridad**): allí el agente solo lee. |

El nivel se comprueba en cada llamada: si cambias el entorno de una conexión a Producción, el agente deja de
poder escribir en ella en ese mismo momento. Además, el control de producción de Vortaq sigue activo por
debajo: el modo MCP nunca envía la confirmación de producción.

**Privacidad**: Vortaq nunca envía la configuración de la conexión (contraseña, host, puerto, usuario, túnel SSH,
ruta del archivo), tampoco en los errores: la borra de los mensajes, quita la contraseña, el host (salvo
`localhost`), las rutas y la propia cuenta (`CURRENT_USER`, `USER()`) de las respuestas y, en MongoDB, rechaza
`rs.status()`, `db.serverStatus()`, `db.currentOp()`, las etapas que describen el servidor (`$collStats`,
`$indexStats`, `$currentOp`…) y las bases de datos de sistema (`admin`, `local`, `config`). Pero con «Lectura» o
«Lectura y escritura» el agente ejecuta consultas cuyos resultados llegan a **su** proveedor de IA (lo que el agente
ve, lo ve el modelo que use) y muestran todo lo que el usuario de la base de datos puede ver, incluido lo que el
servidor dice de sí mismo (por ejemplo `@@hostname`, `inet_server_addr()` o la lista de procesos). Con «Solo
estructura» no se envía ningún resultado de consultas (en MongoDB, ni documentos, ni valores de `enum`/`pattern`
del validador, ni las etapas de las vistas, ni los filtros de los índices parciales, y las claves que parecen datos
—correos, identificadores, fechas, mapas con muchas claves— se agrupan como `<clave>`). El asistente de IA integrado
no cambia: sigue enviando solo la estructura.

### Configurar el cliente

Ajustes muestra el comando con la ruta exacta de tu instalación. Rutas habituales del ejecutable:

| Sistema | Ejecutable                                                                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | `/Applications/Vortaq.app/Contents/MacOS/Vortaq`                                                                                              |
| Windows | `C:\Users\<tú>\AppData\Local\Programs\Vortaq\Vortaq.exe` (instalador; si actualizaste desde ElectronDB, `...\Programs\ElectronDB\Vortaq.exe`) |
| Linux   | El archivo `.AppImage` donde lo guardaste, o `/opt/Vortaq/vortaq` con el paquete `.deb`                                                       |

- **Claude Code** (terminal; añade `--scope user` antes de `vortaq` para todos tus proyectos):

  ```bash
  claude mcp add vortaq -- "/Applications/Vortaq.app/Contents/MacOS/Vortaq" --mcp
  ```

- **Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` en macOS,
  `%APPDATA%\Claude\claude_desktop_config.json` en Windows; o Ajustes › Desarrollador › Editar configuración):

  ```json
  {
    "mcpServers": {
      "vortaq": {
        "command": "C:\\Users\\<tú>\\AppData\\Local\\Programs\\Vortaq\\Vortaq.exe",
        "args": ["--mcp"]
      }
    }
  }
  ```

- **Cursor** (`.cursor/mcp.json` del proyecto o `~/.cursor/mcp.json`):

  ```json
  {
    "mcpServers": {
      "vortaq": {
        "type": "stdio",
        "command": "/home/<tú>/Apps/Vortaq-2.1.0-x86_64.AppImage",
        "args": ["--mcp"]
      }
    }
  }
  ```

- **VS Code** (`.vscode/mcp.json` del proyecto):

  ```json
  {
    "servers": {
      "vortaq": {
        "type": "stdio",
        "command": "/Applications/Vortaq.app/Contents/MacOS/Vortaq",
        "args": ["--mcp"]
      }
    }
  }
  ```

- **Codex** (`~/.codex/config.toml`, en Windows `%USERPROFILE%\.codex\config.toml`; o `.codex/config.toml` de un
  proyecto de confianza). `tool_timeout_sec` deja que una consulta use los 120 s que Vortaq permite (Codex corta a
  los 60 s por defecto):

  ```toml
  [mcp_servers.vortaq]
  command = "/Applications/Vortaq.app/Contents/MacOS/Vortaq"
  args = ["--mcp"]
  tool_timeout_sec = 130
  ```

- **Gemini CLI** (`~/.gemini/settings.json` o `.gemini/settings.json` del proyecto) y **Antigravity**
  (`~/.gemini/config/mcp_config.json`, para la CLI y el editor, o `.agents/mcp_config.json` del proyecto): el
  mismo JSON que Claude Desktop.

- **OpenCode** (`opencode.json` del proyecto o `~/.config/opencode/opencode.json`):

  ```json
  {
    "mcp": {
      "vortaq": {
        "type": "local",
        "command": ["/Applications/Vortaq.app/Contents/MacOS/Vortaq", "--mcp"]
      }
    }
  }
  ```

- **Otro cliente**: añade un servidor MCP local (stdio) con el ejecutable como comando y `--mcp` como argumento.
  Muchos clientes aceptan el mismo JSON que Claude Desktop.

En los archivos JSON escribe la ruta completa (las variables como `%LOCALAPPDATA%` no se expanden) y, en
Windows, con las barras invertidas dobles. En Linux, si la AppImage falla al arrancar con un error de «SUID
sandbox», añade `"--no-sandbox"` a `args`. Desde la carpeta del código el comando es el Electron de
`node_modules` con la carpeta del proyecto y `--mcp` (Ajustes lo muestra; necesita `npm run build`).

### Herramientas y límites

| Herramienta        | Nivel               | Qué hace                                                                                                                                                                                     |
| ------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_connections` | —                   | Conexiones activadas: id, nombre, motor, entorno y nivel. Nada de host, puerto, usuario, ruta ni bases de datos.                                                                             |
| `list_databases`   | Solo estructura     | Bases de datos de usuario (PostgreSQL con sus esquemas; SQLite `main` y adjuntas); las de sistema con `include_system`.                                                                      |
| `list_tables`      | Solo estructura     | Tablas y vistas (MongoDB: colecciones y vistas).                                                                                                                                             |
| `describe_table`   | Solo estructura     | Columnas (tipo, nulos, valor por defecto, clave), índices y claves foráneas; MongoDB: índices y rutas de campos muestreadas con su tipo, sin valores.                                        |
| `run_query`        | Lectura             | Una sola sentencia de lectura (SELECT, WITH, SHOW…) en una sesión nueva de solo lectura; MongoDB: órdenes de lectura del shell (`find`, `aggregate` sin `$out`/`$merge`, `countDocuments`…). |
| `explain_query`    | Lectura             | Plan de un SELECT (`EXPLAIN` sin `ANALYZE`; SQLite `EXPLAIN QUERY PLAN`). La consulta no se ejecuta.                                                                                         |
| `execute_sql`      | Lectura y escritura | Scripts con varias sentencias (escrituras y DDL) en autocommit, parando en el primer error; MongoDB: órdenes de escritura del shell.                                                         |

- `max_rows`: 100 por defecto, 1000 como máximo; `truncated: true` indica que hay más filas.
- `timeout_seconds`: 30 por defecto, 120 como máximo; al superarlo la consulta **se cancela en el servidor**
  (`KILL QUERY`, `pg_cancel_backend`, `killOp` o el proceso de SQLite).
- Los textos largos se recortan a 2.000 caracteres (con una marca) y cada respuesta a unos 200 KB.
- En SQLite, `execute_sql` rechaza `ATTACH`, `DETACH` y `VACUUM`: abrirían, copiarían o escribirían otros
  archivos (las bases de datos adjuntas se configuran en la conexión).
- Valores en JSON: enteros grandes y decimales como texto exacto, binarios como `{"type":"binary","hex":…}`,
  documentos de MongoDB en Extended JSON canónico.
- Cada llamada deja una línea en `logs/mcp.log` del perfil (hora, herramienta, conexión, nivel, resultado,
  duración y filas), nunca el SQL ni los valores.

## Extensión para editores (VS Code, Cursor, VSCodium, Windsurf)

Vortaq también existe como extensión para VS Code y los editores basados en él (Cursor, VSCodium,
Windsurf). Usa el mismo núcleo que la aplicación de escritorio (los mismos drivers, el mismo análisis de SQL y
la misma protección de producción) y trabaja con los cinco motores: MySQL, MariaDB, PostgreSQL, SQLite y
MongoDB. Su código está en [`extensions/vscode`](extensions/vscode) y tiene su propia numeración de versiones
(empieza en la 0.1.0).

<p align="center">
  <img src="docs/images/extension-vscode.png" alt="La extensión Vortaq en VS Code: árbol de conexiones, archivo .sql y resultados editables" width="900" />
</p>

Qué hace (versión 0.2.0):

- **Conexiones** en la barra de actividad (icono de Vortaq): bases de datos, esquemas, tablas, vistas y
  colecciones, con el color, el entorno y el candado de producción de cada conexión. Se crean y editan con el
  mismo formulario que en escritorio (SSH, SSL/TLS, entorno, «Sin contraseña», «Probar conexión»).
- **SQL desde tus archivos `.sql`**: cada documento elige su conexión y base de datos (barra de estado o la línea
  de encima del documento). `Cmd+Enter` / `Ctrl+Enter` ejecuta la selección, la sentencia del cursor o el
  documento; `Cmd+Shift+Enter` / `Ctrl+Shift+Enter`, todo; **Detener** cancela.
- **Resultados** en un panel junto al editor: varias pestañas, Mensajes, filas y tiempos, y **edición** de los
  resultados de una tabla con clave (Aplicar / Descartar, `NULL`).
- **Copiar y exportar**, igual que en escritorio ([Copiar y exportar resultados](#copiar-y-exportar-resultados)):
  selección de celdas, filas o columnas; **Copiar** / **Copiar como** CSV, JSON, `INSERT`, `UPDATE`, lista para
  `IN` o Markdown; **Exportar** a CSV, Excel (`.xlsx`), JSON, SQL, Markdown, HTML o TXT, de la selección, de las
  filas cargadas o del **resultado completo** (otra vez en una sesión de solo lectura, sin límite de filas; en «Ver
  datos», toda la tabla). El archivo se elige con el diálogo de guardar del editor, el progreso aparece en el panel
  y en una notificación con **Cancelar**, y al terminar puedes **Abrir** el archivo o **Mostrarlo en la carpeta**.
- **Ver datos** de tablas y vistas y **Ver documentos** de MongoDB (de solo lectura en esta versión).
- **Producción**: cualquier escritura pide escribir el nombre de la conexión, igual que en escritorio.
- Los paneles siguen el **tema del editor** (claro, oscuro y alto contraste).

**Importar desde la aplicación de escritorio.** El botón «Importar de Vortaq» de la extensión lee las conexiones
de la aplicación de escritorio instalada en el mismo equipo y te deja elegir cuáles traer. **Las contraseñas no
se importan** (la aplicación de escritorio las guarda cifradas con su propia clave): las escribes una vez al
conectar y la extensión las guarda cifradas en el almacén seguro del editor. Cada aplicación conserva sus
propias conexiones y contraseñas.

### Instalar la extensión

Requiere **VS Code 1.123 o posterior** (o un editor basado en esa versión o en una más reciente).

- **Desde el archivo `.vsix`**:
  1. Descarga
     [**`vortaq-0.2.0.vsix`**](https://github.com/Y0rshB3/Vortaq/releases/download/vscode-v0.2.0/vortaq-0.2.0.vsix)
     (versión [`vscode-v0.2.0`](https://github.com/Y0rshB3/Vortaq/releases/tag/vscode-v0.2.0), con su
     `SHA256SUMS.txt`).
  2. En el editor abre **Extensiones**, el menú **…** y **Instalar desde VSIX…** (en inglés,
     _Install from VSIX…_), y elige el archivo. Funciona igual en VS Code, Cursor, VSCodium y Windsurf.

  O desde la terminal, en la carpeta donde lo descargaste:

  ```bash
  code --install-extension vortaq-0.2.0.vsix       # VS Code
  cursor --install-extension vortaq-0.2.0.vsix     # Cursor
  codium --install-extension vortaq-0.2.0.vsix     # VSCodium
  windsurf --install-extension vortaq-0.2.0.vsix   # Windsurf
  ```

- **Desde el Marketplace de VS Code y Open VSX** (próximamente): cuando esté publicada se podrá instalar
  buscando «Vortaq» en la vista Extensiones. VSCodium, Cursor y Windsurf usan Open VSX.

Para generarla tú mismo desde el código: `npm run ext:install` (una vez) y `npm run ext:package`, que deja
`extensions/vscode/vortaq-0.2.0.vsix`.

**SQLite** usa el `node:sqlite` del propio editor (Node 24.10 o posterior), sin módulos nativos. Funciona en VS
Code 1.123+ y en las versiones actuales de Cursor, VSCodium y Windsurf en el escritorio, pero **no en el
servidor remoto de Cursor** (SSH/WSL), que usa un Node más antiguo: ahí SQLite no aparece en el formulario y
sus conexiones explican por qué. El resto de motores funcionan igual en remoto.

## Dónde se guardan los datos

El **perfil** es una carpeta por usuario que se llama como la app:

| Sistema | Carpeta del perfil                                                           |
| ------- | ---------------------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Vortaq`                                       |
| Windows | `%APPDATA%\Vortaq` (normalmente `C:\Users\<usuario>\AppData\Roaming\Vortaq`) |
| Linux   | `~/.config/Vortaq` (o `$XDG_CONFIG_HOME/Vortaq`)                             |

Si usaste la app cuando se llamaba **ElectronDB** (o **Navidog**), tu perfil anterior está en la misma ruta con
la carpeta `ElectronDB` (o `Navidog`). Vortaq lo copia solo en el primer arranque: ver
[Si venías de ElectronDB o de Navidog](#si-venías-de-electrondb-o-de-navidog).

| Archivo o carpeta      | Contenido                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `connections.json`     | Conexiones (sin contraseñas)                                                       |
| `credentials.json`     | Contraseñas cifradas con el almacén del sistema                                    |
| `jobs.json`            | Trabajos de automatización                                                         |
| `job-runs.json`        | Historial de ejecuciones                                                           |
| `settings.json`        | Preferencias (carpeta de Navicat, carpeta de copias, tema, límite de filas)        |
| `logs/`                | Registro de la app (`vortaq.log`) y de las ejecuciones con launchd                 |
| `backups/`             | Copias `.nb3` creadas por la app (carpeta por defecto)                             |
| `notices.json`         | Avisos de arranque que ya cerraste                                                 |
| `tour.json`            | Si ya viste (o saltaste) el tour de bienvenida                                     |
| `filter-profiles.json` | Perfiles de filtro de la vista de datos (solo la definición del filtro)            |
| `ai-providers.json`    | Proveedores del asistente de IA (sin claves; las claves van en `credentials.json`) |
| `ai-memory.json`       | Notas de «Memoria» del asistente por conexión y base de datos                      |
| `ai/`                  | Conversaciones del asistente, un archivo por conexión                              |

### Copiar o mover el perfil

1. Cierra la app.
2. Copia la carpeta del perfil completa (o al menos `connections.json`, `jobs.json`, `settings.json` y
   `backups/`).
3. En el equipo nuevo, **no copies `credentials.json`**: está cifrado con una clave de ese usuario y equipo y no
   se puede descifrar en otro. Escribe de nuevo las contraseñas.
4. Revisa en cada conexión las rutas que dependen del equipo: carpeta de copias, clave SSH y certificados SSL.

Para probar sin tocar tu perfil, arranca con otro (ver [Variables de entorno](#variables-de-entorno)).

### Si venías de ElectronDB o de Navidog

La app se llamaba **ElectronDB** (y antes **Navidog**). La primera vez que arranca como Vortaq, si la carpeta
nueva todavía no tiene conexiones, **copia** (no mueve) el perfil anterior más reciente: el de ElectronDB y, si
no existe o está vacío, el de Navidog. Al terminar avisa una vez de que tus datos se trasladaron y de dónde.

- Se copian los `*.json` (conexiones, trabajos, historial, preferencias, contraseñas y claves de IA cifradas,
  perfiles de filtro, proveedores y memoria del asistente, `tour.json`, `updates.json`, `notices.json`), las
  conversaciones del asistente (`ai/`), `logs/` (el registro antiguo se conserva ahí) y las consultas guardadas
  (`Local Storage`). En Windows también `Local State`, donde está la clave de cifrado de las contraseñas.
- **Las copias `.nb3` no se copian** (pueden ocupar muchos GB): Vortaq sigue usando la carpeta `backups` del
  perfil anterior donde está, como carpeta de copias en **Ajustes** y en cada conexión que la usaba.
- Las demás rutas que apuntaban dentro de la carpeta antigua (por ejemplo, certificados guardados ahí) pasan a
  apuntar a la nueva.
- Nunca sobrescribe lo que ya exista en la carpeta nueva y nunca borra la antigua. Deja un
  `migrated-from-electrondb.json` (o `migrated-from-navidog.json`) con lo copiado (y lo que no se pudo copiar, en
  `failed`) y lo apunta en el registro.
- Con un perfil alternativo (`VORTAQ_USER_DATA`) no se copia nada.

**No borres la carpeta antigua** mientras Vortaq use su `backups/` ni mientras haya contraseñas pendientes
(ver abajo). Para dejar de depender de ella: cierra la app, mueve la carpeta `backups` a otro sitio, ponla en
**Ajustes** y en la carpeta de copias de cada conexión, y después borra la carpeta antigua.

**Contraseñas y claves de IA.** El cifrado del sistema va ligado al nombre de la app, así que hay que volver a
cifrarlas:

- **macOS**: la clave antigua está en el llavero, en el elemento «ElectronDB Safe Storage» (o «Navidog Safe
  Storage»). Vortaq la lee una sola vez y macOS pregunta si `security` puede acceder a ella: elige
  **Permitir**. Los valores se vuelven a cifrar con la clave nueva («Vortaq Safe Storage»). Si algún valor
  viene todavía de Navidog, se pide también esa clave, solo para ese valor. Si deniegas el acceso, no respondes
  al aviso o el llavero está bloqueado, esos valores quedan pendientes y se vuelve a intentar en los siguientes
  arranques (3 intentos en total). Si el elemento no existe, no se reintenta.
- **Windows**: se siguen leyendo con la clave copiada en `Local State` (DPAPI, ligada a tu usuario de Windows,
  no al nombre de la app).
- **Linux**: con GNOME Keyring o KWallet la clave va ligada al nombre de la app, así que las que no se puedan
  leer con la clave nueva se piden de nuevo. Sin llavero (solo base64) se conservan tal cual.

Si alguna no se puede recuperar, la app avisa una vez al arrancar: «Vuelve a escribir la contraseña de: …»
(una clave de IA aparece como «clave de IA «nombre del proveedor»»). Edita esas conexiones o el proveedor en
**Ajustes › IA** y guárdala de nuevo.

Para **volver a intentarlo más tarde** (por ejemplo, si denegaste el acceso las tres veces): cierra la app, abre
`migrated-from-electrondb.json` (o `migrated-from-navidog.json`) en la carpeta del perfil y cambia
`"secrets": "done"` por `"secrets": "pending"`. En el siguiente arranque Vortaq vuelve a leer los valores que le
falten del `credentials.json` de la carpeta antigua (tiene que seguir existiendo) y conserva los que ya hayas
escrito de nuevo.

**Trabajos con "Ejecutar aunque la app esté cerrada"** (macOS): al arrancar, los LaunchAgents antiguos
(`dev.y0rshb3.electrondb.job.*` y `dev.y0rshb3.navidog.job.*`) de los trabajos que ya están en Vortaq se
eliminan y se crean otra vez para Vortaq (`dev.y0rshb3.vortaq.job.*`). Los de trabajos que Vortaq no tiene (por
ejemplo, si no se copió el perfil porque la carpeta nueva ya tenía conexiones) **no se tocan**: siguen lanzando
la versión anterior, dejan de funcionar si la desinstalas, y la app avisa una vez con sus nombres. Crea esos
trabajos en **Automatización** y borra después los archivos antiguos de `~/Library/LaunchAgents`. No vuelvas a
abrir la versión anterior: volvería a crear sus agentes y esos trabajos se ejecutarían dos veces.

**La app anterior.** En macOS, `Vortaq.app` se instala junto a `ElectronDB.app` (otro nombre): cuando
compruebes que todo está en Vortaq, borra `ElectronDB.app` de **Aplicaciones**. En Windows el instalador de
Vortaq sustituye la instalación de ElectronDB (también desde la actualización integrada): cambia los accesos
directos por los de Vortaq y conserva la carpeta de instalación que ya tenía (`%LOCALAPPDATA%\Programs\ElectronDB`
en un equipo actualizado; `...\Programs\Vortaq` en uno nuevo). En Linux, el `.deb` de Vortaq sustituye al
paquete `electrondb`, y la AppImage actualizada aparece con el nombre nuevo en la misma carpeta.

## Actualizaciones

Vortaq comprueba si hay una versión nueva en las
[versiones publicadas en GitHub](https://github.com/Y0rshB3/Vortaq/releases). Solo hace una consulta
anónima a la API pública de GitHub (sin cuenta ni datos tuyos). **No descarga nada hasta que pulsas
Descargar y actualizar** (salvo que actives **Descargar actualizaciones automáticamente**) y nunca instala sin
que lo pidas o cierres la app. Cómo se instala depende del sistema: ver
[Si instalaste la app](#si-instalaste-la-app-instalador-de-github).

- **Al iniciar**: unos segundos después de abrir la app, si hay una versión nueva aparece la ventana **Hay una
  nueva actualización** con lo más destacado (como mucho 5 puntos: la sección «Destacado» de la versión o, si no
  la tiene, los títulos de «Novedades») y los botones **Descargar y actualizar** (en Mac **Descargar
  instalador**; con el `.exe` portable o el `.deb`, **Descargar**; desde el código, **Cómo actualizar**, que
  muestra los comandos con **Copiar comandos**), **Ver todas las novedades**, **Más tarde** y **Omitir esta versión**. Sale
  como mucho una vez por arranque y espera a que se cierre cualquier otra ventana. **Más tarde** la oculta hasta
  un arranque pasadas 6 horas. Se consulta GitHub como mucho una vez cada 6 horas; si no hay conexión, no avisa
  de nada. Se desactiva en **Ajustes → Actualizaciones → Buscar actualizaciones al iniciar**.
- **A mano**: **Más → Buscar actualizaciones…** (o el menú de la app en macOS) siempre consulta GitHub y muestra
  la versión instalada, la última publicada, sus notas y cómo actualizar. La versión instalada también aparece en
  **Ajustes**.
- **Omitir esta versión** deja de avisar de esa versión al iniciar; la siguiente sí se avisa.
- **Después de actualizar**: el primer arranque de una versión nueva muestra una vez **Vortaq se actualizó a
  x.y.z** con lo importante de cada versión desde la que tenías (por ejemplo, de 0.1.2 a 0.1.4 verás la 0.1.3 y
  la 0.1.4). La lista viene con la app (`src/shared/whatsNew.ts`), así que funciona sin Internet. **Ver todas las
  novedades en GitHub** abre la página de la versión. En un perfil nuevo o al volver a una versión anterior no
  sale nada. La última versión vista se guarda en `updates.json` del perfil.
- **Mostrarme cómo**: si alguna de esas versiones trae una guía, la ventana de novedades muestra este botón. La
  cierra y resalta en la pantalla dónde están las novedades, paso a paso (lo que vive dentro de un diálogo se
  explica con texto).

### Si instalaste la app (instalador de GitHub)

Tus conexiones, trabajos y ajustes están en el perfil y no se tocan al actualizar ni al reinstalar.

**Desde ElectronDB.** ElectronDB terminó en la 0.1.9; esta app es **Vortaq 2.0.0**, publicada en el mismo
repositorio de GitHub (ahora `Y0rshB3/Vortaq`). Una instalación de ElectronDB 0.1.9 (Windows o AppImage) la
instala con su actualización integrada y queda Vortaq en su lugar (el instalador conserva la identidad de la app,
así que actualiza esa instalación en vez de crear otra); en el primer arranque Vortaq copia tu perfil (ver
[Si venías de ElectronDB o de Navidog](#si-venías-de-electrondb-o-de-navidog)). En Mac descarga el `.dmg` de
Vortaq: arrastra Vortaq a Aplicaciones y, cuando lo compruebes, borra ElectronDB.

**Windows (instalador `-setup.exe`) y Linux (AppImage)**: actualización integrada.

1. **Descargar y actualizar** descarga la versión nueva dentro de la app. La ventana muestra el progreso
   (descargado / total y velocidad) y un botón **Cancelar**.
2. Antes de usar el archivo se comprueba su suma **sha512** con la publicada en la versión de GitHub
   (`latest.yml` / `latest-linux.yml`). Solo se descarga de las versiones de este repositorio; nunca se pasa a
   una versión anterior ni a una preliminar.
3. Cuando termina: **Reiniciar y actualizar** cierra la app, instala sin preguntas y abre la versión nueva. Con
   **Más tarde** se instala sola la próxima vez que cierres Vortaq. Si hay una restauración en curso, la app
   no se reinicia hasta que termine.
4. Si algo falla verás el motivo en español, **Reintentar** y **Descargar manualmente** (abre el instalador en
   el navegador).

Las versiones publicadas antes de la 0.1.9 no traen `latest.yml`: desde ellas hay que actualizar una vez a mano
(descarga el instalador de la 0.1.9 o posterior). En **Ajustes → Actualizaciones → Descargar actualizaciones
automáticamente** (desactivado por defecto) la descarga empieza sola al encontrar una versión nueva que no
hayas omitido ni pospuesto; instalarla sigue siendo decisión tuya.

**macOS**: **Descargar instalador** guarda en **Descargas** el `.dmg` de tu Mac (Apple Silicon o Intel),
comprueba su suma **SHA-256** con `SHA256SUMS.txt` de la versión (si la versión no la publica, no lo abre y te
ofrece **Descargar manualmente**) y lo abre. Después cierra Vortaq y **arrastra Vortaq a Aplicaciones y
reemplaza** la anterior. En Mac la app no puede reemplazarse sola: macOS solo permite la actualización
automática (Squirrel.Mac) en apps firmadas con un certificado _Developer ID_ de Apple, y Vortaq todavía no
lo tiene.

**`.exe` portable y `.deb`**: **Descargar** abre el archivo en el navegador; cierra Vortaq e instálalo como
la primera vez (`sudo apt install ./vortaq_*_amd64.deb`). Ver
[Aplicación sin firmar](#aplicación-sin-firmar-primer-arranque).

### Windows: reparar una instalación rota

Si al actualizar el instalador dijo **"Failed to uninstall old application files"** (o se cerró a medias) y
ahora no puedes desinstalar Vortaq desde **Configuración → Aplicaciones**, la instalación anterior quedó
a medio borrar: la entrada de "Aplicaciones" sigue en el Registro pero su desinstalador ya no funciona.

**Primero prueba lo sencillo**: cierra Vortaq y ejecuta el instalador de la 0.1.9 o posterior. Desde esa
versión el instalador cierra la app si está abierta, ignora un desinstalador antiguo roto e instala encima,
reparando la entrada de "Aplicaciones".

Si aun así falla, límpialo a mano. **Tus datos no se tocan**: están en `%APPDATA%\Vortaq` (y la copia
anterior en `%APPDATA%\ElectronDB`), carpetas distintas que no debes borrar. En PowerShell (sin administrador):

```powershell
# 0. (Opcional) copia de seguridad de tus datos
Copy-Item -Recurse "$env:APPDATA\Vortaq" "$env:USERPROFILE\Vortaq-copia-perfil"

# 1. Cierra Vortaq (o ElectronDB) y cualquier proceso suyo que haya quedado
Get-Process Vortaq, ElectronDB -ErrorAction SilentlyContinue | Stop-Process -Force

# 2. Mira dónde estaba instalada (%LOCALAPPDATA%\Programs\Vortaq, o ...\Programs\ElectronDB si
#    actualizaste desde ElectronDB)
Get-ItemProperty 'HKCU:\Software\ed60cf51-f5c8-5d88-9777-022dc431ddb4' -ErrorAction SilentlyContinue |
  Select-Object InstallLocation

# 3. Borra la carpeta del PROGRAMA (usa la ruta del paso 2 si es otra)
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\Vortaq", "$env:LOCALAPPDATA\Programs\ElectronDB" -ErrorAction SilentlyContinue

# 4. Borra la entrada de "Aplicaciones" y la del instalador
Remove-Item -Recurse 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ed60cf51-f5c8-5d88-9777-022dc431ddb4' -ErrorAction SilentlyContinue
Remove-Item -Recurse 'HKCU:\Software\ed60cf51-f5c8-5d88-9777-022dc431ddb4' -ErrorAction SilentlyContinue

# 5. Accesos directos antiguos y caché de descargas de la actualización
foreach ($name in 'Vortaq', 'ElectronDB') {
  Remove-Item "$([Environment]::GetFolderPath('Desktop'))\$name.lnk",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\$name.lnk" -ErrorAction SilentlyContinue
}
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\vortaq-updater", "$env:LOCALAPPDATA\electrondb-updater" -ErrorAction SilentlyContinue
```

Después ejecuta el instalador nuevo (`Vortaq-<versión>-x64-setup.exe`): al abrir la app verás tus
conexiones, trabajos y ajustes.

- `ed60cf51-f5c8-5d88-9777-022dc431ddb4` es el identificador fijo de la app en Windows (electron-builder lo
  calcula a partir del `appId` `dev.y0rshb3.electrondb`, que se conserva desde ElectronDB a propósito); es el
  mismo en todas las versiones, también en Vortaq.
- Si la habías instalado **"para todos los usuarios"** (los instaladores hasta la 0.1.8 lo permitían), la
  carpeta es `C:\Program Files\ElectronDB` y las dos claves están en `HKLM:` en vez de `HKCU:`: repite los
  pasos 3 y 4 con esas rutas en un PowerShell **como administrador**. Desde la 0.1.9 el instalador es solo para
  tu usuario (sin permisos de administrador, en `%LOCALAPPDATA%\Programs\Vortaq`) y avisa si encuentra
  una copia "para todos los usuarios".

### Si la usas desde la carpeta del código (`npm run dev`)

El aviso muestra **Cómo actualizar** con los comandos exactos para tu carpeta y un botón **Copiar comandos**.
Cierra la app y ejecuta:

```sh
cd ElectronDB      # tu carpeta (el repositorio aún se llama así)
git pull
npm install        # solo hace algo si cambiaron las dependencias
npm run dev        # o vuelve a generar el instalador: npm run dist
```

Si estás en otra rama distinta de `main`, el diálogo te lo indica: `git pull` trae los cambios de esa rama. El
perfil no se toca al actualizar.

## Solución de problemas

| Síntoma                                                                                                 | Solución                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci` o la primera ejecución (`Downloading Electron binary...`) falla o se queda colgada             | Normalmente es un proxy o un firewall. Ver [Descargas detrás de un proxy](#descargas-detrás-de-un-proxy).                                                                                                                                                                                                      |
| `Electron failed to install correctly`                                                                  | La descarga de Electron se cortó. Borra la carpeta `node_modules/electron`, ejecuta `npm ci` y vuelve a lanzar `npm run dev`.                                                                                                                                                                                  |
| Errores de `node-gyp` / `cpu-features` durante `npm ci`                                                 | Se pueden ignorar si `npm ci` termina. Es una dependencia opcional.                                                                                                                                                                                                                                            |
| `Failed to fetch dynamically imported module` o pantalla en blanco en `npm run dev`                     | Cierra `npm run dev` con `Ctrl+C` y vuelve a lanzarlo. Pasa tras cambiar de rama o actualizar dependencias con el servidor de desarrollo abierto.                                                                                                                                                              |
| El puerto 5173 ya está en uso                                                                           | Hay otro `npm run dev` abierto (o cualquier proyecto Vite). Ciérralo; si no, Vite usará el siguiente puerto libre.                                                                                                                                                                                             |
| `No hay contraseña guardada para la conexión …`                                                         | Edita la conexión, escribe la contraseña y marca **Guardar contraseña**. Ocurre también tras importar desde Navicat o mover el perfil.                                                                                                                                                                         |
| Error al descifrar contraseñas tras copiar el perfil                                                    | Cierra la app, borra `credentials.json` del perfil y vuelve a escribir las contraseñas.                                                                                                                                                                                                                        |
| Tras pasar de ElectronDB (o Navidog) a Vortaq pide contraseñas                                          | No se pudo leer la clave antigua (acceso al llavero denegado o Linux). En macOS se reintenta en los dos arranques siguientes (elige **Permitir**). Si no, escribe de nuevo las contraseñas del aviso o fuerza otro intento: ver [Si venías de ElectronDB o de Navidog](#si-venías-de-electrondb-o-de-navidog). |
| `Access denied for user …` (`ER_ACCESS_DENIED_ERROR`)                                                   | Usuario o contraseña incorrectos, o el usuario no tiene permiso desde tu IP (`'usuario'@'%'` frente a `'usuario'@'localhost'`).                                                                                                                                                                                |
| Error con `caching_sha2_password` o `RSA public key`                                                    | MySQL 8 usa `caching_sha2_password`. Activa SSL en la conexión o conéctate una vez con otro cliente para que el servidor cachee la contraseña. Como último recurso, el administrador puede cambiar el usuario a `mysql_native_password` (eliminado en MySQL 9).                                                |
| `ECONNREFUSED` / `ETIMEDOUT`                                                                            | Comprueba host, puerto y firewall. Si el servidor solo es accesible por SSH, activa el túnel SSH.                                                                                                                                                                                                              |
| `No se pudo leer la clave privada SSH …`                                                                | Revisa la ruta. En macOS/Linux la clave debe pertenecer a tu usuario y tener permisos `600`: `chmod 600 ~/.ssh/id_ed25519`. En Windows usa una ruta completa (`C:\Users\<usuario>\.ssh\id_ed25519`).                                                                                                           |
| `La clave privada SSH … está cifrada y no hay frase de contraseña guardada`                             | Escribe la frase de contraseña de la clave en el campo **Contraseña SSH** y guárdala.                                                                                                                                                                                                                          |
| Linux: `The SUID sandbox helper binary was found, but is not configured correctly`                      | En Ubuntu 23.10+ ocurre por AppArmor. Desde el código: `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`. Con la AppImage: `./Vortaq-*.AppImage --no-sandbox`.                                                                     |
| macOS: "está dañada y no se puede abrir", "no se ha podido verificar" o "desarrollador no identificado" | Ejecuta `xattr -dr com.apple.quarantine "/Applications/Vortaq.app"`. Ver [Aplicación sin firmar](#aplicación-sin-firmar-primer-arranque).                                                                                                                                                                      |
| macOS: "no se puede usar con esta versión de macOS"                                                     | La app necesita macOS 13 (Ventura) o posterior.                                                                                                                                                                                                                                                                |
| `npm warn EBADENGINE` durante `npm ci`                                                                  | Tu Node es demasiado antiguo. Instala Node 24 como en [Requisitos](#requisitos) y repite `npm ci`.                                                                                                                                                                                                             |
| Un trabajo programado no se ejecuta en Windows/Linux                                                    | El programador interno solo funciona con la app abierta: déjala abierta o usa el Programador de tareas / cron con `--run-job=<id>` (ver [Automatización](#automatización)).                                                                                                                                    |
| Windows: "Failed to uninstall old application files" o no se puede desinstalar Vortaq                   | Ver [Windows: reparar una instalación rota](#windows-reparar-una-instalación-rota). Tus datos (`%APPDATA%\Vortaq`) no se tocan.                                                                                                                                                                                |

### Descargas detrás de un proxy

`npm ci` descarga los paquetes de npm; Electron se descarga aparte la primera vez que arranca la app
(`npm run dev` o `npx electron .`) y **no usa** la configuración de proxy de npm.

```sh
# macOS / Linux
npm config set proxy http://proxy.ejemplo:8080
npm config set https-proxy http://proxy.ejemplo:8080
npm ci
ELECTRON_GET_USE_PROXY=1 HTTPS_PROXY=http://proxy.ejemplo:8080 npm run dev
```

```powershell
# Windows (PowerShell)
npm config set proxy http://proxy.ejemplo:8080
npm config set https-proxy http://proxy.ejemplo:8080
npm ci
$env:ELECTRON_GET_USE_PROXY = '1'; $env:HTTPS_PROXY = 'http://proxy.ejemplo:8080'
npm run dev
```

Si el sitio de descargas de Electron (GitHub) está bloqueado, usa un espejo al arrancar por primera vez:
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dev` (en PowerShell,
`$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'` y luego `npm run dev`). Al generar
instaladores, `npm run dist` usa las mismas variables y además `ELECTRON_BUILDER_BINARIES_MIRROR` para las
herramientas de `electron-builder`.

### Registro

Para más detalle, abre **Más → Registro** o el archivo `logs/vortaq.log` del perfil. Con `VORTAQ_DEBUG=1`
el registro es más detallado y se copia también en la terminal.

## Desarrollo

| Comando                             | Qué hace                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm run dev`                       | App en modo desarrollo con recarga en caliente                                                        |
| `npm run check`                     | Lint + typecheck + tests unitarios (debe pasar antes de entregar un cambio)                           |
| `npm test`                          | Tests unitarios (Vitest, proyectos `node` y `web`)                                                    |
| `npm run test:watch`                | Tests en modo observación                                                                             |
| `npm run test:integration`          | Tests contra un MySQL real (se omiten sin `VORTAQ_TEST_MYSQL_URL`)                                    |
| `npm run test:integration:required` | Igual, contra MySQL 8.4 **y** 5.7, MariaDB 11, PostgreSQL 17 y MongoDB 8.2; falla si falta alguna URL |
| `npm run lint`                      | ESLint                                                                                                |
| `npm run format`                    | Prettier                                                                                              |
| `npm run build`                     | Compila a `out/`                                                                                      |
| `npm run test:mcp-e2e`              | Tras `npm run build`: `Vortaq --mcp` con un perfil desechable (`--with-app`: con la app abierta)      |
| `npm run dist[:mac/:win/:linux]`    | Instaladores en `release/`                                                                            |
| `npm run screenshots`               | Capturas de todas las pantallas con un perfil y un MySQL desechables                                  |

### Tests de integración

Necesitan servidores desechables: MySQL 8.4 en el puerto 33306, MySQL 5.7 en el 33357, MariaDB 11 en el
33311 y PostgreSQL 17 en el 55432, más un servidor SSH de prueba en el 52222 para el túnel de PostgreSQL
(siempre en `127.0.0.1`, nunca en 3306/3307). `tests/docker-compose.yml` los declara (imágenes nativas arm64
salvo MySQL 5.7); los comandos valen igual en macOS, Linux y PowerShell:

```sh
docker compose -f tests/docker-compose.yml up -d --wait
# Si ya tienes el contenedor 8.4 antiguo (electrondb-test-mysql o navidog-test-mysql) en el 33306,
# arranca solo el 5.7:
docker compose -f tests/docker-compose.yml up -d --wait mysql57
# Para borrarlos (contenedores y datos):
docker compose -f tests/docker-compose.yml down -v
```

`mysql:5.7` solo existe para amd64: en Apple Silicon corre emulado y el primer arranque tarda más.
Sin Compose, el equivalente es:

```sh
docker run -d --name vortaq-test-mysql -e MYSQL_ROOT_PASSWORD=navidog -e MYSQL_DATABASE=navidog_test -p 127.0.0.1:33306:3306 mysql:8.4.7
docker run -d --name vortaq-test-mysql57 --platform linux/amd64 -e MYSQL_ROOT_PASSWORD=navidog -e MYSQL_DATABASE=navidog_test -p 127.0.0.1:33357:3306 mysql:5.7
# Espera a que cada uno termine de arrancar hasta ver "mysqld is alive":
docker exec vortaq-test-mysql mysqladmin ping -h127.0.0.1 -uroot -pnavidog --wait=30
docker exec vortaq-test-mysql57 mysqladmin ping -h127.0.0.1 -uroot -pnavidog --wait=60
```

MongoDB (8.2: `mongo:8` 8.3 no arranca en los kernels recientes de Docker Desktop) necesita dos contenedores:
uno independiente con usuario y un conjunto de réplicas de un solo miembro para las transacciones:

```sh
docker run -d --name vortaq-test-mongo -p 127.0.0.1:57017:27017 -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=navidog mongo:8.2
docker run -d --name vortaq-test-mongo-rs -p 127.0.0.1:57018:57018 mongo:8.2 mongod --replSet rs0 --port 57018 --bind_ip_all
# Una sola vez, cuando el segundo haya arrancado:
docker exec vortaq-test-mongo-rs mongosh --port 57018 --quiet --eval 'rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:57018" }] })'
```

(o `docker compose -f tests/docker-compose.yml up -d --wait mongo82 mongo82rs` y el mismo `rs.initiate` con
`docker compose … exec mongo82rs`).

`npm run test:integration:required` es la puerta de calidad: ejecuta las suites de MySQL y de backups contra
los dos MySQL, las de MariaDB, PostgreSQL y MongoDB contra los suyos, y **falla** (en vez de omitirlas) si falta
`VORTAQ_TEST_MYSQL_URL`, `VORTAQ_TEST_MYSQL57_URL`, `VORTAQ_TEST_MARIADB_URL`, `VORTAQ_TEST_PG_URL`,
`VORTAQ_TEST_MONGO_URL` o `VORTAQ_TEST_MONGO_RS_URL`.
`VORTAQ_TEST_SSH_URL` es opcional: sin ella solo se omite el test del túnel SSH de PostgreSQL.
`npm run test:integration` omite en silencio el servidor que no tenga URL.

```sh
# macOS / Linux
VORTAQ_TEST_MYSQL_URL='mysql://root:navidog@127.0.0.1:33306/navidog_test' \
VORTAQ_TEST_MYSQL57_URL='mysql://root:navidog@127.0.0.1:33357/navidog_test' \
VORTAQ_TEST_MARIADB_URL='mysql://root:navidog@127.0.0.1:33311/navidog_test' \
VORTAQ_TEST_PG_URL='postgres://postgres:navidog@127.0.0.1:55432/navidog_test' \
VORTAQ_TEST_MONGO_URL='mongodb://root:navidog@127.0.0.1:57017/?authSource=admin' \
VORTAQ_TEST_MONGO_RS_URL='mongodb://127.0.0.1:57018/?replicaSet=rs0' \
VORTAQ_TEST_SSH_URL='ssh://vortaq:navidog@127.0.0.1:52222' \
npm run test:integration:required
```

```powershell
# Windows (PowerShell)
$env:VORTAQ_TEST_MYSQL_URL = 'mysql://root:navidog@127.0.0.1:33306/navidog_test'
$env:VORTAQ_TEST_MYSQL57_URL = 'mysql://root:navidog@127.0.0.1:33357/navidog_test'
$env:VORTAQ_TEST_MARIADB_URL = 'mysql://root:navidog@127.0.0.1:33311/navidog_test'
$env:VORTAQ_TEST_PG_URL = 'postgres://postgres:navidog@127.0.0.1:55432/navidog_test'
$env:VORTAQ_TEST_MONGO_URL = 'mongodb://root:navidog@127.0.0.1:57017/?authSource=admin'
$env:VORTAQ_TEST_MONGO_RS_URL = 'mongodb://127.0.0.1:57018/?replicaSet=rs0'
$env:VORTAQ_TEST_SSH_URL = 'ssh://vortaq:navidog@127.0.0.1:52222'
npm run test:integration:required
```

Usa siempre bases de datos desechables: los tests crean y borran bases y tablas. La contraseña `navidog` y la
base `navidog_test` son los valores con los que se crean estos contenedores de prueba; no tienen relación con
tus datos. Los tests de «Restaurar todo en Local» entre versiones (copia en MySQL 5.7, restauración en 8.4)
usan los dos servidores.

Las expectativas son las mismas en las dos versiones salvo donde 5.7 se comporta de verdad distinto; cada
diferencia está comentada junto al test (`5.7 split`):

- sin `DEFAULT (expr)` (8.0.13+): la clave de `ed_ai` la rellena un trigger;
- sin CTE (`WITH`, 8.0): 5.7 devuelve un error de sintaxis y no hay resultado que editar;
- `COLUMN_TYPE` conserva el ancho de visualización (`int(10) unsigned`);
- `SHOW CREATE TRIGGER` devuelve el texto tal como se escribió (nombre sin comillas);
- un `ON UPDATE` omitido se informa como `RESTRICT` (8.x: `NO ACTION`);
- en vistas materializadas (`ALGORITHM=TEMPTABLE`, `GROUP BY`) las columnas no traen esquema, así que
  `SELECT * FROM vista` queda de solo lectura como "columnas calculadas" en lugar de "el origen es una vista";
- sin `utf8mb4_0900_ai_ci` ni el atributo de columna `SRID` (8.0): los backups usan `utf8mb4_unicode_ci` y el
  SRID va en cada valor;
- sin `information_schema_stats_expiry`: el test de backups hace `ANALYZE TABLE` tras la carga masiva para
  que la estimación de filas no sea la estadística antigua de InnoDB.

En macOS, el test de la migración de contraseñas contra un llavero real se activa aparte: crea un llavero
desechable en la carpeta que indiques (nunca usa el llavero de inicio de sesión) y lo borra al terminar.

```sh
VORTAQ_TEST_KEYCHAIN_DIR="$(mktemp -d)" npm run test:integration
```

### Capturas de pantalla

`npm run screenshots` siembra un perfil de prueba y el MySQL desechable (tablas `shot_*` en `navidog_test`),
compila y abre la app en una ventana de 1600×1000 que recorre las pantallas principales. Guarda `01-home.png` …
`19f-tree-typed-lock.png` e imprime un resumen `[screenshots] {...}`. Los pasos `16*` y `17*`
(«Restaurar todo en Local» y «Restaurar paquete en Local») usan también el MySQL 5.7 desechable como staging
(`VORTAQ_SHOTS_MYSQL57`, por defecto el puerto 33357). Los pasos `18*` (ventanas de actualización)
responden con una versión ficticia de `tests/fixtures/updates/latest-release.json` en vez de consultar GitHub, y
`18f-whats-new` simula una actualización de 0.1.2 a 0.1.4. Los pasos `19*` muestran las confirmaciones de borrado
en Local (se cancelan: no se borra nada) y la sección Seguridad de Ajustes; `19d`-`19f`, con Staging marcado en
Seguridad solo en memoria (no se guarda), los entornos que piden escribir el nombre, esa confirmación sobre
«Staging Demo» (se cancela) y el candado del árbol. Los pasos `20*` muestran el asistente de IA con el
proveedor falso `VORTAQ_AI_FIXTURE=1` (sin red ni claves reales): el panel con una conversación, la sección
IA de Ajustes, «Ver contexto enviado» y «Generar SQL con IA». Nunca usa tu perfil real y se niega a
sembrar un MySQL en los puertos locales habituales (3306-3309). **Solo macOS y Linux**: el script usa sintaxis de
shell POSIX y en Windows npm ejecuta los scripts con `cmd.exe`, aunque lo lances desde Git Bash o PowerShell.

```sh
npm run screenshots
# Rutas y MySQL configurables:
VORTAQ_SHOTS_DIR=/tmp/shots VORTAQ_SHOTS_PROFILE=/tmp/shots/profile \
VORTAQ_SHOTS_MYSQL='mysql://root:navidog@127.0.0.1:33306/navidog_test' npm run screenshots
# Solo algunos pasos (prefijos del nombre del PNG):
VORTAQ_SHOTS_ONLY=05,06 npm run screenshots
# Tour de bienvenida, detección de Navicat y «Mostrarme cómo» (pasos 21*):
VORTAQ_SHOTS_ONLY=21 VORTAQ_WHATS_NEW_FROM=0.1.5 VORTAQ_WHATS_NEW_VERSION=0.1.7 npm run screenshots
```

Los motores tienen sus propios scripts de semillas (perfil de prueba y servidores desechables):
`scripts/seed-engine-shots.mjs` (PostgreSQL y MariaDB, pasos `40*`/`41*`, también la copia de MariaDB con
secuencias), `scripts/seed-sqlite-shots.mjs` (pasos `42*`, con una tarea SQLite y «Recientes») y
`scripts/seed-mongo-shots.mjs` (pasos `43*`, con una tarea MongoDB y «Duplicar colección»); los pasos `44*`
(menú Conexión con todos los motores) sirven con cualquiera de ellos. Cada script explica cómo lanzarlo.

El asistente **Importar…** (pasos `30*`) usa un archivo de DBeaver y un volcado `.sql` sintéticos que el script
de semillas crea junto al perfil (`import-home/`, `import/`); `VORTAQ_IMPORT_HOME` y `VORTAQ_IMPORT_PICK` (solo
con un perfil de prueba) apuntan a ellos. Si cambias `VORTAQ_SHOTS_PROFILE`, pásalas también:

```bash
VORTAQ_SHOTS_ONLY=30 npm run screenshots
```

Por defecto escribe en `$TMPDIR/vortaq-shots`. El perfil (`.../profile`) se borra y se recrea en cada
ejecución, y su carpeta debe llamarse `profile`.

### Variables de entorno

| Variable                        | Efecto                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VORTAQ_USER_DATA=<carpeta>`    | Usa otro perfil (conexiones, trabajos, contraseñas, copias, registros). Con un perfil alternativo no se instalan LaunchAgents.                                                                            |
| `VORTAQ_PLAIN_SECRETS=1`        | Guarda las contraseñas solo en base64, sin cifrar. Solo para perfiles de prueba.                                                                                                                          |
| `VORTAQ_SMOKE=1`                | Arranca, prueba varios canales IPC, SQLite (y MongoDB si hay URL de prueba), imprime `[smoke] {...}` y sale (0 = todo bien).                                                                              |
| `VORTAQ_DEBUG=1`                | Registro a nivel `debug`, copiado también en la consola.                                                                                                                                                  |
| `VORTAQ_TEST_MYSQL_URL`         | MySQL 8.4 desechable para `npm run test:integration[:required]`.                                                                                                                                          |
| `VORTAQ_TEST_MYSQL57_URL`       | MySQL 5.7 desechable para `npm run test:integration[:required]` (incluye la restauración 5.7 → 8.4).                                                                                                      |
| `VORTAQ_TEST_MARIADB_URL`       | MariaDB 11 desechable (`mysql://…:33311/…`) para el motor MariaDB y las correcciones de MariaDB en `npm run test:integration[:required]`.                                                                 |
| `VORTAQ_TEST_PG_URL`            | PostgreSQL 17 desechable (`postgres://…:55432/…`) para `npm run test:integration[:required]`.                                                                                                             |
| `VORTAQ_TEST_MONGO_URL`         | MongoDB 8.2 independiente desechable (`mongodb://root:…@127.0.0.1:57017/?authSource=admin`) para `npm run test:integration[:required]`; también activa el paso de MongoDB de `VORTAQ_SMOKE`.              |
| `VORTAQ_TEST_MONGO_RS_URL`      | Conjunto de réplicas MongoDB 8.2 de un miembro (`mongodb://127.0.0.1:57018/?replicaSet=rs0`) para las transacciones en `npm run test:integration[:required]`.                                             |
| `VORTAQ_SMOKE_MONGO_URL`        | Servidor MongoDB desechable para el paso de MongoDB de `VORTAQ_SMOKE` (si falta, se usa `VORTAQ_TEST_MONGO_URL`; sin ninguna, el paso se omite).                                                          |
| `VORTAQ_TEST_SSH_URL`           | Servidor SSH de prueba (`ssh://usuario:clave@127.0.0.1:52222`, servicio `sshd` del compose) para el test del túnel de PostgreSQL; opcional.                                                               |
| `VORTAQ_TEST_KEYCHAIN_DIR`      | Carpeta desechable para el test del llavero de macOS en `npm run test:integration`.                                                                                                                       |
| `VORTAQ_SCREENSHOTS=<dir>`      | Arnés de capturas. Exige `VORTAQ_USER_DATA`.                                                                                                                                                              |
| `VORTAQ_UPDATES_FIXTURE=<json>` | Solo pruebas y capturas, y solo con `VORTAQ_USER_DATA`: responde a la búsqueda de actualizaciones con ese archivo en vez de GitHub (`{"httpStatus": 429}` simula un error).                               |
| `VORTAQ_UPDATES_RUN_MODE`       | Solo pruebas, y solo con `VORTAQ_USER_DATA`: `packaged` o `source` fuerza el modo de actualización mostrado.                                                                                              |
| `VORTAQ_WHATS_NEW_FROM`         | Solo pruebas y capturas, y solo con `VORTAQ_USER_DATA`: simula que la versión vista antes era esa (las novedades no salen en modo humo ni en capturas sin ella).                                          |
| `VORTAQ_AI_FIXTURE=1`           | Solo pruebas y capturas, y solo con `VORTAQ_USER_DATA`: el asistente de IA responde con textos fijos de un proveedor falso, sin red.                                                                      |
| `VORTAQ_WHATS_NEW_VERSION`      | Solo pruebas, y solo con `VORTAQ_USER_DATA`: simula la versión en ejecución para la ventana de novedades.                                                                                                 |
| `VORTAQ_NAVICAT_CANDIDATES`     | Solo pruebas y capturas, y solo con `VORTAQ_USER_DATA`: carpetas (separadas por `:`, o `;` en Windows) donde buscar Navicat en vez de las habituales; `npm run screenshots` usa `tests/fixtures/navicat`. |

Prueba de humo del binario compilado sin tocar tus datos:

```sh
# macOS / Linux
npm run build
VORTAQ_USER_DATA="$(mktemp -d)" VORTAQ_SMOKE=1 VORTAQ_PLAIN_SECRETS=1 npx electron .
```

```powershell
# Windows (PowerShell)
npm run build
$env:VORTAQ_USER_DATA = "$env:TEMP\vortaq-smoke"; $env:VORTAQ_SMOKE = '1'; $env:VORTAQ_PLAIN_SECRETS = '1'
npx electron .
# Limpia las variables al terminar (o cierra la terminal): si no, el siguiente `npm run dev` de esta terminal
# arrancaría en modo humo, con el perfil de prueba y las contraseñas sin cifrar.
Remove-Item Env:VORTAQ_SMOKE, Env:VORTAQ_PLAIN_SECRETS, Env:VORTAQ_USER_DATA
```

### Estructura del proyecto

| Carpeta           | Contenido                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/`     | Tipos del dominio y contrato IPC tipado (única API entre interfaz y proceso principal)                                             |
| `src/main/`       | Proceso principal de Electron: MySQL, copias `.nb3`, automatización, importación de Navicat, credenciales, asistente de IA (`ai/`) |
| `src/preload/`    | Puente `contextBridge`, sin lógica                                                                                                 |
| `src/renderer/`   | Interfaz Vue 3 + Vuetify 3 + Pinia                                                                                                 |
| `tests/fixtures/` | Archivos sintéticos con el formato de Navicat y un `.nb3` sintético                                                                |

Las convenciones del proyecto están en [`CLAUDE.md`](CLAUDE.md) y los formatos de Navicat verificados en
[`docs/navicat-storage.md`](docs/navicat-storage.md). Léelos antes de tocar la importación o las copias.

## Seguridad

- **Búsqueda de actualizaciones**: lo único que la app envía a Internet por su cuenta es una petición anónima
  (`GET`) a `api.github.com` para leer la última versión publicada; no lleva identificadores ni datos tuyos. Solo
  abre en el navegador enlaces de las versiones de Vortaq en GitHub. Se desactiva en **Ajustes**.
- **Actualización integrada**: solo descarga cuando la pides (o con **Descargar actualizaciones
  automáticamente**), solo de las versiones de este repositorio en GitHub, y comprueba cada archivo antes de
  usarlo (sha512 de `latest.yml` en Windows/Linux, SHA-256 de `SHA256SUMS.txt` en Mac). No acepta versiones
  anteriores ni preliminares. Las copias desde el código y las ejecuciones con un perfil de prueba
  (`VORTAQ_USER_DATA`) nunca descargan ni instalan nada. El registro anota versiones, nombres de archivo y
  errores, nunca datos tuyos.
- **Las copias `.nb3` no van cifradas.** Se escriben con permisos `0600` en tu
  carpeta de usuario, pero cualquiera que copie el archivo puede leer los datos. Trátalas como datos sensibles y
  no las subas a repositorios ni carpetas compartidas.
- Los archivos JSON del perfil se escriben con permisos `0600`. En Windows quedan protegidos por los permisos de tu
  carpeta de usuario.
- Las contraseñas solo se guardan en `credentials.json`, cifradas con el almacén del sistema. Nunca las pongas en
  `connections.json`, en variables de entorno compartidas ni en el repositorio.
- **Nunca subas al repositorio** perfiles, `credentials.json`, copias `.nb3`, claves SSH ni configuraciones con
  hosts o usuarios reales. Los fixtures de `tests/` deben ser anónimos o sintéticos.
- El registro no guarda datos de consultas, contraseñas ni contenido de copias. De los errores de MySQL solo
  guarda el canal y el código.
- Las conexiones de Producción (y las de los entornos marcados en **Ajustes › Seguridad**) exigen escribir su
  nombre para cualquier escritura, tanto en la interfaz como en el proceso principal; Producción no se puede
  quitar de la lista, ni editando `settings.json`. La confirmación de borrado en las demás conexiones es solo de
  la interfaz.

## Licencia

Vortaq es software libre con licencia [MIT](LICENSE): puedes usarlo, copiarlo, modificarlo y distribuirlo,
también con fines comerciales, siempre que conserves el aviso de copyright y la licencia. El icono de la app
(`build/vortaq-icon-source.png` y los archivos generados a partir de él) es obra original del proyecto y se
distribuye con la misma licencia.

## Licencias de terceros

Vortaq incluye componentes de código abierto (Electron y Chromium, Vue, Vuetify, CodeMirror, mysql2, ssh2,
los SDK de Anthropic y OpenAI, entre otros), las fuentes Inter y JetBrains Mono (SIL Open Font License 1.1) y
los iconos Material Design Icons (licencia de Pictogrammers). Cada uno conserva su licencia:

- `npm run build` genera `out/THIRD_PARTY_LICENSES.txt` con todas las dependencias de producción, su licencia y
  el texto de licencia que publica cada paquete (`scripts/third-party-licenses.mjs`; se puede generar aparte
  con `npm run licenses`). Los instaladores lo incluyen junto a `LICENSE` en la carpeta de recursos de la app.
- En la app: **Más › Acerca de Vortaq › Licencias de terceros** (con buscador y **Abrir archivo**).
- Los avisos de Chromium y Node.js vienen con Electron en `LICENSES.chromium.html`, dentro de la instalación.

`package.json` mantiene `"private": true` para que nunca se publique por error en npm; no afecta a la licencia.

## Marcas

Vortaq es un proyecto independiente y no está afiliado, patrocinado ni respaldado por PremiumSoft CyberTech Ltd.
ni por ningún otro fabricante. Navicat® es marca de PremiumSoft CyberTech Ltd.; MySQL® es marca de Oracle;
Electron® es marca de la OpenJS Foundation; las demás marcas pertenecen a sus propietarios y se citan solo para
indicar compatibilidad. La importación de datos de Navicat y el formato .nb3 se han implementado de forma
independiente, a partir de archivos del propio usuario y documentación pública, sin usar código, bibliotecas,
binarios ni recursos gráficos de Navicat. La interfaz, los textos y los iconos son propios o de bibliotecas de
código abierto.
