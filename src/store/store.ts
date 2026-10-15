import { createStore, useStore, type StoreApi } from 'zustand'
import { evalCurve, makeKey } from '../model/curve'
import { simplifyCurve, simplifyTolerance } from '../model/simplify'
import { addActor as addActorTo, emptyProject, newProject, nextClipName } from '../model/defaults'
import { evaluateClip, type RobotDefs } from '../model/evaluate'
import { inCrossfade, itemLen, resolve, sortedItems, validTrack } from '../model/sequence'
import { applyRestPose } from '../model/restPose'
import type { Actor, Item, Clip, Curve, Interp, Project, Tan, Track } from '../model/types'
import { validVideoTrack, videoTrack } from '../model/video'
import type { RobotKind } from '../robot/types'

// Bumped whenever a different project is loaded; async work started against one project checks it before landing.
let generation = 0
export const projectGeneration = () => generation

export type KeyRef = { channel: string; f: number }
export interface Selection { actorId: string | null; channel: string | null; keys: KeyRef[] }
export interface EditorState {
  defs: RobotDefs; project: Project; frame: number; playing: boolean; autoKey: boolean
  view: 'tracks' | 'graph'; sel: Selection
  videoMode: 'off' | 'overlay' | 'split'; videoOpacity: number // viewer preference: not undoable, not saved, survives loadProject
  setVideoMode(m: 'off' | 'overlay' | 'split'): void; setVideoOpacity(v: number): void
  comparePanes: string[] // clip ids shown in preview-only compare panes (max 2): not undoable, not saved, pruned when clips go away
  openComparePane(clipId: string): void; closeComparePane(clipId: string): void
  itemPreview: string | null // item id looping in the clip preview pane: not undoable, not saved, pruned when the item goes away
  openItemPreview(itemId: string): void; closeItemPreview(): void
  setFrame(f: number): void; setPlaying(b: boolean): void; toggleAutoKey(): void; setView(v: 'tracks' | 'graph'): void
  // What edits go to (editor state, not saved): 'piece' = the piece's 수정 층 (Item.offset; clip untouched, no 자동 키 needed),
  // 'clip' = the shared clip itself (needs 자동 키). Key actions below take a clip id or, for a 수정 층, the item id.
  layer: 'piece' | 'clip'; setLayer(l: 'piece' | 'clip'): void
  clearOffset(itemId: string): boolean // drop the piece's whole 수정 층 (one undo step); false = none / locked
  select(actorId: string | null, channel?: string | null): void; selectKeys(keys: KeyRef[], additive: boolean): void
  setValue(actorId: string, channel: string, v: number): void
  setKey(clipId: string, channel: string, f: number, v: number): void
  deleteKeys(clipId: string, keys: KeyRef[]): void
  moveKeys(clipId: string, keys: KeyRef[], df: number): void
  setInterp(clipId: string, keys: KeyRef[], interp: Interp): void
  setTangent(clipId: string, channel: string, f: number, side: 'in' | 'out', t: Tan, linked: boolean): void
  keyGroup(actorId: string, group: string): void
  setTrackFlag(trackId: string, flag: 'hidden' | 'locked', on: boolean): void
  setClip(clipId: string, patch: { name?: string; length?: number }): boolean
  setPlacement(actorId: string, pl: Partial<Actor['placement']>): void
  setColor(actorId: string, hex: string): void
  addActor(robot: RobotKind): void
  selItem: string | null; selectItem(itemId: string | null): void
  editing: string | null; openItem(itemId: string): void; closeItem(): void
  setIn(f: number | null): void; setOut(f: number | null): void
  addMarker(f: number): void; renameMarker(index: number, name: string): void; deleteMarker(index: number): void
  newClip(robot: RobotKind): string
  // Add an imported clip to the assets. If no actor of its robot exists, create one (no default clip) and place the clip at 0; otherwise assets only (null).
  importClipToActor(clip: Clip): { actorId: string; itemId: string } | null
  // New actor (no default clip) for the clip's robot with the clip at `start`; null = unknown clip. One undo entry.
  placeClipAsNewActor(clipId: string, start: number): { actorId: string; itemId: string } | null
  // Add the clip to the assets (name deduped) and place it right after the actor's last item; new item id, null = locked/unknown/robot mismatch. One undo entry.
  // actorId null: a new actor for the clip's robot, with the clip at 0 (메뉴 ▸ GO2 블럭 추가 on a project without a GO2).
  appendClip(actorId: string | null, clip: Clip): string | null
  simplifyClip(clipId: string, rot?: number, pos?: number): number
  deleteClip(clipId: string): boolean
  addMedia(name: string, durationF: number): string
  deleteMedia(mediaId: string): boolean
  addVideoItem(mediaId: string, start: number): boolean
  addItem(actorId: string, clipId: string, start: number): boolean
  moveItem(itemId: string, start: number): boolean
  trimItem(itemId: string, side: 'in' | 'out', df: number): boolean
  splitItem(itemId: string, frame: number): boolean
  deleteItem(itemId: string): boolean
  // Ripple-insert a rest-pose lead-in clip before the item (same track); false = rejected, nothing changed.
  setRestPose(itemId: string): boolean
  beginGesture(): void; endGesture(): void
  fileName: string | null; dirty: boolean
  loadProject(p: Project, fileName: string | null): void; markSaved(fileName: string): void; newProjectFile(): void
  undo(): void; redo(): void
}

const MAX_UNDO = 200
const ROOT = ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw']

// Lock rules: an actor's motion track locked; a clip is locked if ANY item referencing it sits on a locked track.
// Put `clip` in the draft's assets, renaming it `name_2`, `name_3`… if its robot already has that name.
function addUniqueClip(p: Project, clip: Clip) {
  const taken = new Set(Object.values(p.clips).filter(c => c.robot === clip.robot).map(c => c.name))
  let name = clip.name
  for (let n = 2; taken.has(name); n++) name = `${clip.name}_${n}`
  p.clips[clip.id] = { ...clip, name }
}
export const trackLocked = (p: Project, actorId: string) => p.sequence.tracks.some(t => t.kind === 'motion' && t.actorId === actorId && t.locked)
// (also takes an item id: that piece's 수정 층 is locked with its track)
export const clipLocked = (p: Project, clipId: string) => p.sequence.tracks.some(t => t.locked && t.items.some(i => i.refId === clipId || i.id === clipId))

// Curves a key action edits: a clip's channels, or an item's 수정 층 (deltas, clip frames, length of its clip). Read only.
export function keyOwner(p: Project, id: string): { channels: Record<string, Curve>; length: number; robot: RobotKind; offset: boolean } | null {
  const clip = p.clips[id]
  if (clip) return { channels: clip.channels, length: clip.length, robot: clip.robot, offset: false }
  for (const t of p.sequence.tracks) for (const it of t.items) if (it.id === id && p.clips[it.refId])
    return { channels: it.offset ?? {}, length: p.clips[it.refId].length, robot: p.clips[it.refId].robot, offset: true }
  return null
}

// editTarget plus the key owner for the current layer (the clip, or the item for its 수정 층).
export function keyTarget(s: Pick<EditorState, 'project' | 'frame' | 'editing' | 'layer'>, actorId: string) {
  const t = editTarget(s, actorId)
  return t && { ...t, owner: s.layer === 'piece' ? t.itemId : t.clipId }
}

// Which clip and clip frame edits for `actorId` go to. Clip view: the open item (trims ignored); else the item covering the frame.
export function editTarget(s: Pick<EditorState, 'project' | 'frame' | 'editing'>, actorId: string):
  { clipId: string; f: number; itemId: string } | null {
  const p = s.project
  if (s.editing) for (const t of p.sequence.tracks) {
    const it = t.items.find(i => i.id === s.editing)
    if (it && t.actorId === actorId) {
      const f = Math.min(Math.max(s.frame - it.start + it.trimIn, 0), p.clips[it.refId].length - 1)
      return { clipId: it.refId, f, itemId: it.id }
    }
  }
  const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actorId)
  if (!track) return null
  const items = sortedItems(track)
  const cover = items.filter(i => s.frame >= i.start && s.frame < i.start + (i.trimOut - i.trimIn)).at(-1) // later item wins on overlap
  if (cover) return { clipId: cover.refId, f: s.frame - cover.start + cover.trimIn, itemId: cover.id }
  const r = resolve(items, s.frame)
  return r && { clipId: r.item.refId, f: r.cf, itemId: r.item.id }
}

// The item open in clip view with its actor and clip, or null in sequence view.
export function editingItem(s: Pick<EditorState, 'project' | 'editing'>) {
  if (!s.editing) return null
  for (const t of s.project.sequence.tracks) {
    const item = t.items.find(i => i.id === s.editing)
    if (item) return { item, actorId: t.actorId ?? null, clip: s.project.clips[item.refId] }
  }
  return null
}

// Why edits of `channel` are off: a crossfade shows a blend (sequence view, any channel);
// the first frame of a stitched item has its root x/y/yaw matched to the previous item (z/roll/pitch stay editable).
export function editLock(s: Pick<EditorState, 'project' | 'frame' | 'editing'>, actorId: string, channel: string): 'crossfade' | 'stitch' | null {
  const track = s.project.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actorId)
  if (!track) return null
  if (!s.editing && inCrossfade(track, s.frame)) return 'crossfade'
  if (!['root.x', 'root.y', 'root.yaw'].includes(channel)) return null
  const t = editTarget(s, actorId), item = t && track.items.find(i => i.id === t.itemId)
  return item && t.f === item.trimIn && sortedItems(track)[0] !== item ? 'stitch' : null
}

// Stage gizmo lock for the selected channel. The root gizmo moves x/y/yaw together, so any root channel uses root.x
// (a z/roll/pitch selection still locks it on a stitch frame; splitting handles is out of scope).
export function gizmoLock(s: Pick<EditorState, 'project' | 'frame' | 'editing' | 'sel'>): 'crossfade' | 'stitch' | null {
  const { actorId, channel } = s.sel
  if (!actorId || !channel || channel.startsWith('group:')) return null
  return editLock(s, actorId, channel.startsWith('root') ? 'root.x' : channel)
}

// One shared delta for every selected key (all channels) so min f >= 0 and max f <= length-1.
export function clampDf(length: number, keys: KeyRef[], df: number): number {
  if (!keys.length) return 0
  return Math.min(Math.max(Math.round(df), -Math.min(...keys.map(k => k.f))), length - 1 - Math.max(...keys.map(k => k.f)))
}

// Clips and channels an edit mutates; 'all' = every channel of the clip.
type Touched = { clipId: string; channels: string[] | 'all' }[]
const chans = (keys: KeyRef[]) => [...new Set(keys.map(k => k.channel))]

// Dev/test only: deep-freeze clips so code mutating a shared (undeclared) curve throws. Frozen curves are skipped.
function freezeClips(p: Project): Project {
  if (!import.meta.env.DEV) return p
  for (const clip of Object.values(p.clips)) {
    for (const c of Object.values(clip.channels)) {
      if (Object.isFrozen(c)) continue
      for (const k of c.keys) { Object.freeze(k.inTan); Object.freeze(k.outTan); Object.freeze(k) }
      Object.freeze(c.keys); Object.freeze(c)
    }
    Object.freeze(clip.channels); Object.freeze(clip)
  }
  return p
}

export function createEditorStore(defs: RobotDefs, initial: Project = newProject()): StoreApi<EditorState> {
  return createStore<EditorState>((set, get) => {
    let undoS: Project[] = [], redoS: Project[] = []
    let gesture = false // edits inside a gesture share one undo entry
    let gestureMoved = false // the gesture has committed (pushed its undo entry, cleared redo)

    // One user action = one undo entry: mutate a clone, push the old project. In a gesture only the first change pushes.
    const commit = (next: Project) => {
      for (const t of next.sequence.tracks) for (const it of t.items) if (it.offset) { // no empty 수정 층 left behind
        for (const [n, c] of Object.entries(it.offset)) if (!c.keys.length) delete it.offset[n]
        if (!Object.keys(it.offset).length) delete it.offset
      }
      if (!gesture || !gestureMoved) { undoS = [...undoS, get().project].slice(-MAX_UNDO); redoS = [] }
      if (gesture) gestureMoved = true
      set({ project: freezeClips(next), editing: keepEditing(next), dirty: true, comparePanes: keepPanes(next), itemPreview: keepPreview(next) })
    }
    const keepPanes = (p: Project) => {
      const c = get().comparePanes, k = c.filter(id => id in p.clips)
      return k.length === c.length ? c : k
    }
    const keepPreview = (p: Project) => {
      const id = get().itemPreview
      return id && p.sequence.tracks.some(t => t.items.some(i => i.id === id)) ? id : null
    }
    const keepEditing = (p: Project) => {
      const e = get().editing
      return e && p.sequence.tracks.some(t => t.items.some(i => i.id === e)) ? e : null
    }
    // Copy-on-write draft: actors/sequence cloned; per touched clip only the declared channels get fresh curves,
    // all other curves stay shared with older snapshots (frozen in dev, so an undeclared mutation throws).
    const draft = (touched: Touched): Project => {
      const p = get().project
      const next: Project = { ...p, actors: structuredClone(p.actors), sequence: structuredClone(p.sequence), clips: { ...p.clips }, media: [...p.media] }
      for (const { clipId, channels } of touched) {
        const clip = p.clips[clipId]
        if (!clip) continue
        const chs = { ...clip.channels }
        for (const n of channels === 'all' ? Object.keys(chs) : channels)
          if (chs[n]) chs[n] = { keys: chs[n].keys.map(k => ({ ...k, inTan: { ...k.inTan }, outTan: { ...k.outTan } })) }
        next.clips[clipId] = { ...clip, channels: chs }
      }
      return next
    }
    const edit = (fn: (p: Project) => void, touched: Touched) => {
      const next = draft(touched)
      fn(next)
      commit(next)
    }

    // Mutate a candidate; commit only if fn returns true (rejection leaves project and stacks untouched).
    const tryEdit = (fn: (p: Project) => boolean, touched: Touched = []): boolean => {
      const next = draft(touched)
      if (!fn(next)) return false
      commit(next)
      return true
    }
    const findItem = (p: Project, id: string) => {
      for (const t of p.sequence.tracks) { const it = t.items.find(i => i.id === id); if (it) return { t, it } }
      return null
    }

    // Track rule by kind: V1 uses media bounds and forbids overlap; motion tracks allow crossfades.
    const validItems = (p: Project, t: Track) => t.kind === 'video' ? validVideoTrack(t.items, Object.fromEntries(p.media.map(m => [m.id, m]))) : validTrack(t.items)
    const refLen = (p: Project, t: Track, it: Item) => t.kind === 'video' ? p.media.find(m => m.id === it.refId)?.durationF ?? 0 : p.clips[it.refId].length

    // Writable curves of a key owner in the draft: a clip's channels, or an item's 수정 층 (created on demand, emptied ones dropped on commit).
    type Owner = { channels: Record<string, Curve>; length: number; robot: RobotKind; offset: boolean }
    const ownerOf = (p: Project, id: string): Owner | null => {
      const clip = p.clips[id]
      if (clip) return { channels: clip.channels, length: clip.length, robot: clip.robot, offset: false }
      const it = findItem(p, id)?.it, c = it && p.clips[it.refId]
      return it && c ? { channels: (it.offset ??= {}), length: c.length, robot: c.robot, offset: true } : null
    }
    const putKey = (clip: Owner | Clip, channel: string, f: number, v: number) => {
      const j = defs[clip.robot].joints.find(j => j.name === channel)
      if (j && !('offset' in clip && clip.offset)) v = Math.min(Math.max(v, j.lower), j.upper) // deltas: the sum is clamped when baked
      f = Math.min(Math.max(Math.round(f), 0), clip.length - 1)
      const keys = (clip.channels[channel] ??= { keys: [] }).keys
      const k = keys.find(k => k.f === f)
      if (k) k.v = v
      else { keys.push(makeKey(f, v)); keys.sort((a, b) => a.f - b.f) }
    }
    const findKey = (clip: Owner, r: KeyRef) => clip.channels[r.channel]?.keys.find(k => k.f === r.f)

    return {
      selItem: null, selectItem: selItem => set({ selItem }),
      editing: null,
      openItem: itemId => {
        const t = get().project.sequence.tracks.find(t => t.items.some(i => i.id === itemId))
        if (t?.kind === 'motion') set({ editing: itemId, selItem: itemId, sel: { actorId: t.actorId ?? null, channel: null, keys: [] } })
      },
      closeItem: () => set(s => ({ editing: null, frame: Math.max(s.frame, 0) })),
      setIn: f => edit(p => { p.sequence.inF = f; if (f !== null && p.sequence.outF !== null && p.sequence.outF <= f) p.sequence.outF = null }, []),
      setOut: f => edit(p => { p.sequence.outF = f; if (f !== null && p.sequence.inF !== null && p.sequence.inF >= f) p.sequence.inF = null }, []),
      addMarker: f => edit(p => {
        const n = Math.max(0, ...p.sequence.markers.map(m => Number(/^마커 (\d+)$/.exec(m.name)?.[1] ?? 0))) + 1
        p.sequence.markers.push({ f: Math.round(f), name: `마커 ${n}` })
        p.sequence.markers.sort((a, b) => a.f - b.f)
      }, []),
      renameMarker: (i, name) => edit(p => { if (p.sequence.markers[i]) p.sequence.markers[i].name = name }, []),
      deleteMarker: i => edit(p => { p.sequence.markers.splice(i, 1) }, []),
      defs, project: freezeClips(initial), frame: 0, playing: false, autoKey: false, view: 'tracks',
      sel: { actorId: null, channel: null, keys: [] },
      setFrame: frame => set({ frame }),
      setPlaying: playing => set({ playing }),
      toggleAutoKey: () => set(s => ({ autoKey: !s.autoKey })),
      layer: 'piece',
      setLayer: layer => set(s => s.layer === layer ? s : { layer, sel: { ...s.sel, keys: [] } }),
      clearOffset: itemId => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked || !f.it.offset) return false
        delete f.it.offset
        set(s => ({ sel: { ...s.sel, keys: [] } }))
        return true
      }),
      setView: view => set({ view }),
      videoMode: 'overlay', videoOpacity: 0.5,
      setVideoMode: videoMode => set({ videoMode }),
      setVideoOpacity: v => set({ videoOpacity: Math.min(Math.max(v, 0), 1) }),
      comparePanes: [],
      openComparePane: id => set(s => s.comparePanes.includes(id) || !s.project.clips[id] ? s : { comparePanes: [...s.comparePanes, id].slice(-2) }),
      closeComparePane: id => set(s => ({ comparePanes: s.comparePanes.filter(x => x !== id) })),
      itemPreview: null,
      openItemPreview: id => { if (findItem(get().project, id)) set({ itemPreview: id }) },
      closeItemPreview: () => set({ itemPreview: null }),
      select: (actorId, channel = null) => {
        const e = editingItem(get())
        if (e && actorId && actorId !== e.actorId) return // other actors are ghosts in clip view
        set({ sel: { actorId, channel, keys: [] } })
      },
      selectKeys: (keys, additive) => set(s => {
        const base = additive ? s.sel.keys : []
        const add = keys.filter((k, i) =>
          !base.some(b => b.channel === k.channel && b.f === k.f) &&
          keys.findIndex(o => o.channel === k.channel && o.f === k.f) === i)
        return { sel: { ...s.sel, keys: [...base, ...add] } }
      }),
      setValue: (actorId, channel, v) => {
        const s = get()
        if (s.layer === 'clip' && !s.autoKey) return
        const t = editTarget(s, actorId)
        if (!t || editLock(s, actorId, channel) || trackLocked(s.project, actorId)) return
        if (s.layer === 'clip') return s.setKey(t.clipId, channel, t.f, v)
        // 수정 층: key the difference from the clip, so this piece shows v here (joints clamped like a clip key)
        const clip = s.project.clips[t.clipId], def = defs[clip.robot], j = def.joints.find(j => j.name === channel)
        if (j) v = Math.min(Math.max(v, j.lower), j.upper)
        s.setKey(t.itemId, channel, t.f, v - evalCurve(clip.channels[channel] ?? { keys: [] }, t.f, channel === 'root.z' ? def.standingHeight : 0))
      },
      setKey: (clipId, channel, f, v) => clipLocked(get().project, clipId) ? undefined : edit(p => { const o = ownerOf(p, clipId); if (o) putKey(o, channel, f, v) }, [{ clipId, channels: [channel] }]),
      deleteKeys: (clipId, keys) => clipLocked(get().project, clipId) ? undefined : edit(p => {
        const clip = ownerOf(p, clipId)
        if (!clip) return
        for (const r of keys) {
          const c = clip.channels[r.channel]
          if (c) c.keys = c.keys.filter(k => k.f !== r.f)
        }
        set(s => ({ sel: { ...s.sel, keys: s.sel.keys.filter(k => !keys.some(r => r.channel === k.channel && r.f === k.f)) } }))
      }, [{ clipId, channels: chans(keys) }]),
      moveKeys: (clipId, keys, df) => {
        if (clipLocked(get().project, clipId)) return
        const moved: KeyRef[] = []
        edit(p => {
          const clip = ownerOf(p, clipId)
          if (!clip) return
          const d = clampDf(clip.length, keys, df)
          for (const channel of new Set(keys.map(k => k.channel))) {
            const c = clip.channels[channel]
            if (!c) continue
            const from = new Set(keys.filter(k => k.channel === channel).map(k => k.f))
            const sel = c.keys.filter(k => from.has(k.f))
            if (!sel.length) continue
            const mv = sel.map(k => ({ ...k, f: k.f + d }))
            const dest = new Set(mv.map(k => k.f))
            c.keys = [...c.keys.filter(k => !from.has(k.f) && !dest.has(k.f)), ...mv].sort((a, b) => a.f - b.f)
            moved.push(...mv.map(k => ({ channel, f: k.f })))
          }
        }, [{ clipId, channels: chans(keys) }])
        set(s => ({ sel: { ...s.sel, keys: moved } }))
      },
      setInterp: (clipId, keys, interp) => clipLocked(get().project, clipId) ? undefined : edit(p => {
        for (const r of keys) {
          const o = ownerOf(p, clipId), k = o && findKey(o, r)
          if (!k) continue
          k.interp = interp
          if (interp === 'bezier') { k.inTan.dv = 0; k.outTan.dv = 0 }
        }
      }, [{ clipId, channels: chans(keys) }]),
      setTangent: (clipId, channel, f, side, t, linked) => clipLocked(get().project, clipId) ? undefined : edit(p => {
        const o = ownerOf(p, clipId), k = o && findKey(o, { channel, f })
        if (!k) return
        const [mine, other] = side === 'out' ? [k.outTan, k.inTan] : [k.inTan, k.outTan]
        mine.df = t.df; mine.dv = t.dv
        if (linked && t.df !== 0) other.dv = (t.dv / t.df) * other.df
      }, [{ clipId, channels: [channel] }]),
      keyGroup: (actorId, group) => {
        const actor = get().project.actors.find(a => a.id === actorId)
        if (!actor) return // stale id: the actor may have been removed with its last clip
        const def = defs[actor.robot]
        const t = keyTarget(get(), actorId)
        if (!t || trackLocked(get().project, actorId) || clipLocked(get().project, t.clipId)) return
        const { clipId, f } = t
        const names = group === '루트' ? ROOT : def.groups.find(g => g.name === group)?.joints
        if (!names) throw new Error(`unknown group ${group}`)
        if (names.some(n => editLock(get(), actorId, n))) return
        if (t.owner !== clipId) { // 수정 층: key every channel at its current difference
          edit(p => { const o = ownerOf(p, t.owner)!; for (const n of names) putKey(o, n, f, evalCurve(o.channels[n] ?? { keys: [] }, f, 0)) }, [])
          return
        }
        edit(p => {
          const clip = p.clips[clipId]
          const pose = evaluateClip(clip, def, f)
          for (const n of names) {
            const v = ROOT.includes(n)
              ? evalCurve(clip.channels[n] ?? { keys: [] }, f, n === 'root.z' ? def.standingHeight : 0)
              : pose.q[def.joints.findIndex(j => j.name === n)]
            putKey(clip, n, f, v)
          }
        }, [{ clipId, channels: names }])
      },
      setTrackFlag: (trackId, flag, on) => edit(p => { const t = p.sequence.tracks.find(t => t.id === trackId); if (t) t[flag] = on }, []),
      setClip: (clipId, patch) => {
        if (clipLocked(get().project, clipId)) return false
        const name = patch.name?.trim() || undefined
        const len = patch.length === undefined ? undefined : Math.round(patch.length)
        if (len !== undefined && !(len >= 1)) return get().setClip(clipId, { name })
        if (name === undefined && len === undefined) return true
        const gone: KeyRef[] = []
        const ok = tryEdit(p => {
          const clip = p.clips[clipId]
          if (name) clip.name = name
          if (len === undefined) return true
          const old = clip.length
          clip.length = len
          for (const [channel, c] of Object.entries(clip.channels)) {
            for (const k of c.keys) if (k.f > len - 1) gone.push({ channel, f: k.f })
            c.keys = c.keys.filter(k => k.f <= len - 1)
          }
          // an item ending at the clip end follows the new end; other trims are kept, clamped into the clip
          for (const t of p.sequence.tracks) {
            let hit = false
            for (const it of t.items) if (it.refId === clipId) {
              if (it.offset) for (const c of Object.values(it.offset)) c.keys = c.keys.filter(k => k.f <= len - 1)
              it.trimOut = it.trimOut === old ? len : Math.min(it.trimOut, len)
              it.trimIn = Math.min(it.trimIn, it.trimOut - 1)
              hit = true
            }
            if (hit && !validTrack(t.items)) return false
          }
          return true
        }, [{ clipId, channels: len === undefined ? [] : 'all' }])
        if (ok && gone.length) set(s => ({ sel: { ...s.sel, keys: s.sel.keys.filter(k => !gone.some(r => r.channel === k.channel && r.f === k.f)) } }))
        return ok
      },
      setPlacement: (actorId, pl) => { if (trackLocked(get().project, actorId)) return; edit(p => {
        Object.assign(p.actors.find(a => a.id === actorId)!.placement, pl)
      }, []) },
      setColor: (actorId, hex) => edit(p => { p.actors.find(a => a.id === actorId)!.color = hex }, []),
      addActor: robot => commit(addActorTo({ ...get().project, actors: structuredClone(get().project.actors), sequence: structuredClone(get().project.sequence), clips: { ...get().project.clips } }, robot)),
      newClip: robot => {
        const id = crypto.randomUUID()
        edit(p => { p.clips[id] = { id, name: nextClipName(p, robot), robot, length: 120, channels: {} } }, [])
        return id
      },
      importClipToActor: clip => {
        let out: { actorId: string; itemId: string } | null = null
        tryEdit(p => {
          const exists = p.actors.some(a => a.robot === clip.robot)
          if (!exists) Object.assign(p, addActorTo(p, clip.robot, false))
          addUniqueClip(p, clip)
          if (exists) return true
          const actor = p.actors.at(-1)!, track = p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actor.id)!
          const item = { id: crypto.randomUUID(), refId: clip.id, start: 0, trimIn: 0, trimOut: clip.length }
          track.items.push(item)
          out = { actorId: actor.id, itemId: item.id }
          return true
        })
        return out
      },
      appendClip: (actorId, clip) => {
        let out: string | null = null
        tryEdit(p => {
          if (actorId === null) Object.assign(p, addActorTo(p, clip.robot, false))
          const id = actorId ?? p.actors.at(-1)!.id
          const actor = p.actors.find(a => a.id === id)
          const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === id)
          if (!actor || !track || track.locked || actor.robot !== clip.robot) return false
          addUniqueClip(p, clip)
          const item = { id: crypto.randomUUID(), refId: clip.id, start: Math.max(0, ...track.items.map(i => i.start + itemLen(i))), trimIn: 0, trimOut: clip.length }
          track.items.push(item)
          out = item.id
          return validTrack(track.items)
        })
        return out
      },
      placeClipAsNewActor: (clipId, start) => {
        let out: { actorId: string; itemId: string } | null = null
        tryEdit(p => {
          const clip = p.clips[clipId]
          if (!clip) return false
          Object.assign(p, addActorTo(p, clip.robot, false))
          const actor = p.actors.at(-1)!, track = p.sequence.tracks.at(-1)!
          const item = { id: crypto.randomUUID(), refId: clipId, start: Math.round(start), trimIn: 0, trimOut: clip.length }
          track.items.push(item)
          out = { actorId: actor.id, itemId: item.id }
          return true
        }) // clips are only referenced, never mutated: nothing touched
        return out
      },
      simplifyClip: (clipId, rot = 0.001, pos = 0.001) => {
        const clip = get().project.clips[clipId]
        if (!clip || clipLocked(get().project, clipId)) return 0
        const next: Record<string, Curve> = {}
        let cut = 0
        for (const [ch, c] of Object.entries(clip.channels)) {
          const r = simplifyCurve(c, simplifyTolerance(ch, rot, pos))
          cut += c.keys.length - r.keys.length
          next[ch] = r
        }
        if (cut === 0) return 0
        edit(p => { Object.assign(p.clips[clipId].channels, next) }, [{ clipId, channels: 'all' }])
        return cut
      },
      deleteClip: clipId => tryEdit(p => {
        if (!p.clips[clipId] || p.sequence.tracks.some(t => t.items.some(i => i.refId === clipId))) return false
        delete p.clips[clipId]
        return true
      }),
      addMedia: (name, durationF) => {
        if (!Number.isInteger(durationF) || durationF < 1) throw new Error(`invalid durationF ${durationF}`)
        const id = crypto.randomUUID()
        edit(p => {
          if (!videoTrack(p)) p.sequence.tracks.unshift({ id: crypto.randomUUID(), kind: 'video', hidden: false, locked: false, items: [] })
          const taken = new Set(p.media.map(m => m.name))
          let n = name
          for (let i = 2; taken.has(n); i++) n = `${name}_${i}`
          p.media.push({ id, name: n, durationF })
        }, [])
        return id
      },
      deleteMedia: mediaId => tryEdit(p => {
        if (!p.media.some(m => m.id === mediaId) || p.sequence.tracks.some(t => t.items.some(i => i.refId === mediaId))) return false
        p.media = p.media.filter(m => m.id !== mediaId)
        return true
      }),
      addVideoItem: (mediaId, start) => tryEdit(p => {
        const m = p.media.find(m => m.id === mediaId), t = videoTrack(p)
        if (!m || !t || t.locked) return false
        t.items.push({ id: crypto.randomUUID(), refId: mediaId, start: Math.round(start), trimIn: 0, trimOut: m.durationF })
        return validItems(p, t)
      }),
      addItem: (actorId, clipId, start) => tryEdit(p => {
        const clip = p.clips[clipId]
        const track = p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === actorId)
        const actor = p.actors.find(a => a.id === actorId)
        if (!clip || !track || track.locked || !actor || actor.robot !== clip.robot) return false
        track.items.push({ id: crypto.randomUUID(), refId: clipId, start: Math.round(start), trimIn: 0, trimOut: clip.length })
        return validTrack(track.items)
      }),
      moveItem: (itemId, start) => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked) return false
        f.it.start = Math.round(start)
        return validItems(p, f.t)
      }),
      trimItem: (itemId, side, df) => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked) return false
        const d = Math.round(df), it = f.it
        if (side === 'in') { it.start += d; it.trimIn += d } else it.trimOut += d
        return it.trimIn >= 0 && it.trimIn < it.trimOut && it.trimOut <= refLen(p, f.t, it) && validItems(p, f.t)
      }),
      splitItem: (itemId, frame) => tryEdit(p => {
        const f = findItem(p, itemId)
        if (!f || f.t.locked) return false
        const it = f.it, cut = Math.round(frame) - it.start + it.trimIn
        if (!(cut > it.trimIn && cut < it.trimOut)) return false
        const right: Item = { id: crypto.randomUUID(), refId: it.refId, start: Math.round(frame), trimIn: cut, trimOut: it.trimOut }
        if (it.offset) right.offset = structuredClone(it.offset) // clip frames: each piece keeps the part under it
        it.trimOut = cut
        f.t.items.push(right)
        return validItems(p, f.t)
      }),
      deleteItem: itemId => {
        const ok = tryEdit(p => {
          const f = findItem(p, itemId)
          if (!f || f.t.locked) return false
          f.t.items = f.t.items.filter(i => i.id !== itemId)
          // last clip of a motion track gone -> the robot goes with it (the clip stays in the assets)
          if (f.t.kind === 'motion' && !f.t.items.length) {
            p.actors = p.actors.filter(a => a.id !== f.t.actorId)
            p.sequence.tracks = p.sequence.tracks.filter(t => t !== f.t)
          }
          return true
        })
        if (ok) set(s => ({
          selItem: s.selItem === itemId ? null : s.selItem,
          sel: s.sel.actorId && !s.project.actors.some(a => a.id === s.sel.actorId) ? { actorId: null, channel: null, keys: [] } : s.sel,
        }))
        return ok
      },
      setRestPose: itemId => {
        const f = findItem(get().project, itemId), clip = f && get().project.clips[f.it.refId]
        if (!f || !clip || f.t.locked || f.t.kind !== 'motion' || clipLocked(get().project, clip.id) || f.it.trimOut - f.it.trimIn < 3) return false
        edit(p => { p.clips[clip.id] = applyRestPose(p.clips[clip.id], defs[clip.robot], f.it.trimIn, f.it.trimOut) }, [{ clipId: clip.id, channels: 'all' }])
        return true
      },
      fileName: null, dirty: false,
      loadProject: (project, fileName) => {
        generation++
        undoS = []; redoS = []; gesture = false; gestureMoved = false
        set({ project: freezeClips(project), fileName, dirty: false, frame: 0, playing: false, editing: null, selItem: null, sel: { actorId: null, channel: null, keys: [] }, comparePanes: [], itemPreview: null })
      },
      markSaved: fileName => set({ fileName, dirty: false }),
      newProjectFile: () => get().loadProject(emptyProject(), null),
      beginGesture: () => {
        if (gesture) return
        gesture = true; gestureMoved = false // undo entry + redo clear wait for the first commit
      },
      endGesture: () => { gesture = false },
      undo: () => {
        get().endGesture()
        const prev = undoS.at(-1)
        if (!prev) return
        undoS = undoS.slice(0, -1); redoS = [...redoS, get().project]
        set(s => ({ project: prev, editing: keepEditing(prev), dirty: true, sel: { ...s.sel, keys: [] }, comparePanes: keepPanes(prev), itemPreview: keepPreview(prev) }))
      },
      redo: () => {
        get().endGesture()
        const next = redoS.at(-1)
        if (!next) return
        redoS = redoS.slice(0, -1); undoS = [...undoS, get().project]
        set(s => ({ project: next, editing: keepEditing(next), dirty: true, sel: { ...s.sel, keys: [] }, comparePanes: keepPanes(next), itemPreview: keepPreview(next) }))
      },
    }
  })
}

let editor: StoreApi<EditorState> | null = null
export function initEditor(defs: RobotDefs): StoreApi<EditorState> {
  return (editor = createEditorStore(defs, emptyProject()))
}
export function getEditor(): StoreApi<EditorState> {
  if (!editor) throw new Error('editor not initialized')
  return editor
}
export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useStore(getEditor(), selector)
}
