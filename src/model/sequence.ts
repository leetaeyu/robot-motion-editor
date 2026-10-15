import { evaluateClip, type Pose, type RobotDefs } from './pose'
import { quatMul, quatYaw, yawQuat, type Quat } from './rootMath'
import type { Item, Project, Track } from './types'
import { itemClip } from './itemClip'

export interface Xf { x: number; y: number; yaw: number } // clip root -> track coords

export const itemLen = (it: Item): number => it.trimOut - it.trimIn
export const sortedItems = (track: Track): Item[] => [...track.items].sort((a, b) => a.start - b.start)

// `items` must be sorted by start. Item + clip frame for a stage frame: before first item -> its trimIn; gap/after -> previous item's last frame.
export function resolve(items: Item[], frame: number): { item: Item; cf: number } | null {
  let prev: Item | null = null
  for (const it of items) {
    if (frame < it.start) return prev ? { item: prev, cf: prev.trimOut - 1 } : { item: it, cf: it.trimIn }
    if (frame < it.start + itemLen(it)) return { item: it, cf: frame - it.start + it.trimIn }
    prev = it
  }
  return prev ? { item: prev, cf: prev.trimOut - 1 } : null
}

export function applyXf(pose: Pose, xf: Xf): Pose {
  const c = Math.cos(xf.yaw), s = Math.sin(xf.yaw)
  const [x, y, z] = pose.rootPos
  return {
    rootPos: [c * x - s * y + xf.x, s * x + c * y + xf.y, z],
    rootQuat: quatMul(yawQuat(xf.yaw), pose.rootQuat),
    q: pose.q,
  }
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const bb: Quat = dot < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b
  dot = Math.abs(dot)
  let ka = 1 - t, kb = t
  if (dot < 0.9995) { // else nearly parallel: lerp
    const th = Math.acos(dot), sn = Math.sin(th)
    ka = Math.sin((1 - t) * th) / sn
    kb = Math.sin(t * th) / sn
  }
  const r = a.map((v, i) => ka * v + kb * bb[i]) as Quat
  const n = Math.hypot(...r)
  return r.map(v => v / n) as Quat
}

export function blendPose(a: Pose, b: Pose, w: number): Pose {
  const l = (x: number, y: number) => x + (y - x) * w
  return {
    rootPos: [l(a.rootPos[0], b.rootPos[0]), l(a.rootPos[1], b.rootPos[1]), l(a.rootPos[2], b.rootPos[2])],
    rootQuat: slerp(a.rootQuat, b.rootQuat, w),
    q: a.q.map((v, i) => l(v, b.q[i])),
  }
}

const cache = new WeakMap<Project, Map<string, Map<string, Xf>>>() // Project is immutable per edit

export function stitchTransforms(p: Project, defs: RobotDefs, track: Track): Map<string, Xf> {
  let perTrack = cache.get(p)
  if (!perTrack) cache.set(p, perTrack = new Map())
  const hit = perTrack.get(track.id)
  if (hit) return hit
  const out = new Map<string, Xf>()
  perTrack.set(track.id, out)
  const actor = p.actors.find(a => a.id === track.actorId)
  const items = sortedItems(track)
  let prev: Item | null = null
  for (const it of items) {
    let xf: Xf = { x: 0, y: 0, yaw: 0 }
    const clip = itemClip(p, defs, it), prevClip = prev && itemClip(p, defs, prev)
    if (prev && prevClip && clip && actor) {
      const def = defs[actor.robot]
      const pcf = Math.min(Math.max(it.start - prev.start + prev.trimIn, prev.trimIn), prev.trimOut - 1)
      const P = applyXf(evaluateClip(prevClip, def, pcf), out.get(prev.id)!)
      const C = evaluateClip(clip, def, it.trimIn)
      const yaw = quatYaw(P.rootQuat) - quatYaw(C.rootQuat)
      const c = Math.cos(yaw), s = Math.sin(yaw)
      xf = {
        x: P.rootPos[0] - (c * C.rootPos[0] - s * C.rootPos[1]),
        y: P.rootPos[1] - (s * C.rootPos[0] + c * C.rootPos[1]),
        yaw,
      }
    }
    out.set(it.id, xf)
    prev = it
  }
  return out
}

// Track rule: start >= 0, distinct starts, only neighbours overlap (never i and i+2), overlap <= min(len)-1.
export function validTrack(items: Item[]): boolean {
  const s = [...items].sort((a, b) => a.start - b.start)
  if (s.some(it => it.start < 0 || it.trimIn < 0 || itemLen(it) < 1)) return false
  for (let i = 0; i + 1 < s.length; i++) {
    const end = s[i].start + itemLen(s[i])
    if (s[i + 1].start === s[i].start) return false
    if (end - s[i + 1].start > Math.min(itemLen(s[i]), itemLen(s[i + 1])) - 1) return false
    if (i + 2 < s.length && end > s[i + 2].start) return false
  }
  return true
}

// Inverse of world = placement . xf . clipRoot: a world root pose -> clip-local root channels.
export function worldToClipRoot(world: { pos: [number, number, number]; quat: Quat }, placement: Xf, xf: Xf) {
  const un = (v: [number, number], t: Xf): [number, number] => {
    const dx = v[0] - t.x, dy = v[1] - t.y, c = Math.cos(t.yaw), s = Math.sin(t.yaw)
    return [c * dx + s * dy, -s * dx + c * dy]
  }
  const [x, y] = un(un([world.pos[0], world.pos[1]], placement), xf)
  const [qx, qy, qz, qw] = quatMul(yawQuat(-xf.yaw), quatMul(yawQuat(-placement.yaw), world.quat))
  return {
    x, y, z: world.pos[2],
    roll: Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy)),
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (qw * qy - qz * qx)))),
    yaw: Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)),
  }
}

// True when `frame` lies in a crossfade overlap of the track.
export function inCrossfade(track: Track, frame: number): boolean {
  const s = sortedItems(track)
  return s.some((a, i) => i + 1 < s.length && frame >= s[i + 1].start && frame < a.start + itemLen(a))
}
