import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

import { parseCsvPoses } from '../export/importCsv'
import type { RobotDefs } from '../model/pose'
import { quatYaw } from '../model/rootMath'
import { loadDef } from '../test/defs'
import { GO2_BLOCKS, type LoopSpec } from './blocks'

const defs = { go2: loadDef('go2') } as RobotDefs
const read = (id: string) => readFileSync(new URL(`../../public/go2-blocks/${id}.csv`, import.meta.url), 'utf8')
const posesOf = (id: string) => parseCsvPoses(read(id), defs, undefined).poses
const loopSpecs = (): [string, LoopSpec][] => GO2_BLOCKS.flatMap<[string, LoopSpec]>(b =>
  b.kind === 'fixed' ? [] : b.id === 'move' ? [[b.id, b.spec]] : [[b.id, b.left], [b.id, b.right]])

test('every block has a parsable 50fps GO2 csv', () => {
  expect(GO2_BLOCKS).toHaveLength(15)
  for (const b of GO2_BLOCKS) expect(parseCsvPoses(read(b.id), defs, undefined)).toMatchObject({ robot: 'go2', fps: 50 })
})

test('loop specs are contiguous, in range, tail >= 5', () => {
  for (const [id, s] of loopSpecs()) {
    expect(s.head[0]).toBeLessThan(s.head[1])
    expect(s.head[1]).toBe(s.loop[0])
    expect(s.loop[1]).toBe(s.tail[0])
    expect(s.tail[1] - s.tail[0]).toBeGreaterThanOrEqual(5)
    expect(s.tail[1]).toBeLessThanOrEqual(posesOf(id).length)
  }
})

test('per-loop motion: move 0.4~0.8m forward, rotate left > +40°, right < −40°', () => {
  const p = posesOf('move'), m = GO2_BLOCKS.find(b => b.id === 'move')!
  if (m.kind !== 'loop' || m.id !== 'move') throw new Error('move block')
  const [a, b] = [p[m.spec.loop[0]], p[m.spec.loop[1]]]
  const dx = b.rootPos[0] - a.rootPos[0], dy = b.rootPos[1] - a.rootPos[1], h = quatYaw(a.rootQuat)
  expect(Math.hypot(dx, dy)).toBeGreaterThan(0.4)
  expect(Math.hypot(dx, dy)).toBeLessThan(0.8)
  expect(dx * Math.cos(h) + dy * Math.sin(h)).toBeGreaterThan(0) // forward along the heading

  const r = posesOf('rotate'), rot = GO2_BLOCKS.find(b => b.id === 'rotate')!
  if (rot.kind !== 'loop' || rot.id !== 'rotate') throw new Error('rotate block')
  const dyaw = (s: LoopSpec) => {
    const d = quatYaw(r[s.loop[1]].rootQuat) - quatYaw(r[s.loop[0]].rootQuat)
    return Math.atan2(Math.sin(d), Math.cos(d)) * 180 / Math.PI
  }
  expect(dyaw(rot.left)).toBeGreaterThan(40)
  expect(dyaw(rot.right)).toBeLessThan(-40)
})
