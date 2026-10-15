import { useEffect, useRef, useState } from 'react'
import { getEditor, useEditor } from '../store/store'
import { itemLen, sortedItems } from '../model/sequence'
import type { Item, Track } from '../model/types'
import { seqFlash, tv } from './viewState'
import { followStep, markHover, markUserScroll, resetFollow } from './follow'
import { sequenceEnd } from '../transport'
import { drawRuler, hitMarker, LABEL_W, RULER_H } from './ruler'
import { dropPlacement } from '../model/dropPlacement'
import { COLOR } from '../model/defaults'
import { draggedAsset, dropAsset, isAssetDrag } from './assetDrop'
import { mediaUrl, subscribeMedia } from '../media/registry'
import { formatTimecode, frameToX, hoverFrame, hoverScrub, xToFrame, type TimeScale } from './timeScale'

const ROW_H = 28, CHILD_H = 22, EDGE = 6
const DENY = '이 위치에 놓을 수 없습니다'
const LOCKED = '잠긴 트랙입니다'
const ICON_HIT = 18 // hit area; icons are drawn 14px, eye then padlock at the label column's right edge
const EYE_X = LABEL_W - 36, LOCK_X = LABEL_W - 16
const TRI_W = 18, NAME_X = 20, CHILD_X = NAME_X + 16 // disclosure triangle hit width; track / child label x

// Eye (slashed when the track is hidden) and padlock (shackle open when unlocked); `on` = accent, off = line.
function drawEye(ctx: CanvasRenderingContext2D, cx: number, cy: number, on: boolean, col: string) {
  ctx.save(); ctx.strokeStyle = ctx.fillStyle = col; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.ellipse(cx, cy, 7, 4.5, 0, 0, Math.PI * 2); ctx.stroke()
  ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill()
  if (on) { ctx.beginPath(); ctx.moveTo(cx - 6, cy + 6); ctx.lineTo(cx + 6, cy - 6); ctx.stroke() }
  ctx.restore()
}
function drawLock(ctx: CanvasRenderingContext2D, cx: number, cy: number, on: boolean, col: string) {
  ctx.save(); ctx.strokeStyle = ctx.fillStyle = col; ctx.lineWidth = 1.5
  ctx.fillRect(cx - 5, cy - 1, 10, 7)
  ctx.beginPath(); ctx.moveTo(cx - 3, cy - 1); ctx.lineTo(cx - 3, cy - 4); ctx.arc(cx, cy - 4, 3, Math.PI, 0)
  ctx.lineTo(cx + 3, on ? cy - 1 : cy - 5); ctx.stroke()
  ctx.restore()
}
const isVideo = (t: Track) => t.kind === 'video'
// "<start>–<end> · <clip name>" of a child row (sequence frames); time first since split pieces share a clip name
const childLabel = (it: Item, name: string) => `${formatTimecode(it.start)}–${formatTimecode(it.start + itemLen(it))} · ${name}`
// text cut to `w` px with an ellipsis
function fit(ctx: CanvasRenderingContext2D, text: string, w: number) {
  if (ctx.measureText(text).width <= w) return text
  let n = text.length
  while (n > 0 && ctx.measureText(text.slice(0, n) + '…').width > w) n--
  return text.slice(0, n) + '…'
}
// Label column rows: one per track, plus (expanded motion tracks) one child per item in time order; y is canvas px.
interface Row { t: Track; it?: Item; y: number; h: number }

// In-progress drag preview; the store is untouched until mouseup.
interface Drag { itemId: string; mode: 'move' | 'in' | 'out'; df: number }
interface Msg { text: string; left: number; top: number }
interface Rename { index: number; left: number; value: string }

export default function SequenceCanvas() {
  const cv = useRef<HTMLCanvasElement>(null)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [rename, setRename] = useState<Rename | null>(null)
  const cancel = useRef(false)
  const renaming = useRef(false)
  renaming.current = !!rename
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set()) // track ids with their item list open (UI only, not saved)
  const exp = useRef(expanded)
  exp.current = expanded
  const redraw = useRef<() => void>(() => {})
  useEffect(() => redraw.current(), [expanded])
  const toggle = (id: string) => setExpanded(e => { const n = new Set(e); if (!n.delete(id)) n.add(id); return n })

  useEffect(() => {
    const canvas = cv.current!, ed = getEditor()
    const css = getComputedStyle(document.documentElement)
    const col = (n: string) => css.getPropertyValue(n).trim()
    const C = { bg: col('--bg'), panel: col('--panel'), line: col('--line'), text: col('--text'), accent: col('--accent'), piece: col('--piece') }
    let W = 0, H = 0, raf = 0, drag: Drag | null = null, ghost: { y: number; start: number; len: number; color: string } | null = null, timer = 0, scrollY = 0

    const scale = (): TimeScale => ({ x0: LABEL_W - tv.scrollF * tv.ppf, pxPerFrame: tv.ppf })
    // V1 (always first) only shows once the project has media
    const tracks = () => { const p = ed.getState().project; return p.sequence.tracks.filter(t => t.kind === 'motion' || (isVideo(t) && p.media.length > 0)) }
    const refLen = (it: Item) => { const p = ed.getState().project; return p.clips[it.refId]?.length ?? p.media.find(m => m.id === it.refId)?.durationF ?? 0 }
    const refName = (it: Item) => { const p = ed.getState().project; return p.clips[it.refId]?.name ?? p.media.find(m => m.id === it.refId)?.name ?? '' }
    // items of a track with the drag preview applied
    const shown = (t: Track): Item[] => t.items.map(it => {
      if (!drag || drag.itemId !== it.id) return it
      const clipLen = refLen(it), d = drag.df
      if (drag.mode === 'move') return { ...it, start: Math.max(0, it.start + d) }
      if (drag.mode === 'in') { const k = Math.min(Math.max(d, -it.trimIn), itemLen(it) - 1); return { ...it, start: it.start + k, trimIn: it.trimIn + k } }
      return { ...it, trimOut: it.trimOut + Math.min(Math.max(d, 1 - itemLen(it)), clipLen - it.trimOut) }
    })
    const layout = (): Row[] => {
      const out: Row[] = []
      let y = RULER_H - scrollY
      for (const t of tracks()) {
        out.push({ t, y, h: ROW_H }); y += ROW_H
        if (!isVideo(t) && exp.current.has(t.id)) for (const it of sortedItems(t)) { out.push({ t, it, y, h: CHILD_H }); y += CHILD_H }
      }
      return out
    }
    const flash = (text: string, row: number) => {
      const r = layout()[row]
      if (!r) return
      setMsg({ text, left: LABEL_W + 4, top: r.y + r.h + 2 })
      clearTimeout(timer); timer = window.setTimeout(() => setMsg(null), 2000)
    }

    seqFlash.fn = (text, itemId) => flash(text, layout().findIndex(r => !r.it && r.t.items.some(i => i.id === itemId)))

    const draw = () => {
      raf = 0
      const s = ed.getState(), dpr = window.devicePixelRatio || 1
      if (followStep({ frame: s.frame, playF: s.frame, playing: s.playing, visibleF: (W - LABEL_W) / tv.ppf, contentEnd: sequenceEnd(s.project) })) schedule()
      const sc = scale()
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H)
      ctx.font = '11px "IBM Plex Sans KR", sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
      const hatch = (a: number, b: number, y: number, alpha: number) => {
        ctx.save(); ctx.beginPath(); ctx.rect(a, y + 2, b - a, ROW_H - 5); ctx.clip()
        ctx.strokeStyle = C.text; ctx.globalAlpha = alpha; ctx.lineWidth = 1; ctx.beginPath()
        for (let hx = a - ROW_H; hx < b + ROW_H; hx += 6) {
          ctx.moveTo(hx, y + ROW_H - 3); ctx.lineTo(hx + ROW_H - 5, y + 2)
          ctx.moveTo(hx, y + 2); ctx.lineTo(hx + ROW_H - 5, y + ROW_H - 3)
        }
        ctx.stroke(); ctx.restore()
      }
      const rows = layout(), total = rows.reduce((a, r) => a + r.h, 0)
      const maxY = Math.max(0, total - (H - RULER_H))
      if (scrollY > maxY) { scrollY = maxY; schedule() } // rows collapsed or the panel grew
      rows.forEach(r => {
        const { t, y } = r, actor = s.project.actors.find(a => a.id === t.actorId), video = isVideo(t)
        const color = actor?.color ?? C.text
        if (r.it) { // child row: faint span bar, indented "<clip> · start–end"
          const it = shown(t).find(i => i.id === r.it!.id) ?? r.it, h = r.h
          ctx.fillStyle = C.line; ctx.fillRect(0, y + h - 1, W, 1)
          ctx.save(); ctx.beginPath(); ctx.rect(LABEL_W, y, W - LABEL_W, h); ctx.clip()
          const x = frameToX(sc, it.start), w = itemLen(it) * tv.ppf
          ctx.globalAlpha = 0.25; ctx.fillStyle = color; ctx.fillRect(x, y + 3, w, h - 7); ctx.globalAlpha = 1
          if (it.id === s.selItem) { ctx.strokeStyle = C.accent; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 3.5, w - 1, h - 8) }
          ctx.restore()
          ctx.fillStyle = C.bg; ctx.fillRect(0, y, LABEL_W - 1, h - 1)
          ctx.font = '10px "IBM Plex Sans KR", sans-serif'
          ctx.fillStyle = it.id === s.selItem ? C.accent : C.text
          ctx.fillText(fit(ctx, childLabel(it, refName(it)), LABEL_W - CHILD_X - 6), CHILD_X, y + h / 2)
          ctx.font = '11px "IBM Plex Sans KR", sans-serif'
          return
        }
        ctx.fillStyle = C.line; ctx.fillRect(0, y + ROW_H - 1, W, 1)
        ctx.save(); ctx.beginPath(); ctx.rect(LABEL_W, y, W - LABEL_W, ROW_H); ctx.clip()
        const ga = t.locked ? 0.5 : 1 // locked bars: half transparent, no hatch
        ctx.globalAlpha = ga
        const items = sortedItems({ ...t, items: shown(t) })
        for (const it of items) {
          const x = frameToX(sc, it.start), w = itemLen(it) * tv.ppf, by = y + 2, bh = ROW_H - 5
          if (video) { ctx.fillStyle = C.panel; ctx.fillRect(x, by, w, bh) }
          else { ctx.fillStyle = color; ctx.globalAlpha = 0.18 * ga; ctx.fillRect(x, by, w, bh); ctx.globalAlpha = ga }
          if (it.offset) { // 수정 층 keys: short ticks along the bar's bottom edge (clip frames inside the trim)
            ctx.fillStyle = C.piece; ctx.globalAlpha = ga
            const fs = new Set(Object.values(it.offset).flatMap(c => c.keys.map(k => k.f)).filter(f => f >= it.trimIn && f < it.trimOut))
            for (const f of fs) ctx.fillRect(Math.round(frameToX(sc, it.start + f - it.trimIn)) - 1, by + bh - 4, 2, 4)
          }
          if (video && !mediaUrl(it.refId)) hatch(x, x + w, y, 0.25) // offline
          ctx.strokeStyle = it.id === s.selItem ? C.accent : video ? C.line : color; ctx.lineWidth = 1
          ctx.strokeRect(x + 0.5, by + 0.5, w - 1, bh - 1)
        }
        // crossfade: overlap of neighbours, hatched both ways
        for (let k = 0; k + 1 < items.length; k++) {
          const a = frameToX(sc, items[k + 1].start), b = frameToX(sc, items[k].start + itemLen(items[k]))
          if (b <= a) continue
          hatch(a, b, y, 0.5)
        }
        ctx.fillStyle = C.text
        for (const it of items) {
          const x = Math.max(frameToX(sc, it.start), LABEL_W) + 4, right = frameToX(sc, it.start + itemLen(it)) - 4
          if (right > x) ctx.fillText(refName(it) + (video && !mediaUrl(it.refId) ? ' (오프라인)' : ''), x, y + ROW_H / 2, right - x)
        }
        ctx.restore()
        ctx.fillStyle = C.bg; ctx.fillRect(0, y, LABEL_W, ROW_H - 1)
        ctx.globalAlpha = t.hidden ? 0.4 : 1
        if (!video) { ctx.fillStyle = C.text; ctx.fillText(exp.current.has(t.id) ? '▾' : '▸', 6, y + ROW_H / 2) }
        ctx.fillStyle = color; ctx.fillText(video ? 'V1 참조영상' : actor?.name ?? '', video ? 8 : NAME_X, y + ROW_H / 2, EYE_X - 9 - (video ? 8 : NAME_X))
        ctx.globalAlpha = 1
        drawEye(ctx, EYE_X, y + ROW_H / 2, t.hidden, t.hidden ? C.accent : C.line)
        drawLock(ctx, LOCK_X, y + ROW_H / 2, t.locked, t.locked ? C.accent : C.line)
      })
      if (ghost) {
        ctx.save(); ctx.beginPath(); ctx.rect(LABEL_W, RULER_H, W - LABEL_W, H - RULER_H); ctx.clip()
        const gx = frameToX(sc, ghost.start), gw = ghost.len * tv.ppf
        ctx.globalAlpha = 0.3; ctx.fillStyle = ghost.color; ctx.fillRect(gx, ghost.y + 2, gw, ROW_H - 5)
        ctx.globalAlpha = 1; ctx.strokeStyle = ghost.color; ctx.strokeRect(gx + 0.5, ghost.y + 2.5, gw - 1, ROW_H - 6)
        ctx.restore()
      }
      drawRuler(ctx, sc, W, RULER_H, s.project.sequence, s.frame, C)
      const px = Math.round(frameToX(sc, s.frame)) + 0.5
      if (px >= LABEL_W) { ctx.fillStyle = C.accent; ctx.fillRect(px - 0.5, RULER_H, 1, H - RULER_H) }
      ctx.fillStyle = C.line; ctx.fillRect(LABEL_W - 1, 0, 1, H)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw) }
    redraw.current = schedule

    const resize = () => {
      const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect()
      W = r.width; H = r.height
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
      schedule()
    }
    resetFollow()
    const ro = new ResizeObserver(resize); ro.observe(canvas); resize()
    const unsub = ed.subscribe(schedule), unsubMedia = subscribeMedia(schedule)

    // ---- mouse ----
    const pos = (e: { clientX: number; clientY: number }) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }
    const frameAt = (x: number) => Math.max(0, xToFrame(scale(), x))
    const track = (mv: (e: MouseEvent) => void, up: (e: MouseEvent) => void) => {
      const end = (e: MouseEvent) => { removeEventListener('mousemove', mv); removeEventListener('mouseup', end); up(e) }
      addEventListener('mousemove', mv); addEventListener('mouseup', end)
    }
    const rowAt = (y: number) => y < RULER_H ? -1 : layout().findIndex(r => y >= r.y && y < r.y + r.h)
    // topmost item under (x, y) with the zone of the hit (track rows only; child rows are not draggable)
    const itemAt = (x: number, y: number) => {
      const r = layout()[rowAt(y)], t = r?.t
      if (!t || r.it || y < RULER_H || x < LABEL_W) return null
      const sc = scale()
      const items = sortedItems(t).reverse() // later item wins
      const span = (i: Item) => { const x0 = frameToX(sc, i.start), x1 = frameToX(sc, i.start + itemLen(i)); return { x0, x1, edge: Math.min(EDGE, (x1 - x0) / 3) } }
      for (const it of items) { // edges of every item first, so a crossfade tail stays trimmable
        const { x0, x1, edge } = span(it)
        if (x >= x0 && x - x0 < edge) return { t, it, mode: 'in' as Drag['mode'] }
        if (x <= x1 && x1 - x < edge) return { t, it, mode: 'out' as Drag['mode'] }
      }
      const it = items.find(i => { const { x0, x1 } = span(i); return x >= x0 && x <= x1 })
      return it ? { t, it, mode: 'move' as Drag['mode'] } : null
    }

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      canvas.focus()
      const { x, y } = pos(e), s = ed.getState(), row = rowAt(y)
      if (y < RULER_H) {
        const mi = hitMarker(s.project.sequence, scale(), x)
        if (mi !== null) { s.setFrame(s.project.sequence.markers[mi].f); return }
        s.setFrame(frameAt(x)); track(m => s.setFrame(frameAt(pos(m).x)), () => {})
        return
      }
      const r = layout()[row]
      if (r?.it) { // child row (label or time area): select the item and preview it
        s.selectItem(r.it.id)
        if (r.t.actorId) s.select(r.t.actorId)
        s.openItemPreview(r.it.id)
        return
      }
      if (x < LABEL_W) {
        const t = r?.t
        if (!t) return
        if (!isVideo(t) && x < TRI_W) setExpanded(e => { const n = new Set(e); if (!n.delete(t.id)) n.add(t.id); return n })
        else if (Math.abs(x - EYE_X) <= ICON_HIT / 2) s.setTrackFlag(t.id, 'hidden', !t.hidden)
        else if (Math.abs(x - LOCK_X) <= ICON_HIT / 2) s.setTrackFlag(t.id, 'locked', !t.locked)
        else if (t.actorId) s.select(t.actorId)
        return
      }
      const hit = itemAt(x, y)
      if (!hit) {
        s.selectItem(null); s.setFrame(frameAt(x))
        track(m => s.setFrame(frameAt(pos(m).x)), () => {})
        return
      }
      const { t, it, mode } = hit
      s.selectItem(it.id)
      if (t.actorId) s.select(t.actorId)
      track(m => {
        const df = Math.round((pos(m).x - x) / tv.ppf)
        if (df !== (drag?.df ?? 0)) { drag = { itemId: it.id, mode, df }; schedule() }
      }, m => {
        const df = Math.round((pos(m).x - x) / tv.ppf), st = ed.getState()
        drag = null
        if (df !== 0) {
          const ok = mode === 'move' ? st.moveItem(it.id, Math.max(0, it.start + df)) : st.trimItem(it.id, mode, df)
          if (!ok) flash(t.locked ? LOCKED : DENY, row)
        }
        schedule()
      })
    }

    const onDbl = (e: MouseEvent) => {
      const { x, y } = pos(e), s = ed.getState()
      if (y < RULER_H) {
        const mi = hitMarker(s.project.sequence, scale(), x)
        if (mi !== null) { cancel.current = false; setRename({ index: mi, left: Math.max(LABEL_W, x - 55), value: s.project.sequence.markers[mi].name }) }
        return
      }
      const hit = itemAt(x, y)
      if (hit && !isVideo(hit.t)) s.openItem(hit.it.id)
    }

    const onContext = (e: MouseEvent) => {
      const { x, y } = pos(e), s = ed.getState()
      if (y >= RULER_H) return
      e.preventDefault()
      const mi = hitMarker(s.project.sequence, scale(), x)
      if (mi !== null) s.deleteMarker(mi)
    }

    const hover = hoverScrub(() => ed.getState().frame, f => { markHover(); ed.getState().setFrame(f) })
    const onMove = (e: MouseEvent) => {
      const { x, y } = pos(e), h = itemAt(x, y)
      canvas.style.cursor = h && h.mode !== 'move' ? 'ew-resize' : ''
      const f = hoverFrame(x, LABEL_W, scale(), e.buttons !== 0 || ed.getState().playing || renaming.current)
      if (f !== null) hover.push(Math.max(0, f))
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      markUserScroll()
      if (e.ctrlKey) {
        const { x } = pos(e), fAt = tv.scrollF + (x - LABEL_W) / tv.ppf
        tv.ppf = Math.min(Math.max(tv.ppf * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.5), 40)
        tv.scrollF = Math.max(0, fAt - (x - LABEL_W) / tv.ppf)
      } else if (e.shiftKey) { // vertical scroll; clamped in draw
        scrollY = Math.max(0, scrollY + (e.deltaY || e.deltaX))
      } else tv.scrollF = Math.max(0, tv.scrollF + (e.deltaY + e.deltaX) / tv.ppf)
      schedule()
    }

    // ---- asset drag from the project panel: the ghost bar and the drop use the same dropPlacement ----
    const setGhost = (g: typeof ghost) => { ghost = g; schedule() }
    const dropAt = (e: DragEvent) => { const { x, y } = pos(e); return { row: layout()[rowAt(y)], frame: frameAt(x) } } // a child row drops onto its track
    const onDragOver = (e: DragEvent) => {
      if (!isAssetDrag(e.dataTransfer ?? null)) return
      e.preventDefault()
      const asset = draggedAsset(null)
      if (!asset) return
      const { row, frame } = dropAt(e), p = ed.getState().project, pl = dropPlacement(p, asset, row?.t.id ?? null, frame)
      if (pl.kind === 'reject') return setGhost(null)
      const rows = layout(), last = rows.at(-1), bottom = last ? last.y + last.h : RULER_H - scrollY
      if (pl.kind === 'newActor') setGhost({ y: bottom, start: pl.start, len: p.clips[asset.id].length, color: COLOR[pl.robot] })
      else {
        const t = pl.kind === 'video' ? rows.find(r => !r.it && isVideo(r.t)) : rows.find(r => !r.it && r.t.id === pl.trackId)
        const actor = p.actors.find(a => a.id === t?.t.actorId)
        setGhost(t ? { y: t.y, start: pl.start, len: asset.kind === 'clip' ? p.clips[asset.id].length : p.media.find(m => m.id === asset.id)!.durationF, color: actor?.color ?? C.accent } : null)
      }
    }
    const onDrop = (e: DragEvent) => {
      setGhost(null)
      const asset = draggedAsset(e.dataTransfer ?? null)
      if (!asset) return
      e.preventDefault()
      const { row, frame } = dropAt(e), reason = dropAsset(asset, row?.t.id ?? null, frame)
      if (reason) flash(reason, Math.max(0, layout().findIndex(r => r === row)))
    }
    const clearGhost = () => { if (ghost) setGhost(null) }

    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('dblclick', onDbl)
    canvas.addEventListener('contextmenu', onContext)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dragover', onDragOver)
    canvas.addEventListener('drop', onDrop)
    canvas.addEventListener('dragleave', clearGhost)
    addEventListener('dragend', clearGhost)
    return () => {
      seqFlash.fn = null
      ro.disconnect(); unsub(); unsubMedia(); hover.stop(); cancelAnimationFrame(raf); clearTimeout(timer)
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('contextmenu', onContext)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dragover', onDragOver)
      canvas.removeEventListener('drop', onDrop)
      canvas.removeEventListener('dragleave', clearGhost)
      removeEventListener('dragend', clearGhost)
    }
  }, [])

  const commit = () => {
    if (rename && !cancel.current) {
      const name = rename.value.trim()
      if (name) getEditor().getState().renameMarker(rename.index, name)
    }
    setRename(null)
  }
  const project = useEditor(s => s.project)
  const rows = project.sequence.tracks.filter(t => t.kind === 'motion' || (isVideo(t) && project.media.length > 0))
  return (
    <div className="tl-body">
      <canvas ref={cv} tabIndex={0} className="track-canvas seq-canvas" />
      <div className="sr-only">
        {rows.map(t => {
          const name = isVideo(t) ? 'V1 참조영상' : project.actors.find(a => a.id === t.actorId)?.name ?? ''
          const flag = (f: 'hidden' | 'locked', label: string) =>
            <button aria-pressed={t[f]} onClick={() => getEditor().getState().setTrackFlag(t.id, f, !t[f])}>{name} {label}</button>
          const open = !isVideo(t) && expanded.has(t.id)
          return (
            <span key={t.id}>
              {!isVideo(t) && <button aria-expanded={open} onClick={() => toggle(t.id)}
                onKeyDown={e => { if (e.key === ' ') e.stopPropagation() }}>{name} 클립 목록</button>}
              {flag('hidden', '숨기기')}{flag('locked', '잠그기')}
              {open && sortedItems(t).map(it => (
                <button key={it.id} onClick={() => { const s = getEditor().getState(); s.selectItem(it.id); s.openItemPreview(it.id) }}
                  onKeyDown={e => { if (e.key === ' ') e.stopPropagation() }}>
                  {childLabel(it, project.clips[it.refId]?.name ?? '')} 클립 프리뷰
                </button>
              ))}
            </span>
          )
        })}
      </div>
      {!rows.length && <div className="seq-empty">CSV 가져오기로 모션을 불러오세요</div>}
      {msg && <div className="seq-msg" style={{ left: msg.left, top: msg.top }}>{msg.text}</div>}
      {rename && (
        <input className="seq-rename" autoFocus value={rename.value} style={{ left: rename.left }}
          onChange={e => setRename({ ...rename, value: e.target.value })} onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') { cancel.current = true; e.currentTarget.blur() }
          }} />
      )}
    </div>
  )
}
