import { Slice, type Schema } from '@tiptap/pm/model'
import { Lexer, type Token, type Tokens } from 'marked'
import type { RichText } from './db'

const MAX_MARKDOWN_CHARS = 400_000

type Mark = { type: string; attrs?: { href: string } }
type InlineState = { html: string[] }
type MarkdownMode = 'plain' | 'inline' | 'document'

const HTML_MARKS: Record<string, string> = { mark: 'highlight', u: 'underline' }

export function isMarkdownFile(file: { name: string; type?: string }): boolean {
  const name = file.name.toLowerCase()
  return name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.mdown') || name.endsWith('.mkd') || file.type === 'text/markdown'
}

export function clipboardPrefersFile(plain: string, files: { name: string }[]): boolean {
  if (!files.length) return false
  const trimmed = plain.trim()
  if (!trimmed) return true
  if (files.length !== 1 || !files[0].name) return false
  const name = files[0].name
  return trimmed === name || trimmed.endsWith(`\\${name}`) || trimmed.endsWith(`/${name}`)
}

export function combineMarkdownFiles(files: { name: string; text: string }[]): string {
  const parts = files.map(file => normalize(file.text))
  if (parts.length <= 1) return parts[0] ?? ''
  return files.map((file, index) => {
    const title = file.name.replace(/\.(md|markdown|mdown|mkd)$/i, '').replace(/[#\r\n]+/g, ' ').trim() || '未命名'
    return `## ${title}\n\n${parts[index].trim()}`
  }).join('\n\n')
}

export function looksLikeMarkdown(text: string): boolean {
  return markdownMode(text) !== 'plain'
}

function markdownMode(text: string): MarkdownMode {
  const normalized = normalize(text)
  if (!normalized.trim() || normalized.length > MAX_MARKDOWN_CHARS) return 'plain'
  const lines = normalized.split('\n')
  let fence: string | null = null
  let headings = 0
  let lists = 0
  let quotes = 0
  let tasks = 0
  let tables = 0
  let fences = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[2][0]
      if (!fence) {
        fence = marker
        fences += 1
      } else if (fence === marker) fence = null
      continue
    }
    if (fence) continue
    if (/^ {0,3}#{1,6}[ \t]+\S/.test(line)) headings += 1
    if (/^ {0,3}>/.test(line)) quotes += 1
    if (/^ {0,3}[-*+][ \t]+\[[ xX]\](?:[ \t]|$)/.test(line)) tasks += 1
    else if (/^ {0,3}(?:[-*+]|\d{1,2}[.)])[ \t]+\S/.test(line)) lists += 1
    const next = lines[index + 1]
    if (next && line.includes('|') && isTableSeparator(next)) tables += 1
  }
  const document = fences > 0 || tables > 0 || tasks > 0 || lists >= 2 || quotes >= 2 || (headings > 0 && !looksLikeSourceCode(normalized))
  if (document) return 'document'
  if (hasInlineMarkdown(stripFences(normalized))) return 'inline'
  return 'plain'
}

export function markdownToDocument(text: string, options?: { force?: boolean }): RichText | null {
  const normalized = normalize(text)
  if (!normalized.trim() || normalized.length > MAX_MARKDOWN_CHARS) return null
  const mode = options?.force ? 'document' : markdownMode(normalized)
  if (mode === 'plain') return null
  if (mode === 'inline') return inlineDocument(normalized)
  const { matter, body } = takeFrontMatter(normalized)
  const content: RichText[] = []
  if (body.trim()) content.push(...blocksFrom(new Lexer({ gfm: true, breaks: true }).lex(body)))
  const metadata = matter ? metadataBlocks(matter) : []
  if (content.length && metadata.length) content.push({ type: 'horizontalRule' })
  content.push(...metadata)
  return content.length ? { type: 'doc', content } : null
}

export function markdownPasteSlice(schema: Schema, text: string, options?: { force?: boolean }): Slice | null {
  const json = markdownToDocument(text, options)
  if (!json?.content?.length) return null
  try {
    const node = schema.nodeFromJSON(json)
    node.check()
    const open = (block?: RichText) => block?.type === 'paragraph' ? 1 : 0
    return new Slice(node.content, open(json.content[0]), open(json.content[json.content.length - 1]))
  } catch {
    return null
  }
}

function normalize(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function hasInlineMarkdown(text: string): boolean {
  return /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|<https?:\/\/[^>\s]+>/i.test(text)
    || /<(mark|u)>[\s\S]*?<\/\1>/i.test(text)
}

function stripFences(text: string): string {
  const kept: string[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const match = /^( {0,3})(`{3,}|~{3,})/.exec(line)
    if (match) {
      const marker = match[2][0]
      if (!fence) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (!fence) kept.push(line)
  }
  return kept.join('\n')
}

function looksLikeSourceCode(text: string): boolean {
  let score = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (/^(import|from|export|const|let|var|function|class|def|return|if|for|while|public|private|protected|package|using|fn|impl|struct|enum)\b/.test(trimmed)) score += 2
    if (/#include\b/.test(trimmed)) score += 2
    if (/[{};]\s*$/.test(trimmed)) score += 1
    if (/^(\/\/|\/\*|\*\/)/.test(trimmed)) score += 1
  }
  return score >= 3
}

function takeFrontMatter(text: string): { matter: string | null; body: string } {
  const lines = text.split('\n')
  const fence = lines[0]?.trim()
  if (fence !== '---' && fence !== '+++') return { matter: null, body: text }
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    const current = lines[index].trim()
    if (current === fence || current === '...') {
      end = index
      break
    }
  }
  if (end < 1) return { matter: null, body: text }
  const inner = lines.slice(1, end)
  if (inner.some(line => /^ {0,3}#{1,6}[ \t]/.test(line) || /^ {0,3}(`{3,}|~{3,})/.test(line) || /^ {0,3}>/.test(line))) return { matter: null, body: text }
  const usable = inner.filter(line => line.trim())
  const yaml = usable.length > 0 && usable.every(line => {
    const trimmed = line.trim()
    return trimmed.startsWith('#') || /^[\w.-]+\s*:/.test(trimmed) || /^-\s+/.test(trimmed) || /^\s+\S/.test(line)
  })
  if (!yaml) return { matter: null, body: text }
  return { matter: inner.join('\n').trim(), body: lines.slice(end + 1).join('\n') }
}

function metadataBlocks(matter: string): RichText[] {
  const fields: { key: string; values: string[] }[] = []
  for (const line of matter.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && fields.length) {
      fields[fields.length - 1].values.push(item[1].trim())
      continue
    }
    const field = /^([\w.-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (field && !/^\s/.test(line)) {
      fields.push({ key: field[1], values: field[2].trim() ? [field[2].trim()] : [] })
      continue
    }
    return [codeBlock(matter)]
  }
  return fields.map(field => paragraph([
    textNode(`${field.key}：`, [{ type: 'bold' }]),
    ...(field.values.length ? [textNode(field.values.join('、'))] : [])
  ]))
}

function inlineDocument(text: string): RichText | null {
  const lexer = new Lexer({ gfm: true, breaks: true })
  const content = text.split('\n').map(line => {
    if (!line) return { type: 'paragraph' }
    const rendered = inlineContent(lexer.inlineTokens(line))
    return rendered.length ? paragraph(rendered) : { type: 'paragraph' }
  })
  return content.length ? { type: 'doc', content } : null
}

function blocksFrom(tokens: Token[]): RichText[] {
  return tokens.flatMap(blockFrom)
}

function blockFrom(token: Token): RichText[] {
  switch (token.type) {
    case 'space':
    case 'def':
    case 'checkbox':
      return []
    case 'heading':
      return headingBlock(token as Tokens.Heading)
    case 'paragraph': {
      const content = inlineContent(token.tokens)
      return content.length ? [paragraph(content)] : []
    }
    case 'text': {
      if (token.tokens?.some(isStructural)) return blocksFrom(token.tokens)
      const content = inlineContent(token.tokens ?? [{ type: 'text', raw: token.text ?? '', text: token.text ?? '' }])
      return content.length ? [paragraph(content)] : []
    }
    case 'code':
      return [codeBlock(token.text ?? '')]
    case 'blockquote':
      return quoteBlock(blocksFrom(token.tokens ?? []))
    case 'list':
      return listBlocks(token as Tokens.List)
    case 'hr':
      return [{ type: 'horizontalRule' }]
    case 'table':
      return tableBlock(token as Tokens.Table)
    case 'html':
      return htmlBlock(token.text)
    default:
      if ('tokens' in token && token.tokens?.length) {
        const nested = blocksFrom(token.tokens)
        if (nested.length) return nested
      }
      if ('text' in token && token.text?.trim()) return [paragraph([textNode(token.text)])]
      return []
  }
}

function headingBlock(token: Tokens.Heading): RichText[] {
  const content = inlineContent(token.tokens)
  if (!content.length) return []
  const level = Math.min(3, Math.max(1, token.depth || 1))
  return [{ type: 'heading', attrs: { level }, content }]
}

function quoteBlock(content: RichText[]): RichText[] {
  return content.length ? [{ type: 'blockquote', content }] : []
}

function listBlocks(token: Tokens.List): RichText[] {
  const runs: { kind: 'task' | 'ordered' | 'bullet'; items: Tokens.ListItem[] }[] = []
  for (const item of token.items) {
    const kind = item.task ? 'task' : token.ordered ? 'ordered' : 'bullet'
    const last = runs[runs.length - 1]
    if (last?.kind === kind) last.items.push(item)
    else runs.push({ kind, items: [item] })
  }
  let usedStart = false
  return runs.map(run => {
    if (run.kind === 'task') {
      return {
        type: 'taskList',
        content: run.items.map(item => ({
          type: 'taskItem',
          attrs: { checked: Boolean(item.checked) },
          content: itemContent(item)
        }))
      }
    }
    const content = run.items.map(item => ({ type: 'listItem', content: itemContent(item) }))
    if (run.kind === 'ordered') {
      const start = !usedStart && typeof token.start === 'number' && token.start > 1 ? token.start : 1
      usedStart = true
      return start === 1 ? { type: 'orderedList', content } : { type: 'orderedList', attrs: { start }, content }
    }
    return { type: 'bulletList', content }
  })
}

function itemContent(item: Tokens.ListItem): RichText[] {
  const content = blocksFrom(item.tokens)
  return content.length ? content : [{ type: 'paragraph' }]
}

function tableBlock(token: Tokens.Table): RichText[] {
  const headers = token.header.map(cell => plainText(cell.tokens).trim())
  const labeled = headers.some(Boolean)
  const items = token.rows.flatMap(row => {
    const parts: RichText[] = []
    row.forEach((cell, index) => {
      const cellContent = inlineContent(cell.tokens)
      if (!cellContent.length && !(labeled && headers[index])) return
      if (parts.length) parts.push(textNode('；'))
      if (labeled && headers[index]) parts.push(textNode(`${headers[index]}：`, [{ type: 'bold' }]))
      parts.push(...cellContent)
    })
    const content = mergeText(parts)
    return content.length ? [{ type: 'listItem', content: [paragraph(content)] }] : []
  })
  return items.length ? [{ type: 'bulletList', content: items }] : []
}

function htmlBlock(raw: string): RichText[] {
  const text = raw.trim()
  if (!text || /^<!--[\s\S]*-->$/.test(text)) return []
  return [paragraph([textNode(text)])]
}

function codeBlock(text: string): RichText {
  const normalized = text.replace(/\u0000/g, '').replace(/\n$/, '')
  return normalized ? { type: 'codeBlock', content: [textNode(normalized)] } : { type: 'codeBlock' }
}

function paragraph(content: RichText[]): RichText {
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

function inlineContent(tokens: Token[] | undefined): RichText[] {
  if (!tokens?.length) return []
  return mergeText(renderInline(tokens, [], { html: [] }))
}

function renderInline(tokens: Token[], inherited: Mark[], state: InlineState): RichText[] {
  const parts: RichText[] = []
  for (const token of tokens) {
    const marks = leafMarks(inherited, state.html)
    switch (token.type) {
      case 'text':
      case 'escape':
        pushText(parts, token.text, marks, state)
        break
      case 'codespan':
        pushText(parts, token.text.replace(/\n+/g, ' '), [...marks, { type: 'code' }], state)
        break
      case 'br':
        parts.push({ type: 'hardBreak' })
        break
      case 'strong':
        parts.push(...renderInline(token.tokens ?? [], [...inherited, { type: 'bold' }], state))
        break
      case 'em':
        parts.push(...renderInline(token.tokens ?? [], [...inherited, { type: 'italic' }], state))
        break
      case 'del':
        parts.push(...renderInline(token.tokens ?? [], [...inherited, { type: 'strike' }], state))
        break
      case 'link':
      case 'image':
        parts.push(...renderLink(token as Tokens.Link | Tokens.Image, inherited, state))
        break
      case 'html':
        renderHtml(token.text, state, parts, marks)
        break
      case 'checkbox':
        break
      default:
        if ('tokens' in token && token.tokens?.length) parts.push(...renderInline(token.tokens, inherited, state))
        else if ('text' in token && token.text) pushText(parts, token.text, marks, state)
    }
  }
  return parts
}

function renderLink(token: Tokens.Link | Tokens.Image, inherited: Mark[], state: InlineState): RichText[] {
  const href = token.href?.trim() ?? ''
  const kind = classifyHref(href)
  let inner = token.tokens?.length ? token.tokens : []
  if (!plainText(inner).trim()) {
    const fallback = token.type === 'image' ? '图片' : href
    inner = fallback ? [{ type: 'text', raw: fallback, text: fallback }] : []
  }
  if (kind === 'safe') return renderInline(inner, [...inherited, { type: 'link', attrs: { href } }], state)
  const parts = renderInline(inner, inherited, state)
  if (kind === 'plain' && href && !plainText(inner).includes(href)) parts.push(textNode(` (${href})`, leafMarks(inherited, state.html)))
  return parts
}

function renderHtml(raw: string, state: InlineState, parts: RichText[], marks: Mark[]): void {
  const trimmed = raw.trim()
  const open = /^<(mark|u)>$/i.exec(trimmed)
  if (open) {
    state.html.push(HTML_MARKS[open[1].toLowerCase()])
    return
  }
  const close = /^<\/(mark|u)>$/i.exec(trimmed)
  if (close) {
    const name = HTML_MARKS[close[1].toLowerCase()]
    const index = state.html.lastIndexOf(name)
    if (index >= 0) state.html.splice(index, 1)
    return
  }
  if (/^<!--[\s\S]*-->$/.test(trimmed)) return
  pushText(parts, raw, marks, state)
}

function pushText(parts: RichText[], value: string, marks: Mark[], _state: InlineState): void {
  const chunks = value.replace(/\u0000/g, '').split('\n')
  chunks.forEach((chunk, index) => {
    if (index > 0) parts.push({ type: 'hardBreak' })
    if (chunk) parts.push(textNode(chunk, marks))
  })
}

function leafMarks(inherited: Mark[], html: string[]): Mark[] {
  const marks = [...inherited, ...html.map(type => ({ type }))]
  const order = ['link', 'bold', 'italic', 'strike', 'code', 'highlight', 'underline']
  return marks.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
}

function mergeText(parts: RichText[]): RichText[] {
  const merged: RichText[] = []
  for (const part of parts) {
    if (part.type === 'text' && !part.text) continue
    const previous = merged[merged.length - 1]
    if (part.type === 'text' && previous?.type === 'text' && sameMarks(previous.marks, part.marks)) {
      previous.text = `${previous.text ?? ''}${part.text ?? ''}`
      continue
    }
    merged.push(part.type === 'text' ? textNode(part.text ?? '', part.marks as Mark[] | undefined) : part)
  }
  return merged
}

function textNode(text: string, marks?: Mark[]): RichText {
  return marks?.length ? { type: 'text', text, marks } : { type: 'text', text }
}

function sameMarks(left: RichText['marks'], right: RichText['marks']): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? [])
}

function plainText(tokens: Token[] | undefined): string {
  if (!tokens?.length) return ''
  return tokens.map(token => {
    if (token.type === 'text' || token.type === 'escape' || token.type === 'codespan') return token.text
    if ('tokens' in token && token.tokens) return plainText(token.tokens)
    return 'text' in token ? token.text ?? '' : ''
  }).join('')
}

function isStructural(token: Token): boolean {
  return ['blockquote', 'code', 'heading', 'hr', 'html', 'list', 'paragraph', 'table'].includes(token.type)
}

function classifyHref(href: string): 'safe' | 'plain' | 'drop' {
  if (!href || /[\u0000-\u001F\u007F]/.test(href) || /^(javascript|data|vbscript):/i.test(href)) return 'drop'
  if (/^(https?:\/\/|mailto:)/i.test(href)) {
    try {
      const url = new URL(href)
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') return 'safe'
    } catch {
      return 'plain'
    }
  }
  return 'plain'
}

