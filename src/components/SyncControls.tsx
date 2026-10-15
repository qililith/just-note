import { Cloud, CloudOff, CloudUpload, LoaderCircle } from 'lucide-react'
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
  const pending = kind === 'pending' || kind === 'offline'
  const busy = syncing || kind === 'syncing'
  const hint = issue ? (issueCount > 0 ? `${issueCount} 项需要处理 · 点击查看` : '点击查看详情') : busy ? '' : '点击立即同步'
  const title = hint ? `${label} · ${hint}` : label
  return (
    <button
      type="button"
      className={`sync-button kind-${kind} ${issue ? 'has-issue' : ''} ${iconOnly ? 'icon-only' : ''}`}
      title={title}
      aria-label={title}
      aria-busy={busy}
      onClick={() => { if (issue) onOpenDetails(); else if (!busy) onSync() }}
      onContextMenu={event => { event.preventDefault(); onOpenDetails() }}
    >
      <StatusIcon kind={busy ? 'syncing' : kind} size={iconOnly ? 21 : 17} />
      {(issue || pending) && !busy && <span className={`sync-dot ${issue ? 'issue' : ''}`} aria-hidden="true" />}
    </button>
  )
}
