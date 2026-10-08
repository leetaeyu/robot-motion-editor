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
const tEnd = (c: Clip) => (c.length - 1) * 50 / 60 // source frame sampled by the clip's last 60fps key

test('move N from value: 1.0m → 5 loops, length', () => {
  expect(blockActual(move, walk, 1.0)).toEqual({ n: 5, actual: expect.closeTo(1.0, 5) })
  const clip = buildBlockClip(move, walk, 50, 1.0, defs)
  expect(clip.robot).toBe('go2')
  expect(clip.length).toBe(Math.floor((10 + 20 * 5 + 10 - 1) * 60 / 50) + 1)
})

test('move root advances head + N·loop + tail distance, starts at origin', () => {
  const clip = buildBlockClip(move, walk, 50, 1.0, defs)
  expect(first(clip, 'root.x')).toBeCloseTo(0)
  expect(last(clip, 'root.x')).toBeCloseTo(0.01 * tEnd(clip)) // head + 5 loops + tail, all at 0.01m/frame
  expect(last(clip, 'root.y')).toBeCloseTo(0)
})

test('tiny value → n = 1', () => {
  expect(blockActual(move, walk, 0.1)!.n).toBe(1)
  expect(blockActual(rotate, turn, 5)!.n).toBe(1)
})

test('rotate sign picks left/right spec; yaw delta sign matches', () => {
  const per = 0.02 * 20 * 180 / Math.PI
  expect(blockActual(rotate, turn, 45)).toEqual({ n: 2, actual: expect.closeTo(2 * per, 5) })
  expect(blockActual(rotate, turn, -45)).toEqual({ n: 2, actual: expect.closeTo(-2 * per, 5) })
  const l = buildBlockClip(rotate, turn, 50, 45, defs), r = buildBlockClip(rotate, turn, 50, -45, defs)
  expect(first(l, 'root.yaw')).toBeCloseTo(0)
  expect(last(l, 'root.yaw')).toBeCloseTo(0.02 * tEnd(l))
  expect(last(r, 'root.yaw')).toBeCloseTo(-0.02 * tEnd(r))
})

test('fixed block: length = resampled source, rebased to origin', () => {
  const fixed: Block = { id: 'stretch', label: 'Stretch', kind: 'fixed' }
  const src = walk.map(p => ({ ...p, rootPos: [p.rootPos[0] + 3, 2, 0.3] as Pose['rootPos'] }))
  expect(blockActual(fixed, src, 0)).toBeNull()
  const clip = buildBlockClip(fixed, src, 50, 0, defs)
  expect(clip.length).toBe(Math.floor(59 * 60 / 50) + 1)
  expect(first(clip, 'root.x')).toBeCloseTo(0)
  expect(first(clip, 'root.y')).toBeCloseTo(0)
})

test('name: Move_1m, Rotate_-46deg, Stretch', () => {
  expect(buildBlockClip(move, walk, 50, 1.0, defs).name).toBe('Move_1m')
  expect(buildBlockClip(rotate, turn, 50, -45, defs).name).toBe('Rotate_-46deg')
  expect(buildBlockClip({ id: 'stretch', label: 'Stretch', kind: 'fixed' }, walk, 50, 0, defs).name).toBe('Stretch')
})

test('loop seams stay continuous (blend): joint step at a seam ≤ largest in-loop step', () => {
  const clip = buildBlockClip(move, walk, 50, 1.0, defs)
  const q = clip.channels.FR_hip_joint.keys.map(k => k.v)
  const steps = q.slice(1).map((v, i) => Math.abs(v - q[i]))
  expect(Math.max(...steps)).toBeLessThan(0.6) // sin period 10 @50fps sampled at 60fps: max step ≈ 0.52
})

test('real move.csv: 1.8m → actual within ±5% of n·perLoop, clip covers head + n·loop + tail', () => {
  const m = GO2_BLOCKS.find(b => b.id === 'move')!
  if (m.kind !== 'loop' || m.id !== 'move') throw new Error('move block')
  const { poses, fps } = parseCsvPoses(readFileSync(new URL('../../public/go2-blocks/move.csv', import.meta.url), 'utf8'), defs, undefined)
  const r = blockActual(m, poses, 1.8)!
  expect(r.n).toBe(3)
  expect(Math.abs(r.actual - 1.8) / 1.8).toBeLessThan(0.05)
  const dist = (a: number, b: number) => Math.hypot(poses[b].rootPos[0] - poses[a].rootPos[0], poses[b].rootPos[1] - poses[a].rootPos[1])
  const { head, tail } = m.spec
  const expected = dist(head[0], head[1]) + r.actual + dist(tail[0], tail[1] - 1)
  const clip = buildBlockClip(m, poses, fps, 1.8, defs)
  expect(Math.abs(Math.hypot(last(clip, 'root.x'), last(clip, 'root.y')) - expected) / expected).toBeLessThan(0.05)
})
