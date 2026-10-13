/**
 * Webview messages are JSON, while the desktop renderer gets core results
 * through Electron's structured clone. The core already returns JSON-safe
 * values for query results (cells are string | number | boolean | null,
 * binary as `0x…` text, MongoDB values as canonical Extended JSON), so this
 * is a safety net for anything else a handler may return: it never changes a
 * value that JSON already carries exactly.
 */

const hex = (bytes: Uint8Array): string =>
  '0x' +
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()

/**
 * Deep copy of `value` that survives JSON.stringify/parse unchanged:
 * bigint → decimal text, bytes → `0x…`, Date → ISO text, Map → object,
 * Set → array, NaN/±Infinity → their text, undefined and functions dropped
 * (null inside arrays, as JSON does). Cycles become null.
 */
export function toJsonSafe(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return value.toString()
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
  }
  if (value === null) return null
  const obj = value as object
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString()
  if (obj instanceof Uint8Array) return hex(obj)
  if (obj instanceof ArrayBuffer) return hex(new Uint8Array(obj))
  if (ArrayBuffer.isView(obj))
    return hex(new Uint8Array(obj.buffer, obj.byteOffset, obj.byteLength))
  if (seen.has(obj)) return null
  seen.add(obj)
  try {
    if (Array.isArray(obj)) return obj.map((item) => toJsonSafe(item, seen) ?? null)
    if (obj instanceof Set) return [...obj].map((item) => toJsonSafe(item, seen) ?? null)
    const out: Record<string, unknown> = {}
    const entries = obj instanceof Map ? [...obj.entries()] : Object.entries(obj)
    for (const [key, item] of entries) {
      const safe = toJsonSafe(item, seen)
      if (safe !== undefined) out[String(key)] = safe
    }
    return out
  } finally {
    seen.delete(obj)
  }
}
