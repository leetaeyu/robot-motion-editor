import { evalCurve, makeKey } from './curve'
import type { RobotDefs } from './pose'
import type { Clip, Curve, Item, Key, Project } from './types'
import type { RobotDef } from '../robot/types'

// 조각 수정 층: Item.offset holds per-channel delta curves in clip frames (joints rad, root m/rad). The piece plays
// clip + offset; the shared clip is never touched. Spec docs/superpowers/specs/2026-10-13-piece-offset-design.md.

export const offsetKeyCount = (it: Item) => Object.values(it.offset ?? {}).reduce((n, c) => n + c.keys.length, 0)

/** The clip with `offset` added on its channels: one linear key per frame on the offset channels (joints clamped to the
 * URDF limits), every other channel shared with `clip`. Evaluated at integer frames it equals base + offset exactly. */
export function bakeOffset(clip: Clip, def: RobotDef, offset: Record<string, Curve>): Clip {
  const channels = { ...clip.channels }
  for (const [n, oc] of Object.entries(offset)) {
    if (!oc.keys.length) continue
    const base = clip.channels[n] ?? { keys: [] }, fb = n === 'root.z' ? def.standingHeight : 0
    const j = def.joints.find(j => j.name === n)
    const keys: Key[] = []
    for (let f = 0; f < clip.length; f++) {
      const v = evalCurve(base, f, fb) + evalCurve(oc, f, 0)
      keys.push(makeKey(f, j ? Math.min(Math.max(v, j.lower), j.upper) : v, 'linear'))
    }
    channels[n] = { keys }
  }
  return { ...clip, channels }
}

// Memo per offset object and clip: a project is immutable per edit, so the bake is redone only after an edit.
const cache = new WeakMap<Record<string, Curve>, WeakMap<Clip, Clip>>()

/** The clip a motion item plays: its clip, plus the item's 수정 층 when it has one. undefined for an unknown clip. */
export function itemClip(p: Project, defs: RobotDefs, it: Item): Clip | undefined {
  const clip = p.clips[it.refId]
  if (!clip || !it.offset || !offsetKeyCount(it)) return clip
  let m = cache.get(it.offset)
  if (!m) cache.set(it.offset, m = new WeakMap())
  let r = m.get(clip)
  if (!r) m.set(clip, r = bakeOffset(clip, defs[clip.robot], it.offset))
  return r
}
