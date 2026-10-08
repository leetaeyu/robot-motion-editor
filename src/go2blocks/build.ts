import { posesToClip } from '../export/importCsv'
import { rebasePose, type Pose, type RobotDefs } from '../model/pose'
import { quatYaw } from '../model/rootMath'
import { applyXf, blendPose, type Xf } from '../model/sequence'
import type { Clip } from '../model/types'
import type { Block, LoopSpec } from './blocks'

const SEAM = 5 // source frames blended after each loop seam
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
// d applied k times
function powXf(d: Xf, k: number): Xf {
  let out: Xf = { x: 0, y: 0, yaw: 0 }
  for (let i = 0; i < k; i++) {
    const c = Math.cos(d.yaw), s = Math.sin(d.yaw)
    out = { x: c * out.x - s * out.y + d.x, y: s * out.x + c * out.y + d.y, yaw: out.yaw + d.yaw }
  }
  return out
}

function loopPlan(b: LoopBlock, poses: Pose[], value: number) {
  const spec = specOf(b, value), [s, e] = spec.loop
  const d = loopXf(poses[s], poses[e])
  const per = b.id === 'move' ? Math.hypot(poses[e].rootPos[0] - poses[s].rootPos[0], poses[e].rootPos[1] - poses[s].rootPos[1]) : d.yaw * DEG
  const n = Math.max(1, Math.round(Math.abs(value) / Math.abs(per)))
  return { spec, d, n, actual: n * per }
}

/** Loop count and the value the clip really covers (m or signed degrees); null for fixed blocks. */
export function blockActual(block: Block, poses: Pose[], value: number): { n: number; actual: number } | null {
  if (block.kind === 'fixed') return null
  const { n, actual } = loopPlan(block, poses, value)
  return { n, actual }
}

/** Source poses (at `fps`) -> 60fps GO2 clip starting at the origin. Loop blocks: head + loop × n + tail. */
export function buildBlockClip(block: Block, poses: Pose[], fps: number, value: number, defs: RobotDefs): Clip {
  let out: Pose[] = poses, name = block.label
  if (block.kind === 'loop') {
    const { spec, d, n, actual } = loopPlan(block, poses, value)
    const [s, e] = spec.loop
    out = poses.slice(spec.head[0], spec.head[1])
    for (let k = 0; k < n; k++) {
      const xk = powXf(d, k), prev = powXf(d, k - 1)
      poses.slice(s, e).forEach((p, i) => {
        const cur = applyXf(p, xk)
        out.push(k > 0 && i < SEAM ? blendPose(applyXf(poses[e + i], prev), cur, (i + 1) / (SEAM + 1)) : cur)
      })
    }
    const xl = powXf(d, n - 1) // the tail continues the last loop copy, as poses[e..] continue poses[s..e)
    for (const p of poses.slice(spec.tail[0], spec.tail[1])) out.push(applyXf(p, xl))
    name = block.id === 'move' ? `Move_${+actual.toFixed(1)}m` : `Rotate_${Math.round(actual)}deg`
  }
  const origin = out[0]
  return posesToClip(out.map(p => rebasePose(p, origin)), fps, 'go2', defs, name)
}
