import { useEffect, useRef, useState } from 'react'
import { importCsvFiles, importVideoFiles } from './importActions'
import { newProjectFile, openProject, saveProject } from './projectActions'

type Item = { label: string; hint?: string; run: () => void }

export default function FileMenu({ onExport, onBlocks }: { onExport: () => void; onBlocks: () => void }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null) // null = closed
  const trig = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const first = useRef(false) // focus the first item once the menu has rendered
  const groups: Item[][] = [
    [{ label: '새 프로젝트', run: newProjectFile }, { label: '열기', hint: 'Ctrl+O', run: openProject },
      { label: '저장', hint: 'Ctrl+S', run: () => saveProject() }, { label: '다른 이름으로 저장', hint: 'Ctrl+Shift+S', run: () => saveProject(true) }],
    [{ label: 'CSV 가져오기', run: importCsvFiles }, { label: '영상 가져오기', run: importVideoFiles }, { label: 'GO2 블럭 추가…', run: onBlocks }],
    [{ label: '내보내기', run: onExport }],
  ]
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])]
  const open = (focusFirst: boolean) => {
    const r = trig.current!.getBoundingClientRect()
    first.current = focusFirst
    setPos({ left: r.left, top: r.bottom + 2 })
  }
  const close = () => { setPos(null); trig.current?.focus() }

  useEffect(() => { if (pos && first.current) { first.current = false; items()[0]?.focus() } }, [pos])
  useEffect(() => {
    if (!pos) return
    const away = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node) && !trig.current?.contains(e.target as Node)) setPos(null) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [pos])

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') setPos(null)
    if (!['Enter', ' ', 'ArrowDown'].includes(e.key)) return
    e.preventDefault(); e.stopPropagation() // not a global Space/Enter shortcut
    open(true)
  }
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items(), i = list.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus() }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(list.length - 1)
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'Tab') close() // focus lands on the trigger; the default Tab then moves on from there
  }

  return (
    <>
      <button ref={trig} aria-haspopup="menu" aria-expanded={!!pos} onClick={() => (pos ? setPos(null) : open(false))} onKeyDown={onTriggerKey}>파일</button>
      {pos && (
        <div ref={menu} role="menu" aria-label="파일" className="mb-menu" style={pos} onKeyDown={onMenuKey}>
          {groups.map((g, gi) => (
            <div key={gi} role="group">
              {gi > 0 && <div role="separator" className="mb-sep" />}
              {g.map(it => (
                <button key={it.label} role="menuitem" tabIndex={-1} aria-keyshortcuts={it.hint}
                  onClick={() => { close(); it.run() }}>
                  {it.label}{it.hint && <span className="mb-hint" aria-hidden="true">{it.hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
