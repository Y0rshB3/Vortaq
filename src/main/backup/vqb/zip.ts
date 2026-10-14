import { createReadStream } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { createDeflateRaw, crc32 } from 'node:zlib'
import { VqbFormatError } from './errors'

/**
 * Minimal ZIP container for .vqb files (docs/vqb-format.md, "Container").
 *
 * Writer: every entry is STORED (method 0): the payloads are already gzip
 * and/or AES-GCM, so deflate would only waste time. Each body is complete in
 * memory before it is written, so the local header already carries its
 * CRC-32 and sizes (no data descriptors) and any unzip tool reads it. ZIP64 records are added only when an offset, the
 * central directory or the entry count needs them (archives > 4 GiB). A
 * single entry is never that big: data is split in ~5 MB chunks.
 *
 * `addFile` (used by the .xlsx export, never by .vqb) streams a file into a
 * DEFLATE entry: the local header is written first with blank CRC/sizes and
 * patched in place once the data is written, so it needs no data descriptor
 * either and memory stays bounded however large the file is.
 *
 * Reader: the central directory at the end of the file lists every entry,
 * so finding manifest.json (written last) costs two small positioned reads
 * however large the archive is.
 */

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const EOCD_SIZE = 22
const ZIP64_EOCD_SIZE = 56
const ZIP64_LOCATOR_SIZE = 20
const MAX32 = 0xffffffff
const MAX16 = 0xffff
/** General purpose flag bit 11: file names are UTF-8. */
const FLAG_UTF8 = 0x0800
/** Largest entry the writer accepts and the reader loads into memory. */
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024

export interface ZipEntryInfo {
  name: string
  /** Offset of the entry's local header. */
  headerOffset: number
  /** Uncompressed size. */
  size: number
  crc: number
  /** 8 for `addFile` entries (DEFLATE); absent = 0 (stored). */
  method?: number
  /** Bytes stored in the archive when compressed; absent = `size`. */
  compressedSize?: number
}

/** Thrown when a streamed entry would need ZIP64 sizes (4 GiB or more). */
export const ZIP_ENTRY_TOO_LARGE = 'La entrada ZIP supera 4 GB'

/** MS-DOS date/time fields of a Date (local time, 2-second resolution). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()))
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

function checkName(name: string): Buffer {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))
    throw new Error(`Nombre de entrada ZIP no válido: ${name}`)
  const bytes = Buffer.from(name, 'utf8')
  if (bytes.length > MAX16) throw new Error(`Nombre de entrada ZIP demasiado largo: ${name}`)
  return bytes
}

export class ZipWriter {
  private position = 0
  private readonly entries: ZipEntryInfo[] = []
  private readonly names = new Set<string>()
  private readonly stamp: { time: number; date: number }
  private closed = false

  private constructor(
    private readonly handle: FileHandle,
    date: Date,
    /** Tests: write the ZIP64 records even for a small archive. */
    private readonly force64: boolean
  ) {
    this.stamp = dosDateTime(date)
  }

  /** Creates `path` (never overwrites an existing file). */
  static async create(
    path: string,
    date = new Date(),
    options: { forceZip64?: boolean } = {}
  ): Promise<ZipWriter> {
    const handle = await open(path, 'wx')
    return new ZipWriter(handle, date, options.forceZip64 === true)
  }

  /** Bytes written so far. */
  get size(): number {
    return this.position
  }

  private async write(buffer: Buffer): Promise<void> {
    let done = 0
    while (done < buffer.length) {
      const { bytesWritten } = await this.handle.write(
        buffer,
        done,
        buffer.length - done,
        this.position + done
      )
      done += bytesWritten
    }
    this.position += buffer.length
  }

  /** Appends one stored entry; returns its size and CRC-32. */
  async add(name: string, data: Buffer): Promise<ZipEntryInfo> {
    if (this.closed) throw new Error('El archivo ZIP ya está cerrado')
    if (this.names.has(name)) throw new Error(`Entrada ZIP repetida: ${name}`)
    if (data.length >= MAX_ENTRY_BYTES)
      throw new Error(`La entrada ${name} es demasiado grande para un archivo .vqb`)
    const nameBytes = checkName(name)
    const headerOffset = this.position
    const crc = crc32(data) >>> 0
    const header = Buffer.alloc(LOCAL_HEADER_SIZE)
    header.writeUInt32LE(LOCAL_SIG, 0)
    header.writeUInt16LE(20, 4) // version needed: 2.0
    header.writeUInt16LE(FLAG_UTF8, 6)
    header.writeUInt16LE(0, 8) // stored
    header.writeUInt16LE(this.stamp.time, 10)
    header.writeUInt16LE(this.stamp.date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)
    await this.write(Buffer.concat([header, nameBytes]))
    await this.write(data)
    const entry = { name, headerOffset, size: data.length, crc }
    this.entries.push(entry)
    this.names.add(name)
    return entry
  }

  /**
   * Appends the file at `sourcePath` as one DEFLATE entry, streamed (bounded
   * memory). The local header is patched with the CRC-32 and sizes after the
   * data. Throws ZIP_ENTRY_TOO_LARGE past 4 GiB (no ZIP64 sizes here).
   */
  async addFile(name: string, sourcePath: string): Promise<ZipEntryInfo> {
    if (this.closed) throw new Error('El archivo ZIP ya está cerrado')
    if (this.names.has(name)) throw new Error(`Entrada ZIP repetida: ${name}`)
    const nameBytes = checkName(name)
    const headerOffset = this.position
    const header = Buffer.alloc(LOCAL_HEADER_SIZE)
    header.writeUInt32LE(LOCAL_SIG, 0)
    header.writeUInt16LE(20, 4) // version needed: 2.0 (deflate)
    header.writeUInt16LE(FLAG_UTF8, 6)
    header.writeUInt16LE(8, 8) // deflate
    header.writeUInt16LE(this.stamp.time, 10)
    header.writeUInt16LE(this.stamp.date, 12)
    header.writeUInt16LE(nameBytes.length, 26)
    header.writeUInt16LE(0, 28)
    await this.write(Buffer.concat([header, nameBytes]))
    let crc = 0
    let size = 0
    let compressed = 0
    const deflate = createDeflateRaw({ level: 6 })
    const source = createReadStream(sourcePath)
    source.on('data', (chunk) => {
      const data = chunk as Buffer
      crc = crc32(data, crc) >>> 0
      size += data.length
    })
    source.on('error', (err) => deflate.destroy(err))
    source.pipe(deflate)
    for await (const chunk of deflate) {
      const data = chunk as Buffer
      compressed += data.length
      if (compressed >= MAX32) {
        source.destroy()
        deflate.destroy()
        throw new Error(ZIP_ENTRY_TOO_LARGE)
      }
      await this.write(data)
    }
    if (size >= MAX32) throw new Error(ZIP_ENTRY_TOO_LARGE)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(compressed, 18)
    header.writeUInt32LE(size, 22)
    await this.writeAt(header, headerOffset)
    const entry: ZipEntryInfo = {
      name,
      headerOffset,
      size,
      crc,
      method: 8,
      compressedSize: compressed
    }
    this.entries.push(entry)
    this.names.add(name)
    return entry
  }

  /** Overwrites bytes already written (the header of a streamed entry). */
  private async writeAt(buffer: Buffer, position: number): Promise<void> {
    let done = 0
    while (done < buffer.length) {
      const { bytesWritten } = await this.handle.write(
        buffer,
        done,
        buffer.length - done,
        position + done
      )
      done += bytesWritten
    }
  }

  /** Writes the central directory and the end records, then closes the file. */
  async finish(): Promise<number> {
    if (this.closed) throw new Error('El archivo ZIP ya está cerrado')
    const cdOffset = this.position
    const parts: Buffer[] = []
    for (const e of this.entries) {
      const nameBytes = Buffer.from(e.name, 'utf8')
      const zip64Offset = this.force64 || e.headerOffset >= MAX32
      const extra = zip64Offset ? Buffer.alloc(12) : Buffer.alloc(0)
      if (zip64Offset) {
        extra.writeUInt16LE(0x0001, 0)
        extra.writeUInt16LE(8, 2)
        extra.writeBigUInt64LE(BigInt(e.headerOffset), 4)
      }
      const h = Buffer.alloc(CENTRAL_HEADER_SIZE)
      h.writeUInt32LE(CENTRAL_SIG, 0)
      h.writeUInt16LE((3 << 8) | 45, 4) // made by: Unix, spec 4.5
      h.writeUInt16LE(zip64Offset ? 45 : 20, 6)
      h.writeUInt16LE(FLAG_UTF8, 8)
      h.writeUInt16LE(e.method ?? 0, 10)
      h.writeUInt16LE(this.stamp.time, 12)
      h.writeUInt16LE(this.stamp.date, 14)
      h.writeUInt32LE(e.crc, 16)
      h.writeUInt32LE(e.compressedSize ?? e.size, 20)
      h.writeUInt32LE(e.size, 24)
      h.writeUInt16LE(nameBytes.length, 28)
      h.writeUInt16LE(extra.length, 30)
      h.writeUInt16LE(0, 32) // comment
      h.writeUInt16LE(0, 34) // disk
      h.writeUInt16LE(0, 36) // internal attributes
      h.writeUInt32LE((0o100644 << 16) >>> 0, 38) // regular file, rw-r--r--
      h.writeUInt32LE(zip64Offset ? MAX32 : e.headerOffset, 42)
      parts.push(h, nameBytes, extra)
    }
    const cd = Buffer.concat(parts)
    await this.write(cd)
    const cdSize = cd.length
    const count = this.entries.length
    const needs64 = this.force64 || count >= MAX16 || cdOffset >= MAX32 || cdSize >= MAX32
    if (needs64) {
      const z = Buffer.alloc(ZIP64_EOCD_SIZE)
      const zOffset = this.position
      z.writeUInt32LE(ZIP64_EOCD_SIG, 0)
      z.writeBigUInt64LE(BigInt(ZIP64_EOCD_SIZE - 12), 4)
      z.writeUInt16LE((3 << 8) | 45, 12)
      z.writeUInt16LE(45, 14)
      z.writeUInt32LE(0, 16)
      z.writeUInt32LE(0, 20)
      z.writeBigUInt64LE(BigInt(count), 24)
      z.writeBigUInt64LE(BigInt(count), 32)
      z.writeBigUInt64LE(BigInt(cdSize), 40)
      z.writeBigUInt64LE(BigInt(cdOffset), 48)
      const l = Buffer.alloc(ZIP64_LOCATOR_SIZE)
      l.writeUInt32LE(ZIP64_LOCATOR_SIG, 0)
      l.writeUInt32LE(0, 4)
      l.writeBigUInt64LE(BigInt(zOffset), 8)
      l.writeUInt32LE(1, 16)
      await this.write(Buffer.concat([z, l]))
    }
    const end = Buffer.alloc(EOCD_SIZE)
    end.writeUInt32LE(EOCD_SIG, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(needs64 ? MAX16 : count, 8)
    end.writeUInt16LE(needs64 ? MAX16 : count, 10)
    end.writeUInt32LE(needs64 ? MAX32 : cdSize, 12)
    end.writeUInt32LE(needs64 ? MAX32 : cdOffset, 16)
    end.writeUInt16LE(0, 20)
    await this.write(end)
    await this.handle.sync().catch(() => undefined)
    await this.handle.close()
    this.closed = true
    return this.position
  }

  /** Closes the file without finishing it (the caller removes it). */
  async abort(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.handle.close().catch(() => undefined)
  }
}

const damaged = (detail: string): VqbFormatError =>
  new VqbFormatError(`El archivo no es una copia .vqb válida (${detail}).`)

export class ZipReader {
  private readonly byName = new Map<string, ZipEntryInfo>()

  private constructor(
    private readonly handle: FileHandle,
    readonly fileSize: number,
    readonly entries: ZipEntryInfo[]
  ) {
    for (const e of entries) this.byName.set(e.name, e)
  }

  static async open(path: string): Promise<ZipReader> {
    const handle = await open(path, 'r')
    try {
      const { size } = await handle.stat()
      const entries = await readDirectory(handle, size)
      return new ZipReader(handle, size, entries)
    } catch (err) {
      await handle.close().catch(() => undefined)
      throw err
    }
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  entry(name: string): ZipEntryInfo | null {
    return this.byName.get(name) ?? null
  }

  /** The stored bytes of an entry, CRC-32 checked. */
  async read(name: string): Promise<Buffer> {
    const e = this.byName.get(name)
    if (!e) throw damaged(`falta la entrada ${name}`)
    if (e.size > MAX_ENTRY_BYTES) throw damaged(`la entrada ${name} es demasiado grande`)
    const header = await readAt(this.handle, e.headerOffset, LOCAL_HEADER_SIZE)
    if (header.length < LOCAL_HEADER_SIZE || header.readUInt32LE(0) !== LOCAL_SIG)
      throw damaged(`cabecera local de ${name} dañada`)
    if (header.readUInt16LE(8) !== 0) throw damaged(`la entrada ${name} está comprimida`)
    const dataOffset =
      e.headerOffset + LOCAL_HEADER_SIZE + header.readUInt16LE(26) + header.readUInt16LE(28)
    if (dataOffset + e.size > this.fileSize) throw damaged(`la entrada ${name} está truncada`)
    const data = await readAt(this.handle, dataOffset, e.size)
    if (data.length !== e.size) throw damaged(`la entrada ${name} está truncada`)
    if (crc32(data) >>> 0 !== e.crc) throw damaged(`CRC incorrecto en ${name}`)
    return data
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => undefined)
  }
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await handle.read(buffer, done, length - done, position + done)
    if (bytesRead === 0) break
    done += bytesRead
  }
  return done === length ? buffer : buffer.subarray(0, done)
}

async function readDirectory(handle: FileHandle, size: number): Promise<ZipEntryInfo[]> {
  if (size < EOCD_SIZE) throw damaged('demasiado pequeño')
  // EOCD is at the end, followed by a comment of at most 65535 bytes.
  const tailLength = Math.min(size, EOCD_SIZE + MAX16)
  const tail = await readAt(handle, size - tailLength, tailLength)
  let eocd = -1
  for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw damaged('no tiene directorio ZIP; puede estar incompleto')
  const eocdAbs = size - tailLength + eocd
  let count = tail.readUInt16LE(eocd + 10)
  let cdSize = tail.readUInt32LE(eocd + 12)
  let cdOffset = tail.readUInt32LE(eocd + 16)
  if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
    const locatorAt = eocdAbs - ZIP64_LOCATOR_SIZE
    const locator = locatorAt >= 0 ? await readAt(handle, locatorAt, ZIP64_LOCATOR_SIZE) : null
    if (!locator || locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIG)
      throw damaged('falta el localizador ZIP64')
    const zOffset = Number(locator.readBigUInt64LE(8))
    const z = await readAt(handle, zOffset, ZIP64_EOCD_SIZE)
    if (z.length < ZIP64_EOCD_SIZE || z.readUInt32LE(0) !== ZIP64_EOCD_SIG)
      throw damaged('registro ZIP64 dañado')
    count = Number(z.readBigUInt64LE(32))
    cdSize = Number(z.readBigUInt64LE(40))
    cdOffset = Number(z.readBigUInt64LE(48))
  }
  if (cdOffset + cdSize > size || cdSize > 256 * 1024 * 1024)
    throw damaged('directorio ZIP fuera de rango')
  const cd = await readAt(handle, cdOffset, cdSize)
  const entries: ZipEntryInfo[] = []
  let pos = 0
  for (let i = 0; i < count; i++) {
    if (pos + CENTRAL_HEADER_SIZE > cd.length || cd.readUInt32LE(pos) !== CENTRAL_SIG)
      throw damaged('directorio ZIP dañado')
    const method = cd.readUInt16LE(pos + 10)
    const crc = cd.readUInt32LE(pos + 16)
    let compressed = cd.readUInt32LE(pos + 20)
    let uncompressed = cd.readUInt32LE(pos + 24)
    const nameLength = cd.readUInt16LE(pos + 28)
    const extraLength = cd.readUInt16LE(pos + 30)
    const commentLength = cd.readUInt16LE(pos + 32)
    let headerOffset = cd.readUInt32LE(pos + 42)
    const name = cd.toString(
      'utf8',
      pos + CENTRAL_HEADER_SIZE,
      pos + CENTRAL_HEADER_SIZE + nameLength
    )
    // ZIP64 extended information: only the fields set to 0xFFFFFFFF are present, in order.
    let x = pos + CENTRAL_HEADER_SIZE + nameLength
    const extraEnd = x + extraLength
    while (x + 4 <= extraEnd) {
      const tag = cd.readUInt16LE(x)
      const len = cd.readUInt16LE(x + 2)
      if (tag === 0x0001) {
        let f = x + 4
        if (uncompressed === MAX32 && f + 8 <= x + 4 + len) {
          uncompressed = Number(cd.readBigUInt64LE(f))
          f += 8
        }
        if (compressed === MAX32 && f + 8 <= x + 4 + len) {
          compressed = Number(cd.readBigUInt64LE(f))
          f += 8
        }
        if (headerOffset === MAX32 && f + 8 <= x + 4 + len)
          headerOffset = Number(cd.readBigUInt64LE(f))
      }
      x += 4 + len
    }
    if (method !== 0 || compressed !== uncompressed)
      throw damaged(`la entrada ${name} usa una compresión que .vqb no admite`)
    entries.push({ name, headerOffset, size: compressed, crc })
    pos += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength
  }
  return entries
}
