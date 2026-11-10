/**
 * T-SQL lexer (docs/sqlserver-design.md): the single tokenizer every SQL Server
 * consumer uses (the GO splitter, both production-guard functions, the
 * destructive-statement check, result editability). Pure and linear time.
 *
 * It follows SQL Server's lexical rules:
 * - '…' strings double the quote; N'…' is a Unicode string (same token); backslashes
 *   are plain characters;
 * - identifiers are quoted with […] (`]]` is an escaped `]`) or "…" (doubling;
 *   QUOTED_IDENTIFIER is ON for every Vortaq session);
 * - `--` starts a line comment (no space needed); block comments NEST
 *   (`/* a /* b *\/ c *\/` is one comment), an unterminated one runs to the end;
 * - `@name` is a variable or parameter, `@@name` a system function; `#t` and
 *   `##t` are temporary tables (plain words here);
 * - `0x…` is a binary literal (a number token).
 */

export type MsTokenKind =
  | 'word' //     unquoted identifier or keyword (value as written), also #temp
  | 'ident' //    quoted identifier (value unescaped)
  | 'string' //   '…' or N'…' (value = raw text)
  | 'number' //   12, 1.5e3, 0x1F
  | 'variable' // @x, @@ROWCOUNT
  | 'op' //       operator (+, <=, <>, !=, +=, ::…)
  | 'punct' //    ( ) , ; .
  | 'comment' //  -- line or /* block */

export interface MsToken {
  kind: MsTokenKind
  /** Unquoted words keep their spelling; quoted identifiers are unescaped. */
  value: string
  /** Offset of the first character in the source. */
  start: number
  /** Offset just after the last character. */
  end: number
  /** 1-based line of the first character. */
  line: number
}

const OP_CHARS = new Set('+-*/<>=~!&|%^'.split(''))
/** Multi-character operators of T-SQL (compound assignment included). */
const MULTI_OPS = new Set([
  '<=',
  '>=',
  '<>',
  '!=',
  '!<',
  '!>',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '::'
])

function isWordStart(c: number): boolean {
  // letters, _, # (temporary objects) and any non-ASCII letter
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 35 || c >= 0x80
}

function isWordPart(c: number): boolean {
  // letters, digits, _, @, $, #
  return isWordStart(c) || (c >= 48 && c <= 57) || c === 64 || c === 36
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

/** End (exclusive) of a quoted run starting at `open`, where a doubled `close` is an escape. */
function endOfDoubled(src: string, open: number, close: string): number {
  let i = open + 1
  const n = src.length
  while (i < n) {
    if (src[i] === close) {
      if (src[i + 1] === close) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return n
}

/** End (exclusive) of a block comment starting at `open` (`/*`), honouring nesting. */
function endOfBlockComment(src: string, open: number): number {
  let depth = 0
  let i = open
  const n = src.length
  while (i < n) {
    if (src[i] === '/' && src[i + 1] === '*') {
      depth++
      i += 2
      continue
    }
    if (src[i] === '*' && src[i + 1] === '/') {
      depth--
      i += 2
      if (depth === 0) return i
      continue
    }
    i++
  }
  return n
}

function unquote(raw: string, close: string): string {
  const body = raw.length >= 2 && raw.endsWith(close) ? raw.slice(1, -1) : raw.slice(1)
  return body.split(close + close).join(close)
}

/** Tokenizes `src`. Whitespace is skipped; comments are kept as tokens. */
export function tokenizeTsql(src: string): MsToken[] {
  const tokens: MsToken[] = []
  const n = src.length
  let i = 0
  let line = 1
  let counted = 0
  const lineAt = (pos: number): number => {
    for (; counted < pos; counted++) if (src.charCodeAt(counted) === 10) line++
    return line
  }
  const push = (kind: MsTokenKind, start: number, end: number, value: string): void => {
    tokens.push({ kind, value, start, end, line: lineAt(start) })
  }

  while (i < n) {
    const c = src.charCodeAt(i)
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++
      continue
    }
    if (ch === '-' && src[i + 1] === '-') {
      const eol = src.indexOf('\n', i)
      const end = eol < 0 ? n : eol
      push('comment', i, end, src.slice(i, end))
      i = end
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = endOfBlockComment(src, i)
      push('comment', i, end, src.slice(i, end))
      i = end
      continue
    }
    if ((ch === 'N' || ch === 'n') && src[i + 1] === "'") {
      const end = endOfDoubled(src, i + 1, "'")
      push('string', i, end, src.slice(i, end))
      i = end
      continue
    }
    if (ch === "'") {
      const end = endOfDoubled(src, i, "'")
      push('string', i, end, src.slice(i, end))
      i = end
      continue
    }
    if (ch === '"') {
      const end = endOfDoubled(src, i, '"')
      push('ident', i, end, unquote(src.slice(i, end), '"'))
      i = end
      continue
    }
    if (ch === '[') {
      const end = endOfDoubled(src, i, ']')
      push('ident', i, end, unquote(src.slice(i, end), ']'))
      i = end
      continue
    }
    if (ch === '@') {
      let j = i + 1
      if (src[j] === '@') j++
      while (j < n && isWordPart(src.charCodeAt(j))) j++
      if (j > i + 1) {
        push('variable', i, j, src.slice(i, j))
        i = j
        continue
      }
    }
    if (isDigit(c) || (ch === '.' && isDigit(src.charCodeAt(i + 1)))) {
      let j = i
      if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2
        while (j < n && /[0-9a-fA-F]/.test(src[j])) j++
      } else {
        while (j < n && (isDigit(src.charCodeAt(j)) || src[j] === '.')) j++
        if ((src[j] === 'e' || src[j] === 'E') && /[0-9+-]/.test(src[j + 1] ?? '')) {
          j += 2
          while (j < n && isDigit(src.charCodeAt(j))) j++
        }
      }
      push('number', i, j, src.slice(i, j))
      i = j
      continue
    }
    if (isWordStart(c)) {
      let j = i + 1
      while (j < n && isWordPart(src.charCodeAt(j))) j++
      push('word', i, j, src.slice(i, j))
      i = j
      continue
    }
    if (OP_CHARS.has(ch) || ch === ':') {
      const two = src.slice(i, i + 2)
      const len = MULTI_OPS.has(two) ? 2 : 1
      push('op', i, i + len, src.slice(i, i + len))
      i += len
      continue
    }
    push('punct', i, i + 1, ch)
    i++
  }
  return tokens
}

/** Tokens without comments. */
export function tsqlCodeTokens(tokens: MsToken[]): MsToken[] {
  return tokens.filter((t) => t.kind !== 'comment')
}
