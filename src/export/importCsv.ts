import { makeKey } from '../model/curve'
import type { Pose, RobotDefs } from '../model/pose'
import { nearestAngle, quatToEuler, type Quat } from '../model/rootMath'
import { blendPose } from '../model/sequence'
import type { Clip } from '../model/types'
import type { RobotKind } from '../robot/types'
import { HEAD_FIXED, ROBOT_TYPE } from './csv'

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
  const type = idx('RobotType') === undefined ? undefined : at('RobotType', lines[0].cells, lines[0].n)
  if (type !== undefined && type !== ROBOT_TYPE[robot]) throw new Error(`RobotType(${type})과 DOF Number(${dof})가 맞지 않습니다`)
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
export const isHeadedCsv = (text: string) => {
  const first = text.split(/\r?\n/).find(l => l.trim())
  return !!first && isHeaded(first.split(','))
}

// Unitree RL motion CSV -> poses at the file's own fps.
// srcFps is only used for the headerless format; the headed one carries its own.
export function parseCsvPoses(text: string, defs: RobotDefs, srcFps: 30 | 60 | undefined): { robot: RobotKind; fps: number; poses: Pose[] } {
  const lines: Line[] = []
  text.split(/\r?\n/).forEach((line, i) => { if (line.trim()) lines.push({ cells: line.split(',').map(s => s.trim()), n: i + 1 }) })
  if (!lines.length) throw new Error('데이터가 없습니다')
  const headed = isHeaded(lines[0].cells)
  if (headed && lines.length < 2) throw new Error('데이터가 없습니다')
  const { robot, rows, fps } = headed ? parseHeaded(lines[0].cells, lines.slice(1), defs) : parseHeadless(lines, srcFps ?? 60)
  return { robot, fps, poses: rows.map(r => ({ rootPos: [r[0], r[1], r[2]], rootQuat: r.slice(3, 7) as Quat, q: r.slice(7) })) }
}

// Poses at `fps` -> 60fps editable clip with a linear key on every channel/frame.
// 60fps frame f samples source time f * fps / 60: positions/joints lerped, root quaternion slerped.
export function posesToClip(poses: Pose[], fps: number, robot: RobotKind, defs: RobotDefs, name: string): Clip {
  const frames = fps === 60 ? poses : Array.from({ length: Math.floor((poses.length - 1) * 60 / fps) + 1 }, (_, f) => {
    const t = f * fps / 60, i = Math.floor(t)
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
export function csvToClip(text: string, defs: RobotDefs, srcFps: 30 | 60 | undefined, name: string): Clip {
  const { robot, fps, poses } = parseCsvPoses(text, defs, srcFps)
  return posesToClip(poses, fps, robot, defs, name)
}
