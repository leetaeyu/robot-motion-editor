import { makeKey } from '../model/curve'
import type { Pose, RobotDefs } from '../model/pose'
import { nearestAngle, quatToEuler, type Quat } from '../model/rootMath'
import { blendPose } from '../model/sequence'
import type { Clip } from '../model/types'
import type { RobotKind } from '../robot/types'
import { HEAD_FIXED } from './csv'
import { FPS } from '../model/fps'

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/ // decimal only: no hex, Infinity, blanks
const ROBOT_BY_COLS = { 36: 'g1', 19: 'go2' } as const
const ROBOT_BY_DOF: Record<number, RobotKind> = { 29: 'g1', 12: 'go2' }
const num = (s: string) => (NUM.test(s) ? Number(s) : NaN)
type Line = { cells: string[]; n: number } // n: 1-based source row number
type Parsed = { robot: RobotKind; rows: number[][]; fps: number }

// Headerless: x,y,z,qx,qy,qz,qw,q1..qN, robot from the column count, fps from the caller.
function parseHeadless(lines: Line[], srcFps: number): Parsed {
  const rows = lines.map(l => {
    const r = l.cells.map(num)
    if (!r.every(Number.isFinite)) throw new Error(`${l.n}행에 숫자가 아닌 값이 있습니다`)
    return r
  })
  const cols = rows[0].length
  const robot = (ROBOT_BY_COLS as Record<number, RobotKind>)[cols]
  if (!robot) throw new Error(`열 수가 36(G1) 또는 19(GO2)가 아닙니다: ${cols}`)
  const bad = rows.findIndex(r => r.length !== cols)
  if (bad >= 0) throw new Error(`열 수가 36(G1) 또는 19(GO2)가 아닙니다: ${rows[bad].length} (${lines[bad].n}행)`)
  return { robot, rows, fps: srcFps }
}

// Headed (frequency(fps),RobotType,DOF Number,time(ms),...): columns found by name; time(ms) ignored.
function parseHeaded(head: string[], lines: Line[], defs: RobotDefs): Parsed {
  const col = new Map<string, number>()
  head.forEach((h, i) => {
    if (!h) return
    if (col.has(h.toLowerCase())) throw new Error(`헤더에 같은 열 이름이 두 번 있습니다: ${h}`)
    col.set(h.toLowerCase(), i)
  })
  const idx = (name: string) => col.get(name.toLowerCase())
  const at = (name: string, row: string[], n: number) => {
    const v = num(row[idx(name)!] ?? '')
    if (!Number.isFinite(v)) throw new Error(`${n}행에 숫자가 아닌 값이 있습니다`)
    return v
  }
  for (const h of ['DOF Number', 'frequency(fps)', ...HEAD_FIXED.slice(4)]) if (idx(h) === undefined) throw new Error(`헤더에 '${h}' 열이 없습니다`)
  const dof = at('DOF Number', lines[0].cells, lines[0].n)
  const robot = ROBOT_BY_DOF[dof]
  if (!robot) throw new Error(`DOF Number가 29(G1) 또는 12(GO2)가 아닙니다: ${dof}`)
  // RobotType is not trusted: real-robot GO2 logs write 0 (G1). DOF + joint columns decide the robot.
  const type = idx('RobotType') === undefined ? undefined : at('RobotType', lines[0].cells, lines[0].n)
  const joints = defs[robot].joints.map(j => j.name)
  const missing = joints.filter(j => idx(j) === undefined)
  if (missing.length) throw new Error(`헤더에 관절 열이 없습니다: ${missing.join(', ')}`)
  const names = [...HEAD_FIXED.slice(4), ...joints]
  const need = Math.max(...names.map(n => idx(n)!), idx('frequency(fps)')!)
  const typeCol = idx('RobotType')
  let fps = NaN
  const rows = lines.map(l => {
    if (l.cells.length <= need) throw new Error(`열 수가 헤더와 다릅니다 (${l.n}행)`)
    const f = at('frequency(fps)', l.cells, l.n)
    if (Number.isNaN(fps)) fps = f
    else if (f !== fps) throw new Error(`fps 값이 행마다 다릅니다 (${l.n}행)`)
    if (at('DOF Number', l.cells, l.n) !== dof || (typeCol !== undefined && at('RobotType', l.cells, l.n) !== type)) throw new Error(`RobotType/DOF 값이 행마다 다릅니다 (${l.n}행)`)
    return names.map(n => at(n, l.cells, l.n))
  })
  if (fps !== 30 && fps !== 50 && fps !== 60) throw new Error(`지원하지 않는 fps입니다: ${fps}`)
  return { robot, rows, fps }
}

/** True when a header cell is `frequency(fps)` (trimmed, case-insensitive): the headed format that carries its own fps. */
export const isHeaded = (cells: string[]) => cells.some(c => c.trim().toLowerCase() === 'frequency(fps)')
const isMotionJson = (text: string) => text.trimStart().startsWith('{')
export const isHeadedCsv = (text: string) => {
  if (isMotionJson(text)) return true // carries its own 50fps
  const first = text.split(/\r?\n/).find(l => l.trim())
  return !!first && isHeaded(first.split(','))
}

// go2_motion_clip_v2 JSON (converted from a Unitree CSV): root_local x/y/z + base_quaternion_xyzw + q in `joint_order`.
function parseMotionJson(text: string, defs: RobotDefs): { robot: RobotKind; fps: number; poses: Pose[] } {
  let d: any
  try { d = JSON.parse(text) } catch { throw new Error('JSON을 읽을 수 없습니다') }
  if (d?.format !== 'go2_motion_clip_v2') throw new Error(`지원하지 않는 JSON 형식입니다: ${d?.format ?? '(없음)'}`)
  if (d.robot !== 'go2') throw new Error(`지원하지 않는 로봇입니다: ${d.robot}`)
  const { q, root_local: root, base_quaternion_xyzw: quat, joint_order: order } = d
  if (!Array.isArray(q) || !Array.isArray(root) || !Array.isArray(quat) || !Array.isArray(order) || !q.length || root.length !== q.length || quat.length !== q.length) throw new Error('프레임 데이터가 올바르지 않습니다')
  const fps = Number(d.nominal_rate)
  if (fps !== 30 && fps !== 50 && fps !== 60) throw new Error(`지원하지 않는 fps입니다: ${d.nominal_rate}`)
  const cols = defs.go2.joints.map(j => order.indexOf(j.name.replace(/_joint$/, '')))
  const bad = cols.indexOf(-1)
  if (bad >= 0) throw new Error(`joint_order에 관절이 없습니다: ${defs.go2.joints[bad].name}`)
  const finite = (a: unknown, n: number) => Array.isArray(a) && a.length >= n && a.slice(0, n).every(v => typeof v === 'number' && Number.isFinite(v))
  const poses = q.map((qf: number[], i: number): Pose => {
    if (!finite(qf, order.length) || !finite(root[i], 3) || !finite(quat[i], 4)) throw new Error(`${i + 1}번째 프레임에 숫자가 아닌 값이 있습니다`)
    return { rootPos: [root[i][0], root[i][1], root[i][2]], rootQuat: quat[i].slice(0, 4) as Quat, q: cols.map(c => qf[c]) }
  })
  return { robot: 'go2', fps, poses }
}

// Unitree RL motion CSV (or go2_motion_clip_v2 JSON) -> poses at the file's own fps.
// srcFps is only used for the headerless format; the headed one carries its own.
export function parseCsvPoses(text: string, defs: RobotDefs, srcFps: 30 | 50 | 60 | undefined): { robot: RobotKind; fps: number; poses: Pose[] } {
  if (isMotionJson(text)) return parseMotionJson(text, defs)
  const lines: Line[] = []
  text.split(/\r?\n/).forEach((line, i) => { if (line.trim()) lines.push({ cells: line.split(',').map(s => s.trim()), n: i + 1 }) })
  if (!lines.length) throw new Error('데이터가 없습니다')
  const headed = isHeaded(lines[0].cells)
  if (headed && lines.length < 2) throw new Error('데이터가 없습니다')
  const { robot, rows, fps } = headed ? parseHeaded(lines[0].cells, lines.slice(1), defs) : parseHeadless(lines, srcFps ?? FPS)
  return { robot, fps, poses: rows.map(r => ({ rootPos: [r[0], r[1], r[2]], rootQuat: r.slice(3, 7) as Quat, q: r.slice(7) })) }
}

// Poses at `fps` -> project-fps editable clip with a linear key on every channel/frame.
// project frame f samples source time f * fps / FPS: positions/joints lerped, root quaternion slerped.
export function posesToClip(poses: Pose[], fps: number, robot: RobotKind, defs: RobotDefs, name: string): Clip {
  const frames = fps === FPS ? poses : Array.from({ length: Math.floor((poses.length - 1) * FPS / fps) + 1 }, (_, f) => {
    const t = f * fps / FPS, i = Math.floor(t)
    return t === i ? poses[i] : blendPose(poses[i], poses[i + 1], t - i)
  })

  const names = ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw', ...defs[robot].joints.map(j => j.name)]
  const vals: number[][] = names.map(() => [])
  let prev: number[] | null = null
  for (const p of frames) {
    const e = quatToEuler(p.rootQuat)
    const u: number[] = prev ? e.map((v, i) => nearestAngle(v, prev![i])) : e
    prev = u
    ;[...p.rootPos, ...u, ...p.q].forEach((v, i) => vals[i].push(v))
  }
  const channels: Clip['channels'] = {}
  names.forEach((n, i) => { channels[n] = { keys: vals[i].map((v, f) => makeKey(f, v, 'linear')) } })
  return { id: crypto.randomUUID(), name, robot, length: frames.length, channels }
}

// Unitree RL motion CSV -> editable clip.
export function csvToClip(text: string, defs: RobotDefs, srcFps: 30 | 50 | 60 | undefined, name: string): Clip {
  const { robot, fps, poses } = parseCsvPoses(text, defs, srcFps)
  return posesToClip(poses, fps, robot, defs, name)
}
