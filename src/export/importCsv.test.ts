import { loadDef } from '../test/defs'
import { existsSync } from 'node:fs'
import { expect, test } from 'vitest'

import { newProject } from '../model/defaults'
import { makeKey } from '../model/curve'
import { evaluateClip, type Pose, type RobotDefs } from '../model/evaluate'
import type { Clip } from '../model/types'
import { normalizedPose, posesToCsv, samplePoses } from './csv'
import { csvToClip, isHeadedCsv, parseCsvPoses } from './importCsv'

const load = loadDef
const defs: RobotDefs = { g1: load('g1'), go2: load('go2') }

const poseRows = (clip: Clip): Pose[] => {
  const out: Pose[] = []
  for (let f = 0; f < clip.length; f++) out.push(normalizedPose(evaluateClip(clip, defs[clip.robot], f), out[out.length - 1]))
  return out
}
const expectCsvClose = (a: string, b: string, tol: number) => {
  const ra = a.trimEnd().split('\n'), rb = b.trimEnd().split('\n')
  expect(rb).toHaveLength(ra.length)
  expect(rb[0]).toBe(ra[0])
  ra.slice(1).forEach((r, i) => r.split(',').forEach((v, j) => expect(Math.abs(Number(v) - Number(rb[i + 1].split(',')[j]))).toBeLessThan(tol)))
}
const row = (n: number, over: Record<number, number> = {}) =>
  Array.from({ length: n }, (_, i) => (i === 6 ? 1 : over[i] ?? 0)).join(',')

test('roundtrip: export → import → export at 60fps equals', () => {
  const proj = structuredClone(newProject())
  const [g1] = proj.actors
  const item = proj.sequence.tracks.find(t => t.actorId === g1.id)!.items[0]
  const clip = proj.clips[item.refId]
  clip.channels['root.x'] = { keys: [makeKey(0, 0, 'linear'), makeKey(119, 1, 'linear')] }
  clip.channels['root.yaw'] = { keys: [makeKey(0, 0.2, 'bezier'), makeKey(100, 3.5, 'bezier')] }
  clip.channels['root.pitch'] = { keys: [makeKey(0, 0.1, 'hold')] }
  clip.channels['left_elbow_joint'] = { keys: [makeKey(5, 0.3, 'linear'), makeKey(80, 1.1, 'linear')] }
  const csv1 = posesToCsv(samplePoses(proj, defs, g1.id, item.id, 'world'), defs.g1)
  const imp = csvToClip(csv1, defs, undefined, 'rt')
  expect(imp.robot).toBe('g1')
  expect(imp.length).toBe(120)
  expectCsvClose(csv1, posesToCsv(poseRows(imp), defs.g1), 1e-5)
})

test('30fps resampled to 60fps (2N-1 frames, midpoints interpolated)', () => {
  const clip = csvToClip([row(36, { 7: 0 }), row(36, { 7: 1 }), row(36, { 7: 0.5, 0: 2 })].join('\n') + '\n', defs, 30, 'x')
  expect(clip.length).toBe(5)
  const j = defs.g1.joints[0].name
  expect(clip.channels[j].keys.map(k => k.v)).toEqual([0, 0.5, 1, 0.75, 0.5])
  expect(clip.channels['root.x'].keys.map(k => k.v)).toEqual([0, 0, 0, 1, 2])
})

test('yaw beyond π stays continuous after import', () => {
  const rows = [3.0, 3.1, 3.2, 3.3].map(y => {
    const h = y / 2
    return [0, 0, 0, 0, 0, Math.sin(h), Math.cos(h), ...new Array(29).fill(0)].join(',')
  })
  const ks = csvToClip(rows.join('\n'), defs, 60, 'x').channels['root.yaw'].keys.map(k => k.v)
  ks.forEach((v, i) => { if (i) expect(v).toBeGreaterThan(ks[i - 1]) })
  expect(ks[3]).toBeCloseTo(3.3, 6)
})

test('bad column count and non-numeric rejected', () => {
  expect(() => csvToClip('1,2,3\n', defs, 60, 'x')).toThrow('열 수가')
  expect(() => csvToClip(row(36).replace('0', 'abc'), defs, 60, 'x')).toThrow('1행에 숫자가 아닌')
})

test('GO2 detected by 19 columns; blank lines ignored', () => {
  const clip = csvToClip(`\n${row(19)}\n\n${row(19)}\n`, defs, 60, 'g')
  expect(clip.robot).toBe('go2')
  expect(clip.length).toBe(2)
  expect(clip.name).toBe('g')
})

test('rejects hex/Infinity/overflow; column error names the row', () => {
  for (const v of ['0x10', 'Infinity', '1e999']) expect(() => csvToClip(row(36).replace('0', v), defs, 60, 'x')).toThrow('숫자가 아닌')
  expect(() => csvToClip(`${row(36)}

${row(19)}
`, defs, 60, 'x')).toThrow('19 (3행)')
})

// ---- headed (new) format ----
const neutral = (n: number, def = defs.g1): Pose[] =>
  Array.from({ length: n }, (_, i) => ({ rootPos: [i * 0.01, 0, 0.8], rootQuat: [0, 0, 0, 1], q: def.joints.map((_, j) => 0.001 * (i + j)) }))
const headed = (n: number, def = defs.g1) => posesToCsv(neutral(n, def), def)
const edit = (csv: string, fn: (rows: string[][]) => void) => {
  const rows = csv.trimEnd().split('\n').map(l => l.split(','))
  fn(rows)
  return rows.map(r => r.join(',')).join('\n') + '\n'
}

test('headed: g1/go2 detected from DOF, time ignored, fps from the file', () => {
  const g = csvToClip(headed(5), defs, 30, 'x') // caller fps ignored for headed files
  expect(g.robot).toBe('g1')
  expect(g.length).toBe(5)
  expect(g.channels['root.x'].keys.map(k => k.v)).toEqual([0, 0.01, 0.02, 0.03, 0.04])
  const o = csvToClip(headed(4, defs.go2), defs, undefined, 'x')
  expect(o.robot).toBe('go2')
  expect(o.channels.FL_hip_joint.keys).toHaveLength(4)
  const t = csvToClip(edit(headed(3), r => { r[2][3] = '99999' }), defs, 60, 'x') // time(ms) ignored
  expect(t.length).toBe(3)
})

test('headed: columns mapped by name, any order', () => {
  const csv = headed(3)
  const order = [0, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 40, ...Array.from({ length: 29 }, (_, i) => 39 - i)]
  const shuffled = csv.trimEnd().split('\n').map(l => { const c = l.split(','); return order.map(i => c[i]).join(',') }).join('\n')
  const a = csvToClip(csv, defs, 60, 'x'), b = csvToClip(shuffled, defs, 60, 'x')
  expect(Object.keys(b.channels).sort()).toEqual(Object.keys(a.channels).sort())
  for (const k of Object.keys(a.channels)) expect(b.channels[k].keys.map(v => v.v)).toEqual(a.channels[k].keys.map(v => v.v))
})

test('headed 30fps resampled to 60fps (2N-1 frames)', () => {
  const csv = edit(headed(3), r => r.slice(1).forEach(x => { x[0] = '30' }))
  const clip = csvToClip(csv, defs, 60, 'x')
  expect(clip.length).toBe(5)
  expect(clip.channels['root.x'].keys.map(k => k.v)).toEqual([0, 0.005, 0.01, 0.015, 0.02])
})

test('headed: errors are Korean and name the row', () => {
  expect(() => csvToClip(edit(headed(3), r => { r[3][0] = '30' }), defs, 60, 'x')).toThrow('fps 값이 행마다 다릅니다')
  expect(() => csvToClip(edit(headed(3), r => r.slice(1).forEach(x => { x[0] = '24' })), defs, 60, 'x')).toThrow('지원하지 않는 fps입니다: 24')
  expect(() => csvToClip(edit(headed(3), r => r.slice(1).forEach(x => { x[2] = '7' })), defs, 60, 'x')).toThrow('DOF Number')
  expect(() => csvToClip(edit(headed(3), r => { r[0][12] = 'bogus' }), defs, 60, 'x')).toThrow(`헤더에 관절 열이 없습니다: ${defs.g1.joints[1].name}`)
  expect(() => csvToClip(edit(headed(3), r => { r[2][5] = 'abc' }), defs, 60, 'x')).toThrow('3행에 숫자가 아닌')
  expect(() => csvToClip(edit(headed(3), r => { r[2].length = 20 }), defs, 60, 'x')).toThrow('3행')
  expect(() => csvToClip(headed(0), defs, 60, 'x')).toThrow('데이터가 없습니다')
})

test('headed: frequency(fps) column may be anywhere, not only first', () => {
  const rot = (l: string) => { const c = l.split(','); return [...c.slice(1, -1), c[0], ''].join(',') }
  const csv = headed(3).split('\n').map(rot).join('\n')
  const clip = csvToClip(csv, defs, 30, 'x')
  expect(clip.length).toBe(3)
  expect(clip.channels['root.x'].keys.map(k => k.v)).toEqual([0, 0.01, 0.02])
})

test('headed: robot from DOF even when RobotType disagrees (real-robot logs write 0 for GO2)', () => {
  const go2 = csvToClip(withFps(edit(headed(4, defs.go2), r => r.slice(1).forEach(x => { x[1] = '0' })), 50), defs, undefined, 'x')
  expect(go2.robot).toBe('go2')
  expect(csvToClip(edit(headed(3), r => r.slice(1).forEach(x => { x[1] = '1' })), defs, 60, 'x').robot).toBe('g1')
})

test('headed: duplicate header name and per-row RobotType/DOF mismatch rejected', () => {
  expect(() => csvToClip(edit(headed(3), r => { r[0][12] = r[0][11] }), defs, 60, 'x')).toThrow(`헤더에 같은 열 이름이 두 번 있습니다: ${defs.g1.joints[0].name}`)
  expect(() => csvToClip(edit(headed(3), r => { r[3][1] = '1' }), defs, 60, 'x')).toThrow('RobotType/DOF 값이 행마다 다릅니다 (4행)')
  expect(() => csvToClip(edit(headed(3), r => { r[3][2] = '12' }), defs, 60, 'x')).toThrow('RobotType/DOF 값이 행마다 다릅니다 (4행)')
})

test('headed: header detection is case-insensitive and CRLF safe', () => {
  const csv = headed(2).replace('frequency(fps)', ' Frequency(FPS) ').replace(/\n/g, '\r\n')
  expect(csvToClip(csv, defs, 60, 'x').length).toBe(2)
})

test('roundtrip headed: export → import → export is identical, 30fps path untouched by headed 60', () => {
  const csv1 = headed(30)
  const clip = csvToClip(csv1, defs, undefined, 'rt')
  expect(posesToCsv(poseRows(clip), defs.g1)).toBe(csv1)
  const csv2 = headed(12, defs.go2)
  expect(posesToCsv(poseRows(csvToClip(csv2, defs, undefined, 'rt')), defs.go2)).toBe(csv2)
})

const SAMPLE = new URL('../../assets/data/Track1_원본_합본.csv', import.meta.url)
test.skipIf(!existsSync(SAMPLE))('real sample: header and first 300 rows import as G1 60fps', async () => {
  const { openSync, readSync, closeSync } = await import('node:fs')
  const fd = openSync(SAMPLE, 'r'), buf = Buffer.alloc(300 * 800)
  const n = readSync(fd, buf, 0, buf.length, 0); closeSync(fd)
  const text = buf.subarray(0, n).toString('utf8').split('\n').slice(0, 301).join('\n') + '\n'
  const clip = csvToClip(text, defs, undefined, 'sample')
  expect(clip.robot).toBe('g1')
  expect(clip.length).toBe(300)
  expect(clip.channels.left_knee_joint.keys).toHaveLength(300)
})

test('isHeadedCsv: header detection for skipping the fps dialog', () => {
  expect(isHeadedCsv(headed(2))).toBe(true)
  expect(isHeadedCsv('\n a, Frequency(FPS) ,b\r\n1,2,3\n')).toBe(true)
  expect(isHeadedCsv('0,0,0,0,0,0,1\n')).toBe(false)
  expect(isHeadedCsv('')).toBe(false)
})

const withFps = (csv: string, fps: number) => edit(csv, r => r.slice(1).forEach(c => { c[0] = String(fps) }))

test('headed 50fps → resampled to 60fps', () => {
  const clip = csvToClip(withFps(headed(6, defs.go2), 50), defs, undefined, 'r50') // root.x = i * 0.01 per source row
  expect(clip.length).toBe(Math.floor(5 * 60 / 50) + 1)
  const x = clip.channels['root.x'].keys
  expect(x[0].v).toBeCloseTo(0)
  expect(x.at(-1)!.v).toBeCloseTo(0.05)
  expect(x[3].v).toBeCloseTo(3 * 50 / 60 * 0.01)
})

test('headed 25fps still rejected', () => {
  expect(() => csvToClip(withFps(headed(4, defs.go2), 25), defs, undefined, 'x')).toThrow('지원하지 않는 fps')
})

test('parseCsvPoses keeps source fps and frames', () => {
  const r = parseCsvPoses(withFps(headed(6, defs.go2), 50), defs, undefined)
  expect(r).toMatchObject({ robot: 'go2', fps: 50 })
  expect(r.poses).toHaveLength(6)
  expect(r.poses[2].rootPos[0]).toBeCloseTo(0.02)
})
