import { useEffect, useState, type ReactNode } from 'react'
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

// actorId null = a new GO2 actor on 추가 (the menu dialog); onAdded gets the actor the block went to and the clip name.
// `actions` = dialog layout: stacked fields, then a footer with those buttons and 추가 side by side (note above the footer).
export default function Go2BlockPanel({ actorId, onAdded, actions, note }: { actorId: string | null; onAdded?: (actorId: string, name: string) => void; actions?: ReactNode; note?: ReactNode }) {
  const locked = useEditor(s => !!actorId && trackLocked(s.project, actorId))
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
    const st = getEditor().getState(), clip = buildBlockClip(block, t.poses, t.fps, v, st.defs)
    const itemId = st.appendClip(actorId, clip)
    const p = getEditor().getState().project, track = itemId ? p.sequence.tracks.find(tr => tr.items.some(i => i.id === itemId)) : null
    if (itemId && track?.actorId) onAdded?.(track.actorId, p.clips[clip.id]?.name ?? clip.name)
  }

  const loopLabel = block.kind === 'loop' ? (block.param === 'meters' ? '거리' : '각도') : ''
  const status = <>
    {actual && <p className="ps-dim" role="status">→ 실제 {+actual.actual.toFixed(unit === 'm' ? 2 : 0)}{unit} ({actual.n}회)</p>}
    {tpl?.id === id && tpl.err && <p className="ps-dim" role="alert">템플릿을 불러오지 못했습니다: {tpl.err}</p>}
  </>
  if (actions) return (
    <>
      <label className="ps-field"><span>블럭</span>
        <select aria-label="블럭" value={id} onChange={e => pick(e.target.value)}>
          {GO2_BLOCKS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
      </label>
      {block.kind === 'loop' && (
        <label className="ps-field"><span>{loopLabel}{block.param === 'degrees' && <span className="ps-dim"> · 음수 = 우회전</span>}</span>
          <span className="ps-unit">
            <input type="number" aria-label="값" value={value}
              step={block.param === 'meters' ? 0.1 : 1} min={block.param === 'meters' ? 0.1 : undefined}
              onChange={e => setValue(e.target.value)} /><i>{unit}</i>
          </span>
        </label>
      )}
      {(actual || (tpl?.id === id && tpl.err)) && <div className="ps-status">{status}</div>}
      {note}
      <footer className="ps-foot">
        <span className="ps-gap" />
        {actions}
        <button type="button" className="ps-primary" disabled={!t || !valid || locked} onClick={add}>추가</button>
      </footer>
    </>
  )

  return (
    <section className="insp go2-blocks">
      <h3 className="insp-sec-t">GO2 블럭 추가</h3>
      <label className="insp-field"><span className="insp-lab">블럭</span>
        <select aria-label="블럭" value={id} onChange={e => pick(e.target.value)}>
          {GO2_BLOCKS.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
      </label>
      {block.kind === 'loop' && (
        <label className="insp-field"><span className="insp-lab">{loopLabel}{block.param === 'degrees' && <span>음수 = 우회전</span>}</span>
          <span className="insp-unit">
            <input type="number" aria-label="값" value={value}
              step={block.param === 'meters' ? 0.1 : 1} min={block.param === 'meters' ? 0.1 : undefined}
              onChange={e => setValue(e.target.value)} /><i>{unit}</i>
          </span>
        </label>
      )}
      <div className="insp-addrow">
        <span className="insp-addstat">{status}</span>
        <button disabled={!t || !valid || locked} onClick={add}>추가</button>
      </div>
    </section>
  )
}
