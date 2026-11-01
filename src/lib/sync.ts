import { accountDb, emptyDocument, type ConflictRecord, type FolderRecord, type NoteDatabase, type NoteRecord, type RichText } from './db'
import { summaryFromText, titleFromText } from './text'
import { demoMode, supabase } from './supabase'

const CURSOR_KEY = 'syncCursor'
const SYNC_LOCK = 'just-note-sync'
const mutationKey = (entity: 'note' | 'folder', id: string) => `mutation:${entity}:${id}`

export type SyncOutcome = { ok: true } | { ok: false; reason: string; skipped?: boolean }

export type SyncOptions = {
  silent?: boolean
  editingNoteId?: string | null
  /** Manual sync waits for the lock; auto uses ifAvailable and may skip. */
  waitForLock?: boolean
}

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

export type SyncRpc = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
  auth: { getSession(): PromiseLike<{ data: { session: unknown } }> }
}

type PullContext = { editingNoteId?: string | null }

let inFlight: Promise<SyncOutcome> | null = null

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

type MutationRequest = { baseVersion: number; payload: Record<string, unknown> }
/** request is null for ids stored before requests were recorded alongside them. */
type PendingMutation = { id: string; request: MutationRequest | null }

async function readPending(db: NoteDatabase, entity: 'note' | 'folder', id: string): Promise<PendingMutation | null> {
  const raw = (await db.meta.get(mutationKey(entity, id)))?.value
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingMutation>
    if (typeof parsed?.id === 'string') return { id: parsed.id, request: parsed.request ?? null }
  } catch { /* legacy plain id */ }
  return { id: raw, request: null }
}

async function writePending(db: NoteDatabase, entity: 'note' | 'folder', id: string, pending: PendingMutation) {
  await db.meta.put({ key: mutationKey(entity, id), value: JSON.stringify(pending) })
}

async function clearMutationId(db: NoteDatabase, entity: 'note' | 'folder', id: string) {
  await db.meta.delete(mutationKey(entity, id))
}

function sameRequest(a: MutationRequest, b: MutationRequest) {
  return a.baseVersion === b.baseVersion && JSON.stringify(a.payload) === JSON.stringify(b.payload)
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

/**
 * Send one mutation. If an earlier attempt for this entity is still recorded with a different
 * request, it may have committed without us seeing the reply: replay it first (the server answers
 * idempotently) so its version is known as ours, then send the current request on top of it.
 * Reusing the old id for a new request would be rejected by the server forever.
 */
async function sendMutation(
  db: NoteDatabase,
  client: SyncRpc,
  entity: 'note' | 'folder',
  entityId: string,
  request: MutationRequest
): Promise<MutationResult> {
  const pending = await readPending(db, entity, entityId)
  let current = request
  if (pending?.request && !sameRequest(pending.request, request)) {
    const replay = await callApply(client, pending.id, entity, entityId, pending.request.baseVersion, pending.request.payload)
    await clearMutationId(db, entity, entityId)
    if (replay.status === 'ok' && replay.record) {
      const version = asVersion((replay.record as { version: number | string }).version)
      await (entity === 'note' ? db.notes : db.folders).update(entityId, { serverVersion: version })
      if (replay.seq) await writeCursor(db, replay.seq)
      current = { ...request, baseVersion: version }
    }
  }
  const reusable = pending && (pending.request === null || sameRequest(pending.request, current))
  const id = reusable ? pending.id : crypto.randomUUID()
  await writePending(db, entity, entityId, { id, request: current })
  try {
    return await callApply(client, id, entity, entityId, current.baseVersion, current.payload)
  } catch (cause) {
    if (!(pending?.request === null && cause instanceof Error && cause.message.includes('Mutation ID reused'))) throw cause
    const fresh = crypto.randomUUID()
    await writePending(db, entity, entityId, { id: fresh, request: current })
    return callApply(client, fresh, entity, entityId, current.baseVersion, current.payload)
  }
}

/** Our recorded-but-unacknowledged upload came back through pull: it is ours, not a conflict. */
async function isOwnPendingWrite(db: NoteDatabase, local: NoteRecord, remote: CloudNote) {
  const request = (await readPending(db, 'note', local.id))?.request
  if (!request || request.baseVersion !== local.serverVersion || asVersion(remote.version) !== request.baseVersion + 1) return false
  const payload = request.payload as { plainText?: string; folderId?: string | null; isPinned?: boolean; deletedAt?: string | null }
  return normalizePlain(payload.plainText ?? '') === normalizePlain(remote.plain_text ?? '')
    && (payload.folderId ?? null) === (remote.folder_id ?? null)
    && Boolean(payload.isPinned) === Boolean(remote.is_pinned)
    && (payload.deletedAt == null) === (remote.deleted_at == null)
}

async function keepRemoteNoteConflict(db: NoteDatabase, note: NoteRecord, remote: CloudNote, reason: string) {
  console.warn('[just-note] conflict', { noteId: note.id, reason, localVersion: note.serverVersion, remoteVersion: remote.version })
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
    // Do not bump editSeq: hasConflict alone drives「处理冲突」. Bumping while focused
    // falsely triggers「其它窗口已更新 / 加载新版本」even for echo conflicts.
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

function normalizePlain(text: string) {
  return text.replace(/\r\n/g, '\n').trimEnd()
}

function sameNoteContent(local: NoteRecord, plainText: string, remote: CloudNote) {
  return normalizePlain(plainText) === normalizePlain(remote.plain_text ?? '')
    && (local.folderId ?? null) === (remote.folder_id ?? null)
    && Boolean(local.isPinned) === Boolean(remote.is_pinned)
    && (local.deletedAt ?? null) === (remote.deleted_at ?? null)
}

type ApplyNoteOptions = {
  /**
   * Our own write coming back (push ack or pull echo): keep editSeq so a focused editor does not
   * see「其它窗口已更新」, and keep any unresolved conflict — our echo does not resolve it.
   */
  ownWrite?: boolean
  /** Only apply if the local row still has this editSeq; otherwise just advance serverVersion. */
  expectEditSeq?: number
}

async function applyRemoteNote(db: NoteDatabase, remote: CloudNote, options: ApplyNoteOptions = {}) {
  const version = asVersion(remote.version)
  const plainText = remote.plain_text ?? ''
  const title = remote.title || titleFromText(plainText)
  const summary = summaryFromText(plainText)
  await db.transaction('rw', db.notes, db.bodies, db.conflicts, async () => {
    const existing = await db.notes.get(remote.id)
    if (existing && options.expectEditSeq !== undefined && existing.editSeq !== options.expectEditSeq) {
      // A newer local save landed while the upload was in flight: keep it and its dirty flag.
      await db.notes.put({ ...existing, serverVersion: version })
      return
    }
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
      editSeq: options.ownWrite ? (existing?.editSeq ?? 0) : (existing?.editSeq ?? 0) + 1,
      hasConflict: options.ownWrite ? (existing?.hasConflict ?? 0) : 0
    }
    await db.notes.put(note)
    await db.bodies.put({ id: remote.id, doc: remote.doc ?? emptyDocument, plainText })
    if (!options.ownWrite) await db.conflicts.delete(remote.id)
  })
  await clearMutationId(db, 'note', remote.id)
}

async function assimilateChange(db: NoteDatabase, item: PullItem, ctx: PullContext = {}) {
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
  const body = await db.bodies.get(remote.id)
  // Identical content (including the echo of our own upload): adopt the version, nothing else.
  if (body && sameNoteContent(local, body.plainText, remote)) {
    await applyRemoteNote(db, remote, { ownWrite: true, expectEditSeq: local.editSeq })
    return
  }
  // Our upload whose reply was lost, and we have typed since: take its version, keep newer local text.
  if (local.dirty && await isOwnPendingWrite(db, local, remote)) {
    await db.notes.update(remote.id, { serverVersion: version })
    await clearMutationId(db, 'note', remote.id)
    return
  }
  if (ctx.editingNoteId === remote.id || local.dirty) {
    await keepRemoteNoteConflict(db, local, remote, local.dirty ? 'pull: local dirty' : 'pull: editing')
    return
  }
  await applyRemoteNote(db, remote)
}

export async function pullChanges(db: NoteDatabase, client: SyncRpc, ctx: PullContext = {}) {
  let after = await readCursor(db)
  for (;;) {
    const page = await callPull(client, after)
    for (const item of page.items) await assimilateChange(db, item, ctx)
    if (page.next !== after) await writeCursor(db, page.next)
    if (page.items.length === 0 || page.next === after) break
    after = page.next
  }
}

async function pushFolder(db: NoteDatabase, client: SyncRpc, folder: FolderRecord) {
  const result = await sendMutation(db, client, 'folder', folder.id, {
    baseVersion: folder.serverVersion,
    payload: { name: folder.name, sortOrder: folder.sortOrder, deletedAt: folder.deletedAt }
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
  const result = await sendMutation(db, client, 'note', note.id, {
    baseVersion: note.serverVersion,
    payload: {
      title: note.title,
      doc: body.doc,
      docVersion: 1,
      plainText: body.plainText,
      folderId: note.folderId,
      isPinned: note.isPinned,
      deletedAt: note.deletedAt
    }
  })
  const remote = result.record as CloudNote | null
  if (result.status === 'ok' && remote) {
    // Checked inside the write transaction: a save landing during the upload is never overwritten.
    await applyRemoteNote(db, remote, { ownWrite: true, expectEditSeq: note.editSeq })
    await clearMutationId(db, 'note', note.id)
    if (result.seq) await writeCursor(db, result.seq)
    return
  }
  await clearMutationId(db, 'note', note.id)
  if (!remote) return
  if (sameNoteContent(note, body.plainText, remote)) {
    await applyRemoteNote(db, remote, { ownWrite: true, expectEditSeq: note.editSeq })
    return
  }
  await keepRemoteNoteConflict(db, note, remote, 'push: base version rejected')
}

export async function pushDirty(db: NoteDatabase, client: SyncRpc) {
  const folders = (await db.folders.where('dirty').equals(1).toArray()).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  for (const folder of folders) await pushFolder(db, client, folder)
  const notes = (await db.notes.where('dirty').equals(1).toArray()).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
  for (const note of notes) await pushNote(db, client, note)
}

async function withSyncLock<T>(waitForLock: boolean, run: () => Promise<T>): Promise<T | { skipped: true }> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) return run()
  if (waitForLock) {
    return locks.request(SYNC_LOCK, run)
  }
  let ran = false
  const result = await locks.request(SYNC_LOCK, { ifAvailable: true }, async lock => {
    if (!lock) return { skipped: true as const }
    ran = true
    return run()
  })
  if (!ran) return { skipped: true }
  return result as T
}

async function executeSyncRound(
  userId: string,
  client: SyncRpc,
  options: SyncOptions
): Promise<SyncOutcome> {
  const { data } = await client.auth.getSession()
  if (!data.session) return { ok: false, reason: '请先登录' }
  const db = accountDb(userId)
  const ctx: PullContext = { editingNoteId: options.editingNoteId }
  await pullChanges(db, client, ctx)
  await pushDirty(db, client)
  await pullChanges(db, client, ctx)
  return { ok: true }
}

export async function runSync(
  userId: string,
  options: SyncOptions = {},
  client: SyncRpc | null = supabase
): Promise<SyncOutcome> {
  if (demoMode) return { ok: false, reason: '演示模式不同步云端' }
  if (!client) return { ok: false, reason: '尚未配置云端服务' }
  if (client === supabase && typeof navigator !== 'undefined' && !navigator.onLine) return { ok: false, reason: '当前离线' }

  const waitForLock = options.waitForLock ?? !options.silent

  const start = async (): Promise<SyncOutcome> => {
    try {
      const locked = await withSyncLock(waitForLock, () => executeSyncRound(userId, client, options))
      if (locked && typeof locked === 'object' && 'skipped' in locked && locked.skipped) {
        return { ok: false, reason: '其它标签页正在同步', skipped: true }
      }
      return locked as SyncOutcome
    } catch (cause) {
      return { ok: false, reason: cause instanceof Error ? cause.message : '同步失败' }
    }
  }

  if (inFlight) return inFlight
  inFlight = start().finally(() => { inFlight = null })
  return inFlight
}

export async function runManualSync(userId: string, client: SyncRpc | null = supabase): Promise<SyncOutcome> {
  return runSync(userId, { silent: false, waitForLock: true }, client)
}
