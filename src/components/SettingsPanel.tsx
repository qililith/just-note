import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, ChevronRight, Cloud, LayoutGrid, List, Moon, Sun } from 'lucide-react'
import { toast } from 'sonner'
import { accountDb } from '../lib/db'
import { estimateStorage, exportAccount, wipeAccount, type StorageEstimate } from '../lib/notes'
import { downloadBatchExport, downloadBlob, type BatchExportKind } from '../lib/noteExport'
import { useSaveFlags } from '../lib/saveState'

type Props = {
  userId: string
  currentFolderId?: string | null
  theme: string
  syncStatus: string
  hasSyncIssue: boolean
  isMobile: boolean
  pendingCount: number
  conflictCount: number
  onThemeChange: (theme: 'light' | 'dark') => void
  onOpenSync: () => void
  onClose: () => void
  onLogout: () => Promise<void>
  onCleared: () => Promise<void>
  listStyle: 'cards' | 'compact'
  onListStyleChange: (style: 'cards' | 'compact') => void
}

function formatBytes(bytes: number) {
  return `${(bytes / 1048576).toFixed(1)} MiB`
}

export function SettingsPanel({ userId, currentFolderId, theme, syncStatus, hasSyncIssue, isMobile, pendingCount, conflictCount, onThemeChange, onOpenSync, onClose, onLogout, onCleared, listStyle, onListStyleChange }: Props) {
  const db = accountDb(userId)
  const [busy, setBusy] = useState(false)
  const [storage, setStorage] = useState<StorageEstimate | null>(null)
  const [exportScope, setExportScope] = useState(currentFolderId ?? '__all__')
  const [exportKind, setExportKind] = useState<BatchExportKind>('md-zip')
  const saveFlags = useSaveFlags()
  const saving = saveFlags.pending || saveFlags.held
  const notes = useLiveQuery(() => db.notes.toArray(), [db], []) ?? []
  const folders = useLiveQuery(() => db.folders.toArray(), [db], []) ?? []
  const exportCount = notes.filter(note => !note.deletedAt && (exportScope === '__all__' || note.folderId === (exportScope === '__unfiled__' ? null : exportScope))).length

  const run = async (task: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try { await task(); toast.success(success) }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : '操作失败') }
    finally { setBusy(false) }
  }

  return <section className="settings-page" aria-label="设置">
    <header className="settings-heading"><button type="button" aria-label="返回便签" onClick={onClose}><ArrowLeft size={22} /></button><h2>设置</h2></header>
    <button type="button" className="settings-sync" onClick={onOpenSync}>
      <Cloud size={23} /><span><strong>同步</strong><small className={hasSyncIssue ? 'has-issue' : ''}>{syncStatus}</small></span><ChevronRight size={20} />
    </button>
    {isMobile && <fieldset className="settings-theme"><legend>显示模式</legend>
      <label><input type="radio" name="display-theme" value="light" checked={theme !== 'dark'} onChange={() => onThemeChange('light')} /><Sun size={21} /><span>白天模式</span></label>
      <label><input type="radio" name="display-theme" value="dark" checked={theme === 'dark'} onChange={() => onThemeChange('dark')} /><Moon size={21} /><span>暗夜模式</span></label>
    </fieldset>}
    {isMobile && <fieldset className="settings-theme"><legend>便签展示</legend>
      <label><input type="radio" name="note-list-style" checked={listStyle === 'cards'} onChange={() => onListStyleChange('cards')} /><LayoutGrid size={21} /><span>卡片视图</span></label>
      <label><input type="radio" name="note-list-style" checked={listStyle === 'compact'} onChange={() => onListStyleChange('compact')} /><List size={21} /><span>列表视图</span></label>
    </fieldset>}
    <section className="settings-block">
      <h3>备份</h3>
      <p>建议定期导出一份备份，放到这台电脑以外的地方。</p>
      <button type="button" disabled={busy || saving} onClick={() => void run(async () => {
        const payload = await exportAccount(db)
        downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `只是便签备份-${payload.exportedAt.slice(0, 10)}.json`)
      }, '已开始下载备份')}>导出备份</button>
    </section>
    <section className="settings-block">
      <h3>导出为文件</h3>
      <p>按文件夹或全部便签生成便于阅读的副本，不能用来完整恢复。单条便签请在编辑页导出。</p>
      <label>范围<select aria-label="导出范围" value={exportScope} disabled={busy} onChange={event => setExportScope(event.target.value)}>
        <option value="__all__">全部便签</option><option value="__unfiled__">未分类</option>
        {folders.filter(folder => !folder.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
      </select></label>
      <label>格式<select aria-label="批量导出类型" value={exportKind} disabled={busy} onChange={event => setExportKind(event.target.value as BatchExportKind)}>
        <option value="md-zip">Markdown（压缩包）</option>
        <option value="txt-zip">纯文本（压缩包）</option>
        <option value="html-zip">网页（压缩包）</option>
        <option value="md-merged">合并成一个 Markdown</option>
        <option value="txt-merged">合并成一个文本文件</option>
      </select></label>
      <p>共 {exportCount} 条，不含回收站。</p>
      <button type="button" disabled={busy || saving || exportCount === 0} onClick={() => void run(() => downloadBatchExport(db,
        exportScope === '__all__' ? { kind: 'all' } : { kind: 'folder', folderId: exportScope === '__unfiled__' ? null : exportScope }, exportKind), '已开始下载')}>下载</button>
    </section>
    <section className="settings-block">
      <h3>本机占用</h3>
      <p>数字是估算，不能代替备份。</p>
      <button type="button" disabled={busy} onClick={() => void run(async () => setStorage(await estimateStorage(db)), '占用信息已更新')}>查看本机占用</button>
      {storage && <>
        <p>{storage.notes} 条便签（含回收站），约 {formatBytes(storage.noteBytes)}。</p>
        {storage.siteUsageBytes !== null && <p>本网址在浏览器中共占用约 {formatBytes(storage.siteUsageBytes)}。</p>}
      </>}
    </section>
    <section className="settings-block">
      <h3>这台设备</h3>
      <p>退出登录不会删掉这台设备上的内容。</p>
      <button type="button" disabled={busy || saving} onClick={() => void onLogout()}>退出登录</button>
    </section>
    <section className="settings-block danger-block">
      <h3>清除本机数据</h3>
      <p>清除会删掉这台设备上的便签，其他设备不受影响。请先导出备份。</p>
      <button type="button" className="danger-action" disabled={busy || saving} onClick={() => {
        const warning = pendingCount > 0 || conflictCount > 0
          ? '还有没同步或没处理的内容，清除后只能从你导出的备份里找回。确认清除这台设备上的便签？'
          : '确认已经导出备份，并清除这台设备上的便签？'
        if (confirm(warning)) void run(async () => { await wipeAccount(userId); await onCleared() }, '这台设备上的数据已清除')
      }}>清除本机数据并退出</button>
    </section>
  </section>
}
