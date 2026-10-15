import { Cloud, CloudOff, CloudUpload, LoaderCircle, RefreshCw } from 'lucide-react'
import type { SyncKind } from '../lib/syncUi'

type Props = {
  label: string
  kind: SyncKind
  issueCount: number
  syncing: boolean
  iconOnly?: boolean
  onOpenDetails: () => void
  onSync: () => void
}

function StatusIcon({ kind, size }: { kind: SyncKind; size: number }) {
  if (kind === 'syncing') return <LoaderCircle size={size} className="sync-spin" />
  if (kind === 'offline') return <CloudOff size={size} />
  if (kind === 'pending' || kind === 'failed') return <CloudUpload size={size} />
  return <Cloud size={size} />
}

export function SyncControls({ label, kind, issueCount, syncing, iconOnly = false, onOpenDetails, onSync }: Props) {
  const issue = kind === 'unsaved' || kind === 'conflict' || kind === 'failed' || kind === 'external' || issueCount > 0
  return (
    <div className={`sync-controls ${iconOnly ? 'icon-only' : ''}`}>
      <button type="button" className={`sync-status-button ${issue ? 'unsaved' : ''} kind-${kind}`} title={label} aria-label={label} onClick={onOpenDetails}>
        <StatusIcon kind={kind} size={iconOnly ? 20 : 15} />
        {!iconOnly && <span className="sync-status-label">{label}</span>}
        {issueCount > 0 && <span className="sync-issue-badge" aria-label={`${issueCount} 项需要处理`}>{issueCount}</span>}
      </button>
      {!iconOnly && <button type="button" className="toolbar-btn sync-now-btn" title="立即同步" aria-label="立即同步" disabled={syncing} onClick={onSync}>
        {syncing ? <LoaderCircle size={15} className="sync-spin" /> : <RefreshCw size={15} />}
        <span>同步</span>
      </button>}
    </div>
  )
}
