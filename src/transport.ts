import { editingItem, getEditor, type EditorState } from './store/store'
import { onHandleArrow } from './layout/useLayout'
import { sortedItems } from './model/sequence'
import type { Project } from './model/types'
import { openProject, saveProject } from './projectActions'
import { seqFlash } from './timeline/viewState'
import { FPS } from './model/fps'

export function sequenceEnd(p: Project): number {
  let end = 0
  for (const t of p.sequence.tracks) for (const it of t.items) end = Math.max(end, it.start + it.trimOut - it.trimIn)
  return end
}

// Playback / arrow-key range [lo, hi): the open clip in clip view, In..Out in sequence view if both set, else 0..end.
export function playRange(s: Pick<EditorState, 'project' | 'editing'>): [number, number] {
  const e = editingItem(s)
  if (e) { const lo = e.item.start - e.item.trimIn; return [lo, lo + e.clip.length] }
  const { inF, outF } = s.project.sequence
  return inF !== null && outF !== null ? [inF, outF] : [0, sequenceEnd(s.project)]
}

// Item the C key splits: an item under the playhead (strictly inside), preferring the track of the selected item, then the selected actor's, then the top-most. None in clip view.
export function splitTarget(s: Pick<EditorState, 'project' | 'editing' | 'selItem' | 'sel' | 'frame'>): string | null {
  if (s.editing) return null
  const tracks = s.project.sequence.tracks
  const hits = tracks.flatMap(t => {
    const it = sortedItems(t).filter(i => s.frame > i.start && s.frame < i.start + i.trimOut - i.trimIn).at(-1)
    return it ? [{ t, it }] : []
  })
  const pick = hits.find(h => h.t.items.some(i => i.id === s.selItem))
    ?? hits.find(h => h.t.kind === 'motion' && s.sel.actorId && h.t.actorId === s.sel.actorId) ?? hits[0]
  return pick?.it.id ?? null
}

// Split at the playhead and select the new right-hand piece (same track, starts at the playhead).
export function splitAtPlayhead(ed: Pick<ReturnType<typeof getEditor>, 'getState'>, id: string): boolean {
  const { frame } = ed.getState()
  if (!ed.getState().splitItem(id, frame)) return false
  const s = ed.getState()
  const right = s.project.sequence.tracks.find(t => t.items.some(i => i.id === id))?.items.find(i => i.id !== id && i.start === frame)
  if (right) s.selectItem(right.id)
  return true
}

// Delete/C on an item of a locked track: the store rejects it; say why.
const lockedItem = (s: Pick<EditorState, 'project'>, id: string) => {
  const yes = s.project.sequence.tracks.some(t => t.locked && t.items.some(i => i.id === id))
  if (yes) seqFlash.fn?.('잠긴 트랙입니다', id)
  return yes
}

const typing =(t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))

export function startTransport(): () => void {
  const ed = getEditor()
  let raf = 0, t0 = 0, f0 = 0, was = false, last = 0

  const tick = () => {
    const s = ed.getState()
    if (s.playing) {
      const [lo, hi] = playRange(s)
      const now = performance.now()
      if (!was || hi <= lo || s.frame !== last || s.frame < lo || s.frame >= hi) { // start, scrubbed, or range moved away
        t0 = now; f0 = s.frame >= hi || s.frame < lo ? lo : s.frame }
      let f = f0 + Math.floor((now - t0) * FPS / 1000) // from start time, so no drift accumulates
      if (hi > lo && f >= hi) { t0 = now; f0 = lo; f = lo }
      if (f !== s.frame) s.setFrame(f)
      last = f
    }
    was = s.playing
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ['s', 'o'].includes(e.key.toLowerCase())) { // file shortcuts work everywhere
      e.preventDefault()
      if (!e.repeat) { if (e.key.toLowerCase() === 's') saveProject(e.shiftKey); else openProject() }
      return
    }
    if (typing(e.target) || e.altKey || (e.target instanceof Element && e.target.closest('[role=menu]'))) return // menus own their keys
    if (onHandleArrow(e)) return // resize handles own their arrow keys
    // panel rows own Delete/Backspace and the plain editing keys; undo, Space and arrows still pass through
    if (e.target instanceof Element && e.target.closest('#project') && !e.ctrlKey && !e.metaKey && ['Delete', 'Backspace', 'Escape', 'c', 'i', 'o', 'm'].includes(e.key.length === 1 ? e.key.toLowerCase() : e.key)) return
    const s = ed.getState()
    const step = (n: number) => {
      e.preventDefault()
      if (s.editing) { const [lo, hi] = playRange(s); s.setFrame(Math.min(Math.max(s.frame + n, lo), hi - 1)) }
      else s.setFrame(Math.min(Math.max(s.frame + n, 0), sequenceEnd(s.project)))
    }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase()
      if (k === 'z') { e.preventDefault(); e.shiftKey ? s.redo() : s.undo() }
      else if (k === 'y') { e.preventDefault(); s.redo() }
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      if (e.target instanceof HTMLButtonElement) e.target.blur() // avoid a second toggle from the button's own click
      s.setPlaying(!s.playing)
    } else if (e.key === 'ArrowLeft') step(e.shiftKey ? -10 : -1)
    else if (e.key === 'ArrowRight') step(e.shiftKey ? 10 : 1)
    else if (e.key === 'Escape') { if (s.editing && !e.defaultPrevented && !(e.target as Element | null)?.closest?.('dialog[open]')) s.closeItem() }
    else if (e.key === 'Delete') { if (!s.editing && s.selItem) { e.preventDefault(); if (!lockedItem(s, s.selItem)) s.deleteItem(s.selItem) } }
    else if (e.key.toLowerCase() === 'i') s.setIn(Math.max(s.frame, 0))
    else if (e.key.toLowerCase() === 'o') s.setOut(Math.max(s.frame, 0))
    else if (e.key.toLowerCase() === 'm') s.addMarker(Math.max(s.frame, 0))
    else if (e.key.toLowerCase() === 'c') {
      const id = splitTarget(s)
      if (id && !lockedItem(s, id)) splitAtPlayhead(ed, id)
    }
    else if (s.editing && e.key === 'Tab' && e.target instanceof Element && e.target.closest('#timeline')) {
      e.preventDefault(); s.setView(s.view === 'tracks' ? 'graph' : 'tracks')
      // the focused canvas is unmounted by the switch; refocus the new one so Tab keeps toggling
      requestAnimationFrame(() => document.querySelector<HTMLElement>('#timeline canvas')?.focus())
    }
  }
  window.addEventListener('keydown', onKey)
  return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey) }
}
