import { afterEach, describe, expect, it } from 'vitest'
import { accountDb, deleteAccountDb, emptyDocument } from '../src/lib/db'
import { createFolder, createNote, saveNoteContent } from '../src/lib/notes'
import { pullChanges, pushDirty, runManualSync, runSync } from '../src/lib/sync'

const userId = 'sync-test-user'

afterEach(async () => {
  await deleteAccountDb(userId)
})

function noteRecord(id: string, version: number, plainText: string, extras: Partial<{ title: string; folder_id: string | null; is_pinned: boolean; deleted_at: string | null }> = {}) {
  return {
    id,
    title: extras.title ?? plainText.split('\n')[0] ?? '',
    doc: { type: 'doc', content: [{ type: 'paragraph', content: plainText ? [{ type: 'text', text: plainText }] : [] }] },
    plain_text: plainText,
    folder_id: extras.folder_id ?? null,
    is_pinned: extras.is_pinned ?? false,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    deleted_at: extras.deleted_at ?? null,
    version
  }
}

function folderRecord(id: string, version: number, name: string, sortOrder = 0) {
  return {
    id,
    name,
    sort_order: sortOrder,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
    deleted_at: null,
    version
  }
}

function mockClient(handlers: {
  pull?: (after: string) => { items: unknown[]; next: string }
  apply?: (args: Record<string, unknown>) => { status: 'ok' | 'conflict'; record: unknown; seq?: string }
}) {
  return {
    auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'pull_changes') {
        const page = handlers.pull?.(String(args.p_after)) ?? { items: [], next: String(args.p_after) }
        return { data: page, error: null }
      }
      if (fn === 'apply_mutation') {
        const result = handlers.apply?.(args) ?? { status: 'ok' as const, record: null }
        return { data: result, error: null }
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } }
    }
  }
}

describe('sync engine', () => {
  it('uploads dirty notes and clears the dirty flag', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '本地', doc: emptyDocument, plainText: '本地正文' }, 1)

    const applied: Record<string, unknown>[] = []
    const client = mockClient({
      pull: after => ({ items: [], next: after }),
      apply: args => {
        applied.push(args)
        const remote = noteRecord(String(args.p_entity_id), 1, '本地正文')
        return { status: 'ok', record: remote, seq: '1' }
      }
    })

    await pushDirty(db, client)
    const stored = await db.notes.get(note.id)
    expect(stored?.dirty).toBe(0)
    expect(stored?.serverVersion).toBe(1)
    expect(applied[0]?.p_entity).toBe('note')
    expect(applied[0]?.p_base_version).toBe(0)
    expect((await db.meta.get('syncCursor'))?.value).toBe('1')
  })

  it('pulls remote notes into an empty local database', async () => {
    const db = accountDb(userId)
    const remoteId = crypto.randomUUID()
    const client = mockClient({
      pull: after => {
        if (after !== '0') return { items: [], next: after }
        return {
          items: [{ seq: '3', entity: 'note', record: noteRecord(remoteId, 3, '云端来的') }],
          next: '3'
        }
      }
    })

    await pullChanges(db, client)
    const stored = await db.notes.get(remoteId)
    const body = await db.bodies.get(remoteId)
    expect(stored?.dirty).toBe(0)
    expect(stored?.serverVersion).toBe(3)
    expect(body?.plainText).toBe('云端来的')
    expect((await db.meta.get('syncCursor'))?.value).toBe('3')
  })

  it('keeps dirty local notes and stores the remote version as a conflict', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '本地', doc: emptyDocument, plainText: '本地未上传' }, 1)
    await db.notes.update(note.id, { serverVersion: 1, dirty: 1 })

    const client = mockClient({
      pull: after => {
        if (after !== '0') return { items: [], next: after }
        return {
          items: [{ seq: '4', entity: 'note', record: noteRecord(note.id, 4, '别人改过的') }],
          next: '4'
        }
      }
    })

    await pullChanges(db, client)
    const stored = await db.notes.get(note.id)
    const body = await db.bodies.get(note.id)
    const conflict = await db.conflicts.get(note.id)
    expect(body?.plainText).toBe('本地未上传')
    expect(stored?.hasConflict).toBe(1)
    expect(stored?.dirty).toBe(1)
    expect(stored?.serverVersion).toBe(4)
    expect(conflict?.plainText).toBe('别人改过的')
  })

  it('lets the cloud win on folder conflicts during pull', async () => {
    const db = accountDb(userId)
    const folder = await createFolder(db, '本地名')
    await db.folders.update(folder.id, { serverVersion: 1, dirty: 1, name: '还没上传' })

    const client = mockClient({
      pull: after => {
        if (after !== '0') return { items: [], next: after }
        return {
          items: [{ seq: '2', entity: 'folder', record: folderRecord(folder.id, 2, '云端名', 5) }],
          next: '2'
        }
      }
    })

    await pullChanges(db, client)
    const stored = await db.folders.get(folder.id)
    expect(stored?.name).toBe('云端名')
    expect(stored?.sortOrder).toBe(5)
    expect(stored?.dirty).toBe(0)
    expect(stored?.serverVersion).toBe(2)
  })

  it('reuses the same mutation id when a dirty note is pushed again', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '一', doc: emptyDocument, plainText: '一' }, 1)
    const ids: string[] = []
    const client = mockClient({
      pull: after => ({ items: [], next: after }),
      apply: args => {
        ids.push(String(args.p_mutation_id))
        throw new Error('network')
      }
    })

    await expect(pushDirty(db, client)).rejects.toThrow('network')
    const retry = mockClient({
      pull: after => ({ items: [], next: after }),
      apply: args => {
        ids.push(String(args.p_mutation_id))
        return { status: 'ok', record: noteRecord(note.id, 1, '一'), seq: '1' }
      }
    })
    await pushDirty(db, retry)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
  })

  it('runManualSync reports missing login', async () => {
    const result = await runManualSync(userId, {
      auth: { getSession: async () => ({ data: { session: null } }) },
      rpc: async () => ({ data: null, error: null })
    })
    expect(result).toEqual({ ok: false, reason: '请先登录' })
  })

  it('runSync merges concurrent callers into one flight', async () => {
    let pulls = 0
    const client = mockClient({
      pull: after => {
        pulls += 1
        return { items: [], next: after }
      }
    })
    const [a, b] = await Promise.all([
      runSync(userId, { silent: true }, client),
      runSync(userId, { silent: true }, client)
    ])
    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    // one round = pull + push + pull → 2 pull RPCs, not 4
    expect(pulls).toBe(2)
  })

  it('does not overwrite body while editingNoteId is focused', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '本地', doc: emptyDocument, plainText: '正在编辑' }, 1)
    await db.notes.update(note.id, { serverVersion: 1, dirty: 0 })

    const client = mockClient({
      pull: after => {
        if (after !== '0') return { items: [], next: after }
        return {
          items: [{ seq: '5', entity: 'note', record: noteRecord(note.id, 5, '远端覆盖') }],
          next: '5'
        }
      }
    })

    await pullChanges(db, client, { editingNoteId: note.id })
    const body = await db.bodies.get(note.id)
    const stored = await db.notes.get(note.id)
    const conflict = await db.conflicts.get(note.id)
    expect(body?.plainText).toBe('正在编辑')
    expect(stored?.hasConflict).toBe(1)
    expect(stored?.serverVersion).toBe(5)
    expect(conflict?.plainText).toBe('远端覆盖')
  })

  it('does not invent a conflict when focused echo matches local content', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '本地', doc: emptyDocument, plainText: '同一段字' }, 1)
    const before = await db.notes.get(note.id)
    await db.notes.update(note.id, { serverVersion: 1, dirty: 0 })

    const client = mockClient({
      pull: after => {
        if (after !== '0') return { items: [], next: after }
        return {
          items: [{ seq: '6', entity: 'note', record: noteRecord(note.id, 6, '同一段字') }],
          next: '6'
        }
      }
    })

    await pullChanges(db, client, { editingNoteId: note.id })
    const stored = await db.notes.get(note.id)
    const conflict = await db.conflicts.get(note.id)
    expect(stored?.hasConflict).toBe(0)
    expect(stored?.dirty).toBe(0)
    expect(stored?.serverVersion).toBe(6)
    expect(stored?.editSeq).toBe(before?.editSeq)
    expect(conflict).toBeUndefined()
  })

  it('push success ack does not bump editSeq when content matches', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '本地', doc: emptyDocument, plainText: '刚写的' }, 1)
    const before = await db.notes.get(note.id)
    const client = mockClient({
      pull: after => ({ items: [], next: after }),
      apply: args => ({
        status: 'ok' as const,
        record: noteRecord(String(args.p_entity_id), 1, '刚写的'),
        seq: '1'
      })
    })

    await pushDirty(db, client)
    const stored = await db.notes.get(note.id)
    expect(stored?.dirty).toBe(0)
    expect(stored?.serverVersion).toBe(1)
    expect(stored?.editSeq).toBe(before?.editSeq)
    expect(stored?.hasConflict).toBe(0)
  })

  it('runSync silent option still returns outcome for callers', async () => {
    const client = mockClient({
      pull: after => ({ items: [], next: after })
    })
    const silent = await runSync(userId, { silent: true }, client)
    const loud = await runSync(userId, { silent: false }, client)
    expect(silent).toEqual({ ok: true })
    expect(loud).toEqual({ ok: true })
  })
})
