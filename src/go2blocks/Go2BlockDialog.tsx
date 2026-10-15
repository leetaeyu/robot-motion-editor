import { useEffect, useRef, useState } from 'react'
import { useEditor } from '../store/store'
import Go2BlockPanel from './Go2BlockPanel'

// 메뉴 ▸ GO2 블럭 추가…: the block panel for any project, with or without a GO2. Blocks go to the end of the chosen
// GO2's track, or (새 GO2 로봇) to a new GO2 actor from 0 s; after that the dialog keeps appending to that actor.
export default function Go2BlockDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const actors = useEditor(s => s.project.actors), selId = useEditor(s => s.sel.actorId)
  const go2s = actors.filter(a => a.robot === 'go2')
  const [target, setTarget] = useState('new')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setTarget(go2s.find(a => a.id === selId)?.id ?? go2s[0]?.id ?? 'new')
      setMsg('')
      d.showModal()
    }
    if (!open && d.open) d.close()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // a target that disappeared (undo of the new actor, deleted track) falls back to the first GO2, else a new one
  const t = target !== 'new' && !go2s.some(a => a.id === target) ? go2s[0]?.id ?? 'new' : target

  return (
    <dialog ref={ref} className="ps go2-dlg" onKeyDown={e => e.stopPropagation()} onClose={onClose}>
      {open && <div className="ps-form">
        <header className="ps-head">
          <h2>GO2 블럭 추가</h2>
          <span className="ps-dim">실제 GO2 로그로 만든 동작을 트랙 끝에 붙입니다</span>
        </header>
        <label className="ps-field"><span>붙일 로봇</span>
          <select aria-label="붙일 로봇" value={t} onChange={e => { setTarget(e.target.value); setMsg('') }}>
            {go2s.map(a => <option key={a.id} value={a.id}>{a.name} (트랙 끝에 붙임)</option>)}
            <option value="new">새 GO2 로봇 (0초부터)</option>
          </select>
        </label>
        <Go2BlockPanel actorId={t === 'new' ? null : t} onAdded={(actorId, name) => { setTarget(actorId); setMsg(`추가했습니다: ${name}`) }}
          note={msg && <p className="ps-ok" aria-live="polite">✓ {msg}</p>}
          actions={<button type="button" onClick={() => ref.current?.close()}>닫기</button>} />
      </div>}
    </dialog>
  )
}
