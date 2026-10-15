import { afterEach, describe, expect, it } from 'vitest'
import { accountDb, deleteAccountDb, emptyDocument } from '../src/lib/db'
import { createFolder, createNote, deleteFolder, purgeExpiredTrash, saveNoteContent, searchNoteIds, updateNoteMeta } from '../src/lib/notes'

const userId = 'notes-test-user'

afterEach(async () => {
  await deleteAccountDb(userId)
})

describe('local notes', () => {
  it('saves without checking a version and keeps a displaced copy', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '一', doc: emptyDocument, plainText: '第一版' }, 1)

    await saveNoteContent(db, note.id, { title: '二', doc: emptyDocument, plainText: '第二版' }, 1)
    const conflict = await db.conflicts.get(note.id)
    const body = await db.bodies.get(note.id)
    expect(conflict?.plainText).toBe('第一版')
    expect(body?.plainText).toBe('第二版')
    expect((await db.notes.get(note.id))?.hasConflict).toBe(1)

    await saveNoteContent(db, note.id, { title: '三', doc: emptyDocument, plainText: '第三版' }, 1)
    const copies = (await db.notes.toArray()).filter(item => item.title.includes('自动副本'))
    expect(copies).toHaveLength(1)
    expect((await db.bodies.get(copies[0].id))?.plainText).toBe('第二版')
    expect((await db.bodies.get(note.id))?.plainText).toBe('第三版')
  })

  it('does not treat pin or folder changes as content edits', async () => {
    const db = accountDb(userId)
    const folder = await createFolder(db, '工作')
    const note = await createNote(db, null)
    await updateNoteMeta(db, note.id, { isPinned: true, folderId: folder.id })
    const stored = await db.notes.get(note.id)
    expect(stored?.editSeq).toBe(1)
    expect(stored?.isPinned).toBe(true)
    expect(stored?.dirty).toBe(1)
  })

  it('moves notes out of a deleted folder and finds text ignoring case', async () => {
    const db = accountDb(userId)
    const folder = await createFolder(db, '工作')
    const note = await createNote(db, folder.id)
    await saveNoteContent(db, note.id, { title: '会议', doc: emptyDocument, plainText: 'Hello World' }, 1)
    await deleteFolder(db, folder.id)
    expect((await db.notes.get(note.id))?.folderId).toBeNull()
    expect((await db.folders.get(folder.id))?.deletedAt).not.toBeNull()
    const ids = await searchNoteIds(db, 'hello', await db.notes.toArray())
    expect(ids.has(note.id)).toBe(true)
  })

  it('purges trash older than 30 days and keeps everything else', async () => {
    const db = accountDb(userId)
    const oldNote = await createNote(db, null)
    const recentNote = await createNote(db, null)
    const liveNote = await createNote(db, null)
    const nowMs = Date.parse('2026-10-15T00:00:00.000Z')
    await updateNoteMeta(db, oldNote.id, { deletedAt: new Date(nowMs - 31 * 24 * 60 * 60 * 1000).toISOString() })
    await updateNoteMeta(db, recentNote.id, { deletedAt: new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString() })
    expect(await purgeExpiredTrash(db, 30, nowMs)).toBe(1)
    expect(await db.notes.get(oldNote.id)).toBeUndefined()
    expect(await db.bodies.get(oldNote.id)).toBeUndefined()
    expect(await db.notes.get(recentNote.id)).toBeTruthy()
    expect(await db.notes.get(liveNote.id)).toBeTruthy()
  })
})
