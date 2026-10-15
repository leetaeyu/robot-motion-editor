import { useEffect, useReducer, useRef, useState } from 'react'
import { relinkMedia, setImportResult, useImportUi } from '../importActions'
import { mediaUrl, subscribeMedia } from '../media/registry'
import { getEditor, useEditor } from '../store/store'
import { setDragged } from '../timeline/assetDrop'
import { FPS } from '../model/fps'

function RenameInput({ name, onDone }: { name: string; onDone: (v: string | null) => void }) {
  const cancelled = useRef(false)
  return (
    <input autoFocus defaultValue={name} aria-label="클립 이름 변경"
      onFocus={e => e.currentTarget.select()}
      onBlur={e => onDone(cancelled.current ? null : e.currentTarget.value)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
      }} />
  )
}

type Menu = { kind: 'clip' | 'media'; id: string; x: number; y: number; card: HTMLElement }

// Right-click menu of a card: focus moves in on open, back to the card on Esc; an outside click closes it.
function CardMenu({ menu, items, close }: { menu: Menu; items: [string, () => void][]; close: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(false) }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [menu])
  const onKey = (e: React.KeyboardEvent) => {
    const list = [...ref.current!.querySelectorAll<HTMLElement>('[role=menuitem]')], i = list.indexOf(document.activeElement as HTMLElement)
    const d = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[e.key]
    if (d) { e.preventDefault(); list[(i + d + list.length) % list.length]?.focus() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
    else if (e.key === 'Tab') close(true)
  }
  return (
    <div ref={ref} role="menu" aria-label="에셋" className="tl-menu" style={{ left: menu.x, top: menu.y }} onKeyDown={onKey}>
      {items.map(([label, run]) => <button key={label} role="menuitem" tabIndex={-1} onClick={() => { close(false); run() }}>{label}</button>)}
    </div>
  )
}

export default function ProjectPanel() {
  const ed = getEditor()
  const project = useEditor(s => s.project)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [msg, setMsg] = useState(0) // timestamp of the last rejection; a new value restarts the 3 s timer
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(0), 3000); return () => clearTimeout(t) }, [msg])

  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => subscribeMedia(bump), []) // re-render when a url is (un)set
  const res = useImportUi(s => s.res)
  useEffect(() => { if (res) { const t = setTimeout(() => setImportResult(null), 10000); return () => clearTimeout(t) } }, [res])
  const [mmsg, setMmsg] = useState(0)
  const [lmsg, setLmsg] = useState(0)
  useEffect(() => { if (!lmsg) return; const t = setTimeout(() => setLmsg(0), 3000); return () => clearTimeout(t) }, [lmsg])
  useEffect(() => { if (!mmsg) return; const t = setTimeout(() => setMmsg(0), 3000); return () => clearTimeout(t) }, [mmsg])
  const delMedia = (id: string) => { if (!ed.getState().deleteMedia(id)) setMmsg(performance.now()) }

  const uses = (id: string) => project.sequence.tracks.reduce((n, t) => n + t.items.filter(i => i.refId === id).length, 0)
  const del = (id: string) => { if (!ed.getState().deleteClip(id)) setMsg(performance.now()) }
  const clips = Object.values(project.clips)

  const [menu, setMenu] = useState<Menu | null>(null)
  const closeMenu = (refocus: boolean) => { if (refocus) menu?.card.focus(); setMenu(null) }
  const menuProps = (kind: Menu['kind'], id: string) => ({
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => { e.preventDefault(); setMenu({ kind, id, x: e.clientX, y: e.clientY, card: e.currentTarget }) },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault(); e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        setMenu({ kind, id, x: r.left + 8, y: r.top + 24, card: e.currentTarget })
      } else if (e.key === 'Delete') { e.stopPropagation(); if (kind === 'clip') del(id); else delMedia(id) }
      else if (e.key === 'Enter' && kind === 'clip') { e.stopPropagation(); setRenaming(id) }
    },
  })
  const sec = (f: number) => `${(f / FPS).toFixed(2)}초`

  return (
    <div className="pp">
      <h2>에셋</h2>
      {!clips.length && !project.media.length && <p className="pp-dim">파일 ▸ CSV 가져오기로 모션을 불러오세요</p>}
      {clips.length > 0 && <h3>모션 (CSV)</h3>}
      {clips.map(c => (
        <div key={c.id} className="pp-card" tabIndex={0} draggable={renaming !== c.id}
          onDragStart={e => { e.dataTransfer.setData('application/x-motion-clip', c.id); e.dataTransfer.effectAllowed = 'copy'; setDragged({ kind: 'clip', id: c.id }) }}
          onDragEnd={() => setDragged(null)}
          onDoubleClick={() => setRenaming(c.id)} {...menuProps('clip', c.id)}>
          <div className="pp-head">
            {renaming === c.id
              ? <RenameInput name={c.name} onDone={v => { if (v?.trim() && !ed.getState().setClip(c.id, { name: v })) setLmsg(performance.now()); setRenaming(null) }} />
              : <span className="pp-name" title={c.name}>{c.name}</span>}
            <span className="pp-tag">{c.robot.toUpperCase()}</span>
          </div>
          <div className="pp-box">
            <div className="pp-meta">{sec(c.length)} · {c.length} 프레임 · 사용 {uses(c.id)}</div>
            <button title="이 모션을 비교 프리뷰에 나란히 재생 (타임라인에는 추가하지 않음)" onClick={() => ed.getState().openComparePane(c.id)}>⇄ 비교</button>
          </div>
        </div>
      ))}
      {project.media.length > 0 && <h3>영상</h3>}
      {project.media.map(m => {
        const off = mediaUrl(m.id) == null
        return (
          <div key={m.id} className="pp-card pp-media" tabIndex={0} draggable
            onDragStart={e => { e.dataTransfer.setData('application/x-motion-media', m.id); e.dataTransfer.effectAllowed = 'copy'; setDragged({ kind: 'media', id: m.id }) }}
            onDragEnd={() => setDragged(null)}
            {...menuProps('media', m.id)}>
            <div className="pp-head"><span className="pp-name" title={m.name}>{m.name}</span></div>
            <div className="pp-box">
              <div className="pp-meta">{sec(m.durationF)}{off && <> · <span className="pp-off">오프라인</span></>}</div>
              {off && <button aria-label={`${m.name} 다시 연결`} onClick={() => relinkMedia(m)}>다시 연결</button>}
            </div>
          </div>
        )
      })}
      {menu && <CardMenu menu={menu} close={closeMenu} items={menu.kind === 'clip'
        ? [['이름 변경', () => setRenaming(menu.id)], ['삭제', () => del(menu.id)]]
        : [['삭제', () => delMedia(menu.id)]]} />}
      {res && (
        <div className="pp-msg" role="status">
          {res.head && <p>{res.head}</p>}
          {res.lines.map(f => <p key={f}>{f}</p>)}
        </div>
      )}
      {mmsg > 0 && <p className="pp-msg">시퀀스에서 쓰는 영상은 삭제할 수 없습니다</p>}
      {lmsg > 0 && <p className="pp-msg">잠긴 트랙입니다</p>}
      {msg > 0 && <p className="pp-msg">시퀀스에서 쓰는 클립은 삭제할 수 없습니다</p>}
    </div>
  )
}
