import { getSchema } from '@tiptap/react'
import { DOMSerializer } from '@tiptap/pm/model'
import { strToU8, zip } from 'fflate'
import { createEditorExtensions } from './editor'
import type { FolderRecord, NoteDatabase, NoteRecord, RichText } from './db'

export type NoteExportFormat = 'txt' | 'md' | 'html'
export type BatchExportKind = 'txt-zip' | 'md-zip' | 'html-zip' | 'txt-merged' | 'md-merged'
export type BatchExportScope = { kind: 'all' } | { kind: 'folder'; folderId: string | null }
type ExportContent = { title: string; doc: RichText }
type ExportNote = ExportContent & Pick<NoteRecord, 'folderId' | 'isPinned' | 'updatedAt' | 'id'>
let htmlSchema: ReturnType<typeof getSchema> | undefined

function escapeMarkdown(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/[\\`*_{}\[\]<>#+.!|~()-]/g, '\\$&')
}

function wrapMark(text: string, marker: string): string {
  return text.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, before: string, body: string, after: string) => body ? `${before}${marker}${body}${marker}${after}` : text)
}

function codeFence(text: string, minimum: number): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  return '`'.repeat(Math.max(minimum, longest + 1))
}

function inline(node: RichText, format: NoteExportFormat): string {
  if (node.type === 'hardBreak') return format === 'md' ? '  \n' : '\n'
  if (node.type !== 'text') return (node.content ?? []).map(child => inline(child, format)).join('')
  const raw = node.text ?? ''
  if (format === 'txt') return raw
  let text = escapeMarkdown(raw)
  if (node.marks?.some(mark => mark.type === 'code')) {
    const fence = codeFence(raw, 1)
    text = `${fence} ${raw} ${fence}`
  }
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') text = wrapMark(text, '**')
    if (mark.type === 'italic') text = wrapMark(text, '*')
    if (mark.type === 'strike') text = wrapMark(text, '~~')
    if (mark.type === 'highlight') text = `<mark>${text}</mark>`
    if (mark.type === 'underline') text = `<u>${text}</u>`
    if (mark.type === 'link' && typeof mark.attrs?.href === 'string' && /^(https?:|mailto:)/i.test(mark.attrs.href)) {
      const href = mark.attrs.href.replace(/[\s<>()[\]\\]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
      text = `[${text}](${href})`
    }
  }
  return text
}

function block(node: RichText, format: NoteExportFormat): string {
  const children = node.content ?? []
  switch (node.type) {
    case 'doc': return children.map(child => block(child, format)).join('\n\n')
    case 'paragraph': return inline(node, format)
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(node.attrs?.level) || 1))
      return `${format === 'md' ? `${'#'.repeat(level)} ` : ''}${inline(node, format)}`
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const start = Number(node.attrs?.start) || 1
      return children.map((item, index) => {
        const marker = node.type === 'orderedList' ? `${start + index}. ` : node.type === 'taskList' ? `- [${item.attrs?.checked ? 'x' : ' '}] ` : '- '
        const body = (item.content ?? []).map(child => block(child, format)).join('\n\n')
        return marker + body.replace(/\n/g, `\n${' '.repeat(marker.length)}`)
      }).join('\n')
    }
    case 'blockquote': return children.map(child => block(child, format)).join('\n\n').split('\n').map(line => `> ${line}`).join('\n')
    case 'codeBlock': {
      const text = inline(node, 'txt')
      if (format === 'txt') return text
      const fence = codeFence(text, 3)
      return `${fence}\n${text}\n${fence}`
    }
    case 'horizontalRule': return '---'
    default: throw new Error(`无法导出未支持的正文类型：${node.type}`)
  }
}

export function makeNoteExport(note: ExportContent, format: NoteExportFormat): { filename: string; content: string; mimeType: string } {
  const title = note.title.trim() ? note.title : '无标题'
  let basename = Array.from(title.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')).slice(0, 80).join('').replace(/[. ]+$/g, '').trim() || '无标题'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename)) basename = `便签-${basename}`
  if (format === 'html') {
    const schema = htmlSchema ??= getSchema(createEditorExtensions())
    const doc = schema.nodeFromJSON(note.doc)
    doc.check()
    const container = document.createElement('main')
    const heading = document.createElement('h1')
    heading.textContent = title
    container.append(heading, DOMSerializer.fromSchema(schema).serializeFragment(doc.content))
    container.querySelectorAll('input').forEach(input => { input.disabled = true })
    container.querySelectorAll('a').forEach(link => {
      if (!/^(https?:|mailto:)/i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href')
    })
    const escapedTitle = document.createElement('span')
    escapedTitle.textContent = title
    return {
      filename: `${basename}.html`, mimeType: 'text/html;charset=utf-8',
      content: `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle.innerHTML}</title><style>body{max-width:760px;margin:32px auto;padding:0 24px;font:16px/1.7 system-ui;color:#292929;overflow-wrap:anywhere}h1,h2,h3{line-height:1.35}mark{background:#fff2b3;color:#343025;padding:2px 4px;border-radius:3px}pre{overflow:auto;padding:16px;background:#f4f4f1}blockquote{margin-left:0;padding-left:16px;border-left:3px solid #ccc;color:#666}ul[data-type="taskList"]{list-style:none;padding-left:0}li[data-type="taskItem"]{display:flex;gap:8px;align-items:baseline}li[data-type="taskItem"]>div{flex:1}li[data-type="taskItem"]>div>p{margin:0}</style></head><body>${container.outerHTML}</body></html>\n`
    }
  }
  const heading = format === 'md' ? `# ${escapeMarkdown(title)}` : title
  return {
    filename: `${basename}.${format}`,
    content: `${heading}\n\n${block(note.doc, format)}\n`,
    mimeType: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function downloadNoteExport(note: ExportContent, format: NoteExportFormat): void {
  const exported = makeNoteExport(note, format)
  downloadBlob(new Blob([exported.content], { type: exported.mimeType }), exported.filename)
}

function safeName(name: string): string {
  return makeNoteExport({ title: name, doc: { type: 'doc', content: [] } }, 'txt').filename.slice(0, -4)
}

function uniqueName(name: string, used: Set<string>, extension = ''): string {
  let candidate = name + extension
  let count = 2
  while (used.has(candidate.normalize('NFC').toLowerCase())) candidate = `${name} (${count++})${extension}`
  used.add(candidate.normalize('NFC').toLowerCase())
  return candidate
}

export function prepareBatchExport(notes: ExportNote[], folders: FolderRecord[], scope: BatchExportScope, kind: BatchExportKind) {
  const activeFolders = folders.filter(folder => !folder.deletedAt)
  const folder = scope.kind === 'folder' && scope.folderId ? activeFolders.find(item => item.id === scope.folderId) : null
  if (scope.kind === 'folder' && scope.folderId && !folder) throw new Error('所选文件夹已不可用，请重新选择')
  const selected = notes.filter(note => scope.kind === 'all' || note.folderId === scope.folderId)
    .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  if (!selected.length) throw new Error('所选范围没有可导出的便签')
  const format = kind.split('-')[0] as NoteExportFormat
  const scopeName = scope.kind === 'all' ? '全部便签' : folder?.name ?? '未分类'
  const base = `只是便签导出-${safeName(scopeName)}`
  if (kind.endsWith('-merged')) {
    const separator = format === 'md' ? '\n\n---\n\n' : `\n\n${'='.repeat(40)}\n\n`
    return { filename: `${base}.${format}`, content: selected.map(note => makeNoteExport(note, format).content).join(separator), files: null, count: selected.length }
  }
  const directoryNames = new Set<string>(['未分类'])
  const folderPaths = new Map([...activeFolders].sort((a, b) => a.id.localeCompare(b.id)).map(item => [item.id, uniqueName(safeName(item.name), directoryNames)]))
  const usedPaths = new Set<string>()
  const files: Record<string, Uint8Array> = Object.create(null)
  for (const note of selected) {
    const file = makeNoteExport(note, format)
    const directory = note.folderId ? folderPaths.get(note.folderId) ?? '未分类' : '未分类'
    const extension = `.${format}`
    const path = uniqueName(`${directory}/${file.filename.slice(0, -extension.length)}`, usedPaths, extension)
    files[path] = strToU8(file.content)
  }
  return { filename: `${base}-${format.toUpperCase()}.zip`, content: null, files, count: selected.length }
}

export async function downloadBatchExport(db: NoteDatabase, scope: BatchExportScope, kind: BatchExportKind): Promise<number> {
  const snapshot = await db.transaction('r', db.notes, db.bodies, db.folders, async () => {
    const notes = (await db.notes.toArray()).filter(note => !note.deletedAt)
    const bodies = new Map((await db.bodies.bulkGet(notes.map(note => note.id))).flatMap(body => body ? [[body.id, body] as const] : []))
    return {
      notes: notes.map(note => ({ ...note, doc: bodies.get(note.id)?.doc ?? { type: 'doc', content: [] } })),
      folders: await db.folders.toArray()
    }
  })
  const exported = prepareBatchExport(snapshot.notes, snapshot.folders, scope, kind)
  const blob = exported.files
    ? new Blob([Uint8Array.from(await new Promise<Uint8Array>((resolve, reject) => zip(exported.files!, { level: 6 }, (error, data) => error ? reject(error) : resolve(data)))).buffer], { type: 'application/zip' })
    : new Blob([exported.content!], { type: kind.startsWith('md') ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' })
  downloadBlob(blob, exported.filename)
  return exported.count
}
