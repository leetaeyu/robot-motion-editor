import { evalCurve, makeKey } from './curve'
import type { Clip, Curve, Key } from './types'
import type { RobotDef } from '../robot/types'
import { FPS } from './fps'

export const REST_HOLD = 30 // max frames held at the rest pose (0.5 s)
export const REST_BLEND = FPS // max frames easing back into the motion (1 s)

const ROOT = ['root.x', 'root.y', 'root.z', 'root.roll', 'root.pitch', 'root.yaw']
const smooth = (t: number) => 3 * t * t - 2 * t * t * t
const lerp = (a: [number, number], b: [number, number], s: number): [number, number] => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]

// Clamp a handle to its segment like evalCurve does (sign: +1 out, -1 in).
const clampDf = (df: number, sign: 1 | -1, len: number) => { const d = Math.max(0, df * sign); return d > len ? len / d : 1 }

/** Split `ks` at frame f without changing the curve: returns the keys up to f and from f, each with a key at f. */
function split(ks: Key[], f: number): [Key[], Key[]] {
  if (!ks.length) return [[], []]
  const i = ks.findIndex(k => k.f >= f)
  if (i >= 0 && ks[i].f === f) return [ks.slice(0, i + 1), ks.slice(i)]
  const k0 = i < 0 ? ks.at(-1) : ks[i - 1], k1 = i < 0 ? undefined : ks[i]
  if (!k0 || !k1) { const n = makeKey(f, (k0 ?? k1)!.v, 'linear'); return [[...ks.slice(0, i < 0 ? ks.length : i), n], [n, ...(i < 0 ? [] : ks.slice(i))]] }
  const n = makeKey(f, evalCurve({ keys: [k0, k1] }, f, 0), k0.interp === 'hold' ? 'hold' : 'linear')
  const L = ks.slice(0, i), R = ks.slice(i)
  if (k0.interp !== 'bezier') return [[...L, n], [n, ...R]]
  const len = k1.f - k0.f, so = clampDf(k0.outTan.df, 1, len), si = clampDf(k1.inTan.df, -1, len)
  const P: [number, number][] = [[k0.f, k0.v], [k0.f + k0.outTan.df * so, k0.v + k0.outTan.dv * so], [k1.f + k1.inTan.df * si, k1.v + k1.inTan.dv * si], [k1.f, k1.v]]
  let lo = 0, hi = 1
  for (let j = 0; j < 40; j++) { const m = (lo + hi) / 2; const u = 1 - m; const x = u * u * u * P[0][0] + 3 * u * u * m * P[1][0] + 3 * u * m * m * P[2][0] + m * m * m * P[3][0]; if (x < f) lo = m; else hi = m }
  const s = (lo + hi) / 2, q0 = lerp(P[0], P[1], s), q1 = lerp(P[1], P[2], s), q2 = lerp(P[2], P[3], s), r0 = lerp(q0, q1, s), r1 = lerp(q1, q2, s), p = lerp(r0, r1, s)
  n.v = p[1]
  const left = { ...k0, outTan: { df: q0[0] - P[0][0], dv: q0[1] - P[0][1] } }, right = { ...k1, inTan: { df: q2[0] - P[3][0], dv: q2[1] - P[3][1] } }
  const nl = { ...n, inTan: { df: r0[0] - f, dv: r0[1] - p[1] } }, nr = { ...n, interp: 'bezier' as const, outTan: { df: r1[0] - f, dv: r1[1] - p[1] } }
  return [[...L.slice(0, -1), left, nl], [nr, right, ...R.slice(1)]]
}

/** Bake a rest-pose start into clip frames [a, b): hold the standing pose, then ease back into the original motion.
 * Frames outside the baked window evaluate exactly as before. Returns a new clip; the input is untouched. */
export function applyRestPose(clip: Clip, def: RobotDef, a: number, b: number): Clip {
  const len = b - a, hold = Math.min(REST_HOLD, Math.floor(len / 3)), blend = Math.min(REST_BLEND, len - hold - 1), end = a + hold + blend
  const channels: Record<string, Curve> = { ...clip.channels }
  const names = [...ROOT, ...def.joints.map(j => j.name)]
  for (const n of names) {
    const orig = clip.channels[n] ?? { keys: [] }, fb = n === 'root.z' ? def.standingHeight : 0
    const o = (f: number) => evalCurve(orig, f, fb)
    const keep = n === 'root.x' || n === 'root.y' || n === 'root.yaw'
    const R = keep ? o(a) : n === 'root.z' ? def.standingHeight : 0
    const win: Key[] = []
    for (let f = a; f <= end; f++) {
      const s = f <= a + hold ? 0 : smooth((f - a - hold) / blend)
      win.push(makeKey(f, R + (o(f) - R) * s, 'linear'))
    }
    let ks = orig.keys
    const left = a > 0 ? split(ks, a - 1)[0] : []
    if (left.length) left[left.length - 1] = { ...left.at(-1)!, interp: 'linear' }
    const right = end + 1 <= clip.length - 1 ? split(ks, end + 1)[1] : ks.filter(k => k.f > end)
    channels[n] = { keys: [...left, ...win, ...right] }
  }
  return { ...clip, channels }
}
