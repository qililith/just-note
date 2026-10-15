import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { closeHistory } from '@tiptap/pm/history'
import { Fragment, Slice } from '@tiptap/pm/model'
import { toast } from 'sonner'
import { createEditorExtensions } from '../lib/editor'
import { ArrowLeft, Bold, CheckSquare, ChevronDown, ChevronLeft, ChevronRight, Cloud, Download, FileText, FolderInput, Heading1, Heading2, Heading3, Highlighter, Italic, List, ListOrdered, Maximize2, Menu, Minimize2, Moon, PanelLeftOpen, Pin, Redo2, RefreshCw, Sun, Trash2, Type, Undo2, X } from 'lucide-react'
import { SyncControls } from './SyncControls'
import { FolderPicker } from './FolderPicker'
import { syncUi } from '../lib/syncUi'
import type { FolderRecord, RichText } from '../lib/db'
import { titleFromText, titleWithSuffix, withLeadingTitle } from '../lib/text'
import { beginSave, endSave, holdInput, releaseInput } from '../lib/saveState'
import { downloadNoteExport, type NoteExportFormat } from '../lib/noteExport'

export type EditorNote = {
  id: string
  title: string
  doc: RichText
  plainText: string
  editSeq: number
  folderId: string | null
  isPinned: boolean
}

type Change = { title: string; doc: RichText; plainText: string }

type Props = {
  note: EditorNote | null
  folders: FolderRecord[]
  onEdit: (id: string, change: Change, loadedEditSeq: number) => Promise<{ editSeq: number }>
  onSaveCopy: (change: Change) => Promise<boolean>
  onDiscardError: () => void
  onMoveFolder: (folderId: string | null) => void
  onOpenSidebar?: () => void
  onOpenData: () => void
  onOpenConflicts: () => void
  onManualSync: () => void
  localError: string | null
  syncError: string | null
  pendingCount: number
  syncIssueCount: number
  hasConflict: boolean
  syncing: boolean
  online: boolean
  lastSyncAt: string | null
  isMobile: boolean
  theme: string
  onToggleTheme: () => void
  onBack?: () => void
  onPin?: () => void
  onDelete?: () => void
}

function EditorBody({ note, folders, onEdit, onSaveCopy, onDiscardError, onMoveFolder, onOpenSidebar, onOpenData, onOpenConflicts, onManualSync, localError, syncError, pendingCount, syncIssueCount, hasConflict, syncing, online, lastSyncAt, isMobile, theme, onToggleTheme, onBack, onPin, onDelete }: Props & { note: EditorNote }) {
  const [fullscreen, setFullscreen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [wordCount, setWordCount] = useState(() => withLeadingTitle(note.title, note.doc, note.plainText).plainText.length)
  const [saving, setSaving] = useState(false)
  const [externalChange, setExternalChange] = useState(false)
  const loadedSeq = useRef(note.editSeq)
  const pendingChange = useRef<Change | null>(null)
  const burstStart = useRef<number | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const writeChain = useRef<Promise<void>>(Promise.resolve())
  const holding = useRef(false)
  const mounted = useRef(true)
  const onEditRef = useRef(onEdit)
  onEditRef.current = onEdit
  const toolbarGroupRef = useRef<HTMLDivElement>(null)
  const folderMenuRef = useRef<HTMLDetailsElement>(null)
  const [toolbarOverflow, setToolbarOverflow] = useState(false)
  const [toolbarShifted, setToolbarShifted] = useState(false)
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)
  const [fontPanelOpen, setFontPanelOpen] = useState(false)
  const [mobileMenu, setMobileMenu] = useState<'actions' | 'folders' | 'export' | null>(null)
  const mobileMenuRef = useRef<HTMLDialogElement>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)

  const releaseHoldIfIdle = () => {
    if (pendingChange.current || !holding.current) return
    holding.current = false
    releaseInput()
  }

  const flush = useCallback(() => {
    const change = pendingChange.current
    if (!change) return writeChain.current
    pendingChange.current = null
    burstStart.current = null
    window.clearTimeout(saveTimer.current)
    const noteId = note.id
    beginSave()
    if (mounted.current) setSaving(true)
    const task = writeChain.current.then(async () => {
      try {
        const saved = await onEditRef.current(noteId, change, loadedSeq.current)
        loadedSeq.current = saved.editSeq
      } catch {
        if (!pendingChange.current) pendingChange.current = change
      }
    }).finally(() => {
      endSave()
      if (mounted.current) setSaving(false)
      releaseHoldIfIdle()
    })
    writeChain.current = task
    return task
  }, [note.id])
  const flushRef = useRef(flush)
  flushRef.current = flush

  const enqueue = useCallback((doc: RichText, plainText: string) => {
    pendingChange.current = { doc, plainText, title: titleFromText(plainText) }
    if (!holding.current) {
      holding.current = true
      holdInput()
    }
    const now = Date.now()
    burstStart.current ??= now
    const elapsed = now - burstStart.current
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { void flushRef.current() }, elapsed >= 1000 ? 0 : Math.min(300, 1000 - elapsed))
  }, [])

  const editor = useEditor({
    extensions: createEditorExtensions(),
    enablePasteRules: false,
    content: withLeadingTitle(note.title, note.doc, note.plainText).doc,
    onUpdate: ({ editor: changed }) => {
      const plainText = changed.getText({ blockSeparator: '\n' })
      setWordCount(plainText.length)
      enqueue(changed.getJSON() as RichText, plainText)
    },
    onBlur: () => { void flushRef.current() },
    editorProps: {
      attributes: { class: 'editor-content', 'aria-label': '便签正文', 'data-placeholder': '开始写点什么' },
      transformPastedHTML: () => '',
      handlePaste: (view, event) => {
        if (!event.clipboardData) return false
        const plain = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
        event.preventDefault()
        if (!plain) { toast.error('剪贴板没有可粘贴的纯文本'); return true }
        const { state } = view
        if (state.selection.$from.parent.type.spec.code) {
          view.dispatch(closeHistory(state.tr).insertText(plain).scrollIntoView())
          view.dispatch(closeHistory(view.state.tr))
          return true
        }
        // Use the current view, not the editor reference captured during its
        // initialization. Text nodes preserve literal HTML and empty lines.
        const marks = state.storedMarks ?? state.selection.$from.marks()
        const paragraphs = plain.split('\n').map(line => state.schema.nodes.paragraph.create(null,
          line ? state.schema.text(line, marks) : undefined))
        const slice = Slice.maxOpen(Fragment.fromArray(paragraphs))
        view.dispatch(closeHistory(state.tr).replaceSelection(slice).setMeta('uiEvent', 'paste').scrollIntoView())
        view.dispatch(closeHistory(view.state.tr))
        return true
      }
    }
  }, [note.id])

  const loadStoredVersion = useCallback(() => {
    if (!editor) return
    const stored = withLeadingTitle(note.title, note.doc, note.plainText)
    editor.commands.setContent(stored.doc, { emitUpdate: false })
    setWordCount(stored.plainText.length)
    loadedSeq.current = note.editSeq
    pendingChange.current = null
    releaseHoldIfIdle()
    setExternalChange(false)
  }, [editor, note.doc, note.plainText, note.editSeq])

  useEffect(() => {
    if (!editor) return
    if (note.editSeq === loadedSeq.current) { setExternalChange(false); return }
    if (saving || pendingChange.current || localError || editor.isFocused) { setExternalChange(true); return }
    loadStoredVersion()
    onDiscardError()
  }, [editor, note.editSeq, saving, localError, loadStoredVersion, onDiscardError])

  useEffect(() => {
    mounted.current = true
    const onHidden = () => { if (document.visibilityState === 'hidden') void flushRef.current() }
    const onPageHide = () => { void flushRef.current() }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      mounted.current = false
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPageHide)
      void flushRef.current()
      if (holding.current) {
        holding.current = false
        releaseInput()
      }
    }
  }, [])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFullscreen(false)
        setFolderMenuOpen(false)
        setExportOpen(false)
        setFontPanelOpen(false)
        setMobileMenu(null)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  useEffect(() => {
    if (!isMobile) return
    const viewport = window.visualViewport
    const resize = () => document.documentElement.style.setProperty('--mobile-viewport-height', `${viewport?.height ?? window.innerHeight}px`)
    resize()
    viewport?.addEventListener('resize', resize)
    return () => {
      viewport?.removeEventListener('resize', resize)
      document.documentElement.style.removeProperty('--mobile-viewport-height')
    }
  }, [isMobile])

  useEffect(() => {
    const dialog = mobileMenuRef.current
    if (mobileMenu && isMobile) {
      if (dialog && !dialog.open) dialog.showModal()
    } else if (dialog?.open) {
      dialog.close()
      moreButtonRef.current?.focus()
    }
  }, [mobileMenu, isMobile])

  useEffect(() => {
    const group = toolbarGroupRef.current
    if (!group) return
    const updateScrollState = () => {
      setToolbarOverflow(group.scrollWidth - group.clientWidth > 2)
      setToolbarShifted(group.scrollLeft > 8)
    }
    const resizeObserver = new ResizeObserver(updateScrollState)
    resizeObserver.observe(group)
    group.addEventListener('scroll', updateScrollState, { passive: true })
    const frame = window.requestAnimationFrame(updateScrollState)
    return () => {
      window.cancelAnimationFrame(frame)
      group.removeEventListener('scroll', updateScrollState)
      resizeObserver.disconnect()
    }
  }, [isMobile])

  const toolbar = [
    { label: '加粗', icon: Bold, action: () => editor?.chain().focus().toggleBold().run() },
    { label: '斜体', icon: Italic, action: () => editor?.chain().focus().toggleItalic().run() },
    { label: '高亮', icon: Highlighter, action: () => editor?.chain().focus().toggleHighlight().run() },
    { label: '大标题', icon: Heading1, action: () => editor?.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: '中标题', icon: Heading2, action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: '小标题', icon: Heading3, action: () => editor?.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: '无序列表', icon: List, action: () => editor?.chain().focus().toggleBulletList().run() },
    { label: '有序列表', icon: ListOrdered, action: () => editor?.chain().focus().toggleOrderedList().run() },
    { label: '待办清单', icon: CheckSquare, action: () => editor?.chain().focus().toggleTaskList().run() },
    { label: '撤销', icon: Undo2, action: () => editor?.chain().focus().undo().run() },
    { label: '重做', icon: Redo2, action: () => editor?.chain().focus().redo().run() }
  ]
  const status = syncUi({ localError: Boolean(localError), externalChange, saving, hasConflict, syncError: Boolean(syncError), pendingCount, syncing, online, lastSyncAt })
  const hasSaveIssue = Boolean(localError || externalChange || hasConflict || syncError || syncIssueCount)
  const openStatus = () => { if (hasConflict || syncIssueCount > 0) onOpenConflicts(); else onOpenData() }
  const exportNote = (format: NoteExportFormat) => {
    if (!editor) return
    try {
      downloadNoteExport({ title: titleFromText(editor.getText({ blockSeparator: '\n' })), doc: editor.getJSON() as RichText }, format)
      setMobileMenu(null)
      toast.success('下载已发起，请检查下载文件')
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : '导出失败') }
  }
  const moveToFolder = (folderId: string | null) => { setFolderMenuOpen(false); onMoveFolder(folderId) }
  const toggleToolbarPage = () => {
    const group = toolbarGroupRef.current
    if (!group) return
    group.scrollTo({ left: toolbarShifted ? 0 : group.scrollWidth, behavior: 'smooth' })
  }
  const handleToolbarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || (event.target as HTMLElement).closest('.toolbar-folder-popover')) return
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary'))
      .filter(control => control.offsetParent !== null && !control.closest('.toolbar-folder-popover'))
    const current = controls.indexOf(event.target as HTMLElement)
    if (current < 0 || controls.length === 0) return
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : event.key === 'ArrowRight' ? (current + 1) % controls.length : (current - 1 + controls.length) % controls.length
    event.preventDefault()
    controls[next]?.focus()
  }
  const handleFolderMenuKeyDown = (event: ReactKeyboardEvent<HTMLDetailsElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setFolderMenuOpen(false)
      folderMenuRef.current?.querySelector<HTMLElement>('summary')?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
    const items = Array.from(folderMenuRef.current?.querySelectorAll<HTMLButtonElement>('.toolbar-folder-popover button') ?? [])
    if (!items.length) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length
    event.preventDefault()
    items[next]?.focus()
  }

  return (
    <div className={`editor-container ${fullscreen ? 'fullscreen' : ''} ${isMobile ? 'mobile-editor' : ''}`}>
      {isMobile && <div className="mobile-editor-header">
        <button type="button" aria-label="返回列表" onClick={() => { void flushRef.current(); onBack?.() }}><ArrowLeft size={22} /></button>
        <div className="mobile-header-spacer" />
        {toolbar.slice(9).map(({ label, icon: Icon, action }) => <button type="button" key={label} aria-label={label} onPointerDown={event => event.preventDefault()} onClick={action}><Icon size={21} /></button>)}
        <SyncControls label={status.label} kind={status.kind} issueCount={syncIssueCount} syncing={syncing} iconOnly onOpenDetails={openStatus} onSync={onManualSync} />
        <button type="button" ref={moreButtonRef} aria-label="更多便签操作" aria-haspopup="dialog" aria-expanded={Boolean(mobileMenu)} onClick={() => { setFontPanelOpen(false); setMobileMenu('actions') }}><Menu size={23} />{hasSaveIssue && <span className="mobile-issue-dot" />}</button>
      </div>}
      {(!isMobile || localError || externalChange || hasConflict || syncError) && <div className={`editor-toolbar ${isMobile ? 'mobile-recovery-toolbar' : ''}`} role="toolbar" aria-label="便签编辑工具" onKeyDown={handleToolbarKeyDown}>
        {onOpenSidebar && <button type="button" className="toolbar-btn sidebar-expand-btn" title="展开侧栏" aria-label="展开侧栏" onClick={onOpenSidebar}><PanelLeftOpen size={16} /></button>}
        <div ref={toolbarGroupRef} className={`toolbar-group ${toolbarOverflow ? 'has-overflow' : ''} ${toolbarShifted ? 'is-shifted' : ''}`} role="group" aria-label="排版工具">
          {toolbar.map(({ label, icon: Icon, action }, index) => (
            <span className="toolbar-wrapper" key={label}>
              {(index === 3 || index === 6 || index === 9) && <span className="toolbar-divider" />}
              <button type="button" className="toolbar-btn" title={label} aria-label={label} onClick={action}><Icon size={16} /></button>
            </span>
          ))}
        </div>
        {toolbarOverflow && <button type="button" className="toolbar-btn toolbar-scroll-next" title={toolbarShifted ? '返回前面的排版工具' : '查看更多排版工具'} aria-label={toolbarShifted ? '向左返回前面的排版工具' : '向右查看更多排版工具'} onClick={toggleToolbarPage}>{toolbarShifted ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}</button>}
        <div className="toolbar-spacer" />
        <SyncControls label={status.label} kind={status.kind} issueCount={syncIssueCount} syncing={syncing} onOpenDetails={openStatus} onSync={onManualSync} />
        {hasConflict && <button type="button" className="toolbar-btn recovery-btn" onClick={onOpenConflicts}>处理冲突</button>}
        {syncError && !hasConflict && <button type="button" className="toolbar-btn recovery-btn" onClick={onOpenConflicts}>查看同步问题</button>}
        {localError && !saving && <button type="button" className="toolbar-btn recovery-btn" onClick={() => {
          if (!editor) return
          enqueue(editor.getJSON() as RichText, editor.getText({ blockSeparator: '\n' }))
          void flushRef.current()
        }}>重新保存</button>}
        {(localError || externalChange) && <button type="button" className="toolbar-btn recovery-btn" onClick={() => {
          if (!editor) return
          const plainText = editor.getText({ blockSeparator: '\n' })
          void onSaveCopy({ title: titleWithSuffix(titleFromText(plainText), '（恢复副本）'), doc: editor.getJSON() as RichText, plainText })
        }}>另存为新便签</button>}
        {(localError || externalChange) && <button type="button" className="toolbar-btn recovery-btn" onClick={() => {
          if (!editor || !navigator.clipboard?.writeText) { toast.error('无法自动复制，请手动复制标题和正文'); return }
          const draft = editor.getText({ blockSeparator: '\n' })
          void navigator.clipboard.writeText(draft).then(() => toast.success('草稿文本已复制')).catch(() => toast.error('复制失败，请手动复制标题和正文'))
        }}>复制草稿文本</button>}
        {externalChange && <button type="button" className="toolbar-btn recovery-btn" onClick={() => {
          if (!editor || !confirm('加载另一窗口的新版本？当前编辑器中尚未保存的内容会被替换，建议先另存副本。')) return
          loadStoredVersion()
          onDiscardError()
        }}>加载新版本</button>}
        <details ref={folderMenuRef} className="toolbar-folder-menu" open={folderMenuOpen} onToggle={event => { setFolderMenuOpen(event.currentTarget.open); if (event.currentTarget.open) setExportOpen(false) }} onKeyDown={handleFolderMenuKeyDown}><summary className="toolbar-btn" title="移动到文件夹" aria-label="移动当前便签到文件夹" aria-haspopup="menu" aria-expanded={folderMenuOpen}><FolderInput size={16} /></summary><div className="toolbar-folder-popover"><p>移动到文件夹</p><FolderPicker folders={folders} currentId={note.folderId} onPick={moveToFolder} /></div></details>
        <details className="toolbar-folder-menu" open={exportOpen} onToggle={event => { setExportOpen(event.currentTarget.open); if (event.currentTarget.open) setFolderMenuOpen(false) }}><summary className="toolbar-btn" title="导出这条便签" aria-label="导出这条便签"><Download size={16} /></summary><div className="toolbar-folder-popover" role="menu" aria-label="导出这条便签"><p>导出这条便签</p><button type="button" role="menuitem" onClick={() => { exportNote('txt'); setExportOpen(false) }}><span>纯文本</span></button><button type="button" role="menuitem" onClick={() => { exportNote('md'); setExportOpen(false) }}><span>Markdown</span></button><button type="button" role="menuitem" onClick={() => { exportNote('html'); setExportOpen(false) }}><span>网页</span></button></div></details>
        <span className="word-count">{wordCount} 字</span>
        <button type="button" className="toolbar-btn editor-theme-toggle" aria-label="切换主题" title="切换主题" onClick={onToggleTheme}>
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
        </button>
        <button type="button" className="toolbar-btn fullscreen-btn" title={fullscreen ? '退出全屏' : '全屏编辑'} onClick={() => setFullscreen(!fullscreen)}>
          {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>}
      <div className="editor-body">
        <EditorContent editor={editor} className="editor-content-shell" />
      </div>
      {isMobile && <div className="mobile-editor-tools">
        {fontPanelOpen && <div className="mobile-font-panel" role="group" aria-label="字体设置" id="mobile-font-panel">
          {toolbar.slice(3, 6).map(({ label, icon: Icon, action }) => <button type="button" key={label} aria-label={label} onPointerDown={event => event.preventDefault()} onClick={action}><Icon size={22} /><span>{label}</span></button>)}
          {toolbar.slice(0, 3).map(({ label, icon: Icon, action }) => <button type="button" key={label} aria-label={label} onPointerDown={event => event.preventDefault()} onClick={action}><Icon size={22} /><span>{label}</span></button>)}
        </div>}
        <div className="mobile-bottom-toolbar" role="toolbar" aria-label="常用排版" onKeyDown={handleToolbarKeyDown}>
          <button type="button" className={fontPanelOpen ? 'active' : ''} aria-label="字体" aria-expanded={fontPanelOpen} aria-controls="mobile-font-panel" onPointerDown={event => event.preventDefault()} onClick={() => setFontPanelOpen(current => !current)}><Type size={24} /></button>
          {[toolbar[7], toolbar[6], toolbar[8]].map(item => item && <button type="button" key={item.label} aria-label={item.label} onPointerDown={event => event.preventDefault()} onClick={item.action}><item.icon size={24} /></button>)}
          <button type="button" aria-label="收起键盘和字体面板" onClick={() => { editor?.commands.blur(); setFontPanelOpen(false) }}><ChevronDown size={24} /></button>
        </div>
      </div>}
      {isMobile && <dialog ref={mobileMenuRef} className="mobile-action-sheet" aria-label={mobileMenu === 'folders' ? '移动到文件夹' : mobileMenu === 'export' ? '导出便签' : '更多便签操作'} onCancel={() => setMobileMenu(null)}>
        <div className="mobile-sheet-heading"><h2>{mobileMenu === 'folders' ? '移动到文件夹' : mobileMenu === 'export' ? '导出便签' : '更多功能'}</h2><button type="button" aria-label="关闭操作菜单" onClick={() => setMobileMenu(null)}><X size={22} /></button></div>
        {mobileMenu === 'export' ? <div className="mobile-sheet-items">
          <button type="button" onClick={() => exportNote('txt')}><FileText size={20} /><span>导出这条便签为 TXT</span></button>
          <button type="button" onClick={() => exportNote('md')}><FileText size={20} /><span>导出这条便签为 Markdown</span></button>
          <button type="button" onClick={() => exportNote('html')}><FileText size={20} /><span>导出这条便签为网页</span></button>
        </div> : mobileMenu === 'folders' ? <FolderPicker folders={folders} currentId={note.folderId} onPick={folderId => { onMoveFolder(folderId); setMobileMenu(null) }} /> : <div className="mobile-sheet-items">
          <p className="mobile-sheet-meta">{wordCount} 字</p>
          <button type="button" onClick={() => { onPin?.(); setMobileMenu(null) }}><Pin size={20} /><span>{note.isPinned ? '取消置顶' : '置顶便签'}</span></button>
          <button type="button" onClick={() => setMobileMenu('folders')}><FolderInput size={20} /><span>移动便签</span><ChevronRight size={18} /></button>
          <button type="button" onClick={() => setMobileMenu('export')}><Download size={20} /><span>导出便签</span><ChevronRight size={18} /></button>
          <button type="button" onClick={() => { setMobileMenu(null); onManualSync() }}><RefreshCw size={20} /><span>立即同步</span></button>
          <button type="button" onClick={() => { setMobileMenu(null); onOpenData() }}><Cloud size={20} /><span>数据与同步</span></button>
          <button type="button" onClick={onToggleTheme}>{theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}<span>切换主题</span></button>
          <button type="button" className="danger" onClick={() => { setMobileMenu(null); onDelete?.() }}><Trash2 size={20} /><span>移入回收站</span></button>
        </div>}
      </dialog>}
    </div>
  )
}

export function NoteEditor(props: Props) {
  if (!props.note) return <div className="editor-empty"><div className="editor-empty-content"><p>选择或创建一个便签开始编辑</p></div></div>
  return <EditorBody key={props.note.id} {...props} note={props.note} />
}
