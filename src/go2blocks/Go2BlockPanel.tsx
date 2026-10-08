import { useEffect, useState } from 'react'
import { parseCsvPoses } from '../export/importCsv'
import type { Pose } from '../model/pose'
import { getEditor, trackLocked, useEditor } from '../store/store'
import { blockUrl, GO2_BLOCKS } from './blocks'
import { blockActual, buildBlockClip } from './build'

type Template = { fps: number; poses: Pose[] }
// One fetch per block; a failed load is dropped so picking the block again retries.
const cache = new Map<string, Promise<Template>>()
function loadTemplate(id: string): Promise<Template> {
  let p = cache.get(id)
  if (!p) {
    p = fetch(blockUrl(id))
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text() })
      .then(text => parseCsvPoses(text, getEditor().getState().defs, undefined))
    p.catch(() => cache.delete(id))
    cache.set(id, p)
  }
  return p
}

const DEFAULT = { meters: 1.0, degrees: 90 }

export default function Go2BlockPanel({ actorId }: { actorId: string }) {
  const locked = useEditor(s => trackLocked(s.project, actorId))
  const [id, setId] = useState(GO2_BLOCKS[0].id)
  const [value, setValue] = useState(String(DEFAULT.meters)) // GO2_BLOCKS[0] is Move
  const [tpl, setTpl] = useState<{ id: string; t?: Template; err?: string } | null>(null)
  const block = GO2_BLOCKS.find(b => b.id === id)!

  useEffect(() => {
    let live = true
    setTpl(null)
    loadTemplate(id).then(t => live && setTpl({ id, t }), (e: Error) => live && setTpl({ id, err: e.message }))
    return () => { live = false }
  }, [id])

  const pick = (next: string) => {
    const b = GO2_BLOCKS.find(b => b.id === next)!
    setId(next)
    setValue(b.kind === 'loop' ? String(DEFAULT[b.param]) : '')
  }

  const t = tpl?.id === id ? tpl.t : undefined
  const v = block.kind === 'loop' ? (value.trim() === '' ? NaN : Number(value)) : 0
  const valid = Number.isFinite(v) && (block.kind !== 'loop' || block.param !== 'meters' || v >= 0.1)
  const actual = t && valid ? blockActual(block, t.poses, v) : null
  const unit = block.kind === 'loop' && block.param === 'meters' ? 'm' : '°'

  const add = () => {
    if (!t || !valid) return
    const st = getEditor().getState()
    st.appendClip(actorId, buildBlockClip(block, t.poses, t.fps, v, st.defs))
  }

  return (
    <div className="insp go2-blocks">
      <div className="insp-row">
        <label>블럭
          <select aria-label="블럭" value={id} onChange={e => pick(e.target.value)}>
            {GO2_BLOCKS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </label>
      </div>
      {block.kind === 'loop' && (
        <div className="insp-row">
          <label>{block.param === 'meters' ? '거리 (m)' : '각도 (°, 음수 = 우회전)'}
            <input type="number" aria-label="값" value={value}
              step={block.param === 'meters' ? 0.1 : 1} min={block.param === 'meters' ? 0.1 : undefined}
              onChange={e => setValue(e.target.value)} />
          </label>
        </div>
      )}
      {actual && <p className="insp-hint" role="status">→ 실제 {+actual.actual.toFixed(unit === 'm' ? 2 : 0)}{unit} ({actual.n}회)</p>}
      {tpl?.id === id && tpl.err && <p className="insp-hint" role="alert">템플릿을 불러오지 못했습니다: {tpl.err}</p>}
      <div className="insp-row">
        <button disabled={!t || !valid || locked} onClick={add}>추가</button>
      </div>
    </div>
  )
}
