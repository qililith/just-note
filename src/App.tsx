import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, Check, ChevronDown, ChevronRight, FileText, GripVertical, Menu, Moon, PanelLeftClose, PanelLeftOpen, Pencil, Pin, Plus, Search, Settings, StickyNote, Sun, Trash2, X } from 'lucide-react'
import { toast, Toaster } from 'sonner'
import type { User as AuthUser } from '@supabase/supabase-js'
import { accountDb, type NoteRecord, type RichText } from './lib/db'
import { createFolder, createNote, createNoteWithContent, deleteFolder, purgeExpiredTrash, renameFolder, reorderFolders, saveNoteContent, searchNoteIds, updateNoteMeta } from './lib/notes'
import { MAX_FOLDER_NAME_LENGTH } from './lib/text'
import { hasUnsavedWork, useSaveFlags } from './lib/saveState'
import { demoMode, forgetUser, isAuthRejection, lastUserKey, rememberedUser, rememberUser, supabase, themeKey } from './lib/supabase'
import { runManualSync } from './lib/sync'
import { formatSyncClock, rememberLastSync, rememberedLastSync, syncUi } from './lib/syncUi'
import { SettingsPanel } from './components/SettingsPanel'
import { SyncControls } from './components/SyncControls'

type Account = { id: string; email: string }
type MobileHistoryState = { token: string; layer: 'list' | 'editor' | 'settings' | 'panel' | 'conflicts'; noteId: string | null; view: 'list' | 'editor'; settingsOpen: boolean }
const demoAccount: Account = { id: 'local-demo', email: '本地演示' }
const trashId = '__trash__'
const listStyleKey = 'just-note:list-style'
const NoteEditor = lazy(() => import('./components/NoteEditor').then(module => ({ default: module.NoteEditor })))
const DataPanel = lazy(() => import('./components/DataPanel').then(module => ({ default: module.DataPanel })))
const ConflictDialog = lazy(() => import('./components/ConflictDialog').then(module => ({ default: module.ConflictDialog })))

function Login({ onLogin, onDemo }: { onLogin: (email: string, password: string) => Promise<void>; onDemo: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <div className="login-page"><div className="login-container">
    <div className="login-brand"><div className="brand-logo"><StickyNote size={48} /></div><h1 className="brand-title">只是便签</h1><p className="brand-subtitle">简单、优雅地记录想法</p></div>
    <div className="login-form"><form className="login-card" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('')
      try { await onLogin(email, password) } catch (cause) { setError(cause instanceof Error ? cause.message : '登录失败') } finally { setBusy(false) }
    }}>
      <h2 className="login-title">欢迎使用</h2><p className="login-desc">请使用管理员为你创建的账号登录</p>
      {!supabase && <p className="form-message">尚未配置云端服务。请先按 README 设置。</p>}
      <input className="login-input" type="email" autoComplete="username" placeholder="邮箱" aria-label="邮箱" value={email} onChange={event => setEmail(event.target.value)} required />
      <input className="login-input" type="password" autoComplete="current-password" placeholder="密码" aria-label="密码" value={password} onChange={event => setPassword(event.target.value)} required />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn-login" type="submit" disabled={busy || !supabase}>{busy ? '登录中…' : '登录'}</button>
      {demoMode && <button className="btn-login" type="button" onClick={onDemo}>进入本地演示</button>}
    </form></div>
  </div></div>
}

function formatDate(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const gap = Date.now() - date.getTime()
  if (gap < 60_000) return '刚刚'
  if (gap < 3_600_000) return `${Math.floor(gap / 60_000)} 分钟前`
  if (gap < 86_400_000) return `${Math.floor(gap / 3_600_000)} 小时前`
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function NotesWorkspace({ account, onLogout, sessionEnded, onDiscardDraft }: { account: Account; onLogout: () => Promise<void>; sessionEnded: boolean; onDiscardDraft: () => void }) {
  const db = useMemo(() => accountDb(account.id), [account.id])
  const [theme, setTheme] = useState(() => localStorage.getItem(themeKey) || 'light')
  const [listStyle, setListStyle] = useState<'cards' | 'compact'>(() => localStorage.getItem(listStyleKey) === 'compact' ? 'compact' : 'cards')
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  const [mobileView, setMobileView] = useState<'list' | 'editor'>('list')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true)
  const [foldersExpanded, setFoldersExpanded] = useState(true)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [noteId, setNoteId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [searchIds, setSearchIds] = useState<Set<string> | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const folderCreateBusyRef = useRef(false)
  const folderCreateCancelRef = useRef(false)
  const folderRenameHandledRef = useRef(false)
  const [localError, setLocalError] = useState<{ noteId: string; message: string } | null>(null)
  const [dataPanelOpen, setDataPanelOpen] = useState(false)
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [lastSyncAt, setLastSyncAt] = useState(() => rememberedLastSync())
  const [creatingNote, setCreatingNote] = useState(false)
  const creatingNoteRef = useRef(false)
  const saveFlags = useSaveFlags()
  const hasUnsavedDraft = localError?.noteId === noteId
  const navigationToken = useRef(crypto.randomUUID())
  const activeMobileLayer = useRef<'list' | 'editor' | 'settings' | 'panel' | 'conflicts'>('list')
  const noteIdRef = useRef(noteId)
  noteIdRef.current = noteId

  const canLeaveEditor = useCallback(() => {
    if (hasUnsavedDraft) { toast.error('当前便签尚未保存，请先重新保存或另存为新便签'); return false }
    return true
  }, [hasUnsavedDraft])
  const canLeaveEditorRef = useRef(canLeaveEditor)
  canLeaveEditorRef.current = canLeaveEditor

  useEffect(() => {
    if (!isMobile) return
    const marker: MobileHistoryState = { token: navigationToken.current, layer: 'list', noteId: null, view: 'list', settingsOpen: false }
    window.history.replaceState({ ...(window.history.state ?? {}), justNoteMobile: marker }, '')
    activeMobileLayer.current = 'list'
    const onPopState = (event: PopStateEvent) => {
      const entry = event.state?.justNoteMobile as MobileHistoryState | undefined
      const next = entry?.token === navigationToken.current ? entry.layer : 'list'
      if (activeMobileLayer.current === 'editor' && next === 'list' && !canLeaveEditorRef.current()) {
        window.history.pushState({ ...(window.history.state ?? {}), justNoteMobile: {
          token: navigationToken.current, layer: 'editor', noteId: noteIdRef.current,
          view: 'editor', settingsOpen: false
        } }, '')
        return
      }
      activeMobileLayer.current = next
      setConflictDialogOpen(next === 'conflicts')
      setDataPanelOpen(next === 'panel')
      setSettingsOpen(next === 'settings' || next === 'panel' && Boolean(entry?.settingsOpen))
      setMobileView(next === 'editor' || entry?.view === 'editor' ? 'editor' : 'list')
      if (next === 'editor' && entry?.noteId) setNoteId(entry.noteId)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [isMobile])

  useEffect(() => {
    if (!isMobile) return
    const layer = conflictDialogOpen ? 'conflicts' : dataPanelOpen ? 'panel' : settingsOpen ? 'settings' : mobileView
    if (layer === activeMobileLayer.current) {
      if (layer === 'editor') {
        const entry = window.history.state?.justNoteMobile
        if (entry?.token === navigationToken.current && entry.noteId !== noteId) {
          window.history.replaceState({ ...window.history.state, justNoteMobile: { ...entry, noteId } }, '')
        }
      }
      return
    }
    if (layer === 'list' || (activeMobileLayer.current === 'panel' || activeMobileLayer.current === 'conflicts') && layer !== 'panel' && layer !== 'conflicts') {
      window.history.back()
      return
    }
    window.history.pushState({ ...(window.history.state ?? {}), justNoteMobile: {
      token: navigationToken.current, layer, noteId, view: mobileView, settingsOpen
    } }, '')
    activeMobileLayer.current = layer
  }, [isMobile, mobileView, settingsOpen, dataPanelOpen, conflictDialogOpen, noteId])

  const loadedNotes = useLiveQuery(() => db.notes.toArray(), [db])
  const notesLoaded = loadedNotes !== undefined
  const notes = useMemo(() => loadedNotes ?? [], [loadedNotes])
  const folders = useLiveQuery(() => db.folders.toArray(), [db], []) ?? []
  const body = useLiveQuery(() => noteId ? db.bodies.get(noteId) : undefined, [db, noteId])
  const conflictCount = useLiveQuery(() => db.conflicts.count(), [db], 0) ?? 0
  const pendingCount = notes.filter(note => note.dirty).length + folders.filter(folder => folder.dirty).length
  const syncError: string | null = null
  const selectedNote = notes.find(note => note.id === noteId) ?? null
  const keepDeletedOpen = hasUnsavedDraft || saveFlags.pending || saveFlags.held
  const currentRow = selectedNote && (!selectedNote.deletedAt || keepDeletedOpen) ? selectedNote : null
  const currentNote = currentRow && body?.id === currentRow.id ? { ...currentRow, doc: body.doc, plainText: body.plainText } : null
  const activeFolders = useMemo(() => folders.filter(folder => !folder.deletedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)), [folders])
  const visibleNotes = useMemo(() => notes.filter(note => {
    if (folderId === trashId) return !!note.deletedAt
    if (note.deletedAt) return false
    if (query.trim()) return searchIds?.has(note.id) ?? false
    return folderId === null || note.folderId === folderId
  }).sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)), [notes, folderId, query, searchIds])

  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem(themeKey, theme) }, [theme])
  useEffect(() => { localStorage.setItem(listStyleKey, listStyle) }, [listStyle])
  useEffect(() => { void purgeExpiredTrash(db) }, [db])
  useEffect(() => {
    const text = query.trim()
    if (!text) { setSearchIds(null); return }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void searchNoteIds(db, text, notes).then(ids => { if (!cancelled) setSearchIds(ids) })
    }, 150)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [db, query, notes])
  useEffect(() => {
    if (!hasUnsavedDraft) return
    const warnOnClose = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warnOnClose)
    return () => window.removeEventListener('beforeunload', warnOnClose)
  }, [hasUnsavedDraft])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 640px)')
    const changed = () => { setIsMobile(media.matches); if (!media.matches) setSidebarOpen(false) }
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  useEffect(() => {
    if (!notesLoaded) return
    if (noteId && notes.some(note => note.id === noteId) && !visibleNotes.some(note => note.id === noteId) && !keepDeletedOpen) setNoteId(visibleNotes[0]?.id ?? null)
    if (!noteId && !isMobile && visibleNotes[0] && folderId !== trashId) setNoteId(visibleNotes[0].id)
  }, [noteId, notes, notesLoaded, visibleNotes, isMobile, folderId, keepDeletedOpen])
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  const manualSync = useCallback(async () => {
    setSyncing(true)
    try {
      const ok = await runManualSync()
      if (ok) {
        const now = new Date()
        rememberLastSync(now)
        setLastSyncAt(now.toISOString())
        toast.success(`同步成功（${formatSyncClock(now)}）`)
      } else toast.error('同步失败')
    } finally { setSyncing(false) }
  }, [])
  const status = syncUi({ pendingCount, conflictCount, syncing, online, lastSyncAt })
  const openData = () => { if (!sessionEnded) setDataPanelOpen(true) }
  const openConflicts = () => { if (!sessionEnded) setConflictDialogOpen(true) }

  const editNote = useCallback(async (id: string, change: { title: string; doc: RichText; plainText: string }, loadedEditSeq: number) => {
    try {
      const saved = await saveNoteContent(db, id, change, loadedEditSeq)
      setLocalError(previous => previous?.noteId === id ? null : previous)
      return saved
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '本地保存失败'
      setLocalError({ noteId: id, message })
      toast.error(message)
      throw cause
    }
  }, [db])

  const saveCopy = useCallback(async (change: { title: string; doc: RichText; plainText: string }) => {
    try {
      const copy = await createNoteWithContent(db, currentRow?.folderId ?? null, change.title, change.doc, change.plainText)
      setLocalError(null); setNoteId(copy.id); setFolderId(null); toast.success('已保存为新便签')
      return true
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '副本保存失败'); return false }
  }, [db, currentRow?.folderId])

  const create = useCallback(async () => {
    if (creatingNoteRef.current || !canLeaveEditor()) return
    creatingNoteRef.current = true
    setCreatingNote(true)
    try {
      const note = await createNote(db, folderId === trashId ? null : folderId)
      setQuery(''); if (folderId === trashId) setFolderId(null)
      setNoteId(note.id); setMobileView('editor'); setSidebarOpen(false)
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '新建失败') }
    finally { creatingNoteRef.current = false; setCreatingNote(false) }
  }, [db, folderId, canLeaveEditor])

  const act = async (task: () => Promise<unknown>, success?: string) => {
    try { await task(); if (success) toast.success(success) }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : '操作失败') }
  }

  const moveFolder = (sourceId: string, targetId: string) => {
    const ordered = activeFolders.map(folder => folder.id)
    const source = ordered.indexOf(sourceId)
    const target = ordered.indexOf(targetId)
    if (source < 0 || target < 0 || source === target) return
    const [moved] = ordered.splice(source, 1)
    if (!moved) return
    ordered.splice(target, 0, moved)
    void act(() => reorderFolders(db, ordered))
  }

  const saveFolderName = (id: string) => {
    if (!editingName.trim()) { setEditingFolderId(null); return }
    const name = editingName
    folderRenameHandledRef.current = true
    setEditingFolderId(null)
    void act(() => renameFolder(db, id, name), '已重命名')
  }

  const createFolderAtTop = () => {
    if (folderCreateBusyRef.current) return
    const name = newFolderName.trim()
    if (!name) { setCreatingFolder(false); setNewFolderName(''); return }
    const previousOrder = activeFolders.map(folder => folder.id)
    folderCreateBusyRef.current = true
    folderCreateCancelRef.current = false
    void (async () => {
      try {
        const folder = await createFolder(db, name)
        setCreatingFolder(false)
        setNewFolderName('')
        await reorderFolders(db, [folder.id, ...previousOrder])
        toast.success('文件夹已创建')
      } catch (cause) { toast.error(cause instanceof Error ? cause.message : '创建文件夹失败') }
      finally { folderCreateBusyRef.current = false }
    })()
  }

  const cancelFolderCreation = () => {
    folderCreateCancelRef.current = true
    setCreatingFolder(false)
    setNewFolderName('')
  }

  const trashNote = (note: NoteRecord) => { if (note.id === noteId && !canLeaveEditor()) return; void act(() => updateNoteMeta(db, note.id, { deletedAt: new Date().toISOString() }), '已移入回收站') }
  const restoreNote = (note: NoteRecord) => void act(() => updateNoteMeta(db, note.id, { deletedAt: null }), '已恢复')
  const togglePin = (note: NoteRecord) => { if (note.id === noteId && !canLeaveEditor()) return; void act(() => updateNoteMeta(db, note.id, { isPinned: !note.isPinned })) }
  const selectFolder = (id: string | null) => { if (!canLeaveEditor()) return; setSettingsOpen(false); setFolderId(id); setQuery(''); setNoteId(null); setSidebarOpen(false); setMobileView('list') }
  const chooseNote = (note: NoteRecord) => { if (note.deletedAt || note.id !== noteId && !canLeaveEditor()) return; setSettingsOpen(false); setNoteId(note.id); if (isMobile) setMobileView('editor') }
  const selectedFolderName = folderId === trashId ? '回收站' : activeFolders.find(folder => folder.id === folderId)?.name ?? '全部便签'
  const listProps = { notes: visibleNotes, loading: !notesLoaded, currentNoteId: noteId, label: query ? '搜索结果' : selectedFolderName, isTrash: folderId === trashId, query, setQuery, onCreate: () => void create(), onSelect: chooseNote, onDelete: trashNote, onRestore: restoreNote, onPin: togglePin }

  return <div className={`app-layout ${isMobile && mobileView === 'editor' ? 'mobile-editing-layout' : ''} ${sessionEnded ? 'session-ended' : ''}`}>
    {isMobile && <header className="app-header">
      {isMobile && <button type="button" className="btn-menu" aria-label={mobileView === 'editor' ? '返回列表' : '打开菜单'} onClick={() => mobileView === 'editor' ? canLeaveEditor() && setMobileView('list') : setSidebarOpen(true)}>
        {mobileView === 'editor' ? <ArrowLeft size={20} /> : <Menu size={20} />}
      </button>}
      <div className="app-actions"><button type="button" className="btn-theme data-status-button" aria-label={conflictCount ? `设置，${conflictCount} 项冲突` : '设置'} title="设置" onClick={() => setSettingsOpen(true)}><Settings size={20} />{conflictCount > 0 && <span className="conflict-badge" aria-hidden="true">{conflictCount}</span>}</button></div>
    </header>}
    {sessionEnded && <div className="session-ended-banner" role="alert"><span>当前账号已退出或切换。请先处理草稿；本地保存完成后会自动退出。</span>{hasUnsavedDraft && <button type="button" onClick={onDiscardDraft}>草稿已复制，退出</button>}</div>}
    {isMobile && sidebarOpen && <div className="sidebar-overlay" aria-hidden="true" onClick={() => setSidebarOpen(false)} />}
    <div className="app-main">
      <aside className={`app-sidebar ${isMobile ? 'mobile-sidebar' : ''} ${sidebarOpen ? 'open' : ''} ${!isMobile && !desktopSidebarOpen ? 'desktop-collapsed' : ''}`} aria-hidden={!isMobile && !desktopSidebarOpen}>
        <div className="folder-list">
          <div className="sidebar-top-row"><button type="button" className={`folder-item system-folder all-notes-item ${folderId === null ? 'active' : ''}`} onClick={() => selectFolder(null)}><span className="folder-item-name">全部便签</span></button>{!isMobile && desktopSidebarOpen && <button type="button" className="btn-icon btn-ghost sidebar-collapse-btn" title="收起侧栏" aria-label="收起侧栏" onClick={() => setDesktopSidebarOpen(false)}><PanelLeftClose size={15} /></button>}</div>
          <div className="folder-list-header">{isMobile ? <h3 className="folder-list-title mobile-folder-title">文件夹</h3> : <button type="button" className="folder-list-title-btn" aria-expanded={foldersExpanded} onClick={() => setFoldersExpanded(!foldersExpanded)}>{foldersExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<h3 className="folder-list-title">文件夹</h3></button>}<button type="button" className="btn-icon btn-ghost folder-add-btn" title="新建文件夹" aria-label="新建文件夹" onClick={() => { folderCreateCancelRef.current = false; setCreatingFolder(true) }}><Plus size={14} /></button></div>
          {(isMobile || foldersExpanded) && <div className="folder-list-content">
            {creatingFolder && <form className="folder-create-form" onSubmit={event => { event.preventDefault(); createFolderAtTop() }}><input className="folder-create-input" autoFocus placeholder="输入文件夹名称" aria-label="新文件夹名称" title={`按 Enter 创建，按 Escape 取消；名称最多 ${MAX_FOLDER_NAME_LENGTH} 个字符`} maxLength={MAX_FOLDER_NAME_LENGTH} value={newFolderName} onChange={event => setNewFolderName(event.target.value)} onBlur={() => { if (folderCreateCancelRef.current) { folderCreateCancelRef.current = false; return } createFolderAtTop() }} onKeyDown={event => { if (event.key === 'Escape') cancelFolderCreation() }} /></form>}
            {activeFolders.map(folder => <div key={folder.id} className={`folder-item ${folderId === folder.id ? 'active' : ''}`} draggable={editingFolderId !== folder.id} onDragStart={event => event.dataTransfer.setData('text/plain', folder.id)} onDragOver={event => event.preventDefault()} onDrop={event => {
              event.preventDefault(); moveFolder(event.dataTransfer.getData('text/plain'), folder.id)
            }} onClick={() => { if (editingFolderId !== folder.id) selectFolder(folder.id) }}>
              <GripVertical size={14} className="folder-drag-handle" />
              {editingFolderId === folder.id ? <input className="folder-edit-input" autoFocus aria-label="重命名文件夹" title={`按 Enter 保存，按 Escape 取消；名称最多 ${MAX_FOLDER_NAME_LENGTH} 个字符`} maxLength={MAX_FOLDER_NAME_LENGTH} value={editingName} onClick={event => event.stopPropagation()} onChange={event => setEditingName(event.target.value)} onBlur={() => { if (folderRenameHandledRef.current) { folderRenameHandledRef.current = false; return } saveFolderName(folder.id) }} onKeyDown={event => { if (event.key === 'Escape') { folderRenameHandledRef.current = true; setEditingFolderId(null) } if (event.key === 'Enter') { event.preventDefault(); saveFolderName(folder.id) } }} /> : <span className="folder-item-name">{folder.name}</span>}
              {editingFolderId !== folder.id && <div className="folder-actions"><button type="button" className="btn-icon-sm" title="重命名" onClick={event => { event.stopPropagation(); folderRenameHandledRef.current = false; setEditingFolderId(folder.id); setEditingName(folder.name) }}><Pencil size={14} /></button><button type="button" className="btn-icon-sm danger" title="删除文件夹" onClick={event => { event.stopPropagation(); if (currentRow?.folderId === folder.id && !canLeaveEditor()) return; if (confirm('删除文件夹？其中的便签会保留在全部便签中。')) void act(async () => { await deleteFolder(db, folder.id); if (folderId === folder.id) selectFolder(null) }, '文件夹已删除') }}><Trash2 size={14} /></button></div>}
            </div>)}
          </div>}
        </div>
        {!isMobile && <div className="sidebar-divider" />}
        {!isMobile && <NoteList {...listProps} />}
        <div className="sidebar-footer">
          {!isMobile && <button type="button" className={`folder-item system-folder ${settingsOpen ? 'active' : ''}`} onClick={() => setSettingsOpen(true)}><Settings size={14} /><span className="folder-item-name">设置</span></button>}
          <button type="button" className={`folder-item system-folder sidebar-trash ${folderId === trashId ? 'active' : ''}`} onClick={() => selectFolder(trashId)}><Trash2 size={14} /><span className="folder-item-name">回收站</span></button>
        </div>
      </aside>
      {isMobile && mobileView === 'list' && <div className="mobile-note-list-container"><NoteList {...listProps} isMobile listStyle={listStyle} /></div>}
      {(!isMobile || mobileView === 'editor' || sessionEnded) && <main className={`app-editor ${isMobile ? 'mobile-active' : ''}`}>{settingsOpen && !isMobile && !sessionEnded ? <SettingsPanel userId={account.id} currentFolderId={folderId === trashId ? undefined : folderId} isMobile={false} listStyle={listStyle} onListStyleChange={setListStyle} theme={theme} onThemeChange={setTheme} pendingCount={pendingCount} conflictCount={conflictCount} onClose={() => setSettingsOpen(false)} onOpenSync={() => setDataPanelOpen(true)} hasSyncIssue={conflictCount > 0} syncStatus={status.label} onLogout={async () => { if (!canLeaveEditor()) return; setSettingsOpen(false); await onLogout() }} onCleared={onLogout} /> : creatingNote ? <div className="editor-empty">正在新建便签…</div> : currentNote ? <Suspense fallback={<div className="editor-empty">加载编辑器…</div>}><NoteEditor onBack={() => { if (canLeaveEditor()) setMobileView('list') }} onPin={() => togglePin(currentNote)} onDelete={() => { if (!canLeaveEditor()) return; void act(async () => { await updateNoteMeta(db, currentNote.id, { deletedAt: new Date().toISOString() }); setNoteId(null); setMobileView('list') }, '已移入回收站') }} note={currentNote} folders={activeFolders} onEdit={editNote} onSaveCopy={saveCopy} onDiscardError={() => setLocalError(null)} onMoveFolder={destination => { if (!canLeaveEditor()) return; void act(() => updateNoteMeta(db, currentNote.id, { folderId: destination }), '已移动') }} onOpenSidebar={!isMobile && !desktopSidebarOpen ? () => setDesktopSidebarOpen(true) : undefined} onOpenData={openData} onOpenConflicts={openConflicts} onManualSync={() => void manualSync()} localError={localError?.noteId === currentNote.id ? localError.message : null} syncError={syncError} pendingCount={pendingCount} syncIssueCount={conflictCount} hasConflict={currentNote.hasConflict === 1} syncing={syncing} online={online} lastSyncAt={lastSyncAt} isMobile={isMobile} theme={theme} onToggleTheme={() => setTheme(current => current === 'light' ? 'dark' : 'light')} /></Suspense> : currentRow ? <div className="editor-empty">加载编辑器…</div> : <div className="editor-empty"><div className="empty-editor-toolbar">{!isMobile && !desktopSidebarOpen && <button type="button" className="toolbar-btn" title="展开侧栏" aria-label="展开侧栏" onClick={() => setDesktopSidebarOpen(true)}><PanelLeftOpen size={18} /></button>}<div className="toolbar-spacer" /><SyncControls label={status.label} kind={status.kind} issueCount={conflictCount} syncing={syncing} onOpenDetails={conflictCount ? openConflicts : openData} onSync={() => void manualSync()} /><button type="button" className="toolbar-btn editor-theme-toggle" aria-label="切换主题" title="切换主题" onClick={() => setTheme(current => current === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}</button></div><div className="editor-empty-content"><p>选择或创建一个便签开始编辑</p></div></div>}</main>}
    </div>
    {settingsOpen && isMobile && !sessionEnded && <SettingsPanel userId={account.id} currentFolderId={folderId === trashId ? undefined : folderId} isMobile listStyle={listStyle} onListStyleChange={setListStyle} theme={theme} onThemeChange={setTheme} pendingCount={pendingCount} conflictCount={conflictCount} onClose={() => setSettingsOpen(false)} onOpenSync={() => { setSettingsOpen(false); setDataPanelOpen(true) }} hasSyncIssue={conflictCount > 0} syncStatus={status.label} onLogout={async () => { if (!canLeaveEditor()) return; setSettingsOpen(false); await onLogout() }} onCleared={onLogout} />}
    {dataPanelOpen && !sessionEnded && <Suspense fallback={null}><DataPanel lastSyncLabel={status.label} syncing={syncing} pendingCount={pendingCount} conflictCount={conflictCount} onManualSync={() => void manualSync()} onOpenConflicts={() => { setDataPanelOpen(false); openConflicts() }} onClose={() => setDataPanelOpen(false)} /></Suspense>}
    {conflictDialogOpen && !sessionEnded && <Suspense fallback={null}><ConflictDialog userId={account.id} activeNoteId={noteId} onClose={() => setConflictDialogOpen(false)} /></Suspense>}
  </div>
}

function NoteRow({ note, current, isTrash, isMobile, listStyle, onSelect, onDelete, onRestore, onPin, swipeOpen, onSwipeChange }: {
  note: NoteRecord; current: boolean; isTrash: boolean; isMobile: boolean; listStyle: 'cards' | 'compact'
  onSelect: (note: NoteRecord) => void; onDelete: (note: NoteRecord) => void; onRestore: (note: NoteRecord) => void; onPin: (note: NoteRecord) => void
  swipeOpen: boolean; onSwipeChange: (id: string | null) => void
}) {
  const actionWidth = 128
  const [dx, setDx] = useState(0)
  const dxRef = useRef(0)
  const start = useRef<{ x: number; y: number; axis: 'h' | 'v' | null } | null>(null)
  const swiped = useRef(false)
  const itemRef = useRef<HTMLDivElement>(null)
  const swipe = isMobile && !isTrash
  const offset = (value: number) => { dxRef.current = value; setDx(value) }

  useEffect(() => { offset(swipeOpen ? -actionWidth : 0) }, [swipeOpen])
  useEffect(() => {
    if (!swipe) return
    const el = itemRef.current
    if (!el) return
    const onStart = (event: TouchEvent) => {
      start.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, axis: null }
      if (!swipeOpen) onSwipeChange(null)
    }
    const onMove = (event: TouchEvent) => {
      if (!start.current) return
      const mx = event.touches[0].clientX - start.current.x
      const my = event.touches[0].clientY - start.current.y
      if (!start.current.axis) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return
        start.current.axis = Math.abs(mx) > Math.abs(my) ? 'h' : 'v'
      }
      if (start.current.axis !== 'h') return
      swiped.current = true
      event.preventDefault()
      const base = swipeOpen ? -actionWidth : 0
      offset(Math.min(0, Math.max(-actionWidth, base + mx)))
    }
    const onEnd = () => {
      if (!start.current) return
      const next = dxRef.current < -actionWidth / 2 ? -actionWidth : 0
      offset(next)
      onSwipeChange(next < 0 ? note.id : null)
      start.current = null
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [swipe, swipeOpen, note.id, onSwipeChange])

  const body = <>
    <div className="note-item-header">{note.isPinned && !isTrash && <Pin className="note-item-pin" size={14} aria-hidden="true" />}<h4 className="note-item-title">{note.title || (isMobile && listStyle === 'compact' ? note.summary.trim().split('\n')[0]?.slice(0, 60) : '') || '无标题'}</h4>{!swipe && <div className="note-item-actions">{isTrash ? <button type="button" className="btn-icon-sm" title="恢复" onClick={event => { event.stopPropagation(); onRestore(note) }}><Check size={14} /></button> : <><button type="button" className="btn-icon-sm" title={note.isPinned ? '取消置顶' : '置顶'} onClick={event => { event.stopPropagation(); onPin(note) }}><Pin size={14} /></button><button type="button" className="btn-icon-sm danger" title="移入回收站" onClick={event => { event.stopPropagation(); if (confirm('将这条便签移入回收站？')) onDelete(note) }}><Trash2 size={14} /></button></>}</div>}</div>
    <p className="note-item-summary">{note.summary || '无内容'}</p><div className="note-item-footer"><span className="note-item-date">{formatDate(note.updatedAt)}</span>{note.hasConflict === 1 && !isTrash && <span className="note-item-badge">需处理</span>}</div>
  </>
  const select = () => {
    if (swiped.current || dxRef.current !== 0) {
      swiped.current = false
      offset(0)
      onSwipeChange(null)
      return
    }
    onSelect(note)
  }
  const card = <div ref={itemRef} role="option" aria-selected={current} tabIndex={0} className={`note-item ${current ? 'active' : ''} ${note.isPinned ? 'pinned' : ''}`} style={swipe ? { transform: `translateX(${dx}px)` } : undefined} onClick={select} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select() } }}>{body}</div>
  if (!swipe) return card
  return <div className="note-swipe">
    <div className="note-swipe-actions">
      <button type="button" className="note-swipe-pin" onClick={() => { onPin(note); offset(0); onSwipeChange(null) }}>{note.isPinned ? '取消置顶' : '置顶'}</button>
      <button type="button" className="note-swipe-delete" onClick={() => { if (confirm('将这条便签移入回收站？')) onDelete(note); offset(0); onSwipeChange(null) }}>删除</button>
    </div>
    {card}
  </div>
}

function NoteList({ notes, loading, currentNoteId, label, query, setQuery, isTrash, isMobile = false, listStyle = 'cards', onCreate, onSelect, onDelete, onRestore, onPin }: {
  notes: NoteRecord[]; loading: boolean; currentNoteId: string | null; label: string; query: string; setQuery: (value: string) => void; isTrash: boolean; isMobile?: boolean; listStyle?: 'cards' | 'compact'
  onCreate: () => void; onSelect: (note: NoteRecord) => void; onDelete: (note: NoteRecord) => void; onRestore: (note: NoteRecord) => void; onPin: (note: NoteRecord) => void
}) {
  const [searchOpen, setSearchOpen] = useState(Boolean(query))
  const [openSwipe, setOpenSwipe] = useState<string | null>(null)
  const closeSearch = () => { setQuery(''); setSearchOpen(false) }
  return <div className={`note-list ${isMobile && listStyle === 'compact' ? 'compact-note-list' : ''} ${isTrash ? 'is-trash' : ''}`}>{(!isMobile || isTrash) && <div className="note-list-header"><div className="note-list-heading"><h3 className="note-list-title" title={label}>{isTrash ? '回收站' : '便签'}</h3>{!isTrash && !isMobile && <button type="button" className={`btn-icon btn-ghost note-search-toggle ${searchOpen ? 'active' : ''}`} title={searchOpen ? '收起搜索' : '搜索便签'} aria-label={searchOpen ? '收起搜索' : '搜索便签'} aria-expanded={searchOpen} onClick={() => searchOpen ? closeSearch() : setSearchOpen(true)}>{searchOpen ? <X size={16} /> : <Search size={16} />}</button>}</div>{!isMobile && <button type="button" className="btn-icon btn-primary" title="新建便签" aria-label="新建便签" onClick={onCreate}><Plus size={18} /></button>}</div>}
    {!isTrash && (isMobile || searchOpen) && <label className={`search-box ${isMobile ? 'mobile-list-search' : 'search-box-expanded'}`}><Search size={18} /><input autoFocus={!isMobile} aria-label="搜索便签" placeholder="搜索便签" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') closeSearch() }} />{isMobile && query && <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={18} /></button>}</label>}
    <div className="note-list-content" role="listbox" aria-label={label}>{loading ? <div className="note-list-empty"><p>正在读取这台设备上的便签…</p></div> : notes.length ? notes.flatMap((note, index) => {
      const split = !isTrash && note.isPinned && Boolean(notes[index + 1] && !notes[index + 1].isPinned)
      const row = <NoteRow key={note.id} note={note} current={currentNoteId === note.id} isTrash={isTrash} isMobile={isMobile} listStyle={listStyle} onSelect={onSelect} onDelete={onDelete} onRestore={onRestore} onPin={onPin} swipeOpen={openSwipe === note.id} onSwipeChange={setOpenSwipe} />
      return split ? [row, <div key={`${note.id}-split`} className="note-pin-split" role="separator" />] : [row]
    }) : <div className="note-list-empty"><FileText size={48} className="empty-icon" /><p>{query ? '没有找到便签' : isTrash ? '回收站为空' : '暂无便签'}</p>{!isMobile && !isTrash && !query && <button type="button" className="btn-text" onClick={onCreate}>创建第一条便签</button>}</div>}</div>
    {isMobile && <button type="button" className="mobile-list-create" title="新建便签" aria-label="新建便签" onClick={onCreate}><Plus size={26} /></button>}
  </div>
}

export function App() {
  const [account, setAccount] = useState<Account | null>(() => demoMode ? demoAccount : rememberedUser())
  const [sessionEnded, setSessionEnded] = useState(false)
  const accountRef = useRef(account)
  const saveFlags = useSaveFlags()
  accountRef.current = account

  useEffect(() => {
    if (!sessionEnded || saveFlags.pending || saveFlags.held) return
    setSessionEnded(false)
    setAccount(null)
  }, [sessionEnded, saveFlags.pending, saveFlags.held])

  useEffect(() => {
    const signedOutElsewhere = (event: StorageEvent) => {
      const current = accountRef.current
      if (!current || event.key !== lastUserKey || rememberedUser()?.id === current.id) return
      if (hasUnsavedWork()) setSessionEnded(true)
      else { setSessionEnded(false); setAccount(null) }
    }
    window.addEventListener('storage', signedOutElsewhere)
    return () => window.removeEventListener('storage', signedOutElsewhere)
  }, [])

  useEffect(() => {
    const warnOnClose = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedWork()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnOnClose)
    return () => window.removeEventListener('beforeunload', warnOnClose)
  }, [])

  useEffect(() => {
    if (demoMode) return
    const client = supabase
    if (!client) return
    let active = true
    const lock = () => {
      forgetUser()
      if (hasUnsavedWork()) setSessionEnded(true)
      else { accountRef.current = null; setSessionEnded(false); setAccount(null) }
    }
    const accept = (user: AuthUser) => {
      if (accountRef.current && accountRef.current.id !== user.id && hasUnsavedWork()) { lock(); return }
      rememberUser(user)
      accountRef.current = { id: user.id, email: user.email ?? '' }
      setSessionEnded(false)
      setAccount(accountRef.current)
    }
    const verify = async () => {
      if (!active || !rememberedUser()) return
      try {
        const { data, error } = await client.auth.getUser()
        if (!active || !rememberedUser()) return
        if (data.user && !error) accept(data.user)
        else if (!error || isAuthRejection(error)) lock()
        // Transient failures leave the local workspace open. Never delete its data.
      } catch { /* A transport failure is not proof that this account was signed out. */ }
    }
    const retry = () => { void verify() }
    const retryWhenVisible = () => { if (document.visibilityState === 'visible') retry() }
    const { data: subscription } = client.auth.onAuthStateChange(event => {
      if (active && event === 'SIGNED_OUT') lock()
    })
    retry()
    window.addEventListener('online', retry)
    window.addEventListener('focus', retry)
    window.addEventListener('pageshow', retry)
    document.addEventListener('visibilitychange', retryWhenVisible)
    const timer = window.setInterval(retry, 60_000)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('online', retry)
      window.removeEventListener('focus', retry)
      window.removeEventListener('pageshow', retry)
      document.removeEventListener('visibilitychange', retryWhenVisible)
      subscription.subscription.unsubscribe()
    }
  }, [])

  const login = async (email: string, password: string) => {
    if (!supabase) throw new Error('云端服务尚未配置')
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error || !data.user) throw new Error(error?.message ?? '登录失败')
    rememberUser(data.user)
    setSessionEnded(false)
    setAccount({ id: data.user.id, email: data.user.email ?? '' })
  }

  const logout = async () => {
    if (!demoMode) { try { await supabase?.auth.signOut({ scope: 'local' }) } catch { /* Local sign-out still applies. */ } }
    forgetUser()
    setAccount(null)
  }

  const discardDraftAndLock = () => {
    if (!window.confirm('确认草稿已复制到其他地方？退出后未保存的修改会丢失。')) return
    setSessionEnded(false)
    setAccount(null)
  }

  // These toasts contain status text only; they must not intercept toolbar clicks.
  return <><Toaster position="top-right" style={{ pointerEvents: 'none' }} toastOptions={{ style: { pointerEvents: 'none' } }} />{account ? <NotesWorkspace key={account.id} account={account} onLogout={logout} sessionEnded={sessionEnded} onDiscardDraft={discardDraftAndLock} /> : <Login onLogin={login} onDemo={() => setAccount(demoAccount)} />}</>
}
