import { posesToClip } from '../export/importCsv'
import { rebasePose, type Pose, type RobotDefs } from '../model/pose'
import { quatYaw } from '../model/rootMath'
import { applyXf, blendPose, type Xf } from '../model/sequence'
import type { Clip } from '../model/types'
import type { Block, LoopSpec } from './blocks'

const SEAM = 5 // source frames blended after each loop seam
const MAX_LOOPS = 100 // Move ≈ 62m, Rotate ≈ 7200°; keeps a typo like 10000 from hanging the tab
const DEG = 180 / Math.PI
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

type LoopBlock = Extract<Block, { kind: 'loop' }>
const specOf = (b: LoopBlock, value: number): LoopSpec => b.id === 'move' ? b.spec : value >= 0 ? b.left : b.right

// Planar transform taking the loop's first frame onto its last: applyXf(a, d) has b's x, y and yaw.
function loopXf(a: Pose, b: Pose): Xf {
  const yaw = wrap(quatYaw(b.rootQuat) - quatYaw(a.rootQuat)), c = Math.cos(yaw), s = Math.sin(yaw)
  const [ax, ay] = a.rootPos
  return { x: b.rootPos[0] - (c * ax - s * ay), y: b.rootPos[1] - (s * ax + c * ay), yaw }
}
// d applied k times after `from`
function powXf(d: Xf, k: number, from: Xf = { x: 0, y: 0, yaw: 0 }): Xf {
  let out = from
  for (let i = 0; i < k; i++) {
    const c = Math.cos(d.yaw), s = Math.sin(d.yaw)
    out = { x: c * out.x - s * out.y + d.x, y: s * out.x + c * out.y + d.y, yaw: out.yaw + d.yaw }
  }
  return out
}

const dist = (a: Pose, b: Pose) => Math.hypot(b.rootPos[0] - a.rootPos[0], b.rootPos[1] - a.rootPos[1])
const turn = (a: Pose, b: Pose) => wrap(quatYaw(b.rootQuat) - quatYaw(a.rootQuat)) * DEG

// n loops so that head + n·loop + tail lands nearest `value`; actual = what that clip really covers.
function loopPlan(b: LoopBlock, poses: Pose[], value: number) {
  const spec = specOf(b, value), [s, e] = spec.loop, h0 = poses[spec.head[0]], t0 = poses[spec.tail[0]], tl = poses[spec.tail[1] - 1]
  const d = loopXf(poses[s], poses[e])
  const m = b.id === 'move'
  const per = m ? dist(poses[s], poses[e]) : d.yaw * DEG
  const base = m ? dist(h0, poses[s]) + dist(t0, tl) : turn(h0, poses[s]) + turn(t0, tl)
  const n = Math.min(MAX_LOOPS, Math.max(1, Math.round((Math.abs(value) - Math.abs(base)) / Math.abs(per))))
  const actual = m ? dist(h0, applyXf(tl, powXf(d, n - 1))) : base + n * per
  return { spec, d, n, actual }
}

/** Loop count and the value the clip really covers (m or signed degrees); null for fixed blocks. */
export function blockActual(block: Block, poses: Pose[], value: number): { n: number; actual: number } | null {
  if (block.kind === 'fixed') return null
  const { n, actual } = loopPlan(block, poses, value)
  return { n, actual }
}

/** Source poses (at `fps`) -> 50fps GO2 clip starting at the origin. Loop blocks: head + loop × n + tail. */
export function buildBlockClip(block: Block, poses: Pose[], fps: number, value: number, defs: RobotDefs): Clip {
  let out: Pose[] = poses, name = block.label
  if (block.kind === 'loop') {
    const { spec, d, n, actual } = loopPlan(block, poses, value)
    const [s, e] = spec.loop
    out = poses.slice(spec.head[0], spec.head[1])
    let prev = powXf(d, 0), xk = prev
    for (let k = 0; k < n; k++) {
      if (k > 0) { prev = xk; xk = powXf(d, 1, xk) }
      poses.slice(s, e).forEach((p, i) => {
        const cur = applyXf(p, xk)
        out.push(k > 0 && i < SEAM ? blendPose(applyXf(poses[e + i], prev), cur, (i + 1) / (SEAM + 1)) : cur)
      })
    }
    // the tail continues the last loop copy (d^(n-1)), as poses[e..] continue poses[s..e)
    for (const p of poses.slice(spec.tail[0], spec.tail[1])) out.push(applyXf(p, xk))
    name = block.id === 'move' ? `Move_${+actual.toFixed(1)}m` : `Rotate_${Math.round(actual)}deg`
  }
  const origin = out[0]
  return posesToClip(out.map(p => rebasePose(p, origin)), fps, 'go2', defs, name)
}
