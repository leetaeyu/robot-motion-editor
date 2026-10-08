import { loadDef } from '../test/defs'
import { beforeEach, expect, test } from 'vitest'

import type { RobotDefs } from '../model/evaluate'
import { createEditorStore, editLock, editTarget, gizmoLock } from './store'
import { makeKey } from '../model/curve'
import { emptyProject } from '../model/defaults'
import type { Clip } from '../model/types'

const load = loadDef
const defs: RobotDefs = { g1: load('g1'), go2: load('go2') }

let st: ReturnType<typeof createEditorStore>
let c: string, actor: string
const s = () => st.getState()
const curve = (ch: string) => s().project.clips[c].channels[ch] ?? { keys: [] }
const keyAt = (ch: string, f: number) => curve(ch).keys.find(k => k.f === f)!
const ch = 'left_knee_joint'

beforeEach(() => {
  st = createEditorStore(defs)
  actor = s().project.actors[0].id
  c = s().project.sequence.tracks.find(t => t.actorId === actor)!.items[0].refId
})

test('setKey clamps to joint limits', () => {
  s().setKey(c, ch, 0, 99)
  expect(keyAt(ch, 0).v).toBeCloseTo(defs.g1.joints.find(j => j.name === ch)!.upper)
})

test('setKey on existing frame replaces value only', () => {
  s().setKey(c, ch, 5, 1)
  s().setInterp(c, [{ channel: ch, f: 5 }], 'hold')
  s().setKey(c, ch, 5, 0.5)
  expect(curve(ch).keys).toHaveLength(1)
  expect(keyAt(ch, 5)).toMatchObject({ v: 0.5, interp: 'hold' })
})

test('setKey rounds/clamps f and keeps sorted', () => {
  s().setKey(c, ch, 50.4, 0); s().setKey(c, ch, -3, 0); s().setKey(c, ch, 999, 0)
  expect(curve(ch).keys.map(k => k.f)).toEqual([0, 50, 119])
})

test('moveKeys onto existing key replaces it', () => {
  s().setKey(c, ch, 0, 1); s().setKey(c, ch, 10, 2)
  s().moveKeys(c, [{ channel: ch, f: 0 }], 10)
  expect(curve(ch).keys.map(k => [k.f, k.v])).toEqual([[10, 1]])
})

test('deleteKeys', () => {
  s().setKey(c, ch, 0, 1); s().setKey(c, ch, 10, 2)
  s().deleteKeys(c, [{ channel: ch, f: 0 }])
  expect(curve(ch).keys.map(k => k.f)).toEqual([10])
})

test('setValue with autoKey off does not create key', () => {
  s().setValue(actor, ch, 1)
  expect(curve(ch).keys).toHaveLength(0)
  expect(s().autoKey).toBe(false)
})

test('setValue with autoKey keys at current clip frame', () => {
  s().toggleAutoKey(); s().setFrame(7); s().setValue(actor, ch, 1)
  expect(keyAt(ch, 7).v).toBe(1)
  expect(editTarget(s(), actor)).toEqual({ clipId: c, f: 7, itemId: item0().id })
  s().setFrame(500)
  expect(editTarget(s(), actor)).toEqual({ clipId: c, f: 119, itemId: item0().id })
})

test('undo/redo restores project', () => {
  s().setKey(c, ch, 5, 1); s().undo()
  expect(curve(ch).keys).toHaveLength(0)
  s().redo()
  expect(curve(ch).keys).toHaveLength(1)
})

test('new edit clears redo; undo stack capped at 200', () => {
  s().setKey(c, ch, 5, 1); s().undo(); s().setKey(c, ch, 6, 1); s().redo()
  expect(curve(ch).keys.map(k => k.f)).toEqual([6])
  for (let i = 0; i < 210; i++) s().setKey(c, ch, i % 100, i * 0.001)
  let n = 0
  while (s().project !== undefined && n < 300) { const before = s().project; s().undo(); if (s().project === before) break; n++ }
  expect(n).toBe(200)
})

test('linked tangent mirrors slope', () => {
  s().setKey(c, ch, 5, 0)
  s().setTangent(c, ch, 5, 'out', { df: 10, dv: 2 }, true)
  const k = keyAt(ch, 5)
  expect(k.inTan.dv / k.inTan.df).toBeCloseTo(0.2)
  s().setTangent(c, ch, 5, 'in', { df: -5, dv: 0 }, false)
  expect(keyAt(ch, 5).outTan).toEqual({ df: 10, dv: 2 })
})

test('setInterp ease resets tangents, linear keeps them', () => {
  s().setKey(c, ch, 5, 0)
  s().setTangent(c, ch, 5, 'out', { df: 10, dv: 2 }, false)
  s().setInterp(c, [{ channel: ch, f: 5 }], 'linear')
  expect(keyAt(ch, 5)).toMatchObject({ interp: 'linear', outTan: { df: 10, dv: 2 } })
  s().setInterp(c, [{ channel: ch, f: 5 }], 'bezier')
  expect(keyAt(ch, 5)).toMatchObject({ interp: 'bezier', outTan: { df: 10, dv: 0 }, inTan: { df: -10, dv: 0 } })
})

test('keyGroup keys every joint of group in one undo entry', () => {
  const arm = defs.g1.groups.find(g => g.name === '왼팔')!
  expect(arm.joints).toHaveLength(7)
  s().setFrame(3); s().keyGroup(actor, '왼팔')
  for (const j of arm.joints) expect(keyAt(j, 3)).toBeDefined()
  s().undo()
  expect(Object.keys(s().project.clips[c].channels)).toHaveLength(0)
})

test('keyGroup 루트 keys 6 root channels with standing height', () => {
  s().keyGroup(actor, '루트')
  expect(Object.keys(s().project.clips[c].channels).sort()).toEqual(
    ['root.pitch', 'root.roll', 'root.x', 'root.y', 'root.yaw', 'root.z'])
  expect(keyAt('root.z', 0).v).toBeCloseTo(defs.g1.standingHeight)
})

test('selectKeys additive unions without duplicates', () => {
  s().selectKeys([{ channel: ch, f: 1 }], false)
  s().selectKeys([{ channel: ch, f: 1 }, { channel: ch, f: 2 }], true)
  expect(s().sel.keys).toHaveLength(2)
  s().selectKeys([{ channel: ch, f: 9 }], false)
  expect(s().sel.keys).toEqual([{ channel: ch, f: 9 }])
})

test('setPlacement and addActor are undoable', () => {
  s().setPlacement(actor, { x: 3 })
  expect(s().project.actors[0].placement.x).toBe(3)
  s().addActor('go2'); expect(s().project.actors).toHaveLength(3)
  s().undo(); s().undo()
  expect(s().project.actors[0].placement.x).toBe(0)
})

test('moveKeys clamps shared delta so keys never merge', () => {
  s().setKey(c, ch, 118, 1); s().setKey(c, ch, 119, 2)
  const both = [{ channel: ch, f: 118 }, { channel: ch, f: 119 }]
  s().moveKeys(c, both, 5)
  expect(curve(ch).keys.map(k => [k.f, k.v])).toEqual([[118, 1], [119, 2]])
  s().moveKeys(c, both, -200)
  expect(curve(ch).keys.map(k => [k.f, k.v])).toEqual([[0, 1], [1, 2]])
})

test('deleteKeys prunes selection; undo/redo clear key selection', () => {
  s().setKey(c, ch, 1, 1); s().setKey(c, ch, 2, 1)
  s().selectKeys([{ channel: ch, f: 1 }, { channel: ch, f: 2 }], false)
  s().deleteKeys(c, [{ channel: ch, f: 1 }])
  expect(s().sel.keys).toEqual([{ channel: ch, f: 2 }])
  s().undo(); expect(s().sel.keys).toEqual([])
  s().selectKeys([{ channel: ch, f: 2 }], false); s().redo(); expect(s().sel.keys).toEqual([])
})

test('gesture: many setValue = one undo entry; edits after endGesture push again', () => {
  s().toggleAutoKey()
  const before = s().project
  s().beginGesture()
  for (let i = 1; i <= 5; i++) s().setValue(actor, ch, i * 0.1)
  s().endGesture()
  expect(keyAt(ch, 0).v).toBeCloseTo(0.5)
  s().undo()
  expect(s().project).toBe(before)
  s().redo()
  s().setKey(c, ch, 7, 1)
  s().undo()
  expect(keyAt(ch, 0).v).toBeCloseTo(0.5)
  expect(curve(ch).keys.find(k => k.f === 7)).toBeUndefined()
})

test('empty gesture leaves no undo entry', () => {
  s().setKey(c, ch, 3, 1)
  s().beginGesture(); s().endGesture()
  s().undo()
  expect(curve(ch).keys).toHaveLength(0)
})

test('setColor is undoable', () => {
  const old = s().project.actors[0].color
  s().setColor(actor, '#112233')
  expect(s().project.actors[0].color).toBe('#112233')
  s().undo()
  expect(s().project.actors[0].color).toBe(old)
})

test('moveKeys clamps one shared delta across channels (no shear)', () => {
  s().setKey(c, 'root.x', 10, 1); s().setKey(c, 'root.x', 20, 2); s().setKey(c, 'root.y', 20, 3)
  s().moveKeys(c, [{ channel: 'root.x', f: 10 }, { channel: 'root.x', f: 20 }, { channel: 'root.y', f: 20 }], -15)
  expect(curve('root.x').keys.map(k => k.f)).toEqual([0, 10])
  expect(curve('root.y').keys.map(k => k.f)).toEqual([10])
})

const itemOfClip = () => s().project.sequence.tracks.flatMap(t => t.items).filter(i => i.refId === c)

test('setClip: rename; blank name ignored', () => {
  s().setClip(c, { name: '  walk  ' })
  expect(s().project.clips[c].name).toBe('walk')
  s().setClip(c, { name: '   ' })
  expect(s().project.clips[c].name).toBe('walk')
})

test('setClip: shrink deletes keys past the end, trims items, prunes sel; one undo restores', () => {
  s().setKey(c, ch, 10, 0.5); s().setKey(c, ch, 59, 0.6); s().setKey(c, ch, 60, 0.7); s().setKey(c, 'root.x', 100, 1)
  s().selectKeys([{ channel: ch, f: 60 }, { channel: ch, f: 10 }], false)
  const before = s().project
  s().setClip(c, { length: 60 })
  expect(s().project.clips[c].length).toBe(60)
  expect(curve(ch).keys.map(k => k.f)).toEqual([10, 59])
  expect(curve('root.x').keys).toHaveLength(0)
  expect(itemOfClip().every(i => i.trimOut === 60)).toBe(true)
  expect(s().sel.keys).toEqual([{ channel: ch, f: 10 }])
  s().undo()
  expect(s().project).toBe(before)
})

test('setClip: grow sets trimOut; length is a positive integer', () => {
  s().setClip(c, { length: 600 })
  expect(itemOfClip()[0].trimOut).toBe(600)
  s().setClip(c, { length: 0 }); s().setClip(c, { length: NaN })
  expect(s().project.clips[c].length).toBe(600)
  s().setClip(c, { length: 10.6 })
  expect(s().project.clips[c].length).toBe(11)
})

test('edit shares untouched clips by reference', () => {
  s().addActor('go2')
  const before = s().project
  const ids = Object.keys(before.clips)
  const other = ids.find(i => i !== c)!
  s().setKey(c, ch, 0, 0.5)
  expect(s().project.clips[other]).toBe(before.clips[other])
  expect(s().project.clips[c]).not.toBe(before.clips[c])
  expect(before.clips[c].channels[ch]).toBeUndefined()
})

// --- sequence editing ---
const trackItems = (a: string) => s().project.sequence.tracks.find(t => t.actorId === a)!.items
const item0 = () => trackItems(actor)[0]

test('newClip names clip_NN per robot, one undo entry, not placed', () => {
  const before = s().project
  const id = s().newClip('g1')
  expect(s().project.clips[id]).toMatchObject({ name: 'clip_02', robot: 'g1', length: 120 })
  expect(trackItems(actor)).toHaveLength(1)
  s().undo()
  expect(s().project).toBe(before)
})

test('addItem rejects robot mismatch', () => {
  const go2Clip = s().newClip('go2')
  const before = s().project
  expect(s().addItem(actor, go2Clip, 200)).toBe(false)
  expect(s().project).toBe(before)
})

test('addItem + overlap rules', () => {
  const k = s().newClip('g1')
  expect(s().addItem(actor, k, 100)).toBe(true)
  expect(s().addItem(actor, k, 110)).toBe(false)
  expect(s().addItem(actor, k, 0)).toBe(false)
  expect(s().addItem(actor, k, -5)).toBe(false)
})

test('trimItem in/out bounds', () => {
  const id = item0().id
  expect(s().trimItem(id, 'in', -1)).toBe(false)
  expect(s().trimItem(id, 'out', 1)).toBe(false)
  expect(s().trimItem(id, 'in', 119)).toBe(true)
  expect(trackItems(actor)[0]).toMatchObject({ start: 119, trimIn: 119, trimOut: 120 })
  expect(s().trimItem(id, 'in', 1)).toBe(false)
  expect(s().trimItem(id, 'out', -1)).toBe(false)
})

test('trimItem out shortens', () => {
  expect(s().trimItem(item0().id, 'out', -20)).toBe(true)
  expect(item0().trimOut).toBe(100)
})

test('splitItem makes two items sharing the clip', () => {
  const id = item0().id
  expect(s().splitItem(id, 50)).toBe(true)
  const its = trackItems(actor)
  expect(its.map(i => [i.start, i.trimIn, i.trimOut])).toEqual([[0, 0, 50], [50, 50, 120]])
  expect(its[0].refId).toBe(its[1].refId)
  expect(its[0].id).toBe(id)
  expect(its[1].id).not.toBe(id)
  expect(s().splitItem(id, 0)).toBe(false)
  expect(s().splitItem(id, 50)).toBe(false)
})

test('deleteClip refuses clip in use, allows unused', () => {
  expect(s().deleteClip(item0().refId)).toBe(false)
  const k = s().newClip('g1')
  expect(s().deleteClip(k)).toBe(true)
  expect(s().project.clips[k]).toBeUndefined()
})

test('each sequence edit is one undo entry; reject leaves stacks', () => {
  s().moveItem(item0().id, 30)
  expect(item0().start).toBe(30)
  s().undo()
  expect(item0().start).toBe(0)
  s().redo()
  const p = s().project
  expect(s().moveItem(item0().id, -1)).toBe(false)
  expect(s().project).toBe(p)
  s().redo() // redo stack untouched by rejection: nothing to redo, project same
  expect(s().project).toBe(p)
})

test('deleting the last item of a motion track removes its actor and track (one undo)', () => {
  const id = item0().id, before = s().project
  s().select(actor); s().selectItem(id)
  expect(s().deleteItem(id)).toBe(true)
  expect(s().selItem).toBeNull()
  expect(s().sel.actorId).toBeNull()
  expect(s().project.actors.some(a => a.id === actor)).toBe(false)
  expect(s().project.sequence.tracks.some(t => t.actorId === actor)).toBe(false)
  expect(s().project.clips[c]).toBeDefined() // the clip stays in the asset list
  s().undo()
  expect(s().project).toBe(before)
})

test('deleting one of several items keeps the actor', () => {
  const k = s().newClip('g1')
  s().addItem(actor, k, 200)
  s().deleteItem(item0().id)
  expect(s().project.actors.some(a => a.id === actor)).toBe(true)
  expect(trackItems(actor)).toHaveLength(1)
})

test('editTarget in clip view ignores trims', () => {
  const id = item0().id
  s().trimItem(id, 'in', 30)
  s().openItem(id); s().setFrame(0)
  expect(editTarget(s(), actor)).toEqual({ clipId: c, f: 0, itemId: id })
  s().toggleAutoKey(); s().setValue(actor, ch, 0.4)
  expect(keyAt(ch, 0).v).toBeCloseTo(0.4)
  expect(s().sel.actorId).toBe(actor)
})

test('editTarget sequence view: later item on overlap', () => {
  const k = s().newClip('g1')
  s().addItem(actor, k, 100) // A 0..120, B 100..220: overlap 100..119
  const [a, b] = trackItems(actor)
  s().setFrame(110)
  expect(editTarget(s(), actor)).toEqual({ clipId: k, f: 10, itemId: b.id })
  s().setFrame(50)
  expect(editTarget(s(), actor)).toEqual({ clipId: c, f: 50, itemId: a.id })
})

test('editTarget null without items; setValue ignored', () => {
  s().deleteItem(item0().id)
  expect(editTarget(s(), actor)).toBeNull()
  s().toggleAutoKey(); s().setValue(actor, ch, 1); s().keyGroup(actor, '루트')
  expect(curve(ch).keys).toHaveLength(0)
})

test('editing clears when item deleted or undone', () => {
  const id = item0().id
  s().openItem(id); s().deleteItem(id)
  expect(s().editing).toBeNull()
  s().undo(); s().openItem(id)
  expect(s().editing).toBe(id)
  s().closeItem(); expect(s().editing).toBeNull()
  s().splitItem(id, 50); const r = trackItems(actor)[1].id
  s().openItem(r); s().undo()
  expect(s().editing).toBeNull()
  s().redo()
  expect(s().editing).toBeNull()
})

test('in/out ordering', () => {
  s().setIn(100); s().setOut(50)
  expect([s().project.sequence.inF, s().project.sequence.outF]).toEqual([null, 50])
  s().setIn(10); s().setIn(60)
  expect([s().project.sequence.inF, s().project.sequence.outF]).toEqual([60, null])
  s().setOut(200); s().setIn(300)
  expect([s().project.sequence.inF, s().project.sequence.outF]).toEqual([300, null])
  s().setIn(null); expect(s().project.sequence.inF).toBeNull()
})

test('markers add/rename/delete undoable, sorted, numbered', () => {
  s().addMarker(50); s().addMarker(10)
  const m = () => s().project.sequence.markers
  expect(m()).toEqual([{ f: 10, name: '마커 2' }, { f: 50, name: '마커 1' }])
  s().renameMarker(0, '점프'); s().deleteMarker(1); s().addMarker(5)
  expect(m()).toEqual([{ f: 5, name: '마커 1' }, { f: 10, name: '점프' }])
  s().undo(); s().undo(); s().undo()
  expect(m()).toEqual([{ f: 10, name: '마커 2' }, { f: 50, name: '마커 1' }])
})

test('closeItem clamps a negative clip-view frame to 0', () => {
  const id = s().project.sequence.tracks.find(t => t.actorId === actor)!.items[0].id
  s().openItem(id); s().setFrame(-20)
  s().closeItem()
  expect(s().editing).toBeNull(); expect(s().frame).toBe(0)
})

test('projectGeneration bumps on loadProject and newProjectFile only', async () => {
  const { newProject } = await import('../model/defaults')
  const { projectGeneration } = await import('./store')
  const g = projectGeneration()
  s().setFrame(3); expect(projectGeneration()).toBe(g)
  s().loadProject(newProject(), null); expect(projectGeneration()).toBe(g + 1)
  s().newProjectFile(); expect(projectGeneration()).toBe(g + 2)
})

test('loadProject resets history, view state and dirty; edits and undo set dirty', async () => {
  const { newProject } = await import('../model/defaults')
  expect(s().dirty).toBe(false)
  s().setKey(c, ch, 0, 1); expect(s().dirty).toBe(true)
  s().setFrame(7); s().selectItem('x'); s().setPlaying(true)
  const p2 = newProject()
  s().loadProject(p2, 'a.motion.json'); s().undo()
  expect(s().project).toBe(p2); expect(s().dirty).toBe(false)
  expect(s().fileName).toBe('a.motion.json')
  expect(s().frame).toBe(0); expect(s().selItem).toBe(null); expect(s().playing).toBe(false)
  s().addMarker(3); expect(s().dirty).toBe(true)
  s().markSaved('b.motion.json'); expect(s().dirty).toBe(false); expect(s().fileName).toBe('b.motion.json')
  s().undo(); expect(s().dirty).toBe(true)
  s().markSaved('b.motion.json'); s().setFrame(5); expect(s().dirty).toBe(false)
  s().newProjectFile(); expect(s().fileName).toBe(null); expect(s().project.actors).toHaveLength(0)
})

test('setClip: growing a clip into its neighbour is rejected without an edit', () => {
  const track = s().project.sequence.tracks.find(t => t.actorId === actor)!
  expect(s().addItem(actor, c, 100) && s().addItem(actor, c, 200)).toBe(true) // growing would make item 0 overlap item 2
  const before = s().project
  expect(s().setClip(c, { length: 300 })).toBe(false)
  expect(s().project).toBe(before)
  expect(track.items.length).toBe(1) // original snapshot untouched
  expect(s().setClip(c, { name: 'ok' })).toBe(true)
})

// --- copy-on-write edits (C1) ---
test('committed clips, curves and keys are frozen; declared channels are fresh copies', () => {
  s().setKey(c, ch, 0, 0.5); s().setKey(c, 'root.x', 0, 1)
  const before = s().project
  expect(() => { s().project.clips[c].channels[ch].keys[0].v = 9 }).toThrow(TypeError)
  expect(() => { s().project.clips[c].channels['root.x'].keys.push(makeKey(5, 1)) }).toThrow(TypeError)
  expect(() => { s().project.clips[c].channels[ch].keys[0].inTan.dv = 1 }).toThrow(TypeError)
  s().setKey(c, ch, 0, 0.7) // declared channel: new curve, others shared
  expect(curve(ch)).not.toBe(before.clips[c].channels[ch])
  expect(curve('root.x')).toBe(before.clips[c].channels['root.x'])
  expect(before.clips[c].channels[ch].keys[0].v).toBe(0.5)
})

test('perf: setKey on a 5000x36 clip copies only the touched channel', () => {
  const names = Array.from({ length: 36 }, (_, i) => i < 6 ? ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw'][i] : `ch${i}`)
  const id = 'big'
  s().importClipToActor({ id, name: 'big', robot: 'g1', length: 5000, channels: Object.fromEntries(names.map(n => [n, { keys: Array.from({ length: 5000 }, (_, f) => makeKey(f, Math.sin(f), 'linear')) }])) })
  s().setKey(id, 'root.x', 0, 0) // warm-up
  let ms = 0
  for (let i = 0; i < 10; i++) {
    const prev = s().project.clips[id]
    const t0 = performance.now()
    s().setKey(id, 'root.x', 100 + i, 1)
    ms += performance.now() - t0
    const next = s().project.clips[id]
    expect(next.channels['root.x']).not.toBe(prev.channels['root.x'])
    expect(names.filter(n => next.channels[n] === prev.channels[n])).toHaveLength(35)
  }
  expect(ms / 10).toBeLessThan(30)
})

// --- setClip keeps trims (I1) ---
const items = () => [...trackItems(actor)].sort((a, b) => a.start - b.start).map(i => [i.trimIn, i.trimOut])

test('setClip: split items keep their cut; the item at the end follows the new length', () => {
  expect(s().splitItem(item0().id, 50)).toBe(true)
  expect(s().setClip(c, { length: 200 })).toBe(true)
  expect(items()).toEqual([[0, 50], [50, 200]])
})

test('setClip: a trimmed item keeps its trim when the clip grows', () => {
  expect(s().trimItem(item0().id, 'out', -30)).toBe(true)
  expect(s().setClip(c, { length: 130 })).toBe(true)
  expect(items()).toEqual([[0, 90]])
})

test('setClip: shrinking below a trim clamps the item', () => {
  expect(s().trimItem(item0().id, 'in', 40)).toBe(true) // [40,120]
  expect(s().trimItem(item0().id, 'out', -30)).toBe(true) // [40,90]
  expect(s().setClip(c, { length: 30 })).toBe(true)
  expect(items()).toEqual([[29, 30]])
})

// --- gestures (M5) ---
test('undo during a gesture ends it first; endGesture then pops nothing', () => {
  s().toggleAutoKey()
  s().setKey(c, ch, 3, 1)
  const afterKey = s().project
  s().beginGesture(); s().setValue(actor, ch, 0.4)
  s().undo() // ends the gesture, then undoes it
  expect(s().project).toBe(afterKey)
  s().endGesture()
  s().undo()
  expect(curve(ch).keys).toHaveLength(0)
})

test('beginGesture keeps redo until the gesture changes the project', () => {
  s().setKey(c, ch, 3, 1); s().undo()
  s().beginGesture(); s().endGesture()
  s().redo()
  expect(keyAt(ch, 3).v).toBe(1)
  s().undo()
  s().toggleAutoKey()
  s().beginGesture(); s().setValue(actor, ch, 0.2); s().endGesture()
  const p = s().project
  s().redo()
  expect(s().project).toBe(p) // redo was cleared by the change
})

// --- gizmo locks (M4, T6) ---
test('gizmoLock: crossfade locks root and joints in sequence view, not in clip view', () => {
  expect(s().addItem(actor, c, 100)).toBe(true) // overlap 100..119
  s().select(actor, ch); s().setFrame(110)
  expect(gizmoLock(s())).toBe('crossfade')
  s().select(actor, 'root.x')
  expect(gizmoLock(s())).toBe('crossfade')
  s().setFrame(130)
  expect(gizmoLock(s())).toBe(null)
  s().setFrame(110); s().openItem(trackItems(actor)[1].id)
  expect(gizmoLock(s())).toBe(null)
})

test('gizmoLock: root on the first frame of a stitched item', () => {
  expect(s().addItem(actor, c, 120)).toBe(true)
  s().select(actor, 'root.x'); s().setFrame(120)
  expect(gizmoLock(s())).toBe('stitch')
  s().setFrame(121); expect(gizmoLock(s())).toBe(null)
  s().setFrame(0); expect(gizmoLock(s())).toBe(null) // first item is not stitched
  s().setFrame(120); s().select(actor, ch); expect(gizmoLock(s())).toBe(null)
  s().select(actor, 'root.yaw'); s().openItem(trackItems(actor)[1].id); s().select(actor, 'root.yaw')
  expect(gizmoLock(s())).toBe('stitch') // clip view frame 120 = clip frame 0 = trimIn
})

test('setValue/keyGroup rejected in crossfade (sequence view), allowed in clip view', () => {
  expect(s().addItem(actor, c, 100)).toBe(true)
  s().toggleAutoKey(); s().setFrame(110)
  expect(editLock(s(), actor, ch)).toBe('crossfade')
  const before = s().project
  s().setValue(actor, ch, 0.5); s().keyGroup(actor, '왼팔'); s().keyGroup(actor, '루트')
  expect(s().project).toBe(before)
  s().openItem(trackItems(actor)[1].id)
  s().setValue(actor, ch, 0.5)
  expect(s().project).not.toBe(before)
})

test('setValue/keyGroup on stitch frame: root x/y/yaw rejected, z allowed', () => {
  expect(s().addItem(actor, c, 120)).toBe(true)
  s().toggleAutoKey(); s().setFrame(120)
  expect(editLock(s(), actor, 'root.z')).toBe(null)
  const before = s().project
  s().setValue(actor, 'root.x', 0.3); s().keyGroup(actor, '루트')
  expect(s().project).toBe(before)
  s().setValue(actor, 'root.z', 0.7)
  expect(s().project).not.toBe(before)
})

test('addMedia creates single V1 on top; deleteMedia refuses used media', () => {
  const before = s().project.sequence.tracks.length
  const m = s().addMedia('a.mp4', 600)
  const m2 = s().addMedia('a.mp4', 300)
  const tr = s().project.sequence.tracks
  expect(tr.length).toBe(before + 1)
  expect(tr[0].kind).toBe('video')
  expect(s().project.media.map(x => x.name)).toEqual(['a.mp4', 'a.mp4_2'])
  expect(() => s().addMedia('b', 0)).toThrow()
  expect(s().addVideoItem(m, 0)).toBe(true)
  expect(s().deleteMedia(m)).toBe(false)
  expect(s().deleteMedia(m2)).toBe(true)
  s().undo()
  expect(s().project.media.length).toBe(2)
  expect(s().dirty).toBe(true)
})

test('video items: trim bounded by durationF, split works, overlap / motion add rejected', () => {
  const m = s().addMedia('a.mp4', 600)
  expect(s().addVideoItem(m, 0)).toBe(true)
  const v = s().project.sequence.tracks[0]
  const id = v.items[0].id
  expect(s().addVideoItem(m, 100)).toBe(false) // overlap
  expect(s().trimItem(id, 'out', 1)).toBe(false) // beyond durationF
  expect(s().trimItem(id, 'out', -100)).toBe(true)
  expect(s().splitItem(id, 200)).toBe(true)
  expect(s().project.sequence.tracks[0].items.map(i => [i.start, i.trimIn, i.trimOut])).toEqual([[0, 0, 200], [200, 200, 500]])
  expect(s().moveItem(id, 150)).toBe(false)
  expect(s().addItem(v.id, c, 1000)).toBe(false) // motion clip cannot target the video track
  expect(s().project.sequence.tracks[0].items.length).toBe(2)
  s().openItem(id)
  expect(s().editing).toBeNull() // video items have no clip view
  expect(s().deleteItem(id)).toBe(true)
})

test('simplifyClip: reduces dense keys across channels, returns count, one undo; no edit when 0', () => {
  for (let f = 0; f < 100; f++) { s().setKey(c, ch, f, 0.001 * f); s().setKey(c, 'root.x', f, 0.5) }
  const n = s().simplifyClip(c)
  expect(n).toBe(98 * 2)
  expect(curve(ch).keys.map(k => k.f)).toEqual([0, 99])
  expect(s().simplifyClip(c)).toBe(0)
  s().undo()
  expect(curve(ch).keys).toHaveLength(100)
  expect(curve('root.x').keys).toHaveLength(100)
})

test('simplifyClip: sparse bezier clip returns 0 and makes no edit', () => {
  for (const f of [0, 30, 90, 119]) s().setKey(c, ch, f, f / 100)
  const p = s().project
  expect(s().simplifyClip(c)).toBe(0)
  expect(s().project).toBe(p)
})

test('simplifyClip: mixed clip changes only the dense channel', () => {
  for (const f of [0, 30, 90, 119]) s().setKey(c, ch, f, f / 100)
  for (let f = 0; f < 100; f++) s().setKey(c, 'root.x', f, 0.001 * f)
  const sparse = curve(ch)
  expect(s().simplifyClip(c)).toBe(98)
  expect(curve(ch)).toBe(sparse)
  expect(curve('root.x').keys).toHaveLength(2)
})

// --- importClipToActor / empty project ---
const impClip = (robot: 'g1' | 'go2', name: string, length = 10): Clip => ({ id: crypto.randomUUID(), name, robot, length, channels: {} })

test('emptyProject has no actors, clips or tracks', () => {
  const p = emptyProject()
  expect([p.actors.length, Object.keys(p.clips).length, p.sequence.tracks.length]).toEqual([0, 0, 0])
})

test('importClipToActor: creates the actor (no default clip) and places the clip at 0', () => {
  const e = createEditorStore(defs, emptyProject())
  const clip = impClip('g1', 'walk', 50)
  const r = e.getState().importClipToActor(clip)!
  const p = e.getState().project
  expect(p.actors).toHaveLength(1)
  expect(p.actors[0]).toMatchObject({ id: r.actorId, robot: 'g1' })
  expect(Object.keys(p.clips)).toEqual([clip.id])
  expect(p.sequence.tracks).toHaveLength(1)
  expect(p.sequence.tracks[0].items).toEqual([{ id: r.itemId, refId: clip.id, start: 0, trimIn: 0, trimOut: 50 }])
})

test('importClipToActor: an existing actor of that robot gets the clip as an asset only', () => {
  const e = createEditorStore(defs, emptyProject())
  const a = e.getState().importClipToActor(impClip('g1', 'a', 50))!
  expect(e.getState().importClipToActor(impClip('g1', 'b', 30))).toBeNull() // nothing placed
  const o = e.getState().importClipToActor(impClip('go2', 'o', 20))!
  expect(o.actorId).not.toBe(a.actorId)
  const p = e.getState().project
  expect(p.actors.map(x => x.robot)).toEqual(['g1', 'go2'])
  expect(Object.values(p.clips).map(c => c.name)).toEqual(['a', 'b', 'o'])
  expect(p.sequence.tracks.find(t => t.actorId === a.actorId)!.items).toHaveLength(1)
  expect(p.sequence.tracks.find(t => t.actorId === o.actorId)!.items).toHaveLength(1)
})

test('importClipToActor: a gesture batch is one undo entry; first file per robot is placed, the rest are assets', () => {
  const e = createEditorStore(defs, emptyProject())
  e.getState().beginGesture()
  e.getState().importClipToActor(impClip('g1', 'a'))
  e.getState().importClipToActor(impClip('g1', 'b'))
  e.getState().importClipToActor(impClip('go2', 'c'))
  e.getState().endGesture()
  const p = e.getState().project
  expect(p.actors).toHaveLength(2)
  expect(p.sequence.tracks.map(t => t.items.length)).toEqual([1, 1])
  expect(Object.keys(p.clips)).toHaveLength(3)
  e.getState().undo()
  expect(e.getState().project.actors).toHaveLength(0)
  expect(Object.keys(e.getState().project.clips)).toHaveLength(0)
  e.getState().undo() // nothing further
  expect(e.getState().project.actors).toHaveLength(0)
})

test('importClipToActor: a later batch adds a clip only', () => {
  const e = createEditorStore(defs, emptyProject())
  e.getState().importClipToActor(impClip('g1', 'a'))
  e.getState().importClipToActor(impClip('g1', 'b'))
  const p = e.getState().project
  expect([p.actors.length, p.sequence.tracks[0].items.length, Object.keys(p.clips).length]).toEqual([1, 1, 2])
})

test('newProjectFile starts empty; omitted initial project keeps the demo actors', () => {
  expect(createEditorStore(defs).getState().project.actors).toHaveLength(2)
  const e = createEditorStore(defs)
  e.getState().newProjectFile()
  expect(e.getState().project.actors).toHaveLength(0)
  expect(e.getState().project.sequence.tracks).toHaveLength(0)
})

// --- openComparePane / comparePanes (clip ids, preview only) ---
const withClips = () => {
  const e = createEditorStore(defs, emptyProject())
  e.getState().beginGesture()
  for (const n of ['a', 'b', 'c']) e.getState().importClipToActor(impClip('g1', n))
  e.getState().endGesture()
  return { e, ids: Object.keys(e.getState().project.clips) }
}

test('openComparePane: preview only, project untouched, no undo entry', () => {
  const { e, ids } = withClips()
  const before = e.getState().project
  e.getState().markSaved('x.json')
  e.getState().openComparePane(ids[1])
  expect(e.getState().project).toBe(before)
  expect(e.getState().dirty).toBe(false)
  expect(e.getState().comparePanes).toEqual([ids[1]])
  e.getState().undo() // would pop the import entry if one was pushed; here the import itself is undone
  expect(e.getState().project.actors).toHaveLength(0)
})

test('comparePanes: max two, oldest replaced, re-open is a no-op, unknown clip ignored', () => {
  const { e, ids } = withClips()
  e.getState().openComparePane(ids[0]); e.getState().openComparePane(ids[1])
  const list = e.getState().comparePanes
  e.getState().openComparePane(ids[0])
  expect(e.getState().comparePanes).toBe(list)
  e.getState().openComparePane(ids[2])
  expect(e.getState().comparePanes).toEqual([ids[1], ids[2]])
  e.getState().openComparePane('nope')
  expect(e.getState().comparePanes).toEqual([ids[1], ids[2]])
  e.getState().closeComparePane(ids[1])
  expect(e.getState().comparePanes).toEqual([ids[2]])
})

test('comparePanes: pruned when the clip is deleted or the import is undone; cleared on load', () => {
  const { e, ids } = withClips()
  e.getState().openComparePane(ids[1])
  expect(e.getState().deleteClip(ids[1])).toBe(true)
  expect(e.getState().comparePanes).toEqual([])
  e.getState().undo()
  e.getState().openComparePane(ids[1])
  e.getState().undo() // the import is undone: clips gone
  expect(e.getState().comparePanes).toEqual([])
  e.getState().redo()
  e.getState().openComparePane(ids[2])
  e.getState().newProjectFile()
  expect(e.getState().comparePanes).toEqual([])
})

test('placeClipAsNewActor: new actor with the clip at start, one undo entry, clips untouched', () => {
  const e = createEditorStore(defs)
  const before = e.getState().project
  const r = e.getState().placeClipAsNewActor(Object.keys(before.clips)[0], 77)!
  const p = e.getState().project
  expect(p.actors).toHaveLength(3)
  expect(p.actors.at(-1)!.id).toBe(r.actorId)
  expect(p.sequence.tracks.at(-1)!.items).toEqual([expect.objectContaining({ id: r.itemId, start: 77 })])
  expect(Object.keys(p.clips)).toEqual(Object.keys(before.clips)) // no default clip
  e.getState().undo()
  expect(e.getState().project).toBe(before)
})

// ---- appendClip ----
const blockClip = (len: number, name = 'Stretch'): Clip => ({ id: crypto.randomUUID(), name, robot: 'go2', length: len, channels: {} })
const go2Setup = (items: { start: number; trimIn: number; trimOut: number }[]) => {
  const p = structuredClone(s().project)
  const go2 = p.actors.find(a => a.robot === 'go2')!
  const t = p.sequence.tracks.find(t => t.actorId === go2.id)!
  const ref = t.items[0]?.refId ?? Object.values(p.clips).find(c => c.robot === 'go2')!.id
  t.items = items.map(i => ({ id: crypto.randomUUID(), refId: ref, ...i }))
  s().loadProject(p, null)
  return go2.id
}
const itemById = (id: string) => s().project.sequence.tracks.flatMap(t => t.items).find(i => i.id === id)

test('appendClip places at track end (max start+len, not last pushed), one undo', () => {
  const go2 = go2Setup([{ start: 100, trimIn: 10, trimOut: 60 }, { start: 0, trimIn: 0, trimOut: 50 }])
  const clip = blockClip(30)
  const id = s().appendClip(go2, clip)!
  expect(itemById(id)).toMatchObject({ refId: clip.id, start: 150, trimIn: 0, trimOut: 30 })
  s().undo()
  expect(s().project.clips[clip.id]).toBeUndefined()
  expect(itemById(id)).toBeUndefined()
})

test('appendClip twice → back to back', () => {
  const go2 = go2Setup([{ start: 0, trimIn: 0, trimOut: 50 }])
  const a = s().appendClip(go2, blockClip(30))!, b = s().appendClip(go2, blockClip(20))!
  expect(itemById(a)!.start).toBe(50)
  expect(itemById(b)!.start).toBe(80)
})

test('appendClip on empty track starts at 0', () => {
  const go2 = go2Setup([])
  expect(itemById(s().appendClip(go2, blockClip(30))!)!.start).toBe(0)
})

test('appendClip rejects locked track and robot mismatch', () => {
  const go2 = go2Setup([])
  const before = s().project
  expect(s().appendClip(actor, blockClip(30))).toBeNull() // actor = G1
  const t = s().project.sequence.tracks.find(t => t.actorId === go2)!
  s().setTrackFlag(t.id, 'locked', true)
  const locked = s().project
  expect(s().appendClip(go2, blockClip(30))).toBeNull()
  expect(s().project).toBe(locked)
  expect(before.clips).toEqual(locked.clips)
})

test('appendClip dedupes name', () => {
  const go2 = go2Setup([])
  const a = s().appendClip(go2, blockClip(10))!, b = s().appendClip(go2, blockClip(10))!
  const name = (id: string) => s().project.clips[itemById(id)!.refId].name
  expect([name(a), name(b)]).toEqual(['Stretch', 'Stretch_2'])
})
