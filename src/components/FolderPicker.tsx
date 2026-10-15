import { useMemo, useState } from 'react'
import { Check, Folder, Inbox, Search } from 'lucide-react'
import type { FolderRecord } from '../lib/db'

type Props = {
  folders: FolderRecord[]
  currentId: string | null
  onPick: (folderId: string | null) => void
}

export function FolderPicker({ folders, currentId, onPick }: Props) {
  const [query, setQuery] = useState('')
  const text = query.trim().toLocaleLowerCase()
  const matches = useMemo(() => {
    const named = folders.map(folder => ({ id: folder.id as string | null, name: folder.name }))
    if (!text) return named
    return named.filter(item => item.name.toLocaleLowerCase().includes(text))
  }, [folders, text])
  const showUnfiled = !text || '未分类'.includes(text)

  return <div className="folder-picker">
    <label className="folder-picker-search"><Search size={16} /><input autoFocus aria-label="搜索文件夹" placeholder="搜索文件夹" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => event.stopPropagation()} /></label>
    <div className="folder-picker-list" role="menu" aria-label="选择目标文件夹">
      {showUnfiled && <button type="button" role="menuitemradio" aria-checked={currentId === null} className={currentId === null ? 'active' : ''} onClick={() => onPick(null)}>
        <Inbox size={16} /><span>未分类</span>{currentId === null && <Check size={16} />}
      </button>}
      {showUnfiled && matches.length > 0 && <div className="folder-picker-split" />}
      {matches.map(item => <button type="button" role="menuitemradio" aria-checked={currentId === item.id} className={currentId === item.id ? 'active' : ''} key={item.id} onClick={() => onPick(item.id)}>
        <Folder size={16} /><span>{item.name}</span>{currentId === item.id && <Check size={16} />}
      </button>)}
      {!showUnfiled && matches.length === 0 && <p>没有匹配的文件夹</p>}
    </div>
  </div>
}
