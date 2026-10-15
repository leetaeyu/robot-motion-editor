import { evalCurve } from '../model/curve'
import type { Curve, Key } from '../model/types'
import { frameToX, type TimeScale } from './timeScale'
import { FPS } from '../model/fps'

export interface ValueScale { y0: number; pxPerUnit: number } // y0 = pixel y of value 0; value grows upward
export const valueToY = (vs: ValueScale, v: number) => vs.y0 - v * vs.pxPerUnit
export const yToValue = (vs: ValueScale, y: number) => (vs.y0 - y) / vs.pxPerUnit

export function fitView(curves: Curve[], limits: { lower: number; upper: number }[], fromF: number, toF: number, h: number): ValueScale {
  let lo = Infinity, hi = -Infinity
  const add = (v: number) => { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  for (const c of curves) {
    if (!c.keys.length) continue
    for (let f = Math.floor(fromF); f <= toF; f++) add(evalCurve(c, f, 0))
    for (const k of c.keys) if (k.f >= fromF && k.f <= toF) add(k.v)
  }
  for (const l of limits) { add(l.lower); add(l.upper) }
  if (!isFinite(lo)) { lo = -1; hi = 1 }
  if (hi - lo < 1e-3) { lo -= 0.5; hi += 0.5 }
  const pad = (hi - lo) * 0.08, ppu = h / (hi - lo + 2 * pad)
  return { y0: (hi + pad) * ppu, pxPerUnit: ppu }
}

// Runs of frames where |v(f+1)-v(f)|*FPS > velocity; { from, to } in frames.
export function velocityViolations(c: Curve, velocity: number, fromF: number, toF: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  for (let f = Math.floor(fromF); f < toF; f++) {
    if (Math.abs(evalCurve(c, f + 1, 0) - evalCurve(c, f, 0)) * FPS <= velocity) continue
    const last = out[out.length - 1]
    if (last && last.to === f) last.to = f + 1
    else out.push({ from: f, to: f + 1 })
  }
  return out
}

export function handlePoints(k: Key, s: TimeScale, vs: ValueScale): { in: [number, number]; out: [number, number] } {
  const p = (t: { df: number; dv: number }): [number, number] => [frameToX(s, k.f + t.df), valueToY(vs, k.v + t.dv)]
  return { in: p(k.inTan), out: p(k.outTan) }
}
