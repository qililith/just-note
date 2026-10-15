import { useEffect } from 'react'
import { LoaderCircle } from 'lucide-react'

type Props = {
  syncing: boolean
  pendingCount: number
  conflictCount: number
  lastSyncLabel: string
  onManualSync: () => void
  onOpenConflicts: () => void
  onClose: () => void
}

export function DataPanel({ syncing, pendingCount, conflictCount, lastSyncLabel, onManualSync, onOpenConflicts, onClose }: Props) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const summary = conflictCount
    ? `有 ${conflictCount} 条冲突需要处理。`
    : pendingCount
      ? `还有 ${pendingCount} 项改动待同步。`
      : lastSyncLabel

  return <div className="data-panel-overlay" onClick={onClose}>
    <section className="data-panel data-panel-compact" role="dialog" aria-modal="true" aria-label="同步" onClick={event => event.stopPropagation()}>
      <div className="data-panel-heading"><h2>同步</h2><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
      <section>
        <p>{summary}</p>
        <button type="button" className="primary-action" disabled={syncing} onClick={onManualSync}>
          {syncing ? <LoaderCircle size={16} className="sync-spin" /> : null}
          {syncing ? '同步中…' : '立即同步'}
        </button>
        {conflictCount > 0 && <button type="button" className="danger-action" onClick={onOpenConflicts}>处理冲突（{conflictCount}）</button>}
      </section>
    </section>
  </div>
}
