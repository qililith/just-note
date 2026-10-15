export const lastSyncKey = 'just-note:last-sync'

export function formatSyncClock(at: Date | string) {
  const date = typeof at === 'string' ? new Date(at) : at
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export type SyncKind = 'unsaved' | 'external' | 'saving' | 'conflict' | 'syncing' | 'failed' | 'offline' | 'pending' | 'synced' | 'saved'

export type SyncUi = { label: string; kind: SyncKind; issue: boolean }

export function syncUi(input: {
  localError?: boolean
  externalChange?: boolean
  saving?: boolean
  hasConflict?: boolean
  conflictCount?: number
  syncError?: boolean
  pendingCount: number
  syncing?: boolean
  online: boolean
  lastSyncAt: string | null
}): SyncUi {
  if (input.localError) return { label: '未保存', kind: 'unsaved', issue: true }
  if (input.externalChange) return { label: '其它窗口已更新', kind: 'external', issue: true }
  if (input.saving) return { label: '保存中', kind: 'saving', issue: false }
  if (input.hasConflict || (input.conflictCount ?? 0) > 0) return { label: '有冲突', kind: 'conflict', issue: true }
  if (input.syncing) return { label: '同步中…', kind: 'syncing', issue: false }
  if (input.syncError) return { label: '同步失败', kind: 'failed', issue: true }
  if (!input.online && input.pendingCount > 0) return { label: '离线待同步', kind: 'offline', issue: false }
  if (input.pendingCount > 0) return { label: '待同步', kind: 'pending', issue: false }
  if (input.lastSyncAt) return { label: `已同步 ${formatSyncClock(input.lastSyncAt)}`, kind: 'synced', issue: false }
  return { label: '已保存', kind: 'saved', issue: false }
}

export function rememberedLastSync() {
  return localStorage.getItem(lastSyncKey)
}

export function rememberLastSync(at: Date) {
  localStorage.setItem(lastSyncKey, at.toISOString())
}
