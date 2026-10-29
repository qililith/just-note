import { getSchema } from '@tiptap/react'
import { describe, expect, it } from 'vitest'
import type { RichText } from '../src/lib/db'
import { checkDocument, createEditorExtensions } from '../src/lib/editor'
import { clipboardPrefersFile, combineMarkdownFiles, looksLikeMarkdown, markdownPasteSlice, markdownToDocument } from '../src/lib/markdownPaste'

function convert(text: string, options?: { force?: boolean }): RichText {
  const doc = markdownToDocument(text, options)
  expect(doc).not.toBeNull()
  checkDocument(doc)
  return doc!
}

function texts(node: RichText | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(texts).join('')
}

describe('markdown paste', () => {
  it('leaves ordinary notes, arithmetic, filenames, and source code untouched', () => {
    expect(markdownToDocument('今天只是记一笔\n没有记号')).toBeNull()
    expect(markdownToDocument('价格是 3 * 4 = 12')).toBeNull()
    expect(markdownToDocument('file_name_here')).toBeNull()
    expect(markdownToDocument('这是 *强调* 而已')).toBeNull()
    expect(markdownToDocument('2024. 元旦')).toBeNull()
    expect(markdownToDocument('#include <stdio.h>\nint main() {\n  return 0;\n}')).toBeNull()
    expect(markdownToDocument('# comment\nfunction hi() {\n  return 1;\n}')).toBeNull()
    expect(markdownToDocument('- 只是一条横线笔记')).toBeNull()
    expect(markdownToDocument('1. 只有一步')).toBeNull()
    expect(markdownToDocument('> 随口一提')).toBeNull()
    expect(markdownToDocument('今天的记录\n---\n明天再看')).toBeNull()
    expect(looksLikeMarkdown('**未闭合')).toBe(false)
  })

  it('turns a markdown note into headings, emphasis, lists, quotes, and rules', () => {
    const doc = convert('# 标题\n\n短句\n下一句\n\n## 第二节\n\n- 牛奶\n  - 燕麦\n- [x] 完成 **重点**\n\n> 引用一行\n> 第二行\n\n---\n\n#### 更深')
    expect(doc.content?.map(node => node.type)).toEqual(['heading', 'paragraph', 'heading', 'bulletList', 'taskList', 'blockquote', 'horizontalRule', 'heading'])
    expect(doc.content?.[0].attrs).toEqual({ level: 1 })
    expect(texts(doc.content?.[0])).toBe('标题')
    expect(doc.content?.[1].content?.some(node => node.type === 'hardBreak')).toBe(true)
    expect(texts(doc.content?.[1])).toBe('短句\n下一句')
    const nested = doc.content?.[3].content?.[0].content
    expect(nested?.map(node => node.type)).toEqual(['paragraph', 'bulletList'])
    const task = doc.content?.[4].content?.[0]
    expect(task?.attrs).toEqual({ checked: true })
    expect(task?.content?.[0].content?.find(node => node.text === '重点')?.marks).toEqual([{ type: 'bold' }])
    expect(doc.content?.[5].type).toBe('blockquote')
    expect(doc.content?.[7].attrs).toEqual({ level: 3 })
  })

  it('keeps every source line, and only formats inline marks when there is no document structure', () => {
    const long = '这是一段被编辑器折得很长很长很长很长很长很长很长很长很长很长的文字'
    const doc = convert(`\`\`\`js\nconst x = 1\n**not bold**\n\`\`\`\n\n${long}\n还是同一段\n\n***both*** and snake_case\n\n[安全](https://example.com/a) [脚本](javascript:alert(1)) ![图](https://example.com/a.png)\n\n<mark>高亮 **粗**</mark> <u>下划线</u>`)
    expect(texts(doc.content?.[0])).toBe('const x = 1\n**not bold**')
    expect(texts(doc.content?.[1])).toBe(`${long}\n还是同一段`)
    expect(doc.content?.[1].content?.some(node => node.type === 'hardBreak')).toBe(true)
    const both = doc.content?.[2].content?.[0]
    expect(both?.marks?.map(mark => mark.type).sort()).toEqual(['bold', 'italic'])
    const link = doc.content?.[3].content?.find(node => node.text === '安全')
    expect(link?.marks?.[0]).toEqual({ type: 'link', attrs: { href: 'https://example.com/a' } })
    expect(doc.content?.[3].content?.find(node => node.text === '脚本')?.marks).toBeUndefined()
    expect(doc.content?.[3].content?.some(node => node.text?.includes('javascript:'))).toBe(false)
    expect(doc.content?.[3].content?.find(node => node.text === '图')?.marks?.[0].attrs?.href).toBe('https://example.com/a.png')
    expect(doc.content?.[4].content?.find(node => node.text === '粗')?.marks?.map(mark => mark.type).sort()).toEqual(['bold', 'highlight'])
    expect(doc.content?.[4].content?.find(node => node.text === '下划线')?.marks).toEqual([{ type: 'underline' }])
  })

  it('reads tables as labeled rows and keeps front matter after the article', () => {
    const doc = convert('---\ntitle: 笔记\ntags:\n  - 生活\n---\n\n# 正文\n\n| 姓名 | 角色 |\n| --- | --- |\n| Ada | 工程 |\n\n1. 第一步')
    expect(doc.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    const table = doc.content?.find(node => node.type === 'bulletList')
    expect(texts(table?.content?.[0])).toBe('姓名：Ada；角色：工程')
    expect(table?.content?.[0].content?.[0].content?.find(node => node.text === '姓名：')?.marks).toEqual([{ type: 'bold' }])
    expect(doc.content?.some(node => node.type === 'orderedList')).toBe(true)
    expect(texts(doc.content?.at(-2))).toBe('title：笔记')
    expect(texts(doc.content?.at(-1))).toBe('tags：生活')
  })

  it('opens a pasted paragraph into the current line and keeps a heading closed', () => {
    const schema = getSchema(createEditorExtensions())
    const inline = markdownPasteSlice(schema, '**粗体**')
    const blocks = markdownPasteSlice(schema, '# 标题\n\n正文')
    expect(inline?.openStart).toBe(1)
    expect(inline?.openEnd).toBe(1)
    expect(blocks?.openStart).toBe(0)
    expect(blocks?.openEnd).toBe(1)
    expect(markdownPasteSlice(schema, '普通句子')).toBeNull()
    const mixed = convert('记得 **买菜**\n- 这行还是普通文字')
    expect(mixed.content?.map(node => node.type)).toEqual(['paragraph', 'paragraph'])
    expect(mixed.content?.[1].content?.[0].text).toBe('- 这行还是普通文字')
    expect(mixed.content?.[0].content?.some(node => node.marks?.some(mark => mark.type === 'bold'))).toBe(true)
  })

  it('treats a markdown file as markdown even without syntax, and joins several files', () => {
    const doc = convert('第一行\n第二行', { force: true })
    expect(doc.content?.[0].content?.some(node => node.type === 'hardBreak')).toBe(true)
    expect(combineMarkdownFiles([{ name: '一.md', text: '甲' }, { name: '二.markdown', text: '乙' }])).toBe('## 一\n\n甲\n\n## 二\n\n乙')
    expect(clipboardPrefersFile('C:\\笔记\\今日.md', [{ name: '今日.md' }])).toBe(true)
    expect(clipboardPrefersFile('# 标题\n\n正文', [{ name: '今日.md' }])).toBe(false)
  })
})