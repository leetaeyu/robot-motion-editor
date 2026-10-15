import { itemLen, sortedItems } from './sequence'
import type { Item, Media, Project, Track } from './types'
import { FPS } from './fps'

export const videoTrack = (p: Project): Track | null => p.sequence.tracks.find(t => t.kind === 'video') ?? null

// First free frame after the last V1 item (0 when V1 is missing or empty).
export const videoEnd = (p: Project): number =>
  Math.max(0, ...(videoTrack(p)?.items ?? []).map(i => i.start + itemLen(i)))

// V1 rule: start >= 0, 0 <= trimIn < trimOut <= media.durationF, no overlap (touching is fine).
export function validVideoTrack(items: Item[], media: Record<string, Media>): boolean {
  const s = [...items].sort((a, b) => a.start - b.start)
  for (const it of s) {
    const m = Object.hasOwn(media, it.refId) ? media[it.refId] : undefined
    if (!m || it.start < 0 || it.trimIn < 0 || it.trimIn >= it.trimOut || it.trimOut > m.durationF) return false
  }
  return s.every((it, i) => i === 0 || s[i - 1].start + itemLen(s[i - 1]) <= it.start)
}

// Media position for a stage frame; items cover [start, start + len).
export function videoTimeAt(p: Project, frame: number): { mediaId: string; seconds: number; itemId: string } | null {
  const t = videoTrack(p)
  const it = t && sortedItems(t).find(i => frame >= i.start && frame < i.start + itemLen(i))
  return it ? { mediaId: it.refId, seconds: (frame - it.start + it.trimIn) / FPS, itemId: it.id } : null
}
