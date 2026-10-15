import { deleteAccountDb, emptyDocument, type ConflictRecord, type FolderRecord, type NoteBody, type NoteDatabase, type NoteRecord, type RichText } from './db'
import { checkedFolderName, clampTitle, summaryFromText, titleFromText, titleWithSuffix } from './text'

const now = () => new Date().toISOString()
const TRASH_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

type SearchIndex = { text: Map<string, string>; seq: Map<string, number>; ready: boolean }
const searchIndexes = new WeakMap<NoteDatabase, SearchIndex>()

let persistenceRequested = false

function requestPersistentStorage() {
  if (persistenceRequested || typeof navigator === 'undefined' || !navigator.storage?.persist) return
  persistenceRequested = true
  void navigator.storage.persist().catch(() => undefined)
}

function asLocalError(cause: unknown): Error {
  if (cause instanceof Error && (cause.message === '便签不存在' || cause.message === '文件夹不存在')) return cause
  const name = cause instanceof Error ? cause.name : ''
  if (name === 'QuotaExceededError') return new Error('本机存储空间不足，这条内容还没保存')
  return cause instanceof Error ? cause : new Error('本地保存失败')
}

function touchIndex(db: NoteDatabase, id: string, plainText: string, editSeq: number) {
  const index = searchIndexes.get(db)
  if (!index?.ready) return
  index.text.set(id, plainText.toLocaleLowerCase())
  index.seq.set(id, editSeq)
}

function blankNote(folderId: string | null, title: string, summary: string): NoteRecord {
  const stamp = now()
  return {
    id: crypto.randomUUID(),
    title,
    summary,
    folderId,
    isPinned: false,
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
    serverVersion: 0,
    dirty: 1,
    editSeq: 1,
    hasConflict: 0
  }
}

export async function createNote(db: NoteDatabase, folderId: string | null) {
  const note = blankNote(folderId, '', '')
  await db.transaction('rw', db.notes, db.bodies, async () => {
    await db.notes.add(note)
    await db.bodies.add({ id: note.id, doc: emptyDocument, plainText: '' })
  })
  touchIndex(db, note.id, '', note.editSeq)
  requestPersistentStorage()
  return note
}

export async function createNoteWithContent(db: NoteDatabase, folderId: string | null, title: string, doc: RichText, plainText: string) {
  const note = blankNote(folderId, titleFromText(plainText) || clampTitle(title), summaryFromText(plainText))
  await db.transaction('rw', db.notes, db.bodies, async () => {
    await db.notes.add(note)
    await db.bodies.add({ id: note.id, doc, plainText })
  })
  touchIndex(db, note.id, plainText, note.editSeq)
  requestPersistentStorage()
  return note
}

export async function saveNoteContent(
  db: NoteDatabase,
  id: string,
  change: { title: string; doc: RichText; plainText: string },
  loadedEditSeq: number
): Promise<{ editSeq: number }> {
  const title = titleFromText(change.plainText) || clampTitle(change.title)
  const summary = summaryFromText(change.plainText)
  try {
    const saved = await db.transaction('rw', db.notes, db.bodies, db.conflicts, async () => {
      const note = await db.notes.get(id)
      const body = await db.bodies.get(id)
      if (!note || !body) throw new Error('便签不存在')
      let hasConflict = note.hasConflict
      if (note.editSeq !== loadedEditSeq) {
        await keepDisplacedVersion(db, note, body)
        hasConflict = 1
      }
      const editSeq = note.editSeq + 1
      await db.bodies.put({ id, doc: change.doc, plainText: change.plainText })
      await db.notes.put({ ...note, title, summary, updatedAt: now(), dirty: 1, editSeq, hasConflict })
      return { editSeq }
    })
    touchIndex(db, id, change.plainText, saved.editSeq)
    requestPersistentStorage()
    return saved
  } catch (cause) {
    throw asLocalError(cause)
  }
}

async function keepDisplacedVersion(db: NoteDatabase, note: NoteRecord, body: NoteBody) {
  const existing = await db.conflicts.get(note.id)
  if (existing) {
    const copy = blankNote(note.folderId, titleWithSuffix(note.title, '（自动副本）'), body.plainText.slice(0, 80))
    await db.notes.add(copy)
    await db.bodies.add({ id: copy.id, doc: body.doc, plainText: body.plainText })
    return
  }
  const snapshot: ConflictRecord = {
    noteId: note.id,
    title: note.title,
    doc: body.doc,
    plainText: body.plainText,
    folderId: note.folderId,
    isPinned: note.isPinned,
    serverVersion: note.serverVersion,
    updatedAt: note.updatedAt
  }
  await db.conflicts.put(snapshot)
}

export async function updateNoteMeta(db: NoteDatabase, id: string, change: Partial<Pick<NoteRecord, 'folderId' | 'isPinned' | 'deletedAt'>>) {
  await db.transaction('rw', db.notes, async () => {
    const note = await db.notes.get(id)
    if (!note) throw new Error('便签不存在')
    await db.notes.put({ ...note, ...change, dirty: 1, updatedAt: now() })
  })
}

export async function createFolder(db: NoteDatabase, name: string) {
  const trimmed = checkedFolderName(name)
  return db.transaction('rw', db.folders, async () => {
    const folders = await db.folders.toArray()
    const stamp = now()
    const folder: FolderRecord = {
      id: crypto.randomUUID(),
      name: trimmed,
      sortOrder: Math.max(-1, ...folders.map(item => item.sortOrder)) + 1,
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: null,
      serverVersion: 0,
      dirty: 1
    }
    await db.folders.add(folder)
    return folder
  })
}

export async function renameFolder(db: NoteDatabase, id: string, name: string) {
  const trimmed = checkedFolderName(name)
  await db.transaction('rw', db.folders, async () => {
    const folder = await db.folders.get(id)
    if (!folder) throw new Error('文件夹不存在')
    await db.folders.put({ ...folder, name: trimmed, dirty: 1, updatedAt: now() })
  })
}

export async function reorderFolders(db: NoteDatabase, orderedIds: string[]) {
  const stamp = now()
  await db.transaction('rw', db.folders, async () => {
    for (const [index, id] of orderedIds.entries()) {
      const folder = await db.folders.get(id)
      if (!folder || folder.deletedAt || folder.sortOrder === index) continue
      await db.folders.put({ ...folder, sortOrder: index, dirty: 1, updatedAt: stamp })
    }
  })
}

export async function deleteFolder(db: NoteDatabase, folderId: string) {
  const stamp = now()
  await db.transaction('rw', db.folders, db.notes, async () => {
    const folder = await db.folders.get(folderId)
    if (!folder) throw new Error('文件夹不存在')
    await db.folders.put({ ...folder, deletedAt: stamp, updatedAt: stamp, dirty: 1 })
    const notes = await db.notes.where('folderId').equals(folderId).toArray()
    for (const note of notes) await db.notes.put({ ...note, folderId: null, dirty: 1, updatedAt: stamp })
  })
}

export async function resolveConflict(db: NoteDatabase, noteId: string, choice: 'current' | 'other' | 'both') {
  await db.transaction('rw', db.notes, db.bodies, db.conflicts, async () => {
    const conflict = await db.conflicts.get(noteId)
    const note = await db.notes.get(noteId)
    const body = await db.bodies.get(noteId)
    if (!conflict || !note || !body) return
    if (choice === 'both') {
      const copy = blankNote(note.folderId, titleWithSuffix(note.title, '（副本）'), body.plainText.slice(0, 80))
      await db.notes.add(copy)
      await db.bodies.add({ id: copy.id, doc: body.doc, plainText: body.plainText })
    }
    if (choice === 'other' || choice === 'both') {
      const editSeq = note.editSeq + 1
      await db.bodies.put({ id: noteId, doc: conflict.doc, plainText: conflict.plainText })
      await db.notes.put({
        ...note,
        title: conflict.title,
        summary: conflict.plainText.slice(0, 80),
        folderId: conflict.folderId,
        isPinned: conflict.isPinned,
        editSeq,
        dirty: 1,
        hasConflict: 0,
        updatedAt: now()
      })
    } else {
      await db.notes.put({ ...note, hasConflict: 0 })
    }
    await db.conflicts.delete(noteId)
  })
}

export async function purgeExpiredTrash(db: NoteDatabase, retentionDays = TRASH_DAYS, nowMs = Date.now()) {
  const cutoff = nowMs - retentionDays * DAY_MS
  const expired = (await db.notes.toArray()).filter(note => note.deletedAt !== null && Date.parse(note.deletedAt) < cutoff)
  if (expired.length === 0) return 0
  await db.transaction('rw', db.notes, db.bodies, db.conflicts, async () => {
    for (const note of expired) {
      await db.notes.delete(note.id)
      await db.bodies.delete(note.id)
      await db.conflicts.delete(note.id)
    }
  })
  const index = searchIndexes.get(db)
  if (index) {
    for (const note of expired) {
      index.text.delete(note.id)
      index.seq.delete(note.id)
    }
  }
  return expired.length
}

export async function searchNoteIds(db: NoteDatabase, query: string, notes: NoteRecord[]) {
  const needle = query.trim().toLocaleLowerCase()
  const ids = new Set<string>()
  if (!needle) return ids
  const index = await ensureIndex(db, notes)
  for (const note of notes) {
    if (note.deletedAt) continue
    if (note.title.toLocaleLowerCase().includes(needle) || (index.text.get(note.id) ?? '').includes(needle)) ids.add(note.id)
  }
  return ids
}

async function ensureIndex(db: NoteDatabase, notes: NoteRecord[]) {
  let index = searchIndexes.get(db)
  if (!index) {
    index = { text: new Map(), seq: new Map(), ready: false }
    searchIndexes.set(db, index)
  }
  if (!index.ready) {
    await db.bodies.each(body => index!.text.set(body.id, body.plainText.toLocaleLowerCase()))
    for (const note of notes) index.seq.set(note.id, note.editSeq)
    index.ready = true
    return index
  }
  for (const note of notes) {
    if (index.seq.get(note.id) === note.editSeq) continue
    const body = await db.bodies.get(note.id)
    index.text.set(note.id, (body?.plainText ?? '').toLocaleLowerCase())
    index.seq.set(note.id, note.editSeq)
  }
  return index
}

export async function exportAccount(db: NoteDatabase) {
  const notes = await db.notes.toArray()
  const bodies = await db.bodies.toArray()
  const bodyById = new Map(bodies.map(body => [body.id, body]))
  return {
    format: 'just-note-backup' as const,
    version: 1 as const,
    exportedAt: now(),
    notes: notes.map(note => ({
      ...note,
      doc: bodyById.get(note.id)?.doc ?? emptyDocument,
      plainText: bodyById.get(note.id)?.plainText ?? ''
    })),
    folders: await db.folders.toArray(),
    conflicts: await db.conflicts.toArray()
  }
}

export type StorageEstimate = {
  notes: number
  noteBytes: number
  conflictBytes: number
  siteUsageBytes: number | null
  siteQuotaBytes: number | null
  persisted: boolean | null
}

export async function estimateStorage(db: NoteDatabase): Promise<StorageEstimate> {
  const encoder = new TextEncoder()
  const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength
  let noteBytes = 0
  let conflictBytes = 0
  await db.notes.each(item => { noteBytes += size(item) })
  await db.bodies.each(item => { noteBytes += size(item) })
  await db.folders.each(item => { noteBytes += size(item) })
  await db.conflicts.each(item => { conflictBytes += size(item) })
  let siteUsageBytes: number | null = null
  let siteQuotaBytes: number | null = null
  let persisted: boolean | null = null
  try {
    const estimate = await navigator.storage?.estimate?.()
    siteUsageBytes = estimate?.usage ?? null
    siteQuotaBytes = estimate?.quota ?? null
    persisted = navigator.storage?.persist ? await navigator.storage.persist() : null
  } catch { /* Browser storage estimates are optional. */ }
  return { notes: await db.notes.count(), noteBytes, conflictBytes, siteUsageBytes, siteQuotaBytes, persisted }
}

export async function wipeAccount(userId: string) {
  await deleteAccountDb(userId)
}
