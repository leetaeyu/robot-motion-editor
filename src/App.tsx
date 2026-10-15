import { useEffect, useRef, useState } from 'react'
import { fetchRobotDef } from './robot/loadRobot'
import { getEditor, gizmoLock, initEditor, useEditor } from './store/store'
import Inspector from './inspector/Inspector'
import Stage from './viewer/Stage'
import StagePanes from './viewer/StagePanes'
import { videoTrack } from './model/video'
import ProjectPanel from './project/ProjectPanel'
import Timeline from './timeline/Timeline'
import ExportDialog from './export/ExportDialog'
import Go2BlockDialog from './go2blocks/Go2BlockDialog'
import { startTransport } from './transport'
import { onMessage } from './projectActions'
import FileMenu from './FileMenu'
import CsvFpsDialog from './project/CsvFpsDialog'
import { MENUBAR_H, layoutBounds, useLayout, type Layout } from './layout/useLayout'
import { tv } from './timeline/viewState'

function AutoKeyHint() {
  const off = useEditor(s => s.layer === 'clip' && !s.autoKey && !!s.sel.channel && !s.sel.channel.startsWith('group:')) // 이 조각 수정 keys without 자동 키
  return off ? <div className="stage-hint">자동 키 꺼짐: 기즈모 변경은 저장되지 않습니다</div> : null
}

export function CrossfadeHint() {
  const lock = useEditor(gizmoLock)
  return lock === 'crossfade' ? <div className="stage-hint hi">크로스페이드 구간에서는 클립 보기에서 편집하세요</div>
    : lock === 'stitch' ? <div className="stage-hint hi">이 프레임의 루트 위치·방향은 앞 클립 끝에 맞춰집니다</div> : null
}

function Menubar() {
  const st = useEditor(s => s)
  const videoMode = useEditor(s => s.videoMode), videoOpacity = useEditor(s => s.videoOpacity)
  const hasVideo = useEditor(s => !!videoTrack(s.project)?.items.length)
  const [exporting, setExporting] = useState(false)
  const [blocksOpen, setBlocksOpen] = useState(false)
  const name = useEditor(s => s.fileName ?? 'Motion Editor'), dirty = useEditor(s => s.dirty)
  const [msg, setMsg] = useState('')
  const title = name + (dirty ? ' •' : '')
  useEffect(() => { document.title = title }, [title])
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    let t: number | undefined
    const off = onMessage(m => { setMsg(m); clearTimeout(t); t = window.setTimeout(() => setMsg(''), 3000) })
    return () => { off(); clearTimeout(t) }
  }, [])
  return (
    <>
      <FileMenu onExport={() => setExporting(true)} onBlocks={() => setBlocksOpen(true)} />
      <span className="mb-title">{title}</span>
      {msg && <span role="status" className="mb-msg">{msg}</span>}
      {hasVideo && (
        <span role="group" aria-label="영상" className="mb-group">
          <span>영상:</span>
          {([['overlay', '오버레이'], ['split', '분할']] as const).map(([m, label]) =>
            <button key={m} aria-pressed={videoMode === m} onClick={() => st.setVideoMode(m)}>{label}</button>)}
          {videoMode === 'overlay' && <input type="range" aria-label="영상 투명도" min={0} max={1} step={0.05} value={videoOpacity} onChange={e => st.setVideoOpacity(+e.target.value)} />}
        </span>
      )}
      <ExportDialog open={exporting} onClose={() => setExporting(false)} />
      <Go2BlockDialog open={blocksOpen} onClose={() => setBlocksOpen(false)} />
    </>
  )
}


const KEY_STEP = 16
/** 6px separator overlaid on a panel boundary. sign: +1 if dragging toward +axis grows the panel, -1 if it shrinks. */
function Resizer({ k, axis, value, min, max, sign, style, label, set, reset }: {
  k: keyof Layout; min: number; max: number; axis: 'x' | 'y'; value: number; sign: 1 | -1; style: React.CSSProperties; label: string
  set: (p: Partial<Layout>, persist?: boolean) => void; reset: (keys: (keyof Layout)[]) => void
}) {
  const drag = useRef<{ p: number; v: number } | null>(null)
  useEffect(() => () => { document.body.style.userSelect = ''; document.body.style.cursor = '' }, [])
  const pos = (e: { clientX: number; clientY: number }) => (axis === 'x' ? e.clientX : e.clientY)
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    document.body.style.userSelect = ''; document.body.style.cursor = ''
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    set({}, true)
  }
  return (
    <div className={`resizer ${axis}`} role="separator" tabIndex={0} aria-label={label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} style={style}
      onPointerDown={e => {
        if (e.button !== 0) return
        e.preventDefault() // keep focus off the handle after a drag; Tab still reaches it
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { p: pos(e), v: value }
        document.body.style.userSelect = 'none'; document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
      }}
      onPointerMove={e => { if (drag.current) set({ [k]: drag.current.v + sign * (pos(e) - drag.current.p) }) }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end as never}
      onDoubleClick={() => reset([k])}
      onKeyDown={e => {
        const d = axis === 'x' ? { ArrowRight: 1, ArrowLeft: -1 }[e.key] : { ArrowDown: 1, ArrowUp: -1 }[e.key]
        if (d === undefined) return
        e.preventDefault(); e.stopPropagation(); set({ [k]: value + sign * d * KEY_STEP }, true)
      }} />
  )
}

export default function App() {
  const [status, setStatus] = useState<string>('loading')
  const [layout, setLayout, resetLayout] = useLayout()

  useEffect(() => {
    Promise.all([fetchRobotDef('g1'), fetchRobotDef('go2')])
      .then(([g1, go2]) => { initEditor({ g1, go2 }); if (import.meta.env.DEV) (window as any).__editor = getEditor(), (window as any).__tv = tv; setStatus('ready') })
      .catch(e => setStatus(`로봇 불러오기 실패: ${e instanceof Error ? e.message : e}`))
  }, [])

  useEffect(() => (status === 'ready' ? startTransport() : undefined), [status])

  const bounds = layoutBounds(layout, window.innerWidth, window.innerHeight)
  return (
    <div id="app" style={{ gridTemplateColumns: `${layout.left}px 1fr ${layout.right}px`, gridTemplateRows: `${MENUBAR_H}px 1fr ${layout.bottom}px` }}>
      <header id="menubar">{status === 'ready' ? <Menubar /> : 'Motion Editor'}</header>
      <aside id="project">{status === 'ready' && <ProjectPanel />}</aside>
      {status === 'ready' && <CsvFpsDialog />}
      <main id="stage">
        {status === 'ready'
          ? <StagePanes robot={<div className="stage-3d"><AutoKeyHint /><CrossfadeHint /><Stage /></div>} />
          : <div className="stage-3d">{status === 'loading' ? '로봇 불러오는 중…' : status}</div>}
      </main>
      <aside id="inspector">{status === "ready" && <Inspector />}</aside>
      <section id="timeline">{status === 'ready' && <Timeline />}</section>
      <Resizer k="left" axis="x" sign={1} label="프로젝트 패널 너비" value={layout.left} min={bounds.left[0]} max={bounds.left[1]} set={setLayout} reset={resetLayout}
        style={{ left: layout.left - 3, top: MENUBAR_H, bottom: layout.bottom }} />
      <Resizer k="right" axis="x" sign={-1} label="인스펙터 너비" value={layout.right} min={bounds.right[0]} max={bounds.right[1]} set={setLayout} reset={resetLayout}
        style={{ right: layout.right - 3, top: MENUBAR_H, bottom: layout.bottom }} />
      <Resizer k="bottom" axis="y" sign={-1} label="타임라인 높이" value={layout.bottom} min={bounds.bottom[0]} max={bounds.bottom[1]} set={setLayout} reset={resetLayout}
        style={{ left: 0, right: 0, bottom: layout.bottom - 3 }} />
    </div>
  )
}
