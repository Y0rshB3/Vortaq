/**
 * A small reader for machine-written XML (SQL Server's SHOWPLAN XML): elements
 * and attributes only. Text, comments, CDATA, processing instructions and
 * DOCTYPE are skipped; namespace prefixes are dropped from names. Throws on
 * text that is not well-formed.
 */
export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlElement[]
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

const localName = (name: string): string => name.slice(name.indexOf(':') + 1)

export function parseXml(text: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] }
  const stack: XmlElement[] = [root]
  let i = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) break
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      i = end < 0 ? text.length : end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9)
      i = end < 0 ? text.length : end + 3
      continue
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2)
      i = end < 0 ? text.length : end + 1
      continue
    }
    // A tag: find its end outside quoted attribute values.
    let j = lt + 1
    let quote: string | null = null
    while (j < text.length) {
      const ch = text[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
      j++
    }
    if (j >= text.length) throw new Error('XML sin cerrar')
    const tag = text.slice(lt + 1, j)
    i = j + 1
    if (tag.startsWith('/')) {
      const name = localName(tag.slice(1).trim())
      const open = stack.pop()
      if (!open || open.name !== name) throw new Error(`XML mal formado: </${name}>`)
      continue
    }
    const selfClosing = tag.endsWith('/')
    const body = selfClosing ? tag.slice(0, -1) : tag
    const nameMatch = /^([^\s/>]+)/.exec(body)
    if (!nameMatch) throw new Error('XML mal formado')
    const element: XmlElement = { name: localName(nameMatch[1]), attrs: {}, children: [] }
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
    let m: RegExpExecArray | null
    const rest = body.slice(nameMatch[1].length)
    while ((m = attrRe.exec(rest))) element.attrs[localName(m[1])] = decode(m[3] ?? m[4] ?? '')
    stack[stack.length - 1].children.push(element)
    if (!selfClosing) stack.push(element)
  }
  if (stack.length !== 1) throw new Error('XML sin cerrar')
  if (root.children.length !== 1) throw new Error('XML sin un único elemento raíz')
  return root.children[0]
}

/** Every descendant named `name`, depth first, not entering elements named `stopAt`. */
export function findAll(element: XmlElement, name: string, stopAt?: string): XmlElement[] {
  const out: XmlElement[] = []
  const walk = (e: XmlElement): void => {
    for (const child of e.children) {
      if (child.name === name) out.push(child)
      if (stopAt && child.name === stopAt) continue
      walk(child)
    }
  }
  walk(element)
  return out
}
