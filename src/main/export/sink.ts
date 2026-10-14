/**
 * Output files of an export. Everything is written to `<file>.part` and
 * renamed over the chosen file only when complete; a failed or cancelled
 * export deletes its part files, so a half-written file never takes the
 * chosen name. Writes respect the stream's backpressure (bounded memory).
 */
import { createWriteStream, type WriteStream } from 'node:fs'
import { rename, stat, unlink } from 'node:fs/promises'
import { once } from 'node:events'
import { basename, dirname, isAbsolute } from 'node:path'

export class ExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportError'
  }
}

export const PART_SUFFIX = '.part'

/** Checks the destination chosen in the save dialog. */
export async function checkTarget(filePath: unknown): Promise<string> {
  if (typeof filePath !== 'string' || !filePath.trim())
    throw new ExportError('Elige dónde guardar el archivo.')
  if (!isAbsolute(filePath)) throw new ExportError('La ruta del archivo debe ser absoluta.')
  try {
    const parent = await stat(dirname(filePath))
    if (!parent.isDirectory()) throw new Error('not a folder')
  } catch {
    throw new ExportError(`La carpeta de ${basename(filePath)} no existe: elige otra ubicación.`)
  }
  try {
    if ((await stat(filePath)).isDirectory())
      throw new ExportError(`${basename(filePath)} es una carpeta: elige un nombre de archivo.`)
  } catch (err) {
    if (err instanceof ExportError) throw err
    /* the file does not exist yet: fine */
  }
  return filePath
}

export async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    /* already gone */
  }
}

/** A text/binary stream into `<path>` (usually a `.part` file). */
export class FileSink {
  private bytesWritten = 0
  private failure: Error | null = null

  private constructor(
    readonly path: string,
    private readonly stream: WriteStream
  ) {
    stream.on('error', (err) => {
      this.failure ??= err
    })
  }

  static async open(path: string): Promise<FileSink> {
    const stream = createWriteStream(path, { flags: 'w' })
    try {
      await once(stream, 'open')
    } catch (err) {
      throw writeError(err as Error)
    }
    return new FileSink(path, stream)
  }

  get bytes(): number {
    return this.bytesWritten
  }

  async write(chunk: string | Buffer): Promise<void> {
    if (this.failure) throw writeError(this.failure)
    if (!chunk.length) return
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.bytesWritten += data.length
    if (!this.stream.write(data)) {
      try {
        // once() also rejects when the stream emits 'error' meanwhile.
        await once(this.stream, 'drain')
      } catch (err) {
        throw writeError(err as Error)
      }
    }
  }

  /** Flushes and closes the file. */
  async close(): Promise<void> {
    if (this.failure) throw writeError(this.failure)
    if (this.stream.closed) return
    this.stream.end()
    try {
      await once(this.stream, 'close')
    } catch (err) {
      this.failure ??= err as Error
    }
    if (this.failure) throw writeError(this.failure)
  }

  /** Closes without flushing more and deletes the file. */
  async discard(): Promise<void> {
    if (!this.stream.destroyed) {
      this.stream.destroy()
      await once(this.stream, 'close').catch(() => undefined)
    }
    await removeQuietly(this.path)
  }
}

function writeError(err: Error): ExportError {
  const code = (err as { code?: string }).code
  if (code === 'ENOSPC') return new ExportError('No queda espacio en el disco para el archivo.')
  if (code === 'EACCES' || code === 'EPERM')
    return new ExportError('Sin permisos para escribir en esa carpeta: elige otra ubicación.')
  return new ExportError(`No se pudo escribir el archivo (${code ?? err.message}).`)
}

/** Moves the finished part file over the chosen name. */
export async function publish(partPath: string, filePath: string): Promise<void> {
  try {
    await rename(partPath, filePath)
  } catch (err) {
    await removeQuietly(partPath)
    throw writeError(err as Error)
  }
}
