import { getSchema, getTextBetween } from '@tiptap/react'
import { describe, expect, it } from 'vitest'
import { createEditorExtensions, editorBlockSeparator, editorCoreExtensionOptions } from '../src/lib/editor'

describe('editor clipboard plain text', () => {
  it('keeps a single newline between paragraphs (not TipTap default blank lines)', () => {
    const schema = getSchema(createEditorExtensions())
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '第一行' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '第二行' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '第三行' }] }
      ]
    })
    const range = { from: 0, to: doc.content.size }

    expect(getTextBetween(doc, range)).toBe('第一行\n\n第二行\n\n第三行')
    expect(getTextBetween(doc, range, { blockSeparator: editorBlockSeparator })).toBe('第一行\n第二行\n第三行')
    expect(editorCoreExtensionOptions.clipboardTextSerializer.blockSeparator).toBe(editorBlockSeparator)
  })
})
