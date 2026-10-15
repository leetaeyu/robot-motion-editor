import type { RobotKind } from '../robot/types'
import type { Actor, Clip, Project, Track } from './types'
import { FPS } from './fps'

export const COLOR: Record<RobotKind, string> = { g1: '#58B4D1', go2: '#C9D65A' }
const LABEL: Record<RobotKind, string> = { g1: 'G1', go2: 'GO2' }
const LENGTH = 120

export function nextClipName(p: Project | null, robot: RobotKind): string {
  let max = 0
  for (const c of Object.values(p?.clips ?? {})) {
    const m = c.robot === robot && /^clip_(\d+)$/.exec(c.name)
    if (m) max = Math.max(max, +m[1])
  }
  return `clip_${String(max + 1).padStart(2, '0')}`
}

function makeActor(p: Project | null, robot: RobotKind, x: number, withClip = true): { actor: Actor; clip: Clip; track: Track } {
  const n = (p?.actors.filter(a => a.robot === robot).length ?? 0) + 1
  const actor: Actor = {
    id: crypto.randomUUID(), name: `${LABEL[robot]} #${n}`, robot, color: COLOR[robot],
    placement: { x, y: 0, yaw: 0 },
  }
  const clip: Clip = { id: crypto.randomUUID(), name: nextClipName(p, robot), robot, length: LENGTH, channels: {} }
  const track: Track = {
    id: crypto.randomUUID(), kind: 'motion', actorId: actor.id, hidden: false, locked: false,
    items: withClip ? [{ id: crypto.randomUUID(), refId: clip.id, start: 0, trimIn: 0, trimOut: LENGTH }] : [],
  }
  return { actor, clip, track }
}

// withClip=false: an actor with an empty motion track and no clip (the importer fills it).
export function addActor(p: Project, robot: RobotKind, withClip = true): Project {
  const { actor, clip, track } = makeActor(p, robot, 1.5 * p.actors.length, withClip)
  return {
    ...p,
    actors: [...p.actors, actor],
    clips: withClip ? { ...p.clips, [clip.id]: clip } : p.clips,
    sequence: { ...p.sequence, tracks: [...p.sequence.tracks, track] },
  }
}

export function newProject(): Project {
  const g = makeActor(null, 'g1', 0), d = makeActor(null, 'go2', 1.5)
  return {
    version: 2, fps: FPS,
    actors: [g.actor, d.actor],
    clips: { [g.clip.id]: g.clip, [d.clip.id]: d.clip },
    media: [],
    sequence: { tracks: [g.track, d.track], markers: [], inF: null, outF: null },
  }
}

export const emptyProject = (): Project => ({
  version: 2, fps: FPS, actors: [], clips: {}, media: [],
  sequence: { tracks: [], markers: [], inF: null, outF: null },
})
