import type { Sequence } from '../model/types'
import { formatTimecode, frameToX, type TimeScale } from './timeScale'

export const LABEL_W = 160, RULER_H = 24
export interface Colors { bg: string; panel: string; line: string; text: string; accent: string }

// [minor, major] frame steps; major labels are >= 60px apart
const STEPS: [number, number][] = [[1, 1], [1, 2], [1, 5], [5, 10], [5, 25], [25, 50], [25, 100], [50, 250], [50, 500], [250, 1500], [500, 3000]]
export function tickStep(ppf: number): { minor: number; major: number } {
  const [minor, major] = STEPS.find(([, M]) => M * ppf >= 60) ?? STEPS[STEPS.length - 1]
  return { minor, major }
}

// Index of the marker within 4px of x, or null.
export function hitMarker(seq: Sequence, sc: TimeScale, x: number): number | null {
  let best: number | null = null, bd = 4
  seq.markers.forEach((m, i) => { const d = Math.abs(frameToX(sc, m.f) - x); if (d <= bd) { bd = d; best = i } })
  return best
}

export function drawRuler(ctx: CanvasRenderingContext2D, sc: TimeScale, w: number, h: number, seq: Sequence, frame: number, C: Colors): void {
  ctx.fillStyle = C.panel; ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = C.line; ctx.fillRect(0, h - 1, w, 1)
  ctx.save(); ctx.beginPath(); ctx.rect(LABEL_W, 0, w - LABEL_W, h); ctx.clip()
  const { inF, outF } = seq
  if (inF !== null || outF !== null) {
    const a = inF === null ? LABEL_W : frameToX(sc, inF), b = outF === null ? w : frameToX(sc, outF)
    ctx.globalAlpha = 0.25; ctx.fillStyle = C.accent; ctx.fillRect(a, 0, b - a, h - 1); ctx.globalAlpha = 1
    ctx.fillStyle = C.accent
    if (inF !== null) ctx.fillRect(Math.round(a), 0, 1, h)
    if (outF !== null) ctx.fillRect(Math.round(b), 0, 1, h)
  }
  const { minor, major } = tickStep(sc.pxPerFrame)
  const f0 = Math.max(0, Math.floor((LABEL_W - sc.x0) / sc.pxPerFrame / minor) * minor), f1 = (w - sc.x0) / sc.pxPerFrame
  ctx.font = '11px "IBM Plex Sans KR", sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'
  for (let f = f0; f <= f1; f += minor) {
    const x = Math.round(frameToX(sc, f)) + 0.5, big = f % major === 0
    ctx.fillStyle = big ? C.text : C.line
    ctx.fillRect(x, big ? 10 : 16, 1, big ? 14 : 8)
    if (big) { ctx.fillStyle = C.text; ctx.fillText(formatTimecode(f), x + 3, 6) }
  }
  ctx.fillStyle = C.text
  for (const m of seq.markers) {
    const x = frameToX(sc, m.f)
    ctx.beginPath(); ctx.moveTo(x - 4, h - 9); ctx.lineTo(x + 4, h - 9); ctx.lineTo(x, h - 2); ctx.fill()
  }
  const px = Math.round(frameToX(sc, frame)) + 0.5
  ctx.fillStyle = C.accent; ctx.fillRect(px - 0.5, 0, 1, h)
  ctx.restore()
}
