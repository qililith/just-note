import Dexie, { type EntityTable } from 'dexie'

export type RichText = {
  type: string
  attrs?: Record<string, unknown>
  content?: RichText[]
  marks?: { type: string; attrs?: Record<string, unknown>; [key: string]: unknown }[]
  text?: string
  [key: string]: unknown
}

export const emptyDocument: RichText = { type: 'doc', content: [{ type: 'paragraph' }] }

export type NoteRecord = {
  id: string
  title: string
  summary: string
  folderId: string | null
  isPinned: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  serverVersion: number
  dirty: 0 | 1
  editSeq: number
  hasConflict: 0 | 1
}

export type NoteBody = {
  id: string
  doc: RichText
  plainText: string
}

export type FolderRecord = {
  id: string
  name: string
  sortOrder: number
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  serverVersion: number
  dirty: 0 | 1
}

export type ConflictRecord = {
  noteId: string
  title: string
  doc: RichText
  plainText: string
  folderId: string | null
  isPinned: boolean
  serverVersion: number
  updatedAt: string
}

export type MetaRecord = {
  key: string
  value: string
}

export class NoteDatabase extends Dexie {
  notes!: EntityTable<NoteRecord, 'id'>
  bodies!: EntityTable<NoteBody, 'id'>
  folders!: EntityTable<FolderRecord, 'id'>
  conflicts!: EntityTable<ConflictRecord, 'noteId'>
  meta!: EntityTable<MetaRecord, 'key'>

  constructor(userId: string) {
    super(databaseName(userId))
    this.version(1).stores({
      notes: 'id, folderId, dirty, updatedAt, deletedAt',
      bodies: 'id',
      folders: 'id, deletedAt, sortOrder, dirty',
      conflicts: 'noteId',
      meta: 'key'
    })
  }
}

const openDatabases = new Map<string, NoteDatabase>()

export function databaseName(userId: string) {
  return `just-note-${userId}`
}

export function accountDb(userId: string) {
  const existing = openDatabases.get(userId)
  if (existing) return existing
  const db = new NoteDatabase(userId)
  openDatabases.set(userId, db)
  return db
}

export async function deleteAccountDb(userId: string) {
  const existing = openDatabases.get(userId)
  if (existing) {
    openDatabases.delete(userId)
    existing.close()
  }
  await Dexie.delete(databaseName(userId))
}
