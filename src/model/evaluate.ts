import { evaluateClip, type Pose, type RobotDefs } from './pose'
import { applyXf, blendPose, itemLen, resolve, sortedItems, stitchTransforms } from './sequence'
import type { Clip, Item, Project, Track } from './types'
import { itemClip } from './itemClip'
import type { RobotKind } from '../robot/types'

export { evaluateClip, type Pose, type RobotDefs }

const emptyClip = (robot: RobotKind): Clip => ({ id: '', name: '', robot, length: 0, channels: {} })

type ClipEval = typeof evaluateClip
// Root channels only (q empty), for callers that need just the root path, e.g. stage trails.
const evaluateClipRoot: ClipEval = (clip, def, f) => evaluateClip(clip, { ...def, joints: [] }, f)

function trackPose(p: Project, defs: RobotDefs, track: Track, robot: RobotKind, frame: number, ev: ClipEval): Pose {
  const def = defs[robot]
  const xfs = stitchTransforms(p, defs, track)
  const at = (it: Item, cf: number): Pose | null => {
    const clip = itemClip(p, defs, it)
    return clip ? applyXf(ev(clip, def, cf), xfs.get(it.id)!) : null
  }
  const items = sortedItems(track)
  for (let i = 0; i + 1 < items.length; i++) {
    const a = items[i], b = items[i + 1]
    const s = b.start, e = a.start + itemLen(a)
    if (s < e && frame >= s && frame < e) {
      const pa = at(a, frame - a.start + a.trimIn), pb = at(b, frame - b.start + b.trimIn)
      if (pa && pb) return blendPose(pa, pb, (frame - s + 1) / (e - s + 1))
    }
  }
  const hit = resolve(items, frame)
  return (hit && at(hit.item, hit.cf)) || ev(emptyClip(robot), def, 0)
}

function evaluateWith(p: Project, defs: RobotDefs, actorId: string, frame: number, ev: ClipEval): Pose {
  const actor = p.actors.find(a => a.id === actorId)
  if (!actor) throw new Error(`unknown actor ${actorId}`)
  const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actorId)
  const pose = track ? trackPose(p, defs, track, actor.robot, frame, ev) : ev(emptyClip(actor.robot), defs[actor.robot], 0)
  return applyXf(pose, actor.placement)
}

export const evaluate = (p: Project, defs: RobotDefs, actorId: string, frame: number): Pose => evaluateWith(p, defs, actorId, frame, evaluateClip)
// Same item/blend/stitch logic with joints skipped (q is empty).
export const evaluateRoot = (p: Project, defs: RobotDefs, actorId: string, frame: number): Pose => evaluateWith(p, defs, actorId, frame, evaluateClipRoot)

// World pose of an item at a raw clip frame (trims ignored, clamped to the clip).
export function evaluateItem(p: Project, defs: RobotDefs, itemId: string, clipFrame: number): Pose {
  const track = p.sequence.tracks.find(t => t.items.some(i => i.id === itemId))
  const item = track?.items.find(i => i.id === itemId)
  const actor = p.actors.find(a => a.id === track?.actorId)
  const clip = item && itemClip(p, defs, item)
  if (!track || !item || !actor || !clip) throw new Error(`unknown item ${itemId}`)
  const cf = Math.min(Math.max(clipFrame, 0), clip.length - 1)
  const pose = applyXf(evaluateClip(clip, defs[actor.robot], cf), stitchTransforms(p, defs, track).get(itemId)!)
  return applyXf(pose, actor.placement)
}
