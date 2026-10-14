/**
 * Test helper: reads every entry of a ZIP file (stored or deflated), checking
 * each CRC-32 and that the local headers agree with the central directory.
 * Only for tests of the export writers; the .vqb reader (backup/vqb/zip.ts)
 * stays STORED-only on purpose.
 */
import { readFileSync } from 'node:fs'
import { crc32, inflateRawSync } from 'node:zlib'

export interface UnzippedEntry {
  name: string
  method: number
  data: Buffer
}

export function unzip(path: string): Map<string, UnzippedEntry> {
  const zip = readFileSync(path)
  let eocd = -1
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('no end of central directory')
  const count = zip.readUInt16LE(eocd + 10)
  let pos = zip.readUInt32LE(eocd + 16)
  const out = new Map<string, UnzippedEntry>()
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error('bad central header')
    const method = zip.readUInt16LE(pos + 10)
    const crc = zip.readUInt32LE(pos + 16)
    const compressed = zip.readUInt32LE(pos + 20)
    const size = zip.readUInt32LE(pos + 24)
    const nameLength = zip.readUInt16LE(pos + 28)
    const extraLength = zip.readUInt16LE(pos + 30)
    const commentLength = zip.readUInt16LE(pos + 32)
    const offset = zip.readUInt32LE(pos + 42)
    const name = zip.toString('utf8', pos + 46, pos + 46 + nameLength)
    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`bad local header: ${name}`)
    if (zip.readUInt16LE(offset + 8) !== method) throw new Error(`method mismatch: ${name}`)
    if (zip.readUInt32LE(offset + 14) !== crc) throw new Error(`local CRC mismatch: ${name}`)
    if (zip.readUInt32LE(offset + 18) !== compressed)
      throw new Error(`local size mismatch: ${name}`)
    if (zip.readUInt32LE(offset + 22) !== size) throw new Error(`local size mismatch: ${name}`)
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28)
    const raw = zip.subarray(start, start + compressed)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    if (data.length !== size) throw new Error(`size mismatch: ${name}`)
    if (crc32(data) >>> 0 !== crc) throw new Error(`CRC mismatch: ${name}`)
    out.set(name, { name, method, data })
    pos += 46 + nameLength + extraLength + commentLength
  }
  return out
}
