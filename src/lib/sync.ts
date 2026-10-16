import { accountDb, emptyDocument, type ConflictRecord, type FolderRecord, type NoteDatabase, type NoteRecord, type RichText } from './db'
import { summaryFromText, titleFromText } from './text'
import { demoMode, supabase } from './supabase'

const CURSOR_KEY = 'syncCursor'
const mutationKey = (entity: 'note' | 'folder', id: string) => `mutation:${entity}:${id}`

export type SyncOutcome = { ok: true } | { ok: false; reason: string }

type CloudNote = {
  id: string
  title: string
  doc: RichText
  plain_text: string
  folder_id: string | null
  is_pinned: boolean
  created_at: string
  updated_at: string
  deleted_at: string | null
  version: number | string
}

type CloudFolder = {
  id: string
  name: string
  sort_order: number
  created_at: string
  updated_at: string
  deleted_at: string | null
  version: number | string
}

type PullItem = { seq: string; entity: 'note' | 'folder'; record: CloudNote | CloudFolder }
type PullPage = { items: PullItem[]; next: string }
type MutationResult = { status: 'ok' | 'conflict'; record: CloudNote | CloudFolder | null; seq?: string }

type SyncRpc = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
  auth: { getSession(): PromiseLike<{ data: { session: unknown } }> }
}

function asVersion(value: number | string | undefined): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

async function readCursor(db: NoteDatabase) {
  return (await db.meta.get(CURSOR_KEY))?.value ?? '0'
}

async function writeCursor(db: NoteDatabase, value: string) {
  const current = await readCursor(db)
  if (BigInt(value) < BigInt(current)) return
  await db.meta.put({ key: CURSOR_KEY, value })
}

async function mutationIdFor(db: NoteDatabase, entity: 'note' | 'folder', id: string) {
  const key = mutationKey(entity, id)
  const existing = await db.meta.get(key)
  if (existing?.value) return existing.value
  const next = crypto.randomUUID()
  await db.meta.put({ key, value: next })
  return next
}

async function clearMutationId(db: NoteDatabase, entity: 'note' | 'folder', id: string) {
  await db.meta.delete(mutationKey(entity, id))
}

async function callPull(client: SyncRpc, after: string, limit = 100): Promise<PullPage> {
  const { data, error } = await client.rpc('pull_changes', { p_after: after, p_limit: limit })
  if (error) throw new Error(error.message)
  const page = data as PullPage | null
  if (!page || !Array.isArray(page.items) || typeof page.next !== 'string') throw new Error('拉取结果无效')
  return page
}

async function callApply(
  client: SyncRpc,
  mutationId: string,
  entity: 'note' | 'folder',
  entityId: string,
  baseVersion: number,
  payload: Record<string, unknown>
): Promise<MutationResult> {
  const { data, error } = await client.rpc('apply_mutation', {
    p_mutation_id: mutationId,
    p_entity: entity,
    p_entity_id: entityId,
    p_base_version: baseVersion,
    p_payload: payload
  })
  if (error) throw new Error(error.message)
  const result = data as MutationResult | null
  if (!result || (result.status !== 'ok' && result.status !== 'conflict')) throw new Error('上传结果无效')
  return result
}

async function keepRemoteNoteConflict(db: NoteDatabase, note: NoteRecord, remote: CloudNote) {
  const version = asVersion(remote.version)
  const snapshot: ConflictRecord = {
    noteId: note.id,
    title: remote.title ?? '',
    doc: remote.doc ?? emptyDocument,
    plainText: remote.plain_text ?? '',
    folderId: remote.folder_id ?? null,
    isPinned: Boolean(remote.is_pinned),
    serverVersion: version,
    updatedAt: remote.updated_at ?? note.updatedAt
  }
  await db.transaction('rw', db.notes, db.conflicts, async () => {
    const current = await db.notes.get(note.id)
    if (!current) return
    await db.conflicts.put(snapshot)
    await db.notes.put({ ...current, serverVersion: version, hasConflict: 1 })
  })
}

async function applyRemoteFolder(db: NoteDatabase, remote: CloudFolder) {
  const version = asVersion(remote.version)
  const folder: FolderRecord = {
    id: remote.id,
    name: remote.name,
    sortOrder: remote.sort_order ?? 0,
    createdAt: remote.created_at,
    updatedAt: remote.updated_at,
    deletedAt: remote.deleted_at,
    serverVersion: version,
    dirty: 0
  }
  await db.folders.put(folder)
  await clearMutationId(db, 'folder', remote.id)
}

async function applyRemoteNote(db: NoteDatabase, remote: CloudNote) {
  const version = asVersion(remote.version)
  const plainText = remote.plain_text ?? ''
  const title = remote.title || titleFromText(plainText)
  const summary = summaryFromText(plainText)
  await db.transaction('rw', db.notes, db.bodies, db.conflicts, async () => {
    const existing = await db.notes.get(remote.id)
    const editSeq = (existing?.editSeq ?? 0) + 1
    const note: NoteRecord = {
      id: remote.id,
      title,
      summary,
      folderId: remote.folder_id ?? null,
      isPinned: Boolean(remote.is_pinned),
      createdAt: remote.created_at,
      updatedAt: remote.updated_at,
      deletedAt: remote.deleted_at,
      serverVersion: version,
      dirty: 0,
      editSeq,
      hasConflict: 0
    }
    await db.notes.put(note)
    await db.bodies.put({ id: remote.id, doc: remote.doc ?? emptyDocument, plainText })
    await db.conflicts.delete(remote.id)
  })
  await clearMutationId(db, 'note', remote.id)
}

async function assimilateChange(db: NoteDatabase, item: PullItem) {
  if (item.entity === 'folder') {
    await applyRemoteFolder(db, item.record as CloudFolder)
    return
  }
  const remote = item.record as CloudNote
  const version = asVersion(remote.version)
  const local = await db.notes.get(remote.id)
  if (!local) {
    await applyRemoteNote(db, remote)
    return
  }
  if (version <= local.serverVersion) return
  if (local.dirty) {
    await keepRemoteNoteConflict(db, local, remote)
    return
  }
  await applyRemoteNote(db, remote)
}

export async function pullChanges(db: NoteDatabase, client: SyncRpc) {
  let after = await readCursor(db)
  for (;;) {
    const page = await callPull(client, after)
    for (const item of page.items) await assimilateChange(db, item)
    if (page.next !== after) await writeCursor(db, page.next)
    if (page.items.length === 0 || page.next === after) break
    after = page.next
  }
}

async function pushFolder(db: NoteDatabase, client: SyncRpc, folder: FolderRecord) {
  const mutationId = await mutationIdFor(db, 'folder', folder.id)
  const result = await callApply(client, mutationId, 'folder', folder.id, folder.serverVersion, {
    name: folder.name,
    sortOrder: folder.sortOrder,
    deletedAt: folder.deletedAt
  })
  const remote = result.record as CloudFolder | null
  if (result.status === 'ok' && remote) {
    await applyRemoteFolder(db, remote)
    if (result.seq) await writeCursor(db, result.seq)
    return
  }
  if (remote) await applyRemoteFolder(db, remote)
  else await clearMutationId(db, 'folder', folder.id)
}

async function pushNote(db: NoteDatabase, client: SyncRpc, note: NoteRecord) {
  const body = await db.bodies.get(note.id)
  if (!body) throw new Error('便签正文缺失')
  const mutationId = await mutationIdFor(db, 'note', note.id)
  const result = await callApply(client, mutationId, 'note', note.id, note.serverVersion, {
    title: note.title,
    doc: body.doc,
    docVersion: 1,
    plainText: body.plainText,
    folderId: note.folderId,
    isPinned: note.isPinned,
    deletedAt: note.deletedAt
  })
  const remote = result.record as CloudNote | null
  if (result.status === 'ok' && remote) {
    await applyRemoteNote(db, remote)
    if (result.seq) await writeCursor(db, result.seq)
    return
  }
  if (remote) {
    await keepRemoteNoteConflict(db, note, remote)
    await clearMutationId(db, 'note', note.id)
    return
  }
  await clearMutationId(db, 'note', note.id)
}

export async function pushDirty(db: NoteDatabase, client: SyncRpc) {
  const folders = (await db.folders.where('dirty').equals(1).toArray()).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  for (const folder of folders) await pushFolder(db, client, folder)
  const notes = (await db.notes.where('dirty').equals(1).toArray()).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
  for (const note of notes) await pushNote(db, client, note)
}

export async function runManualSync(userId: string, client: SyncRpc | null = supabase): Promise<SyncOutcome> {
  if (demoMode) return { ok: false, reason: '演示模式不同步云端' }
  if (!client) return { ok: false, reason: '尚未配置云端服务' }
  if (client === supabase && typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, reason: '当前离线' }
  try {
    const { data } = await client.auth.getSession()
    if (!data.session) return { ok: false, reason: '请先登录' }
    const db = accountDb(userId)
    await pullChanges(db, client)
    await pushDirty(db, client)
    await pullChanges(db, client)
    return { ok: true }
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : '同步失败' }
  }
}
