import type { RobotDefs } from '../model/evaluate'
import type { Clip, Project } from '../model/types'
import { FPS } from '../model/fps'

export interface TimeScale { x0: number; pxPerFrame: number }
export const frameToX = (s: TimeScale, f: number) => s.x0 + f * s.pxPerFrame
export const xToFrame = (s: TimeScale, x: number) => Math.round((x - s.x0) / s.pxPerFrame)

// Keys (sorted by f) with lo <= f <= hi, found by binary search.
export function keysIn<K extends { f: number }>(keys: K[], lo: number, hi: number): K[] {
  let a = 0, b = keys.length
  while (a < b) { const m = (a + b) >> 1; if (keys[m].f < lo) a = m + 1; else b = m }
  let e = a
  while (e < keys.length && keys[e].f <= hi) e++
  return keys.slice(a, e)
}

const p2 = (n: number) => String(n).padStart(2, '0')
export function formatTimecode(f: number): string {
  if (f < 0) return '-' + formatTimecode(-f)
  const sec = Math.floor(f / FPS)
  return `${p2(Math.floor(sec / 60))}:${p2(sec % 60)}.${p2(f % FPS)}`
}

export interface Row { kind: 'group' | 'channel'; actorId: string; label: string; channels: string[]; expanded?: boolean }
export const ROOT_CHANNELS = ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw']
export const rowKey = (actorId: string, label: string) => `${actorId}/${label}`

export function buildRows(p: Project, defs: RobotDefs, expanded: Set<string>): Row[] {
  const rows: Row[] = []
  for (const a of p.actors) {
    rows.push({ kind: 'group', actorId: a.id, label: a.name, channels: [] })
    const groups = [{ name: '루트', joints: ROOT_CHANNELS }, ...defs[a.robot].groups]
    for (const g of groups) {
      const open = expanded.has(rowKey(a.id, g.name))
      rows.push({ kind: 'group', actorId: a.id, label: g.name, channels: g.joints, expanded: open })
      if (open) for (const ch of g.joints) {
        rows.push({ kind: 'channel', actorId: a.id, label: ch.replace(/_joint$/, ''), channels: [ch] })
      }
    }
  }
  return rows
}

// y is relative to the top of rows[0]; returns clip frames of keys under the point (group rows: every channel key at that frame).
export function hitKey(rows: Row[], clip: Pick<Clip, 'channels'>, s: TimeScale, rowH: number, x: number, y: number): { channel: string; f: number }[] | null {
  const row = rows[Math.floor(y / rowH)]
  if (!row || y < 0) return null
  const hits: { channel: string; f: number }[] = []
  let best = 5
  for (const channel of row.channels) {
    for (const k of clip.channels[channel]?.keys ?? []) {
      const d = Math.abs(frameToX(s, k.f) - x)
      if (d < best) { best = d; hits.length = 0 }
      if (d <= best && d <= 4) hits.push({ channel, f: k.f })
    }
  }
  const f = hits[0]?.f
  const same = hits.filter(h => h.f === f)
  return same.length ? same : null
}

// Hover scrub: the frame under the pointer, or null when hovering the label column or while something else owns the mouse.
export const hoverFrame = (x: number, labelW: number, s: TimeScale, busy: boolean): number | null =>
  busy || x <= labelW ? null : xToFrame(s, x)

// Coalesces hover frames to one store update per animation frame, skipping no-ops.
export function hoverScrub(getFrame: () => number, setFrame: (f: number) => void) {
  let raf = 0, next = 0
  return {
    push(f: number) { next = f; if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (next !== getFrame()) setFrame(next) }) },
    stop() { cancelAnimationFrame(raf); raf = 0 },
  }
}
