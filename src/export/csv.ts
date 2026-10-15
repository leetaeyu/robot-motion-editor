import { evaluate, type Pose, type RobotDefs } from '../model/evaluate'
import { rebasePose } from '../model/pose'
import type { Quat } from '../model/rootMath'
import type { Item, Project } from '../model/types'
import type { RobotDef, RobotKind } from '../robot/types'
import { FPS } from '../model/fps'

export type RootMode = 'local' | 'world'

const LABEL = { g1: 'G1', go2: 'GO2' } as const

export const itemFrameRange = (item: Item) => ({ from: item.start, to: item.start + (item.trimOut - item.trimIn) })

function findItem(p: Project, itemId: string): Item {
  for (const t of p.sequence.tracks) for (const it of t.items) if (it.id === itemId) return it
  throw new Error(`unknown item ${itemId}`)
}

// Unit-length quaternion, sign-flipped to stay on the same hemisphere as the previous row.
export function normalizedPose(src: Pose, prev?: Pose): Pose {
  const n = Math.hypot(...src.rootQuat) || 1
  let q = src.rootQuat.map(v => v / n) as Quat
  if (prev && prev.rootQuat.reduce((s, v, i) => s + v * q[i], 0) < 0) q = q.map(v => -v) as Quat
  return { rootPos: [...src.rootPos], rootQuat: q, q: [...src.q] }
}

export function samplePoses(p: Project, defs: RobotDefs, actorId: string, itemId: string, mode: RootMode): Pose[] {
  const { from, to } = itemFrameRange(findItem(p, itemId))
  const out: Pose[] = []
  for (let f = from; f < to; f++) {
    out.push(normalizedPose(evaluate(p, defs, actorId, f), out[out.length - 1]))
  }
  // Pre-multiplying by a constant quat keeps the sign continuity established above.
  if (mode === 'local' && out.length) return out.map(o => rebasePose(o, out[0]))
  return out
}

const fmt = (v: number) => {
  const s = v.toFixed(6)
  return s === '-0.000000' ? '0.000000' : s
}

export const CSV_FPS = FPS
export const ROBOT_TYPE: Record<RobotKind, number> = { g1: 0, go2: 1 }
export const HEAD_FIXED = ['frequency(fps)', 'RobotType', 'DOF Number', 'time(ms)', 'position X(m)', 'position Y(m)', 'position Z(m)',
  'quaternion X', 'quaternion Y', 'quaternion Z', 'quaternion W']

// Unitree RL motion CSV: header + one row per frame, every line ends with a comma; lines joined by newlines.
export const posesToCsv = (poses: Pose[], def: RobotDef): string =>
  [[...HEAD_FIXED, ...def.joints.map(j => j.name)].join(',') + ',',
    ...poses.map((p, i) => [CSV_FPS, ROBOT_TYPE[def.kind], def.joints.length, Math.round(i * 1000 / CSV_FPS),
      ...[...p.rootPos, ...p.rootQuat, ...p.q].map(fmt)].join(',') + ',')].join('\n') // no newline after the last line, like the reference files

export function csvFileName(p: Project, actorId: string, itemId: string, taken: Set<string>): string {
  const actor = p.actors.find(a => a.id === actorId)
  if (!actor) throw new Error(`unknown actor ${actorId}`)
  const clip = p.clips[findItem(p, itemId).refId]
  const shared = p.actors.filter(a => a.robot === actor.robot).length > 1
  const clean = (s: string) => s.replace(/[/\\:*?"<>|#\s]/g, '_')
  const base = `${clean(shared ? actor.name : LABEL[actor.robot])}_${clean(clip?.name ?? 'clip')}`
  let name = `${base}.csv`
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}.csv`
  taken.add(name)
  return name
}
