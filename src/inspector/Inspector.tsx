import { useEffect, useState } from 'react'
import { evalCurve } from '../model/curve'
import Go2BlockPanel from '../go2blocks/Go2BlockPanel'
import { evaluateClip } from '../model/evaluate'
import type { Interp } from '../model/types'
import { itemClip, offsetKeyCount } from '../model/itemClip'
import { clipLocked, editLock, editTarget, getEditor, keyOwner, trackLocked, useEditor } from '../store/store'
import { playRange } from '../transport'
import { FPS } from '../model/fps'

const ROOT = ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw']
// slider ranges only; root number input is never clamped
const ROOT_RANGE: Record<string, [number, number]> = {
  'root.x': [-5, 5], 'root.y': [-5, 5], 'root.z': [0, 2],
  'root.roll': [-Math.PI, Math.PI], 'root.pitch': [-Math.PI, Math.PI], 'root.yaw': [-Math.PI, Math.PI],
}
const INTERPS: [Interp, string][] = [['linear', '선형'], ['bezier', '이즈'], ['hold', '홀드']]
const isAngle = (ch: string, joint: boolean) => joint || /roll|pitch|yaw/.test(ch)

export default function Inspector() {
  const go2 = useEditor(s => s.project.actors.find(a => a.id === s.sel.actorId && a.robot === 'go2')?.id)
  return <>{go2 && <Go2BlockPanel key={go2} actorId={go2} />}<InspectorBody /></>
}

function InspectorBody() {
  const ed = getEditor()
  const { project, defs, frame, autoKey, sel, editing, layer } = useEditor(s => s)
  const [deg, setDeg] = useState(true)
  const [lenMsg, setLenMsg] = useState(false)
  const [tol, setTol] = useState(0.001)
  const [simpMsg, setSimpMsg] = useState<{ n: number; at: number } | null>(null)
  useEffect(() => { if (!simpMsg) return; const t = setTimeout(() => setSimpMsg(null), 3000); return () => clearTimeout(t) }, [simpMsg])
  const actor = project.actors.find(a => a.id === sel.actorId)
  if (!actor) return <div className="insp-empty">무대에서 링크를 클릭하거나 타임라인에서 채널을 고르세요.</div>

  const def = defs[actor.robot]
  const target = editTarget({ project, frame, editing }, actor.id)
  if (!target) return <div className="insp-empty">이 액터에 클립이 없습니다.</div>
  const { clipId, f } = target
  const clip = project.clips[clipId]
  const item = project.sequence.tracks.flatMap(t => t.items).find(i => i.id === target.itemId)!
  const shown = itemClip(project, defs, item) ?? clip // what this piece plays: the clip plus its 수정 층
  const pose = evaluateClip(shown, def, f)
  const piece = layer === 'piece', owner = piece ? item.id : clipId // key buttons edit the 수정 층 or the clip
  const curves = keyOwner(project, owner)?.channels ?? {}, nOffset = offsetKeyCount(item)
  const canEdit = piece || autoKey // a 수정 층 never changes the clip, so it needs no 자동 키
  const lockedTrack = trackLocked(project, actor.id) || clipLocked(project, clipId)

  const channels = sel.channel === 'root' ? ROOT : sel.channel && !sel.channel.startsWith('group:') ? [sel.channel] : []
  const info = (ch: string) => {
    const j = def.joints.findIndex(j => j.name === ch)
    if (j >= 0) return { joint: true, v: pose.q[j], lo: def.joints[j].lower, hi: def.joints[j].upper }
    const [lo, hi] = ROOT_RANGE[ch] ?? [0, 0]
    return { joint: false, v: evalCurve(shown.channels[ch] ?? { keys: [] }, f, ch === 'root.z' ? def.standingHeight : 0), lo, hi }
  }
  const group = !sel.channel ? null
    : sel.channel.startsWith('group:') ? sel.channel.slice(6)
    : sel.channel.startsWith('root') ? '루트'
    : def.groups.find(g => g.joints.includes(sel.channel!))?.name ?? null

  const keyFrames = channels.flatMap(ch => curves[ch]?.keys.map(k => k.f) ?? [])
  const jump = (dir: 1 | -1) => {
    const t = dir > 0 ? Math.min(...keyFrames.filter(k => k > f)) : Math.max(...keyFrames.filter(k => k < f))
    if (!Number.isFinite(t)) return
    const st = ed.getState(), [lo, hi] = playRange(st) // clip view: the open clip; sequence view: >= 0
    const nf = t - item.trimIn + item.start
    st.setFrame(st.editing ? Math.min(Math.max(nf, lo), hi - 1) : Math.max(nf, 0))
  }
  const atKeys = channels.filter(ch => curves[ch]?.keys.some(k => k.f === f)).map(ch => ({ channel: ch, f }))
  const curInterp = atKeys.length ? curves[atKeys[0].channel].keys.find(k => k.f === f)!.interp : ''

  const lockOf = (ch: string) => editLock({ project, frame, editing }, actor.id, ch)
  const locks = channels.map(lockOf)
  const groupNames = group === '루트' ? ROOT : def.groups.find(g => g.name === group)?.joints ?? []
  const groupLocks = groupNames.map(lockOf)
  const xfade = locks.includes('crossfade') || groupLocks.includes('crossfade')
  const stitch = locks.includes('stitch') || groupLocks.includes('stitch')
  const anyLock = lockedTrack || locks.some(Boolean)

  const num = (v: number, d: boolean) => (d ? (v * 180) / Math.PI : v).toFixed(d ? 1 : 3)
  const set = (ch: string, v: number) => ed.getState().setValue(actor.id, ch, v)
  const act = ed.getState()

  return (
    <div className="insp">
      <div className="insp-row">
        <input type="color" aria-label="색" value={actor.color} onChange={e => act.setColor(actor.id, e.target.value)} />
        <b>{actor.name}</b>
      </div>
      <div className="insp-row insp-layer" role="group" aria-label="편집 대상">
        <button aria-pressed={piece} onClick={() => act.setLayer('piece')} title="원본 클립은 그대로 두고, 이 조각에만 차이를 더합니다(재생·CSV = 원본 + 수정)">이 조각 수정</button>
        <button aria-pressed={!piece} onClick={() => act.setLayer('clip')} title="공유 클립 자체를 고칩니다. 같은 클립을 쓰는 모든 조각이 바뀝니다(자동 키 필요)">원본 클립 수정</button>
      </div>
      {piece ? <div className="insp-row">
        <span className="insp-hint">{nOffset ? `이 조각의 수정 키 ${nOffset}개` : '원본 클립은 그대로 두고 이 조각에만 더합니다'}</span>
        {nOffset > 0 && <button disabled={lockedTrack} onClick={() => act.clearOffset(item.id)} title="이 조각의 수정을 모두 지우고 원본 클립대로 되돌립니다">수정 지우기</button>}
      </div> : <p className="insp-hint">같은 클립을 쓰는 모든 조각이 바뀝니다</p>}
      <div className="insp-row">
        {(['x', 'y', 'yaw'] as const).map(k => (
          <label key={k}>{k}
            <input type="number" step={k === 'yaw' ? 1 : 0.01} disabled={lockedTrack}
              value={k === 'yaw' ? +(actor.placement.yaw * 180 / Math.PI).toFixed(1) : actor.placement[k]}
              onChange={e => {
                const v = e.target.valueAsNumber
                if (Number.isFinite(v)) act.setPlacement(actor.id, { [k]: k === 'yaw' ? v * Math.PI / 180 : v })
              }} />
          </label>
        ))}
      </div>
      <div className="insp-row">
        <label>클립 이름
          <input key={`n${clip.name}`} disabled={lockedTrack} defaultValue={clip.name}
            onBlur={e => act.setClip(clipId, { name: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
        </label>
      </div>
      <div className="insp-row">
        <label>길이 (프레임)
          <input type="number" min={1} step={1} key={`l${clip.length}`} disabled={lockedTrack} defaultValue={clip.length}
            onBlur={e => {
              if (!act.setClip(clipId, { length: e.target.valueAsNumber })) { setLenMsg(true); setTimeout(() => setLenMsg(false), 3000) }
              e.target.value = String(ed.getState().project.clips[clipId].length) }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
        </label>
        <span className="insp-lim">{(clip.length / FPS).toFixed(2)} 초</span>
      </div>
      <div className="insp-row">
        <label>허용 오차
          <input type="number" min={0.00001} step={0.0001} value={tol} onChange={e => setTol(e.target.valueAsNumber)} />
        </label>
        <button disabled={lockedTrack || !(tol >= 0.00001)} onClick={() => setSimpMsg({ n: act.simplifyClip(clipId, tol, tol), at: Date.now() })}>키 줄이기</button>
      </div>
      {lockedTrack && <p className="insp-hint" role="status">잠긴 트랙입니다</p>}
      {simpMsg && <p className="insp-hint" role="status">{simpMsg.n > 0 ? `키 ${simpMsg.n}개를 줄였습니다` : '줄일 키가 없습니다'}</p>}
      {lenMsg && <p className="insp-hint" role="status">다른 클립과 겹쳐서 길이를 바꿀 수 없습니다</p>}
      {xfade && <p className="insp-hint" role="status">크로스페이드 구간에서는 클립 보기에서 편집하세요</p>}
      {!xfade && stitch && <p className="insp-hint" role="status">이 프레임의 루트 위치·방향은 앞 클립 끝에 맞춰집니다</p>}
      {channels.length > 0 && (
        <>
          <div className="insp-row">
            <button onClick={() => setDeg(d => !d)} aria-pressed={deg}>{deg ? '도' : 'rad'}</button>
            <button aria-label="이전 키" onClick={() => jump(-1)}>◀</button>
            <span aria-hidden>◆</span>
            <button aria-label="다음 키" onClick={() => jump(1)}>▶</button>
          </div>
          {!canEdit && !lockedTrack && <p className="insp-hint">자동 키를 켜면 원본 클립을 고칠 수 있습니다</p>}
          {channels.map(ch => {
            const { joint, v, lo, hi } = info(ch)
            const d = deg && isAngle(ch, joint)
            const near = joint && (v - lo < 0.1 * (hi - lo) || hi - v < 0.1 * (hi - lo))
            return (
              <div className="insp-ch" key={ch}>
                <div className="insp-name">{ch}</div>
                  <input type="range" className={near ? 'near' : ''} min={lo} max={hi} step={0.001} value={v} disabled={!canEdit || lockedTrack || !!lockOf(ch)}
                    aria-label={ch}
                    onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); act.beginGesture() }}
                    onPointerUp={() => act.endGesture()}
                    onPointerCancel={() => act.endGesture()}
                    onChange={e => set(ch, +e.target.value)} />
                <div className="insp-row">
                  <input type="number" key={`${f}-${v}-${d}`} defaultValue={num(v, d)} step={d ? 1 : 0.001} disabled={!canEdit || lockedTrack || !!lockOf(ch)}
                    aria-label={`${ch} 값`}
                    onBlur={e => { const n = e.target.valueAsNumber; if (!Number.isFinite(n)) return; const a = d ? n * Math.PI / 180 : n, r = joint ? Math.min(Math.max(a, lo), hi) : a; set(ch, r); e.target.value = num(r, d) }}
                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
                  <span>{d ? '°' : isAngle(ch, joint) ? 'rad' : 'm'}</span>
                </div>
                <div className="insp-lim">{num(lo, d)} ~ {num(hi, d)}</div>
              </div>
            )
          })}
          <div className="insp-row">
            <button disabled={anyLock} onClick={() => channels.forEach(ch => act.setKey(owner, ch, f, piece ? evalCurve(curves[ch] ?? { keys: [] }, f, 0) : info(ch).v))}>키 추가</button>
            <button disabled={!atKeys.length || anyLock} onClick={() => act.deleteKeys(owner, atKeys)}>키 삭제</button>
            <select aria-label="보간" disabled={!atKeys.length || anyLock} value={curInterp}
              onChange={e => act.setInterp(owner, atKeys, e.target.value as Interp)}>
              {!curInterp && <option value="" />}
              {INTERPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </>
      )}
      {group && <button className="insp-group" disabled={lockedTrack || groupLocks.some(Boolean)} onClick={() => act.keyGroup(actor.id, group)}>{group} 전체 키</button>}
    </div>
  )
}
