import { afterEach, describe, expect, it } from 'vitest'
import Dexie from 'dexie'
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
  pull?: (after: string) => { items: unknown[]; next: string } | Promise<{ items: unknown[]; next: string }>
  apply?: (args: Record<string, unknown>) => { status: 'ok' | 'conflict'; record: unknown; seq?: string } | Promise<{ status: 'ok' | 'conflict'; record: unknown; seq?: string }>
}) {
  return {
    auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'pull_changes') {
        const page = await (handlers.pull?.(String(args.p_after)) ?? { items: [], next: String(args.p_after) })
        return { data: page, error: null }
      }
      if (fn === 'apply_mutation') {
        const result = await (handlers.apply?.(args) ?? { status: 'ok' as const, record: null })
        return { data: result, error: null }
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } }
    }
  }
}

type FakeNote = ReturnType<typeof noteRecord>
type FakeResult = { status: 'ok' | 'conflict'; record: FakeNote | null; seq?: string }

/** In-memory twin of apply_mutation / pull_changes: base-version check, per-id idempotency, reuse guard. */
function fakeServer() {
  const notes = new Map<string, FakeNote>()
  const changes: { seq: number; record: FakeNote }[] = []
  const processed = new Map<string, { request: string; result: FakeResult }>()
  let lastSeq = 0
  const server = {
    notes,
    dropNextReply: false,
    beforeApply: null as null | (() => Promise<void>),
    onPull: null as null | (() => Promise<void>),
    client: {
      auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) },
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === 'pull_changes') {
          await server.onPull?.()
          const after = Number(args.p_after)
          const items = changes.filter(change => change.seq > after).map(change => ({ seq: String(change.seq), entity: 'note', record: change.record }))
          return { data: { items, next: items.at(-1)?.seq ?? String(args.p_after) }, error: null }
        }
        if (fn !== 'apply_mutation') return { data: null, error: { message: `unknown rpc ${fn}` } }
        if (server.beforeApply) await server.beforeApply()
        const entityId = String(args.p_entity_id)
        const base = Number(args.p_base_version)
        const payload = args.p_payload as { title: string; doc: unknown; plainText: string; folderId: string | null; isPinned: boolean; deletedAt: string | null }
        const request = JSON.stringify({ entityId, base, payload })
        const mutationId = String(args.p_mutation_id)
        const stored = processed.get(mutationId)
        let result: FakeResult
        if (stored) {
          if (stored.request !== request) return { data: null, error: { message: 'Mutation ID reused with different content' } }
          result = stored.result
        } else {
          const current = notes.get(entityId)
          if ((!current && base === 0) || (current && current.version === base)) {
            const record = { ...noteRecord(entityId, base + 1, payload.plainText), title: payload.title, folder_id: payload.folderId ?? null, is_pinned: payload.isPinned, deleted_at: payload.deletedAt ?? null }
            notes.set(entityId, record)
            lastSeq += 1
            changes.push({ seq: lastSeq, record })
            result = { status: 'ok', record, seq: String(lastSeq) }
          } else {
            result = { status: 'conflict', record: current ?? null }
          }
          processed.set(mutationId, { request, result })
        }
        if (server.dropNextReply) {
          server.dropNextReply = false
          return { data: null, error: { message: 'network' } }
        }
        return { data: result, error: null }
      }
    }
  }
  return server
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

    const beforeSeq = (await db.notes.get(note.id))?.editSeq
    await pullChanges(db, client, { editingNoteId: note.id })
    const body = await db.bodies.get(note.id)
    const stored = await db.notes.get(note.id)
    const conflict = await db.conflicts.get(note.id)
    expect(body?.plainText).toBe('正在编辑')
    expect(stored?.hasConflict).toBe(1)
    expect(stored?.serverVersion).toBe(5)
    expect(stored?.editSeq).toBe(beforeSeq)
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

  it('push success ack never bumps editSeq', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '本地', doc: emptyDocument, plainText: '刚写的' }, 1)
    const before = await db.notes.get(note.id)
    const client = mockClient({
      pull: after => ({ items: [], next: after }),
      apply: args => ({
        status: 'ok' as const,
        // Server may normalize trailing whitespace; ack still must not bump editSeq.
        record: noteRecord(String(args.p_entity_id), 1, '刚写的\n'),
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

  it('treats trailing newline differences as the same content while focused', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '本地', doc: emptyDocument, plainText: '同一段字' }, 1)
    const before = await db.notes.get(note.id)
    await db.notes.update(note.id, { serverVersion: 1, dirty: 0 })

    const client = mockClient({
      pull: after => {
        if (after !== '0') return { items: [], next: after }
        return {
          items: [{ seq: '7', entity: 'note', record: noteRecord(note.id, 7, '同一段字\n') }],
          next: '7'
        }
      }
    })

    await pullChanges(db, client, { editingNoteId: note.id })
    const stored = await db.notes.get(note.id)
    expect(stored?.hasConflict).toBe(0)
    expect(stored?.editSeq).toBe(before?.editSeq)
    expect(await db.conflicts.get(note.id)).toBeUndefined()
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

  it('keeps newer local dirty when user edits during push ack (t2 race)', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '一', doc: emptyDocument, plainText: '一' }, 1)
    const pushed = await db.notes.get(note.id)
    const client = mockClient({
      pull: after => ({ items: [], next: after }),
      apply: async args => {
        // Simulate typing a newer revision while the RPC is in flight.
        await saveNoteContent(db, note.id, { title: '二', doc: emptyDocument, plainText: '二' }, pushed!.editSeq)
        return {
          status: 'ok' as const,
          record: noteRecord(String(args.p_entity_id), 1, '一'),
          seq: '1'
        }
      }
    })

    await pushDirty(db, client)
    const stored = await db.notes.get(note.id)
    const body = await db.bodies.get(note.id)
    expect(body?.plainText).toBe('二')
    expect(stored?.dirty).toBe(1)
    expect(stored?.serverVersion).toBe(1)
    expect(stored?.hasConflict).toBe(0)
  })

  it('ack does not overwrite a save that lands right before the ack is written', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: 'a', doc: emptyDocument, plainText: 'a' }, 1)
    const sent = (await db.notes.get(note.id))!
    let ackPhase = false
    let typedDuringAck = false
    // Any read of the note outside a transaction during the ack leaves a window for the
    // editor's save to land before the ack row is written. Simulate that save there.
    const originalGet = db.notes.get.bind(db.notes) as (key: string) => Promise<unknown>
    ;(db.notes as unknown as { get: (key: string) => Promise<unknown> }).get = async (key: string) => {
      const row = await originalGet(key)
      if (ackPhase && !typedDuringAck && key === note.id && !Dexie.currentTransaction) {
        typedDuringAck = true
        await saveNoteContent(db, note.id, { title: 'ab', doc: emptyDocument, plainText: 'ab' }, sent.editSeq)
      }
      return row
    }
    const client = mockClient({
      pull: after => ({ items: [], next: after }),
      apply: args => {
        ackPhase = true
        return { status: 'ok' as const, record: noteRecord(String(args.p_entity_id), 1, 'a'), seq: '1' }
      }
    })
    await pushDirty(db, client)
    ackPhase = false
    const body = await db.bodies.get(note.id)
    const stored = await db.notes.get(note.id)
    expect(body?.plainText).toBe(typedDuringAck ? 'ab' : 'a')
    expect(stored?.dirty).toBe(typedDuringAck ? 1 : 0)
    expect(stored?.serverVersion).toBe(1)
    expect(stored?.hasConflict).toBe(0)
  })

  it('typing during the upload keeps the newer text dirty and conflict-free', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: 'a', doc: emptyDocument, plainText: 'a' }, 1)
    const sent = (await db.notes.get(note.id))!
    const client = mockClient({
      pull: after => ({ items: [], next: after }),
      apply: async args => {
        await saveNoteContent(db, note.id, { title: 'ab', doc: emptyDocument, plainText: 'ab' }, sent.editSeq)
        return { status: 'ok' as const, record: noteRecord(String(args.p_entity_id), 1, 'a'), seq: '1' }
      }
    })
    await pushDirty(db, client)
    const stored = await db.notes.get(note.id)
    expect((await db.bodies.get(note.id))?.plainText).toBe('ab')
    expect(stored?.dirty).toBe(1)
    expect(stored?.serverVersion).toBe(1)
    expect(stored?.hasConflict).toBe(0)
  })

  it('push ack keeps an unresolved local conflict instead of silently discarding it', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '本地', doc: emptyDocument, plainText: '本地' }, 1)
    await db.conflicts.put({ noteId: note.id, title: '另一版', doc: emptyDocument, plainText: '另一版', folderId: null, isPinned: false, serverVersion: 0, updatedAt: '2026-10-02T00:00:00.000Z' })
    await db.notes.update(note.id, { hasConflict: 1 })
    const client = mockClient({
      pull: after => ({ items: [], next: after }),
      apply: args => ({ status: 'ok' as const, record: noteRecord(String(args.p_entity_id), 1, '本地'), seq: '1' })
    })
    await pushDirty(db, client)
    expect((await db.notes.get(note.id))?.hasConflict).toBe(1)
    expect((await db.conflicts.get(note.id))?.plainText).toBe('另一版')
  })

  it('lost push reply + more typing: no self-conflict and no stuck mutation id', async () => {
    const db = accountDb(userId)
    const server = fakeServer()
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: 'a', doc: emptyDocument, plainText: 'a' }, 1)

    // Server commits, but the reply never reaches the client.
    server.dropNextReply = true
    const first = await runSync(userId, { silent: true, editingNoteId: note.id }, server.client)
    expect(first.ok).toBe(false)

    const seq = (await db.notes.get(note.id))!.editSeq
    await saveNoteContent(db, note.id, { title: 'ab', doc: emptyDocument, plainText: 'ab' }, seq)

    const conflictSeen: number[] = []
    server.onPull = async () => { conflictSeen.push((await db.notes.get(note.id))?.hasConflict ?? 0) }
    const second = await runSync(userId, { silent: true, editingNoteId: note.id }, server.client)
    conflictSeen.push((await db.notes.get(note.id))?.hasConflict ?? 0)

    expect(second).toEqual({ ok: true })
    expect(conflictSeen.every(flag => flag === 0)).toBe(true)
    expect(await db.conflicts.count()).toBe(0)
    expect(server.notes.get(note.id)?.plain_text).toBe('ab')
    const stored = await db.notes.get(note.id)
    expect(stored?.dirty).toBe(0)
    expect(stored?.serverVersion).toBe(server.notes.get(note.id)?.version)
  })

  it('new note → one char → interleaved syncs while focused never flags a conflict', async () => {
    const db = accountDb(userId)
    const server = fakeServer()
    const note = await createNote(db, null)
    const flags: number[] = []
    const watch = async () => { flags.push((await db.notes.get(note.id))?.hasConflict ?? 0); flags.push(await db.conflicts.count()) }

    // Empty draft gets pushed before the first keystroke; typing lands during that push.
    server.beforeApply = async () => {
      server.beforeApply = null
      const seq = (await db.notes.get(note.id))!.editSeq
      await saveNoteContent(db, note.id, { title: 'x', doc: emptyDocument, plainText: 'x' }, seq)
      await watch()
    }
    expect(await runSync(userId, { silent: true, editingNoteId: note.id }, server.client)).toEqual({ ok: true })
    await watch()
    expect(await runSync(userId, { silent: true, editingNoteId: note.id }, server.client)).toEqual({ ok: true })
    await watch()
    expect(await runSync(userId, { silent: true, editingNoteId: note.id }, server.client)).toEqual({ ok: true })
    await watch()

    expect(flags.every(flag => flag === 0)).toBe(true)
    expect(server.notes.get(note.id)?.plain_text).toBe('x')
    expect((await db.notes.get(note.id))?.dirty).toBe(0)
  })

  it('real dual-edit while focused stores conflict without bumping editSeq (t5/t6 engine)', async () => {
    const db = accountDb(userId)
    const note = await createNote(db, null)
    await saveNoteContent(db, note.id, { title: '本地', doc: emptyDocument, plainText: 'A正在打' }, 1)
    const before = await db.notes.get(note.id)
    await db.notes.update(note.id, { serverVersion: 1, dirty: 1 })

    const client = mockClient({
      pull: after => {
        if (after !== '0') return { items: [], next: after }
        return {
          items: [{ seq: '8', entity: 'note', record: noteRecord(note.id, 8, 'B已改完') }],
          next: '8'
        }
      }
    })

    await pullChanges(db, client, { editingNoteId: note.id })
    const stored = await db.notes.get(note.id)
    const body = await db.bodies.get(note.id)
    const conflict = await db.conflicts.get(note.id)
    expect(body?.plainText).toBe('A正在打')
    expect(stored?.hasConflict).toBe(1)
    expect(stored?.dirty).toBe(1)
    expect(stored?.editSeq).toBe(before?.editSeq)
    expect(conflict?.plainText).toBe('B已改完')
  })
})
