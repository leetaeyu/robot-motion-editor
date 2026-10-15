import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

import { parseCsvPoses } from '../export/importCsv'
import type { Pose, RobotDefs } from '../model/pose'
import { yawQuat } from '../model/rootMath'
import type { Clip } from '../model/types'
import { loadDef } from '../test/defs'
import { GO2_BLOCKS, type Block } from './blocks'
import { blockActual, buildBlockClip } from './build'

const defs = { go2: loadDef('go2') } as RobotDefs
const pose = (x: number, yaw: number, f: number): Pose =>
  ({ rootPos: [x, 0, 0.3], rootQuat: yawQuat(yaw), q: Array.from({ length: 12 }, (_, j) => j === 0 ? Math.sin(2 * Math.PI * f / 10) : 0) })
// 50fps, walking 0.01m/frame, joint 0 period 10 frames
const walk = Array.from({ length: 60 }, (_, f) => pose(0.01 * f, 0, f))
const move: Block = { id: 'move', label: 'Move forward', kind: 'loop', param: 'meters', spec: { head: [0, 10], loop: [10, 30], tail: [30, 40] } }
// turning +0.02 rad/frame for 30 frames, then −0.02 rad/frame
const turn = Array.from({ length: 60 }, (_, f) => pose(0, f < 30 ? 0.02 * f : 0.02 * (60 - f), f))
const rotate: Block = { id: 'rotate', label: 'Rotate', kind: 'loop', param: 'degrees',
  left: { head: [0, 5], loop: [5, 25], tail: [25, 30] }, right: { head: [30, 35], loop: [35, 55], tail: [55, 60] } }
const last = (c: Clip, ch: string) => c.channels[ch].keys.at(-1)!.v
const first = (c: Clip, ch: string) => c.channels[ch].keys[0].v
const tEnd = (c: Clip) => c.length - 1 // 50fps source = project fps, so key f is source frame f

// what the clip really travels: planar distance (m) or yaw (degrees) from its first to its last key
const travel = (c: Clip, b: Block) => b.id === 'move' ? Math.hypot(last(c, 'root.x'), last(c, 'root.y')) : last(c, 'root.yaw') * 180 / Math.PI
const expectTravel = (b: Block, poses: Pose[], fps: number, value: number) => {
  const r = blockActual(b, poses, value)!, c = buildBlockClip(b, poses, fps, value, defs)
  expect(Math.abs(travel(c, b) - r.actual)).toBeLessThan(Math.max(0.02 * Math.abs(r.actual), 0.01))
  return r
}

test('move: actual counts head + N·loop + tail; 1.0m → 4 loops', () => {
  // head 0.10m + 4 × 0.20m + tail 0.09m
  expect(blockActual(move, walk, 1.0)).toEqual({ n: 4, actual: expect.closeTo(0.99, 5) })
  const clip = buildBlockClip(move, walk, 50, 1.0, defs)
  expect(clip.robot).toBe('go2')
  expect(clip.length).toBe(10 + 20 * 4 + 10)
  expectTravel(move, walk, 50, 1.0)
})

test('move root starts at origin and runs straight', () => {
  const clip = buildBlockClip(move, walk, 50, 1.0, defs)
  expect(first(clip, 'root.x')).toBeCloseTo(0)
  expect(last(clip, 'root.x')).toBeCloseTo(0.01 * tEnd(clip))
  expect(last(clip, 'root.y')).toBeCloseTo(0)
})

test('tiny value → n = 1', () => {
  expect(blockActual(move, walk, 0.1)!.n).toBe(1)
  expect(blockActual(rotate, turn, 5)!.n).toBe(1)
})

test('huge value → n capped at 100, builds fast', () => {
  expect(blockActual(move, walk, 1e6)!.n).toBe(100)
  const t0 = performance.now()
  buildBlockClip(move, walk, 50, 1e6, defs)
  expect(performance.now() - t0).toBeLessThan(2000)
})

test('rotate sign picks left/right spec; actual = clip yaw', () => {
  const r = expectTravel(rotate, turn, 50, 45), l = expectTravel(rotate, turn, 50, -45)
  expect(r).toEqual({ n: 2, actual: expect.closeTo(0.02 * 49 * 180 / Math.PI, 5) }) // head 5 + 2×20 + tail 4 frames
  expect(l).toEqual({ n: 2, actual: expect.closeTo(-0.02 * 49 * 180 / Math.PI, 5) })
  expect(first(buildBlockClip(rotate, turn, 50, 45, defs), 'root.yaw')).toBeCloseTo(0)
})

test('fixed block: length = resampled source, rebased to origin', () => {
  const fixed: Block = { id: 'stretch', label: 'Stretch', kind: 'fixed' }
  const src = walk.map(p => ({ ...p, rootPos: [p.rootPos[0] + 3, 2, 0.3] as Pose['rootPos'] }))
  expect(blockActual(fixed, src, 0)).toBeNull()
  const clip = buildBlockClip(fixed, src, 50, 0, defs)
  expect(clip.length).toBe(60)
  expect(first(clip, 'root.x')).toBeCloseTo(0)
  expect(first(clip, 'root.y')).toBeCloseTo(0)
})

test('name: Move_1m, Rotate_-56deg, Stretch', () => {
  expect(buildBlockClip(move, walk, 50, 1.0, defs).name).toBe('Move_1m')
  expect(buildBlockClip(rotate, turn, 50, -45, defs).name).toBe('Rotate_-56deg')
  expect(buildBlockClip({ id: 'stretch', label: 'Stretch', kind: 'fixed' }, walk, 50, 0, defs).name).toBe('Stretch')
})

test('loop seams stay continuous (blend): joint step at a seam ≤ largest in-loop step', () => {
  const clip = buildBlockClip(move, walk, 50, 1.0, defs)
  const q = clip.channels.FR_hip_joint.keys.map(k => k.v)
  const steps = q.slice(1).map((v, i) => Math.abs(v - q[i]))
  expect(Math.max(...steps)).toBeLessThan(0.6) // sin period 10 @50fps at 50fps: max step ≈ 0.62
})

test.each([['move', 1.8], ['move', 4], ['rotate', 90], ['rotate', -90], ['rotate', 400]] as const)('real %s.csv %s: shown actual = clip travel', (id, value) => {
  const b = GO2_BLOCKS.find(b => b.id === id)!
  const { poses, fps } = parseCsvPoses(readFileSync(new URL(`../../public/go2-blocks/${id}.csv`, import.meta.url), 'utf8'), defs, undefined)
  const r = expectTravel(b, poses, fps, value)
  expect(Math.sign(r.actual)).toBe(Math.sign(value))
})

// spec §1 success criteria 3/4: Move within ±5%, Rotate within ±5° of the shown actual
test.each([['move', 1.8], ['move', 4], ['rotate', 90], ['rotate', -90], ['rotate', 400]] as const)('real %s.csv %s: spec tolerance (move ±5%, rotate ±5°)', (id, value) => {
  const b = GO2_BLOCKS.find(b => b.id === id)!
  const { poses, fps } = parseCsvPoses(readFileSync(new URL(`../../public/go2-blocks/${id}.csv`, import.meta.url), 'utf8'), defs, undefined)
  const r = blockActual(b, poses, value)!, c = buildBlockClip(b, poses, fps, value, defs)
  const err = Math.abs(travel(c, b) - r.actual)
  expect(err).toBeLessThanOrEqual(id === 'move' ? 0.05 * Math.abs(r.actual) : 5)
})
