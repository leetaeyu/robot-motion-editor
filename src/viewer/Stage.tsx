import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { evalCurve } from '../model/curve'
import { COLOR } from '../model/defaults'
import { evaluate, evaluateClip, evaluateItem, evaluateRoot } from '../model/evaluate'
import { itemClip } from '../model/itemClip'
import { rebasePose } from '../model/pose'
import { nearestAngle } from '../model/rootMath'
import { stitchTransforms, worldToClipRoot } from '../model/sequence'
import type { Clip, Project } from '../model/types'
import { clipLocked, editingItem, editTarget, getEditor, gizmoLock, trackLocked } from '../store/store'
import { sequenceEnd } from '../transport'
import { buildRobot, pivotAngle, type RobotRig } from './buildRobot'
import type { RobotDef } from '../robot/types'
import { FPS } from '../model/fps'

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
const EXTENT = 5
const TARGET = new THREE.Vector3(0.75, 0, 0.6)
const EYE = new THREE.Vector3(3.2, -3.4, 2).sub(TARGET) // initial camera offset from the target
// unit directions from target: front (+x), side (-y), top (tiny y offset avoids up-vector degeneracy)
const VIEWS: Record<string, [number, number, number]> = { '1': [1, 0, 0.15], '3': [0, -1, 0.15], '7': [0, -0.001, 1] }

function makeGrid(): THREE.LineSegments {
  const fine: number[] = [], bold: number[] = []
  for (let i = -EXTENT * 2; i <= EXTENT * 2; i++) {
    const v = i / 2, out = i % 2 === 0 ? bold : fine
    out.push(v, -EXTENT, 0, v, EXTENT, 0, -EXTENT, v, 0, EXTENT, v, 0)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([...fine, ...bold], 3))
  const col = new THREE.Color(css('--line') || '#3B424D'), hi = col.clone().multiplyScalar(1.8)
  const colors: number[] = []
  for (let i = 0; i < fine.length / 3; i++) colors.push(col.r, col.g, col.b)
  for (let i = 0; i < bold.length / 3; i++) colors.push(hi.r, hi.g, hi.b)
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }))
}

// trailKey/trailClips: what the cached trail was built from (items + placement serialized, clips by identity)
interface Entry { rig: RobotRig; trail: THREE.Line; dot: THREE.Points; ghost: boolean; trailKey?: string; trailClips?: (Clip | undefined)[] }

/** One 3D view. `compareClipId` = a view-only compare pane: one robot at the origin driven by that clip from sequence frame 0 (no gizmo, picking or actors). Omitted = the main pane (every actor).
 * With `range` = [from, to) clip frames, the compare robot instead loops that range on its own project-fps clock, root re-based so frame `from` sits at the origin. */
export default function Stage({ compareClipId: cid, range, itemId }: { compareClipId?: string; range?: [number, number]; itemId?: string }) {
  const [lo, hi] = range ?? [0, 0]
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current!
    const ranged = hi > lo
    const store = getEditor()
    const target = TARGET.clone()
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(css('--bg') || '#22262D')
    const grid = makeGrid()
    scene.add(grid)
    const hemi = new THREE.HemisphereLight(0xffffff, 0x4a505c, 1.4)
    hemi.position.set(0, 0, 1)
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(2, -3, 4)
    scene.add(hemi, sun)

    const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100)
    camera.up.set(0, 0, 1)
    camera.position.copy(target).add(EYE)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    el.appendChild(renderer.domElement)
    const orbit = new OrbitControls(camera, renderer.domElement)
    orbit.target.copy(target)
    orbit.update()
    const tc = new TransformControls(camera, renderer.domElement)
    tc.setSize(0.8)
    if (!cid) scene.add(tc.getHelper())
    // dev/e2e hook
    // dev/e2e hook: __stage = main pane, __stages = every pane by key ('main' or the compare clip id)
    const hook = { camera, tc, entries: () => entries, renderer }
    const hookKey = ranged ? 'preview' : cid ?? 'main'
    if (import.meta.env.DEV) {
      const w = window as any
      ;(w.__stages ??= {})[hookKey] = hook
      if (!cid) w.__stage = hook
    }

    let dirty = true, raf = 0
    const t0 = performance.now()
    let shownF = -1
    // compare-pane pose at clip frame f (re-based to the range start when looping a range)
    const clipPose = (clip: Clip, def: RobotDef, f: number) =>
      ranged ? rebasePose(evaluateClip(clip, def, f), evaluateClip(clip, def, lo)) : evaluateClip(clip, def, f)
    const entries = new Map<string, Entry>()
    let rootMode: 'translate' | 'rotate' = 'translate'
    let last: number[] = []

    // hidden track: stage-only (rig, trail, dot, picking, gizmo); evaluation and export are untouched
    const isHidden = (p: Project, id: string) => !!p.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === id)?.hidden
    const applyAll = () => {
      const s = store.getState()
      const ei = editingItem(s)
      for (const a of s.project.actors) {
        const e = entries.get(a.id)
        if (!e) continue
        const hid = isHidden(s.project, a.id)
        e.rig.root.visible = e.trail.visible = e.dot.visible = !hid
        if (hid) continue
        const ghost = !!ei && ei.actorId !== a.id
        if (e.ghost !== ghost) { e.ghost = ghost; e.rig.setGhost(ghost) }
        const t = ei && !ghost ? editTarget(s, a.id) : null
        const pose = t ? evaluateItem(s.project, s.defs, t.itemId, t.f) : evaluate(s.project, s.defs, a.id, s.frame)
        e.rig.applyPose(pose)
        e.dot.position.set(pose.rootPos[0], pose.rootPos[1], 0.002)
      }
      dirty = true
    }

    const disposeObj = (o: THREE.Object3D) =>
      o.traverse(c => {
        const m = c as THREE.Mesh
        m.geometry?.dispose()
        for (const x of [m.material].flat()) x?.dispose()
      })
    const disposeEntry = (e: Entry) => {
      scene.remove(e.rig.root, e.trail, e.dot)
      for (const o of [e.rig.root, e.trail, e.dot]) disposeObj(o)
    }

    // the clip a compare pane shows: the original, or (item preview) the piece's clip with its 수정 층
    const shownClip = () => {
      const { project, defs } = store.getState(), clip = cid ? project.clips[cid] : undefined
      const it = itemId ? project.sequence.tracks.flatMap(t => t.items).find(i => i.id === itemId) : undefined
      return (clip && it && itemClip(project, defs, it)) || clip
    }
    // compare pane: one rig for the clip at the origin; trail rebuilt only when the clip object changes
    const syncClip = () => {
      const { defs } = store.getState()
      const clip = shownClip()
      if (!clip) return
      let e = entries.get(cid!)
      if (!e) {
        const color = new THREE.Color(COLOR[clip.robot])
        const rig = buildRobot(defs[clip.robot], COLOR[clip.robot])
        const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color }))
        const dot = new THREE.Points(
          new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
          new THREE.PointsMaterial({ color, size: 8, sizeAttenuation: false }))
        scene.add(rig.root, trail, dot)
        e = { rig, trail, dot, ghost: false }
        entries.set(cid!, e)
      }
      if (e.trailClips?.[0] === clip) return
      e.trailClips = [clip]
      const noJoints = { ...defs[clip.robot], joints: [] }, pts: number[] = []
      for (let f = ranged ? lo : 0, end = ranged ? Math.min(hi, clip.length) : clip.length; f < end; f++) { const p = clipPose(clip, noJoints, f).rootPos; pts.push(p[0], p[1], 0.002) }
      e.trail.geometry.dispose()
      e.trail.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    }
    const applyClip = () => {
      const s = store.getState(), clip = shownClip(), e = entries.get(cid!)
      if (!clip || !e) return
      const f = ranged ? lo + Math.floor((performance.now() - t0) * FPS / 1000) % Math.max(hi - lo, 1) : s.frame
      if (ranged && f === shownF) return
      shownF = f
      const pose = clipPose(clip, s.defs[clip.robot], Math.min(Math.max(f, 0), clip.length - 1))
      e.rig.applyPose(pose)
      e.dot.position.set(pose.rootPos[0], pose.rootPos[1], 0.002)
      dirty = true
    }

    const syncActors = () => {
      const s = store.getState()
      const { project, defs } = s
      const ids = new Set(project.actors.map(a => a.id))
      for (const [id, e] of entries) if (!ids.has(id)) { disposeEntry(e); entries.delete(id) }
      for (const a of project.actors) {
        if (!ids.has(a.id)) continue
        const color = new THREE.Color(a.color)
        let e = entries.get(a.id)
        if (!e) {
          const rig = buildRobot(defs[a.robot], a.color)
          const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color }))
          const dot = new THREE.Points(
            new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
            new THREE.PointsMaterial({ color, size: 8, sizeAttenuation: false }))
          scene.add(rig.root, trail, dot)
          e = { rig, trail, dot, ghost: false }
          entries.set(a.id, e)
        } else e.rig.setColor(a.color)
        if (isHidden(project, a.id)) continue // trail rebuilt on unhide (trailKey still compares against the stale one)
        // trail covers the whole sequence; rebuilt only when this actor's items, placement or clips change
        const track = project.sequence.tracks.find(t => t.kind === 'motion' && t.actorId === a.id)
        const clips = track?.items.map(i => project.clips[i.refId]) ?? []
        const key = JSON.stringify([track?.items, a.placement])
        if (e.trailKey === key && e.trailClips && clips.length === e.trailClips.length && clips.every((c, i) => c === e.trailClips![i])) continue
        e.trailKey = key; e.trailClips = clips
        const pts: number[] = []
        if (track?.items.length) {
          for (let f = 0, end = sequenceEnd(project); f < end; f++) {
            const p = evaluateRoot(project, defs, a.id, f).rootPos
            pts.push(p[0], p[1], 0.002)
          }
        }
        e.trail.geometry.dispose()
        e.trail.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      }
    }

    // crossfade (displayed pose is a blend, not invertible) or stitched first frame (root x/y/yaw pinned): no gizmo
    const locked = () => {
      const s = store.getState(), id = s.sel.actorId
      const t = id ? editTarget(s, id) : null
      return gizmoLock(s) !== null || (!!id && (isHidden(s.project, id) || trackLocked(s.project, id) || (!!t && clipLocked(s.project, t.clipId))))
    }
    const syncSelection = () => {
      const s = store.getState()
      const { sel } = s
      const ch = sel.channel?.startsWith('root') ? 'root' : sel.channel
      const accent = new THREE.Color(css('--accent') || '#F0A43A').multiplyScalar(0.5)
      for (const [id, e] of entries)
        for (const [obj, via] of e.rig.linkToJoint) {
          const m = obj as THREE.Mesh
          if (!m.isMesh) continue
          ;(m.material as THREE.MeshStandardMaterial).emissive.set(id === sel.actorId && via === ch ? accent : 0x000000)
        }
      const e = sel.actorId ? entries.get(sel.actorId) : undefined
      // re-attaching mid-drag would reset TransformControls' axis and kill the drag
      const target = !e || locked() ? null : ch === 'root' ? e.rig.root : ch ? e.rig.jointPivots[ch] ?? null : null
      if (!tc.dragging && tc.object !== (target ?? undefined)) {
        tc.detach()
        if (target) tc.attach(target)
      }
      if (e && ch === 'root') {
        if (!tc.object) { dirty = true; return }
        tc.setMode(rootMode)
        tc.setSpace(rootMode === 'rotate' ? 'local' : 'world')
        tc.showX = tc.showY = tc.showZ = true
      } else if (e && ch && e.rig.jointPivots[ch] && tc.object) {
        const robot = s.project.actors.find(a => a.id === sel.actorId)!.robot
        const ax = s.defs[robot].joints.find(j => j.name === ch)!.axis
        tc.setMode('rotate')
        tc.setSpace('local')
        tc.showX = !!ax[0]; tc.showY = !!ax[1]; tc.showZ = !!ax[2]
      }
      dirty = true
    }

    // current gizmo values for the root, in clip-local channels: undo placement, then the item's stitch transform
    const rootValues = (): [string, number][] => {
      const s = store.getState(), actor = s.project.actors.find(a => a.id === s.sel.actorId)!
      const target = editTarget(s, actor.id)
      const track = s.project.sequence.tracks.find(t => t.items.some(i => i.id === target?.itemId))
      const xf = (track && target && stitchTransforms(s.project, s.defs, track).get(target.itemId)) || { x: 0, y: 0, yaw: 0 }
      const o = entries.get(actor.id)!.rig.root
      const r = worldToClipRoot({ pos: [o.position.x, o.position.y, o.position.z], quat: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w] }, actor.placement, xf)
      if (rootMode === 'translate') return [['root.x', r.x], ['root.y', r.y], ['root.z', r.z]]
      // euler read-back wraps to (-pi, pi]; keep each angle continuous with the stored channel value
      if (!target) return [['root.roll', r.roll], ['root.pitch', r.pitch], ['root.yaw', r.yaw]]
      const it = track?.items.find(i => i.id === target.itemId), clip = (it && itemClip(s.project, s.defs, it)) || s.project.clips[target.clipId]
      const cur = (ch: string) => evalCurve(clip.channels[ch] ?? { keys: [] }, target.f, 0)
      return [['root.roll', nearestAngle(r.roll, cur('root.roll'))], ['root.pitch', nearestAngle(r.pitch, cur('root.pitch'))], ['root.yaw', nearestAngle(r.yaw, cur('root.yaw'))]]
    }

    tc.addEventListener('dragging-changed', e => {
      orbit.enabled = !e.value
      if (e.value) store.getState().beginGesture()
      else store.getState().endGesture()
      if (e.value && store.getState().sel.channel?.startsWith('root')) last = rootValues().map(v => v[1])
    })
    tc.addEventListener('change', () => { dirty = true })
    tc.addEventListener('objectChange', () => {
      const s = store.getState(), { actorId, channel } = s.sel
      if (!actorId || !channel) return
      if (channel.startsWith('root')) {
        rootValues().forEach(([ch, v], i) => {
          if (Math.abs(v - last[i]) > 1e-6) { last[i] = v; s.setValue(actorId, ch, v) }
        })
      } else {
        const pivot = entries.get(actorId)!.rig.jointPivots[channel]
        const robot = s.project.actors.find(a => a.id === actorId)!.robot
        const ax = s.defs[robot].joints.find(j => j.name === channel)!.axis
        s.setValue(actorId, channel, pivotAngle(pivot, ax))
      }
      applyAll() // snaps back when autoKey is off or the value was clamped
    })
    orbit.addEventListener('change', () => { dirty = true })

    // click-to-select (ignore orbit drags and gizmo hits)
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2()
    let down: [number, number] | null = null, onGizmo = false
    const dom = renderer.domElement
    const onDown = (ev: PointerEvent) => { down = [ev.clientX, ev.clientY]; onGizmo = tc.axis !== null; el.focus() }
    const onUp = (ev: PointerEvent) => {
      if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 4 || onGizmo) return
      const r = dom.getBoundingClientRect()
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      let best: { id: string; via: string; d: number } | null = null
      for (const [id, e] of entries) {
        if (e.ghost || !e.rig.root.visible) continue
        const hit = ray.intersectObject(e.rig.root, true)[0]
        const via = hit && e.rig.linkToJoint.get(hit.object)
        if (via && (!best || hit.distance < best.d)) best = { id, via, d: hit.distance }
      }
      if (best) store.getState().select(best.id, best.via)
      else store.getState().select(null)
    }
    if (!cid) { dom.addEventListener('pointerdown', onDown); dom.addEventListener('pointerup', onUp) }

    const onKey = (ev: KeyboardEvent) => {
      const v = VIEWS[ev.key]
      if (v) {
        const d = camera.position.distanceTo(orbit.target)
        camera.position.copy(target).add(new THREE.Vector3(...v).normalize().multiplyScalar(d))
        orbit.update()
      } else if (!cid && ev.key.toLowerCase() === 'r' && store.getState().sel.channel?.startsWith('root')) {
        rootMode = rootMode === 'translate' ? 'rotate' : 'translate'
        syncSelection()
      }
    }
    el.addEventListener('keydown', onKey)

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight
      if (!w || !h) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      dirty = true
    })
    ro.observe(el)

    let wasLocked = false
    if (cid) { syncClip(); applyClip() } else { syncActors(); applyAll(); syncSelection() }
    const unsub = store.subscribe((s, prev) => {
      if (cid) { if (s.project !== prev.project) { syncClip(); shownF = -1 } applyClip(); return }
      if (s.project !== prev.project) syncActors()
      applyAll()
      const key = (p: typeof s.project) => p.actors.map(a => a.id + a.robot).join()
      const lk = locked()
      if (s.sel !== prev.sel || key(s.project) !== key(prev.project) || lk !== wasLocked) syncSelection()
      wasLocked = lk
    })

    const loop = () => {
      raf = requestAnimationFrame(loop)
      if (ranged) applyClip()
      if (!dirty) return
      dirty = false
      renderer.render(scene, camera)
    }
    loop()

    return () => {
      cancelAnimationFrame(raf)
      unsub(); ro.disconnect()
      dom.removeEventListener('pointerdown', onDown)
      dom.removeEventListener('pointerup', onUp)
      el.removeEventListener('keydown', onKey)
      for (const e of entries.values()) disposeEntry(e)
      disposeObj(grid)
      tc.dispose(); orbit.dispose()
      // dispose() alone keeps the WebGL context alive until GC; release it now so opening/closing
      // preview panes never hits the browser's context limit (which kills the oldest pane's context)
      renderer.forceContextLoss(); renderer.dispose()
      el.removeChild(dom)
      if (import.meta.env.DEV) {
        const w = window as any
        if (w.__stages?.[hookKey] === hook) delete w.__stages[hookKey]
        if (w.__stage === hook) delete w.__stage
      }
    }
  }, [cid, lo, hi])

  return <div ref={host} tabIndex={0} style={{ width: '100%', height: '100%', outline: 'none' }} />
}
