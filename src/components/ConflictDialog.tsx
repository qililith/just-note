import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { toast } from 'sonner'
import { accountDb } from '../lib/db'
import { resolveConflict } from '../lib/notes'
import { useSaveFlags } from '../lib/saveState'

type Props = { userId: string; activeNoteId: string | null; onClose: () => void }

export function ConflictDialog({ userId, activeNoteId, onClose }: Props) {
  const db = accountDb(userId)
  const [busy, setBusy] = useState(false)
  const saveFlags = useSaveFlags()
  const saving = saveFlags.pending || saveFlags.held
  const conflicts = useLiveQuery(async () => {
    const items = await db.conflicts.toArray()
    return Promise.all(items.map(async item => ({
      item,
      currentTitle: (await db.notes.get(item.noteId))?.title ?? '',
      currentText: (await db.bodies.get(item.noteId))?.plainText ?? ''
    })))
  }, [db], []) ?? []

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (conflicts.length === 0 && !busy) onClose()
  }, [conflicts.length, busy, onClose])

  const choose = (noteId: string, choice: 'current' | 'other' | 'both') => {
    if (choice !== 'current' && activeNoteId === noteId && saving) { toast.error('请稍等，这条便签还在保存'); return }
    setBusy(true)
    const message = choice === 'current' ? '已保留本地版本' : choice === 'other' ? '已保留云端版本' : '两版都已保留'
    void resolveConflict(db, noteId, choice).then(() => toast.success(message)).catch(cause => {
      toast.error(cause instanceof Error ? cause.message : '操作失败')
    }).finally(() => setBusy(false))
  }

  return <div className="conflict-overlay" onClick={onClose}>
    <section className="conflict-dialog" role="dialog" aria-modal="true" aria-label="处理冲突" onClick={event => event.stopPropagation()}>
      <div className="data-panel-heading"><h2>处理冲突</h2><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
      {conflicts.map(({ item, currentTitle, currentText }) => <div className="panel-card" key={item.noteId}>
        <p>便签：{currentTitle || item.title || '无标题'}</p>
        <p>这条便签有两个版本。选一边会替换另一边；两者皆保留会把本地内容另存为新便签。</p>
        <div className="conflict-columns">
          <div><p>本地版本</p><pre>{currentText || '无内容'}</pre></div>
          <div><p>云端版本</p><pre>{item.plainText || '无内容'}</pre></div>
        </div>
        <div className="conflict-actions">
          <button type="button" disabled={busy} onClick={() => choose(item.noteId, 'current')}>保留本地版本</button>
          <button type="button" disabled={busy} onClick={() => choose(item.noteId, 'other')}>保留云端版本</button>
          <button type="button" disabled={busy} onClick={() => choose(item.noteId, 'both')}>两者皆保留</button>
        </div>
      </div>)}
    </section>
  </div>
}
