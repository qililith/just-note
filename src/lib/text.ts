import type { RichText } from './db'

export const MAX_TITLE_LENGTH = 255
export const MAX_FOLDER_NAME_LENGTH = 255

export function clampTitle(title: string): string {
  return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) : title
}

export function titleFromText(plainText: string): string {
  const line = plainText.split(/\r?\n/).find(part => part.trim()) ?? ''
  return clampTitle(line.trim())
}

export function summaryFromText(plainText: string): string {
  const lines = plainText.split(/\r?\n/).map(part => part.trim()).filter(Boolean)
  return (lines.slice(1).join(' ') || lines[0] || '').slice(0, 80)
}

export function checkedFolderName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('请输入文件夹名称')
  if (trimmed.length > MAX_FOLDER_NAME_LENGTH) throw new Error(`文件夹名称最多 ${MAX_FOLDER_NAME_LENGTH} 个字符`)
  return trimmed
}

export function titleWithSuffix(title: string, suffix: string): string {
  const base = title || '无标题'
  return base.length + suffix.length <= MAX_TITLE_LENGTH ? `${base}${suffix}` : base
}

export function withLeadingTitle(title: string, doc: RichText, plainText: string): { doc: RichText; plainText: string } {
  const trimmed = title.trim()
  if (!trimmed || trimmed === '无标题' || titleFromText(plainText) === trimmed) return { doc, plainText }
  return {
    doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: trimmed }] }, ...(doc.content ?? [])] },
    plainText: plainText ? `${trimmed}\n${plainText}` : trimmed
  }
}
